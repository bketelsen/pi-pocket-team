// The scorer: S0 (protocol), S1 (the repository check), S2 (the hidden tests) and S3 (2 judges) of 1 attempt, added
// to its result file. The submitted tree (`workDir`) is never changed: S1, S2 and the diff run in copies.
// Contract: the plan's section "Scoring". Exit codes: 0 scored (also with a judge pending), 1 usage error, 2 budget
// refused.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { BENCH_DIR, dataDir, privateDir, writeAtomic, writeJsonAtomic } from "./common.mjs";
import { COMMAND_MS, failText, makeCache, runInSandbox } from "./exec.mjs";
import { fileAt, gitText, overlayFiles } from "./gitfiles.mjs";
import { goModule } from "./hidden.mjs";
import { JUDGES, JUDGE_PROMPT, cutDiff, renderPrompt, runJudge } from "./judge.mjs";
import { UsageError, loadManifest } from "./manifest.mjs";
import { checkoutOf } from "./runner.mjs";
import { DEFAULTS, findProgram } from "./sandbox.mjs";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------------------------------------------
// S0, protocol
// ---------------------------------------------------------------------------------------------------------------

/**
 * The tool calls of a Pi JSON event stream: each `tool_execution_start` (`toolName`, `args`) and each `toolCall`
 * block of an ended assistant message (`name`, `arguments`), once per call id.
 */
export function toolCalls(text) {
    const calls = new Map();
    let anonymous = 0;

    const add = (id, tool, args) => {
        const key = id ?? `#${(anonymous += 1)}`;

        if (!calls.has(key)) {
            calls.set(key, { tool: String(tool ?? ""), args: args ?? {} });
        }
    };

    for (const line of String(text).split("\n")) {
        let event;

        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (event?.type === "tool_execution_start") {
            add(event.toolCallId, event.toolName, event.args);
        } else if (event?.type === "message_end" && event.message?.role === "assistant") {
            for (const part of Array.isArray(event.message.content) ? event.message.content : []) {
                if (part?.type === "toolCall") {
                    add(part.id, part.name, part.arguments);
                }
            }
        }
    }

    return [...calls.values()];
}

/** The credential file in the sandbox. */
const AUTH = "/agent/auth.json";

/** A command that names the credential file (by path, or by the agent dir's variable). */
const namesAuth = (command) =>
    command.includes(AUTH) || /\$\{?PI_CODING_AGENT_DIR\}?\/+auth\.json/.test(command);

/**
 * S0 of a list of tool calls: `protocol` when a `bash` command or a `read` path names `/agent/auth.json`; `leakTry`
 * when a `bash` command names the task's PR number with `pull`, the repository's GitHub URL, or the Go module path of
 * the repository with `@` (the sandbox blocks GitHub; the flag is for the report).
 */
export function s0Of(calls, { prNumber, repo, module = null }) {
    let protocol = false;
    let leakTry = false;
    const number = prNumber ? new RegExp(`(?:^|[^0-9])${prNumber}(?:[^0-9]|$)`) : null;
    const url = new RegExp(
        `github\\.com[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.-])`,
        "i",
    );

    for (const { tool, args } of calls) {
        if (tool === "read") {
            const path = String(args?.path ?? args?.file_path ?? "");

            if (path.includes(AUTH) || posix.resolve("/work", path) === AUTH) {
                protocol = true;
            }
        }

        if (tool === "bash") {
            const command = String(args?.command ?? "");

            if (namesAuth(command)) {
                protocol = true;
            }

            if (
                (number && /pull/i.test(command) && number.test(command)) ||
                url.test(command) ||
                (module && command.includes(`${module}@`))
            ) {
                leakTry = true;
            }
        }
    }

    return { protocol, leakTry };
}

/** The event files of an attempt's tries: `try-<n>/events.jsonl` beside the try of `workDir`. */
export function eventFiles(result) {
    const base = dirname(dirname(result.workDir));
    const tries = (result.tryLog ?? []).map((t) => t.try).filter(Number.isInteger);

    return tries.map((n) => join(base, `try-${n}`, "events.jsonl"));
}

// ---------------------------------------------------------------------------------------------------------------
// Finding the task
// ---------------------------------------------------------------------------------------------------------------

/** Every `*.json` under a folder. */
function jsonFiles(dir) {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir, { recursive: true })
        .map((name) => join(dir, String(name)))
        .filter((file) => file.endsWith(".json") && statSync(file).isFile())
        .sort();
}

