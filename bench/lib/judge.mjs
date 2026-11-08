// S3, the judges: 2 models of 2 families grade a submitted diff by the rubric of the frozen `bench/judge-v3.md`,
// through the Pi CLI in the sandbox with no tool. Each try reserves $1 under the budget guard and settles its real
// list cost; the judge cost is never part of an attempt's usage. A missing or unparsable answer gets 2 more tries;
// then the judge is pending (judged again later), never a fail.
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

/**
 * The judge prompt, version 3: the prompt that the development rounds of the judge calibration chose
 * (`bench/judge-calibration.md`). Versions 1 and 2 stay as the record.
 */
export const JUDGE_PROMPT = join(BENCH_DIR, "judge-v3.md");

/**
 * The SHA-256 of the frozen judge prompt (`bench/judge-v3.md`), set at the freeze that followed the development rounds
 * of the judge calibration (`bench/judge-calibration.mjs --set dev`). The held-out set runs only with this prompt. A
 * change to the prompt is a new calibration, never an edit of this value.
 */
export const JUDGE_PROMPT_SHA256 =
    "23c5c31c42ef09ca72dc4365d50779951c86c4339c6639caae2f4203d7872fb9";

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

/** The C-style escapes of a quoted path that git writes, as bytes. */
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A path as git writes it in a `diff --git` line: as it is, or, for a path with special characters, in double quotes
 * with C-style escapes (`\\`, `\"`, `\t`, `\n`, and octal `\NNN` bytes of UTF-8), decoded to its text.
 */
export function unquotePath(token) {
    const value = String(token ?? "");

    if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
        return value;
    }

    const body = value.slice(1, -1);
    const bytes = [];

    for (let i = 0; i < body.length; i += 1) {
        const c = body[i];

        if (c !== "\\") {
            bytes.push(...Buffer.from(c, "utf8"));
            continue;
        }

        const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
        const next = body[i + 1] ?? "";

        if (octal) {
            bytes.push(parseInt(octal, 8) & 0xff);
            i += octal.length;
        } else if (Object.hasOwn(ESCAPES, next)) {
            bytes.push(ESCAPES[next]);
            i += 1;
        } else {
            bytes.push(92);
        }
    }

    return Buffer.from(bytes).toString("utf8");
}

/** A `diff --git` line: 2 path tokens, each a C-style quoted string or plain text. */
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const GIT_HEADER = new RegExp(`^diff --git (${QUOTED}|a/.+?) (${QUOTED}|b/.+)$`);

/**
 * The path of a file section of a diff: the `b/` path of its `diff --git` line, quoted or not, decoded (the rest of
 * the line when none parses). The section's text is not changed.
 */
export function sectionPath(section) {
    const end = section.indexOf("\n");
    const line = end < 0 ? section : section.slice(0, end);
    const match = GIT_HEADER.exec(line);

    if (!match) {
        return line.slice("diff --git ".length);
    }

    const path = unquotePath(match[2]);

    return path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * A diff with its test files last: the text before the first `diff --git ` line stays first, then the non-test file
 * sections, then the test file sections, each group in its original order. Git sorts files by path, so test files
 * (`desk-x.test.ts` before `desk.ts`) can fill a cut and hide the code they test. It keeps each section's text; it
 * can add 1 newline between sections (after a section with no final newline that is no longer last).
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
export const cutNote = (cut, what) =>
    cut
        ? `The ${what} diff is longer than ${DIFF_LIMIT} characters: below are its stat and its first ${DIFF_LIMIT} characters.`
        : `The ${what} diff is complete.`;

/** An S1 or S2 result in words. */
export const checkWords = (value, none) =>
    value === true ? "passed" : value === false ? "failed" : none;

/**
 * The judge's input: the template with the brief, S1, S2, the 2 diffs and their cut notes. No model name goes in.
 * `submitted` and `reference` are `{ text, cut }` from `cutDiff`.
 */
export function renderPrompt(template, { brief, s1, s2, submitted, reference }) {
    const values = {
        BRIEF: String(brief ?? "").trim(),
        S1: checkWords(s1, "not run"),
        S2: checkWords(s2, "none: this task has no hidden test"),
        SUBMITTED_NOTE: cutNote(submitted.cut, "submitted"),
        SUBMITTED_DIFF: submitted.text.trim() === "" ? "(no change)" : submitted.text,
        REFERENCE_NOTE: cutNote(reference.cut, "merged"),
        REFERENCE_DIFF: reference.text,
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
 * agentSrc, miseInstalls, authPreflight, killGraceMs, wallMs, spawn? }` (`spawn` replaces the pre-flight's in tests). `dir`: the judge's folder in the data dir.
 * Returns `{ model, grade, reasons, tries, cost, pending, refused }`; `refused` when the budget guard refused a try.
 */
export async function runJudge(ctx, { model, prompt, dir, task, stage }) {
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
