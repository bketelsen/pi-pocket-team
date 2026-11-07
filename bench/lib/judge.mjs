// S3, the judges: 2 models of 2 families grade a submitted diff by the rubric of `bench/judge-v1.md`, through the Pi
// CLI in the sandbox with no tool. Each try reserves $1 under the budget guard and settles its real list cost; the
// judge cost is never part of an attempt's usage. A missing or unparsable answer gets 2 more tries; then the judge
// is pending (judged again later), never a fail.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, privateDir, providerOf } from "./common.mjs";
import { reserve, settle } from "./budget.mjs";
import { DEFAULTS, bwrapArgs, identityPaths } from "./sandbox.mjs";
import { runStreamed } from "./proc.mjs";
import { authPreflight, authType, prepareAgentDir } from "./runner.mjs";

/**
 * The judges, in the order of `grades`. Claude Opus 5.5 runs through the route `github-copilot/claude-opus-5.5`: the
 * route `anthropic/claude-opus-5-5` returns HTTP 400 for the Pi CLI. Its family stays anthropic (`JUDGE_FAMILIES`).
 */
export const JUDGES = ["openai/gpt-6.1-sol", "github-copilot/claude-opus-5.5"];

/** The judge prompt, version 1. */
export const JUDGE_PROMPT = join(BENCH_DIR, "judge-v1.md");

/**
 * The SHA-256 of `bench/judge-v1.md` at its freeze (`bench/judge-v1.calibration.md`). The judges' calibration holds
 * for this text only: a changed rubric is a new file (`judge-v2.md`) with a new calibration.
 */
export const JUDGE_PROMPT_SHA256 =
    "226b28d93da03b2879a9fc2a23bb386ea899b07ce4a673754d787f63f9cde0ce";

/** The error of a judge prompt whose hash is not the frozen one. */
export const JUDGE_PROMPT_CHANGED =
    "bench/judge-v1.md changed after its freeze; a changed rubric is judge-v2.md and needs a new calibration";

/** The SHA-256 hex of a file. */
export async function fileSha256(file) {
    return createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
}

/** Throw `JUDGE_PROMPT_CHANGED` when the judge prompt file (default `JUDGE_PROMPT`) is not the frozen text. */
export async function checkJudgePrompt(file = JUDGE_PROMPT) {
    if ((await fileSha256(file)) !== JUDGE_PROMPT_SHA256) {
        throw new Error(JUDGE_PROMPT_CHANGED);
    }
}

/** The most characters of a diff in the judge's input. */
export const DIFF_LIMIT = 60_000;

/** Tries of 1 judge: 1 and 2 more for a missing or unparsable answer. */
export const JUDGE_TRIES = 3;

/** The reservation of 1 judge try, in US dollars. */
export const JUDGE_CAP = 1;

/** The wall limit of 1 judge try. */
export const JUDGE_WALL_MS = 20 * 60_000;

/** The prompt's file name in the judge's `/work`. */
export const PROMPT_FILE = "judge-prompt.md";

/**
 * The minimum token life of a judge's auth pre-flight: it covers `JUDGE_WALL_MS` (20 minutes). The runner's 60
 * minutes fails for OpenAI, whose OAuth token never has 60 minutes left.
 */
export const JUDGE_MIN_EXPIRY = "30m";

/**
 * The message after the prompt file: with the file alone, a model reads it as a document and answers with prose
 * around the JSON.
 */
export const JUDGE_MESSAGE =
    "Grade the submitted change in the attached file by its rubric. Answer with 1 JSON object only, and nothing before or after it.";

/** The folders whose files are test files. */
const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "testdata", "fixtures"]);

/**
 * True for a test file: a path with a folder `test`, `tests`, `__tests__`, `testdata` or `fixtures`, or a base name
 * `*_test.go`, `*_test.py`, `test_*.py`, `*.test.<ext>` or `*.spec.<ext>` (ext: js, mjs, cjs, ts, mts, cts, jsx, tsx).
 */