/**
 * The manifest and task of a result: `--manifest` when given, else the 1 manifest among `bench/pilot.json` and
 * `<data>/manifests/**` that holds the task id. 0 or 2 or more matches is a usage error.
 */
export async function findTask(taskId, { manifest, data }) {
    const files = manifest
        ? [resolve(manifest)]
        : [join(BENCH_DIR, "pilot.json"), ...jsonFiles(join(data, "manifests"))];
    const matches = [];

    for (const file of files) {
        let loaded;

        try {
            loaded = await loadManifest(file);
        } catch (error) {
            if (manifest) {
                throw error;
            }

            continue;
        }

        const task = loaded.tasks.find((t) => t.id === taskId);

        if (task) {
            matches.push({ file, manifest: loaded, task });
        }
    }

    if (matches.length !== 1) {
        throw new UsageError(
            matches.length === 0
                ? `task ${taskId} is in no manifest (${files.length} read)`
                : `task ${taskId} is in ${matches.length} manifests: ${matches.map((m) => m.file).join(", ")}; give --manifest`,
        );
    }

    return matches[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------------------

/** True when a result needs no more scoring. */
export function fullyScored(result) {
    if (!result.s0 || result.judgePending) {
        return false;
    }

    if (result.failure) {
        return true;
    }

    return (
        typeof result.s1 === "boolean" &&
        (result.s2 === null || typeof result.s2 === "boolean") &&
        Array.isArray(result.grades) &&
        result.grades.length === 2 &&
        result.grades.every((g) => typeof g === "number")
    );
}

/** Copy a tree (`cp -a --reflink=auto`): the copy has the tree's files, `.git` included. */
async function copyTree(from, to) {
    await rm(to, { recursive: true, force: true });
    await execFileP("cp", ["-a", "--reflink=auto", from, to]);
}

/** The submitted diff: in a copy of the tree, `git add -A`, then `git diff --cached <parent>` and its stat. */
export async function submittedDiff(workDir, parent, scratch) {
    const copy = join(scratch, "diff");

    await copyTree(workDir, copy);

    try {
        await gitText(copy, ["add", "-A"]);

        return {
            diff: await gitText(copy, ["diff", "--cached", parent]),
            stat: await gitText(copy, ["diff", "--cached", "--stat", parent]),
        };
    } finally {
        await rm(copy, { recursive: true, force: true });
    }
}

/** The reference diff: `git diff <parent> <merge>` in the local checkout, and its stat. */
export async function referenceDiff(checkout, parent, merge) {
    return {
        diff: await gitText(checkout, ["diff", parent, merge]),
        stat: await gitText(checkout, ["diff", "--stat", parent, merge]),
    };
}

/** The diff files of an attempt in the data dir. */
const diffPaths = (data, result, attempt) => {
    const dir = join(data, "diffs", result.stage, result.task);

    return {
        submitted: join(dir, `${attempt}.diff`),
        submittedStat: join(dir, `${attempt}.stat`),
        reference: join(dir, "reference.diff"),
        referenceStat: join(dir, "reference.stat"),
    };
};

/** Read a file, or null. */
const readOr = (file) => readFile(file, "utf8").catch(() => null);

/**
 * Score 1 result file. `ctx`: `{ data, bwrap, pocket, agentSrc, miseInstalls, authPreflight, force, now, log,
 * timeouts, judges, checkout }` and `task`, `manifest`. Returns the exit code.
 */
export async function scoreResult(ctx, file, result, { task, manifest }) {
    const attempt = basename(file, ".json");
    const paths = diffPaths(ctx.data, result, attempt);
    const checkout = checkoutOf(ctx.checkout, manifest, task);
    const judgesOnly =
        !ctx.force && result.judgePending === true && result.s0 && typeof result.s1 === "boolean";
    const save = () => writeJsonAtomic(file, result);
    let submitted;
    let reference;

    if (!judgesOnly) {
        const events = await Promise.all(eventFiles(result).map(readOr));
        const prNumber = Number(String(task.pr).split("#")[1]) || null;
        const module = goModule(await fileAt(checkout, task.parent, "go.mod"));

        result.s0 = s0Of(toolCalls(events.filter(Boolean).join("\n")), {
            prNumber,
            repo: task.repo,
            module,
        });

        if (result.s0.protocol && !result.failure) {
            result.failure = "protocol";
        }

        if (result.failure) {
            Object.assign(result, {
                s1: null,
                s2: null,
                grades: null,
                diffCut: null,
                judgePending: false,
                scoredAt: new Date(ctx.now()).toISOString(),
            });
            await save();
            ctx.log(`${attempt}: ${result.failure}: S1 to S3 skipped`);

            return 0;
        }

        if (!result.workDir || !existsSync(join(result.workDir, ".git"))) {
            throw new UsageError(`the submitted tree is missing: ${result.workDir}`);
        }

        const scratch = join(ctx.data, "score", result.stage, result.task, attempt);
        const cache = join(dirname(result.workDir), "cache");

        await rm(scratch, { recursive: true, force: true });
        await privateDir(scratch);
        await makeCache(cache);

        try {
            const logFile = join(scratch, "..", `${attempt}.score.log`);
            const s1Tree = join(scratch, "s1");

            await copyTree(result.workDir, s1Tree);

            const s1 = await runInSandbox(ctx.sandbox, {
                work: s1Tree,
                cache,
                command: task.check,
                timeoutMs: ctx.timeouts.check,
                logFile,
                step: "S1, the check",
            });

            result.s1 = s1.ok;
            result.s1Detail = s1.ok ? "pass" : failText(s1);
            await rm(s1Tree, { recursive: true, force: true });

            if (task.hiddenCommand) {
                const s2Tree = join(scratch, "s2");

                await copyTree(result.workDir, s2Tree);
                await overlayFiles({
                    checkout,
                    rev: task.merge,
                    files: task.hiddenTests.map((t) => t.file),
                    work: s2Tree,
                });

                const s2 = await runInSandbox(ctx.sandbox, {
                    work: s2Tree,
                    cache,
                    command: task.hiddenCommand,
                    timeoutMs: ctx.timeouts.hidden,
                    logFile,
                    step: "S2, the hidden command",
                });

                result.s2 = s2.ok;
                result.s2Detail = s2.ok ? "pass" : failText(s2);
            } else {
                result.s2 = null;
            }

            const own = await submittedDiff(result.workDir, task.parent, scratch);

            submitted = own;
            reference = await referenceDiff(checkout, task.parent, task.merge);
            await writeAtomic(paths.submitted, own.diff);
            await writeAtomic(paths.submittedStat, own.stat);
            await writeAtomic(paths.reference, reference.diff);
            await writeAtomic(paths.referenceStat, reference.stat);
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }

        result.diffFile = paths.submitted;
        result.grades = [null, null];
        result.judges = [];
        result.judgePending = true;
        await save();
    } else {
        const read = async (diff, stat) => ({ diff: await readOr(diff), stat: await readOr(stat) });

        submitted = await read(paths.submitted, paths.submittedStat);
        reference = await read(paths.reference, paths.referenceStat);

        if (submitted.diff === null) {
            submitted = await submittedDiff(
                result.workDir,
                task.parent,
                join(ctx.data, "score", "diff-" + attempt),
            );
            await writeAtomic(paths.submitted, submitted.diff);
            await writeAtomic(paths.submittedStat, submitted.stat);
        }

        if (reference.diff === null) {
            reference = await referenceDiff(checkout, task.parent, task.merge);
            await writeAtomic(paths.reference, reference.diff);
            await writeAtomic(paths.referenceStat, reference.stat);
        }
    }

    const own = cutDiff(submitted.diff, submitted.stat);
    const ref = cutDiff(reference.diff, reference.stat);
    const prompt = renderPrompt(await readFile(ctx.judgePrompt ?? JUDGE_PROMPT, "utf8"), {
        brief: task.brief,
        s1: result.s1,
        s2: result.s2,
        submitted: own,
        reference: ref,
    });

    result.diffCut = own.cut;
    result.referenceCut = ref.cut;

    const judges = ctx.judges ?? JUDGES;
    const grades = Array.isArray(result.grades) ? [...result.grades] : [null, null];
    const entries = Array.isArray(result.judges) ? [...result.judges] : [];
    let refused = false;

    for (const [i, model] of judges.entries()) {
        const before = entries[i] ?? null;

        if (typeof grades[i] === "number" && !ctx.force) {
            continue;
        }

        if (refused) {
            entries[i] = {
                ...(before ?? { model, tries: 0, cost: 0 }),
                model,
                grade: null,
                pending: true,
            };
            grades[i] = null;
            continue;
        }

        const verdict = await runJudge(ctx.judgeCtx, {
            model,
            prompt,
            dir: join(
                ctx.data,
                "judges",
                result.stage,
                result.task,
                attempt,
                model.replaceAll("/", "__"),
            ),
            task: result.task,
            stage: result.stage,
        });

        refused = verdict.refused;
        grades[i] = verdict.grade;
        entries[i] = {
            model,
            grade: verdict.grade,
            reasons: verdict.reasons,
            tries: (judgesOnly ? (before?.tries ?? 0) : 0) + verdict.tries,
            cost: Math.round(((judgesOnly ? (before?.cost ?? 0) : 0) + verdict.cost) * 1e6) / 1e6,
            pending: verdict.pending,
        };
        ctx.log(
            `${attempt}: judge ${model}: ${verdict.pending ? (refused ? "budget refused" : "pending") : `grade ${verdict.grade}`}`,
        );
    }

    result.grades = grades;
    result.judges = entries;
    result.judgePending = grades.some((g) => typeof g !== "number");
    result.scoredAt = new Date(ctx.now()).toISOString();
    await save();
    ctx.log(
        `${attempt}: s0 ${JSON.stringify(result.s0)}, s1 ${result.s1}, s2 ${result.s2}, grades ${JSON.stringify(grades)}${result.judgePending ? " (judge pending)" : ""}`,
    );

    return refused ? 2 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------

export const SCORE_USAGE = `usage: node bench/score.mjs --result <file> [--manifest <file>] [--checkout <dir>] [--bwrap <path>]
         [--pocket <dir>] [--agent-src <dir>] [--mise-installs <dir>] [--force] [--no-auth-preflight]`;

const SCORE_OPTIONS = {
    result: { type: "string" },
    manifest: { type: "string" },
    checkout: { type: "string" },
    bwrap: { type: "string" },
    pocket: { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    force: { type: "boolean" },
    "no-auth-preflight": { type: "boolean" },
};

/**
 * The scorer's main: returns the exit code. `deps`: `now`, `log`, `judges`, `timeouts`, `killGraceMs` and `judgeWallMs`
 * replace the defaults in tests.
 */
export async function scoreMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));

    try {
        let values;

        try {
            ({ values } = parseArgs({
                args: argv,
                options: SCORE_OPTIONS,
                allowPositionals: false,
            }));
        } catch (error) {
            throw new UsageError(error.message);
        }

        if (!values.result) {
            throw new UsageError("--result is required");
        }

        const file = resolve(values.result);
        let result;

        try {
            result = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            throw new UsageError(`cannot read result ${file}: ${error.message}`);
        }

        if (result.harness) {
            console.log(`harness failure: nothing to score: ${file}`);

            return 0;
        }

        if (fullyScored(result) && !values.force) {
            console.log(`scored already: ${file} (--force scores it again)`);

            return 0;
        }

        const data = dataDir(env);
        const found = await findTask(result.task, { manifest: values.manifest, data });
        const bwrap = findProgram(values.bwrap ?? "bwrap", env);

        if (!bwrap) {
            throw new UsageError(`bwrap not found: ${values.bwrap ?? "bwrap"}`);
        }

        const pocket = resolve(values.pocket ?? DEFAULTS.pocket);
        const miseInstalls = resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls);
        const sandbox = { bwrap, pocket, miseInstalls, data, killGraceMs: deps.killGraceMs };
        const ctx = {
            data,
            sandbox,
            force: Boolean(values.force),
            checkout: values.checkout,
            now: deps.now ?? Date.now,
            log,
            judges: deps.judges,
            timeouts: { check: COMMAND_MS, hidden: COMMAND_MS, ...deps.timeouts },
            judgeCtx: {
                data,
                bwrap,
                pocket,
                miseInstalls,
                agentSrc: resolve(values["agent-src"] ?? DEFAULTS.agentSrc),
                authPreflight: !values["no-auth-preflight"],
                killGraceMs: deps.killGraceMs,
                wallMs: deps.judgeWallMs,
                log,
            },
        };

        return await scoreResult(ctx, file, result, found);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${SCORE_USAGE}`);

            return 1;
        }

        throw error;
    }
}
