// The scorer: S0 (protocol), S1 (the repository check), S2 (the hidden tests) and S3 (2 judges) of 1 attempt, added
// to its result file. The submitted tree (`workDir`) is never changed: S1, S2 and the diff run in copies.
// Contract: the plan's section "Scoring". Exit codes: 0 scored (also with a judge pending), 1 usage error, 2 budget
// refused, 3 scoring error (the result is saved with the scores so far and `scoreError`; run again).
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
    BENCH_DIR,
    cleanupTree,
    dataDir,
    privateDir,
    removeTree,
    writeAtomic,
    writeJsonAtomic,
} from "./common.mjs";
import { scratchClone } from "./clone.mjs";
import { failText, makeCache, runInSandbox, stageAll, stageNote } from "./exec.mjs";
import { gitBuffer, overlayFiles } from "./gitfiles.mjs";
import { goModule } from "./hidden.mjs";
import { JUDGES, JUDGE_PROMPT, cutDiff, renderPrompt, runJudge } from "./judge.mjs";
import { UsageError, loadManifest } from "./manifest.mjs";
import { commandLimits } from "./owners.mjs";
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

/** The tool calls of each try's events (text, or null for a missing file), each try parsed on its own. */
export const callsOfTries = (texts) => texts.filter(Boolean).flatMap((text) => toolCalls(text));

/** The event files of an attempt's tries: `try-<n>/events.jsonl` beside the try of `workDir`. */
export function eventFiles(result) {
    const base = dirname(dirname(result.workDir));
    const tries = (result.tryLog ?? []).map((t) => t.try).filter(Number.isInteger);

    return tries.map((n) => join(base, `try-${n}`, "events.jsonl"));
}

/**
 * The cache folders of an attempt: `try-<n>/cache` of every try folder in the attempt's run folder, not only the tries
 * of the result's `tryLog` (`eventFiles`): a runner that a host restart killed leaves try folders that no result
 * names, and the next run of the same attempt continues the try numbers.
 */
export function cacheDirs(result) {
    const base = dirname(dirname(result.workDir));
    const tries = existsSync(base)
        ? readdirSync(base, { withFileTypes: true })
              .filter((e) => e.isDirectory() && /^try-\d+$/.test(e.name))
              .map((e) => e.name)
        : [];

    return tries.map((name) => join(base, name, "cache"));
}

/**
 * Save `cachesDropped: true`, then remove the cache folder of each try of a scored attempt (`--drop-caches`). The save
 * comes first: a crash during the removal leaves the flag, so no later `--force` scores on a cache that is partly
 * gone. A failed save removes nothing and throws. A failed removal is logged with its path (`cleanupTree`) and changes
 * no exit code; a later run with `--drop-caches` tries the removal again. `work/`, `session/`, `events.jsonl` and
 * `stderr.log` stay.
 */