export function isTestPath(path) {
    const parts = String(path ?? "").split("/");
    const base = parts.pop();

    return (
        parts.some((part) => TEST_FOLDERS.has(part)) ||
        /_test\.(?:go|py)$/.test(base) ||
        /^test_.*\.py$/.test(base) ||
        /\.(?:test|spec)\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(base)
    );
}

/** The path of a file section of a diff: the `b/` path of its `diff --git` line (the `a/` path when none parses). */
const sectionPath = (section) => {
    const end = section.indexOf("\n");
    const line = end < 0 ? section : section.slice(0, end);
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);

    return match ? match[2] : line.slice("diff --git ".length);
};

/**
 * A diff with its test files last: the text before the first `diff --git ` line stays first, then the non-test file
 * sections, then the test file sections, each group in its original order. Git sorts files by path, so test files
 * (`desk-x.test.ts` before `desk.ts`) can fill a cut and hide the code they test.
 */
export function testsLast(diff) {
    const text = String(diff ?? "");
    const starts = [...text.matchAll(/^diff --git /gm)].map((m) => m.index);

    if (starts.length < 2) {
        return text;
    }

    const head = text.slice(0, starts[0]);
    const sections = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
    const ordered = [
        ...sections.filter((section) => !isTestPath(sectionPath(section))),
        ...sections.filter((section) => isTestPath(sectionPath(section))),
    ];

    // Only the original last section can lack its final newline; elsewhere it would join 2 lines.
    return (
        head +
        ordered
            .map((section, i) =>
                i < ordered.length - 1 && !section.endsWith("\n") ? `${section}\n` : section,
            )
            .join("")
    );
}

/**
 * A diff for the judge: as it is up to `DIFF_LIMIT` characters; a longer one becomes its `--stat`, a blank line, and
 * the first `DIFF_LIMIT` characters of the diff with its test files last (`testsLast`), with `cut: true`.
 */
export function cutDiff(diff, stat) {
    const text = String(diff ?? "");

    if (text.length <= DIFF_LIMIT) {
        return { text, cut: false };
    }

    return {
        text: `${String(stat ?? "").trimEnd()}\n\n${testsLast(text).slice(0, DIFF_LIMIT)}`,
        cut: true,
    };
}

/** A stat of a unified diff (files, lines added and removed), for a diff that has no `git diff --stat`. */
export function diffStat(diff) {
    const files = [];
    let current = null;

    for (const line of String(diff ?? "").split("\n")) {
        const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);

        if (header) {
            current = { file: header[2], added: 0, removed: 0 };
            files.push(current);
        } else if (current && line.startsWith("+") && !line.startsWith("+++ ")) {
            current.added += 1;
        } else if (current && line.startsWith("-") && !line.startsWith("--- ")) {
            current.removed += 1;
        }
    }

    const added = files.reduce((sum, f) => sum + f.added, 0);
    const removed = files.reduce((sum, f) => sum + f.removed, 0);

    return [
        ...files.map((f) => ` ${f.file} | +${f.added} -${f.removed}`),
        ` ${files.length} files changed, ${added} insertions(+), ${removed} deletions(-)`,
    ].join("\n");
}

/** The note of a diff in the prompt. */
const cutNote = (cut, what) =>
    cut
        ? `The ${what} diff is longer than ${DIFF_LIMIT} characters: below are its stat and its first ${DIFF_LIMIT} characters.`
        : `The ${what} diff is complete.`;

/** An S1 or S2 result in words. */
const checkWords = (value, none) => (value === true ? "passed" : value === false ? "failed" : none);

/** The reference note of an item with no merged change (a calibration item). */
export const NO_REFERENCE_NOTE =
    "No merged change is given for this item: grade the submitted change by the task and the repository alone.";

/** S1 and S2 of a calibration call: the owners who labelled the items saw only the brief and the diff. */
export const CALIBRATION_CHECK = "not run for this item";

/**
 * The judge's input: the template with the brief, S1, S2, the 2 diffs and their cut notes. No model name goes in.
 * `submitted` and `reference` are `{ text, cut }` from `cutDiff`; `reference: null` gives no merged change (the note
 * `NO_REFERENCE_NOTE` and the diff "(none)"). `calibration: true` gives `CALIBRATION_CHECK` for S1 and S2.
 */
export function renderPrompt(
    template,
    { brief, s1, s2, submitted, reference, calibration = false },
) {
    const values = {
        BRIEF: String(brief ?? "").trim(),
        S1: calibration ? CALIBRATION_CHECK : checkWords(s1, "not run"),
        S2: calibration ? CALIBRATION_CHECK : checkWords(s2, "none: this task has no hidden test"),
        SUBMITTED_NOTE: cutNote(submitted.cut, "submitted"),
        SUBMITTED_DIFF: submitted.text.trim() === "" ? "(no change)" : submitted.text,
        REFERENCE_NOTE: reference === null ? NO_REFERENCE_NOTE : cutNote(reference.cut, "merged"),
        REFERENCE_DIFF: reference === null ? "(none)" : reference.text,
    };

    return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => values[name] ?? whole);
}

/** A candidate text as `{ grade, reasons }` when it is 1 JSON object with an integer grade 0 to 4 and string reasons. */
function answerOf(text) {
    let value;

    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    if (!Number.isInteger(value.grade) || value.grade < 0 || value.grade > 4) {
        return null;
    }

    if (typeof value.reasons !== "string") {
        return null;
    }

    return { grade: value.grade, reasons: value.reasons };
}

/** The balanced top-level `{...}` spans of a text (braces inside JSON strings do not count). */
export function topLevelObjects(text) {
    const spans = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === '"') {
                inString = false;
            }

            continue;
        }

        if (c === '"' && depth > 0) {
            inString = true;
        } else if (c === "{") {
            if (depth === 0) {
                start = i;
            }

            depth += 1;
        } else if (c === "}" && depth > 0) {
            depth -= 1;

            if (depth === 0) {
                spans.push(text.slice(start, i + 1));
            }
        }
    }

    return spans;
}

/**
 * A judge's answer as `{ grade, reasons }`, or null. The text must hold exactly 1 candidate: the whole text as JSON;
 * else its fenced code blocks, when it has any; else its balanced top-level `{...}` objects. A candidate is valid
 * when it parses as 1 object with an integer `grade` from 0 to 4 and a string `reasons`. Exactly 1 valid candidate
 * is the answer; none, or 2 or more, is unparsable (null).
 */