export async function dropCaches(file, result, log) {
    if (result.cachesDropped !== true) {
        await writeJsonAtomic(file, { ...result, cachesDropped: true });
        result.cachesDropped = true;
    }

    for (const dir of cacheDirs(result)) {
        await cleanupTree(dir, log);
    }

    log(`${basename(file, ".json")}: the try caches are dropped`);
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

/** True when a result needs no more scoring (`task`: its manifest task, for a task with no check). */
export function fullyScored(result, task) {
    if (!result.s0 || result.judgePending) {
        return false;
    }

    if (result.failure) {
        return true;
    }

    return (
        s1Done(result, task) &&
        (result.s2 === null || typeof result.s2 === "boolean") &&
        Array.isArray(result.grades) &&
        result.grades.length === 2 &&
        result.grades.every((g) => typeof g === "number")
    );
}

/**
 * S1 is done: null for a task with no check (`check: null`), else a boolean. A boolean S1 of a task that has no check
 * (now) is stale: the check runs again, and gives null.
 */
const s1Done = (result, task) =>
    task?.check === null ? result.s1 === null : typeof result.s1 === "boolean";

/**
 * True when a result needs no more checks-only scoring: S0 is done, and the attempt failed, or S1 (and S2 when the task
 * has one) and the submitted diff are done.
 */
export function checksDone(result, task) {
    if (!result.s0) {
        return false;
    }

    if (result.failure) {
        return true;
    }

    return (
        s1Done(result, task) &&
        (!task?.hiddenCommand || typeof result.s2 === "boolean") &&
        typeof result.diffFile === "string" &&
        result.scoreError === undefined
    );
}

/** Copy a tree (`cp -a --reflink=auto`): the copy has the tree's files, `.git` included. */
async function copyTree(from, to) {
    await removeTree(to);
    await execFileP("cp", ["-a", "--reflink=auto", from, to]);
}

/** Host git in a trusted folder (the local checkout only): `(cwd, args) -> Buffer`. */
export const hostGit = gitBuffer;

/**
 * Git in the sandbox for the submitted diff, as an argv: the bench's own git directory at `/trusted.git` (a disposable
 * clone of the local checkout at the parent), the copy of the submitted tree at `/work`, no system or global config,
 * the attributes of the trusted parent tree (`GIT_ATTR_SOURCE`, git 2.40 or later), no fsmonitor and no hooks. The
 * worker's `.git/config` and its `.gitattributes` choose nothing: no clean filter, no `-diff`, no driver.
 */
const trustedGit = (parent, ...args) => [
    "env",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    `GIT_ATTR_SOURCE=${parent}`,
    "git",
    "--git-dir",
    "/trusted.git",
    "--work-tree",
    "/work",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
];

/** The removal of every `.git` (folder or file) below `/work`, in the sandbox; links are not followed. */
export const NESTED_GIT_REMOVAL = [
    "find",
    "/work",
    "-mindepth",
    "1",
    "-name",
    ".git",
    "-prune",
    "-exec",
    "rm",
    "-rf",
    "--",
    "{}",
    "+",
];

/** The paths of the gitlinks (mode 160000) in `git ls-files -s -z` output. */
export const gitlinkPaths = (text) =>
    String(text)
        .split("\0")
        .filter((entry) => entry.startsWith("160000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));

/** The diff options of the submitted diff: no external diff driver, no textconv, always text, no color. */
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--text", "--no-color"];

/**
 * The submitted diff: `git add -A`, then `git diff --cached <parent>` and its stat, with trusted git metadata
 * (`trustedGit`) over a copy of the tree whose own `.git` is removed first (it is never read). Git runs only inside
 * the sandbox with no credential; the diff and the stat come back on stdout. Host git never runs in a worker's tree.
 */
export async function submittedDiff(ctx, { workDir, parent, checkout, scratch }) {
    const copy = join(scratch, "diff");
    const cache = join(scratch, "diff-cache");
    const trusted = join(scratch, "trusted");

    if (!/^[0-9a-f]{40}$/.test(parent)) {
        throw new Error(`not a commit id: ${parent}`);
    }

    try {
        await copyTree(workDir, copy);
        await removeTree(join(copy, ".git"));
        await removeTree(cache);
        await makeCache(cache);
        await removeTree(trusted);
        await scratchClone({ checkout, work: trusted, parent, merge: null });

        const run = async (argv, step) => {
            const result = await runInSandbox(ctx.sandbox, {
                work: copy,
                cache,
                trustedGit: join(trusted, ".git"),
                argv,
                timeoutMs: ctx.timeouts.check,
                logFile: ctx.logFile,
                step,
            });

            if (!result.ok) {
                throw new Error(`${step} failed (${failText(result)})`);
            }

            return result.stdout;
        };

        // Every `.git` below the root (a nested repository's folder, a submodule's file) goes too, inside the
        // sandbox: else `add -A` stages that folder as a gitlink, and the diff shows a commit id, not the source that
        // S1 and S2 ran.
        await run(NESTED_GIT_REMOVAL, "the removal of nested .git entries");

        // A submodule that the parent tracks is a gitlink (mode 160000) in the trusted index, and `add -A` keeps it
        // a gitlink: it leaves the index (only the index) first, so its folder is staged as ordinary files.
        const gitlinks = gitlinkPaths(
            await run(
                trustedGit(parent, "ls-files", "-s", "-z"),
                "the submitted diff's index list",
            ),
        );

        if (gitlinks.length) {
            await run(
                trustedGit(parent, "update-index", "--force-remove", "--", ...gitlinks),
                "the removal of gitlinks from the index",
            );
        }

        await run(trustedGit(parent, "add", "-A"), "the submitted diff's git add");

        const stat = await run(
            trustedGit(parent, "diff", "--cached", ...DIFF_OPTIONS, "--stat", parent),
            "the submitted diff's stat",
        );
        const diff = await run(
            trustedGit(parent, "diff", "--cached", ...DIFF_OPTIONS, parent),
            "the submitted diff",
        );

        return { diff, stat };
    } finally {
        for (const path of [copy, cache, trusted]) {
            await cleanupTree(path, ctx.log);
        }
    }
}

/** The reference diff: `git diff <parent> <merge>` in the local checkout (trusted), and its stat. */
export async function referenceDiff(checkout, parent, merge, git = hostGit) {
    const options = ["--no-ext-diff", "--no-textconv", "--text"];

    return {
        diff: (await git(checkout, ["diff", ...options, parent, merge])).toString("utf8"),
        stat: (await git(checkout, ["diff", ...options, "--stat", parent, merge])).toString("utf8"),
    };
}

/**
 * Stage the reference's hidden-test files for S2: written on the host from the local checkout (trusted content, with
 * each file's mode from the reference tree: 0755, 0644, or a symbolic link) into a fresh folder. The sandbox binds it
 * read-only at `/overlay` and copies it over its `/work` (`OVERLAY_COPY`, modes kept): the worker's tree may hold
 * symbolic links, and inside the sandbox they reach neither the host nor the submitted tree.
 */
export async function stageOverlay({ checkout, rev, files, staging, git = hostGit }) {
    await removeTree(staging);
    await privateDir(staging);
    // The copy keeps modes, and `/overlay/.` gives its mode to `/work`: a plain folder mode, not 0700.
    await chmod(staging, 0o755);
    await overlayFiles({ checkout, rev, files, work: staging, git });

    return staging;
}

/**
 * The removal, inside the sandbox, of each staged path's destination in `/work` (`rm -rf --`, 1 argument per path).
 * A path must be relative and stay inside `/work`.
 */
export function clearDestinations(files) {
    return [
        "rm",
        "-rf",
        "--",
        ...files.map((file) => {
            const path = posix.normalize(`/work/${file}`);

            if (path === "/work" || !path.startsWith("/work/") || posix.isAbsolute(file)) {
                throw new Error(`hidden file ${file} is outside the tree`);
            }

            return path;
        }),
    ];
}

/** The copy of the staged hidden-test files over `/work`, inside the sandbox, before the hidden command. */
export const OVERLAY_COPY = [
    "cp",
    "-R",
    "--preserve=mode",
    "--remove-destination",
    "/overlay/.",
    "/work/",
];

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

/** True when `path` is a folder (a link to one is not). */
const isFolder = (path) => {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
};

/** Read a file, or null. */
const readOr = (file) => readFile(file, "utf8").catch(() => null);

/** Exit code of a scoring error: the result is saved with the scores so far and `scoreError`; run again. */
export const SCORE_ERROR_EXIT = 3;

/**
 * Score 1 result file. `ctx`: `{ data, sandbox, judgeCtx, force, now, log, timeouts, judges, checkout, git?,
 * submittedDiff? }` and `task`, `manifest`. Returns the exit code: 0 scored, 2 budget refused, 3 a scoring error after
 * S0 (the result keeps every score so far, `judgePending: true` and `scoreError`).
 */
export async function scoreResult(ctx, file, result, { task, manifest }) {
    const attempt = basename(file, ".json");
    const checkout = checkoutOf(ctx.checkout, manifest, task);
    const git = ctx.git ?? hostGit;
    // S1 and S2 are done (S2 when the task has one): only the diff or the judges are left.
    const judgesOnly =
        !ctx.force &&
        result.judgePending === true &&
        Boolean(result.s0) &&
        s1Done(result, task) &&
        (!task.hiddenCommand || typeof result.s2 === "boolean");
    const save = () => writeJsonAtomic(file, result);

    if (!judgesOnly) {
        const events = await Promise.all(eventFiles(result).map(readOr));
        const prNumber = Number(String(task.pr).split("#")[1]) || null;
        const goMod = await git(checkout, ["show", `${task.parent}:go.mod`]).catch(() => null);
        const module = goModule(goMod?.toString("utf8"));

        // Each try's calls on their own: call ids of 2 Pi runs can repeat, and a merge by id would hide a call.
        result.s0 = s0Of(callsOfTries(events), {
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
            delete result.scoreError;
            await save();
            ctx.log(`${attempt}: ${result.failure}: S1 to S3 skipped`);

            return 0;
        }

        // The tree must be there; its own `.git` is not needed (the diff uses trusted git metadata).
        if (!result.workDir || !isFolder(result.workDir)) {
            throw new UsageError(`the submitted tree is missing: ${result.workDir}`);
        }

        result.s1 = null;
        result.s2 = null;
    }

    try {
        // The repository's own limit for S1 and S2 (and their staging and copy steps, and the submitted diff), unless
        // the caller gives explicit ones.
        const limited = { ...ctx, timeouts: commandLimits(ctx.timeouts, task.repo) };

        return await scoreAfterS0(limited, {
            file,
            result,
            task,
            checkout,
            git,
            attempt,
            judgesOnly,
        });
    } catch (error) {
        // The scores so far stay; the judges wait; a later run (judges only, when S1 and S2 are done) goes on.
        result.judgePending = true;
        result.grades ??= [null, null];
        result.scoreError = String(error?.message ?? error).split("\n")[0];
        result.scoredAt = new Date(ctx.now()).toISOString();
        await save();
        ctx.log(`${attempt}: scoring error: ${result.scoreError} (saved; run again)`);

        return SCORE_ERROR_EXIT;
    }
}

/** S1, S2, the diffs and S3 of a result whose S0 is done. Returns the exit code (0 or 2). */
async function scoreAfterS0(ctx, { file, result, task, checkout, git, attempt, judgesOnly }) {
    const paths = diffPaths(ctx.data, result, attempt);
    const save = () => writeJsonAtomic(file, result);
    const makeDiff = ctx.submittedDiff ?? submittedDiff;
    const folder = join(ctx.data, "score", result.stage, result.task);
    let submitted;
    let reference;

    ctx.logFile = join(folder, `${attempt}.score.log`);

    if (!judgesOnly) {
        const scratch = join(folder, attempt);
        const cache = join(dirname(result.workDir), "cache");

        await removeTree(scratch);
        await privateDir(scratch);
        await makeCache(cache);

        try {
            const logFile = ctx.logFile;
            const s1Tree = join(scratch, "s1");

            // A task with no check (`check: null`, the manifest says why in `checkNote`): S1 is not run.
            if (!task.check) {
                result.s1 = null;
                result.s1Detail = `no check: ${task.checkNote ?? "the task has none"}`;
            }

            await copyTree(result.workDir, s1Tree);

            // New files of the worker are untracked: stage them, so a check that lists files with `git ls-files`
            // sees them as a commit holds them. A failure is logged, and the check runs anyway.
            if (task.check) {
                const s1Staged = await stageAll(ctx.sandbox, {
                    work: s1Tree,
                    cache,
                    timeoutMs: ctx.timeouts.check,
                    logFile,
                    step: "S1, the staging of new files",
                });
                const s1 = await runInSandbox(ctx.sandbox, {
                    work: s1Tree,
                    cache,
                    command: task.check,
                    timeoutMs: ctx.timeouts.check,
                    logFile,
                    step: "S1, the check",
                });

                result.s1 = s1.ok;
                result.s1Detail = s1.ok ? "pass" : `${failText(s1)}${stageNote(s1Staged)}`;
            }

            await cleanupTree(s1Tree, ctx.log);

            if (task.hiddenCommand) {
                const s2Tree = join(scratch, "s2");
                const staging = await stageOverlay({
                    checkout,
                    rev: task.merge,
                    files: task.hiddenTests.map((t) => t.file),
                    staging: join(scratch, "overlay"),
                    git,
                });

                await copyTree(result.workDir, s2Tree);

                // The worker's tree may hold a folder (or a file, or a link) where the reference has a file: each staged
                // path's destination goes first, path by path (`cp` cannot put a file over a folder).
                const cleared = await runInSandbox(ctx.sandbox, {
                    work: s2Tree,
                    cache,
                    argv: clearDestinations(task.hiddenTests.map((t) => t.file)),
                    timeoutMs: ctx.timeouts.hidden,
                    logFile,
                    step: "S2, the removal of the hidden tests' destinations",
                });
                const copied = !cleared.ok
                    ? cleared
                    : await runInSandbox(ctx.sandbox, {
                          work: s2Tree,
                          cache,
                          overlay: staging,
                          argv: OVERLAY_COPY,
                          timeoutMs: ctx.timeouts.hidden,
                          logFile,
                          step: "S2, the copy of the hidden tests",
                      });
                // The worker's new files and the hidden tests are staged, as at S1 (a failure is logged only).
                const s2Staged = !copied.ok
                    ? null
                    : await stageAll(ctx.sandbox, {
                          work: s2Tree,
                          cache,
                          timeoutMs: ctx.timeouts.hidden,
                          logFile,
                          step: "S2, the staging of new files",
                      });
                const s2 = !copied.ok
                    ? copied
                    : await runInSandbox(ctx.sandbox, {
                          work: s2Tree,
                          cache,
                          command: task.hiddenCommand,
                          timeoutMs: ctx.timeouts.hidden,
                          logFile,
                          step: "S2, the hidden command",
                      });

                result.s2 = s2.ok;
                result.s2Detail = s2.ok
                    ? "pass"
                    : !cleared.ok
                      ? `the removal of the hidden tests' destinations failed (${failText(cleared)})`
                      : !copied.ok
                        ? `the copy of the hidden tests failed (${failText(copied)})`
                        : `${failText(s2)}${stageNote(s2Staged)}`;
            } else {
                result.s2 = null;
            }

            await save();
            submitted = await makeDiff(ctx, {
                workDir: result.workDir,
                parent: task.parent,
                checkout,
                scratch,
            });
            reference = await referenceDiff(checkout, task.parent, task.merge, git);
            await writeAtomic(paths.submitted, submitted.diff);
            await writeAtomic(paths.submittedStat, submitted.stat);
            await writeAtomic(paths.reference, reference.diff);
            await writeAtomic(paths.referenceStat, reference.stat);
        } finally {
            await cleanupTree(scratch, ctx.log);
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
            const scratch = join(folder, `${attempt}-diff`);

            await removeTree(scratch);
            await privateDir(scratch);

            try {
                submitted = await makeDiff(ctx, {
                    workDir: result.workDir,
                    parent: task.parent,
                    checkout,
                    scratch,
                });
            } finally {
                await cleanupTree(scratch, ctx.log);
            }

            await writeAtomic(paths.submitted, submitted.diff);
            await writeAtomic(paths.submittedStat, submitted.stat);
            result.diffFile = paths.submitted;
        }

        if (reference.diff === null) {
            reference = await referenceDiff(checkout, task.parent, task.merge, git);
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

    // Checks only (the judge calibration's attempts): S0 to S2 and the diffs, and no judge call. The judges stay
    // pending, so a later run without `--checks-only` judges only.
    if (ctx.checksOnly) {
        result.checksOnly = true;
        result.grades = Array.isArray(result.grades) ? result.grades : [null, null];
        result.judges = Array.isArray(result.judges) ? result.judges : [];
        result.judgePending = true;
        result.scoredAt = new Date(ctx.now()).toISOString();
        delete result.scoreError;
        await save();
        ctx.log(
            `${attempt}: s0 ${JSON.stringify(result.s0)}, s1 ${result.s1}, s2 ${result.s2} (checks only: no judge)`,
        );

        return 0;
    }

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
    delete result.scoreError;
    delete result.checksOnly;
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
         [--pocket <dir>] [--agent-src <dir>] [--mise-installs <dir>] [--force] [--checks-only]
         [--no-auth-preflight] [--drop-caches]
--checks-only: S0 to S2 and the diffs, no judge call (the judges stay pending)
--drop-caches: when the result is fully scored (no judge pending, no scoreError) or a failure, remove each try's
               cache/ and set cachesDropped: true; then --force is refused (S1 and S2 need the caches)
exit codes: 0 scored (a judge may be pending), 1 usage error, 2 budget refused,
            3 scoring error (the result is saved with the scores so far and scoreError; run again)`;

const SCORE_OPTIONS = {
    result: { type: "string" },
    manifest: { type: "string" },
    checkout: { type: "string" },
    bwrap: { type: "string" },
    pocket: { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    force: { type: "boolean" },
    "checks-only": { type: "boolean" },
    "no-auth-preflight": { type: "boolean" },
    "drop-caches": { type: "boolean" },
};

/**
 * The scorer's main: returns the exit code. `deps`: `now`, `log`, `judges`, `timeouts`, `killGraceMs`, `judgeWallMs`,
 * `git` (the host git of the local checkout) and `submittedDiff` replace the defaults in tests; `onRun` sees each
 * sandbox run (`runInSandbox`). An explicit `timeouts.check` or `timeouts.hidden` wins over the repository's limit.
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

        if (values["drop-caches"] && values["checks-only"]) {
            throw new UsageError(
                "--drop-caches cannot go with --checks-only: a checks-only result waits for its judges",
            );
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

        // S1 and S2 run in the try's cache (Go modules, npm and pip caches, the Python venv in `/cache/venv`).
        if (values.force && result.cachesDropped === true) {
            throw new UsageError(
                `cannot score ${file} again: S1 and S2 need the try caches (for example the Python venv in /cache/venv), and they were dropped (cachesDropped: true)`,
            );
        }

        const data = dataDir(env);
        const found = await findTask(result.task, { manifest: values.manifest, data });

        if (fullyScored(result, found.task) && !values.force) {
            console.log(`scored already: ${file} (--force scores it again)`);

            // As after a scoring run: a result with `scoreError` keeps its caches (a later run needs them).
            if (values["drop-caches"] && result.scoreError === undefined) {
                await dropCaches(file, result, log);
            }

            return 0;
        }

        if (values["checks-only"] && !values.force && checksDone(result, found.task)) {
            console.log(`checked already: ${file} (--force checks it again)`);

            return 0;
        }

        const bwrap = findProgram(values.bwrap ?? "bwrap", env);

        if (!bwrap) {
            throw new UsageError(`bwrap not found: ${values.bwrap ?? "bwrap"}`);
        }

        const pocket = resolve(values.pocket ?? DEFAULTS.pocket);
        const miseInstalls = resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls);
        const sandbox = {
            bwrap,
            pocket,
            miseInstalls,
            data,
            killGraceMs: deps.killGraceMs,
            onRun: deps.onRun,
        };
        const ctx = {
            data,
            sandbox,
            force: Boolean(values.force),
            checksOnly: Boolean(values["checks-only"]),
            checkout: values.checkout,
            now: deps.now ?? Date.now,
            log,
            judges: deps.judges,
            git: deps.git,
            submittedDiff: deps.submittedDiff,
            // Only explicit limits here: `scoreResult` adds the repository's (`commandLimits`).
            timeouts: { ...deps.timeouts },
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

        const code = await scoreResult(ctx, file, result, found);

        // Only a result that needs nothing more: S1 and S2 of a later run would need the caches.
        if (
            values["drop-caches"] &&
            fullyScored(result, found.task) &&
            result.scoreError === undefined
        ) {
            await dropCaches(file, result, log);
        }

        return code;
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${SCORE_USAGE}`);

            return 1;
        }

        throw error;
    }
}