export function parseAnswer(text) {
    const body = String(text ?? "").trim();
    const whole = answerOf(body);

    if (whole) {
        return whole;
    }

    const fences = [...body.matchAll(/```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)].map((m) =>
        m[1].trim(),
    );
    const candidates = fences.length ? fences : topLevelObjects(body);
    const valid = candidates.map(answerOf).filter(Boolean);

    return valid.length === 1 ? valid[0] : null;
}

/** The text of the last assistant message of a Pi JSON event file, or "". */
export async function answerText(eventsFile) {
    let text;

    try {
        text = await readFile(eventsFile, "utf8");
    } catch {
        return "";
    }

    let answer = "";

    for (const line of text.split("\n")) {
        let event;

        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (event?.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message.content;

            answer =
                typeof content === "string"
                    ? content
                    : (content ?? [])
                          .filter((part) => part?.type === "text")
                          .map((part) => part.text)
                          .join("\n");
        }
    }

    return answer;
}

/**
 * The Pi command of a judge in the sandbox: no tools, no context files, the prompt from a file (an argument above
 * 128 KB fails on Linux), then a short message that asks for the answer.
 */
export const judgeCommand = (model) => [
    "node",
    "/pocket/node_modules/.bin/pi",
    "-p",
    "--mode",
    "json",
    "--model",
    `${model}:high`,
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-session",
    `@/work/${PROMPT_FILE}`,
    JUDGE_MESSAGE,
];

/** The first free try number in a judge's folder (folders are kept). */
function firstTry(dir) {
    if (!existsSync(dir)) {
        return 1;
    }

    const used = readdirSync(dir)
        .map((name) => /^try-(\d+)$/.exec(name)?.[1])
        .filter(Boolean)
        .map(Number);

    return used.length ? Math.max(...used) + 1 : 1;
}

/**
 * Run 1 judge: up to `JUDGE_TRIES` tries until it answers 1 parsable JSON object. `ctx`: `{ data, bwrap, pocket,
 * agentSrc, miseInstalls, authPreflight, killGraceMs, wallMs, spawn?, judgePromptFile? }` (`spawn` replaces the
 * pre-flight's in tests; `judgePromptFile` replaces `JUDGE_PROMPT` in the freeze check). `dir`: the judge's folder in
 * the data dir. Returns `{ model, grade, reasons, tries, cost, pending, refused }`; `refused` when the budget guard
 * refused a try. Throws `JUDGE_PROMPT_CHANGED`, before any try, when the judge prompt is not the frozen text.
 */
export async function runJudge(ctx, { model, prompt, dir, task, stage }) {
    await checkJudgePrompt(ctx.judgePromptFile ?? JUDGE_PROMPT);

    const provider = providerOf(model);
    const out = {
        model,
        grade: null,
        reasons: null,
        tries: 0,
        cost: 0,
        pending: true,
        refused: false,
    };
    let tryNo = firstTry(dir);

    await prepareAgentDir(ctx);

    for (let n = 0; n < JUDGE_TRIES; n += 1, tryNo += 1) {
        const reservation = await reserve(ctx.data, {
            task,
            model,
            stage,
            priced: true,
            cap: JUDGE_CAP,
        });

        if (!reservation.ok) {
            ctx.log(`judge ${model}: ${reservation.reason}`);
            out.refused = true;

            return out;
        }

        const base = join(dir, `try-${tryNo}`);
        const paths = {
            work: join(base, "work"),
            session: join(base, "session"),
            cache: join(base, "cache"),
            agentDir: join(ctx.data, "agent"),
            settings: join(ctx.data, "agent-files", "settings.json"),
            models: join(ctx.agentSrc, "models.json"),
            auth: join(ctx.agentSrc, "auth.json"),
            header: DEFAULTS.header,
            hosts: DEFAULTS.hosts,
            pocket: ctx.pocket,
            miseInstalls: ctx.miseInstalls,
            ...identityPaths(ctx.data),
        };
        let usage = { cost: 0, tokens: 0 };
        let unknown = false;

        out.tries += 1;

        try {
            for (const folder of [paths.work, paths.session, paths.cache]) {
                await privateDir(folder);
            }

            await writeFile(join(paths.work, PROMPT_FILE), prompt, { mode: 0o600 });

            if (
                ctx.authPreflight &&
                (await authType(paths.auth, provider)) === "oauth" &&
                !(await authPreflight(
                    { pocket: ctx.pocket, provider, agentSrc: ctx.agentSrc },
                    { minExpiry: JUDGE_MIN_EXPIRY, spawn: ctx.spawn },
                ))
            ) {
                ctx.log(`judge ${model}, try ${tryNo}: auth pre-flight failed`);
                continue;
            }

            unknown = true;

            const run = await runStreamed({
                bin: ctx.bwrap,
                args: bwrapArgs(paths, { tryNo, command: judgeCommand(model) }),
                eventsFile: join(base, "events.jsonl"),
                logFile: join(base, "stderr.log"),
                wallMs: ctx.wallMs ?? JUDGE_WALL_MS,
                priced: true,
                costLeft: JUDGE_CAP,
                tokensLeft: Number.POSITIVE_INFINITY,
                killGraceMs: ctx.killGraceMs ?? 10_000,
            });

            usage = run.summary.usage;
            unknown = false;

            const answer = parseAnswer(await answerText(join(base, "events.jsonl")));

            if (answer) {
                Object.assign(out, answer, { pending: false });
            } else {
                ctx.log(`judge ${model}, try ${tryNo}: no parsable answer`);
            }
        } finally {
            out.cost = Math.round((out.cost + (unknown ? JUDGE_CAP : usage.cost)) * 1e6) / 1e6;
            await settle(ctx.data, reservation.id, {
                cost: unknown ? JUDGE_CAP : usage.cost,
                tokens: usage.tokens,
                tries: 1,
                unknown,
            });
        }

        if (!out.pending) {
            return out;
        }
    }

    return out;
}
