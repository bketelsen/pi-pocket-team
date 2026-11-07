// The harvester: desk threads with exactly 1 merged PR in a bench repository become candidate tasks, validated in
// the sandbox, and written as 1 candidate manifest per repository (schema v1 tasks, `loadManifest` reads them).
// Contract: the plan's sections "Bench" (Harvest, Manifest task) and "Scoring" (S2, hidden tests).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { features, sshHostNames } from "../../model-router.ts";
import {
    cleanupTree,
    dataDir,
    privateDir,
    readJson,
    removeTree,
    writeJsonAtomic,
} from "./common.mjs";
import { scratchClone } from "./clone.mjs";
import { COMMAND_MS, failText, makeCache, runInSandbox } from "./exec.mjs";
import {
    fileAt,
    gitBuffer,
    hasCommit,
    nameStatus,
    overlayFiles,
    revParse,
    topNames,
} from "./gitfiles.mjs";
import {
    JUNIT,
    classify,
    discoveryCommand,
    dropSharedNames,
    goFileOutcome,
    goModule,
    goTestNames,
    hiddenCommand,
    hiddenFiles,
    nodeOutcome,
    parseNameStatus,
    proposeCommands,
    pytestOutcome,
    reporterCommands,
    testLanguage,
} from "./hidden.mjs";
import { TASK_FIELDS, UsageError, loadManifest } from "./manifest.mjs";
import { BENCH_REPOS, SEED, benchRepo, readRoster, rosterDir, seededShuffle } from "./owners.mjs";
import { pocketDb, readThreads, routeJudgments } from "./pocket.mjs";
import { checkoutOf } from "./runner.mjs";
import { DEFAULTS, findProgram } from "./sandbox.mjs";

const execFileP = promisify(execFile);

/** Valid tasks per size stratum (3 strata: at most 60 per repository). */
export const PER_STRATUM = 20;

/** The size strata, by lines changed (additions + deletions). */
export const STRATA = ["small", "medium", "large"];

/** The stratum of a size: up to 50, 51 to 300, over 300. */
export const stratumOf = (size) => (size <= 50 ? "small" : size <= 300 ? "medium" : "large");

/**
 * The version of the validation: a cached validation of another version runs again. Version 2: the overlay keeps
 * each file's mode from the reference tree.
 */
export const VALIDATION_VERSION = 2;

/** The cache key of a candidate's validation. */
export const validationKey = ({ merge, parent, commands, brief, route }) =>
    sha(JSON.stringify([VALIDATION_VERSION, merge, parent, commands, brief, route]));

/** True when a cached outcome is an unexpected error: it is never reused (earlier versions cached such errors). */
const isValidationError = (outcome) =>
    String(outcome?.reason ?? "").startsWith("validation error:");

/** The `gh pr view` fields the harvester reads. */
export const PR_FIELDS = "mergeCommit,mergedAt,files,additions,deletions,state,headRefOid";

/** 1 day in milliseconds. */
const DAY = 86_400_000;

/** `owner/name#n` as `{ repo, number }`, or null. */
export function parseRef(ref) {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(String(ref));

    return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/** A date option as a time: `YYYY-MM-DD` is the start of that UTC day; `end` gives the start of the next day. */
export function dateOption(text, { end = false } = {}) {
    if (text === undefined || text === null) {
        return null;
    }

    const day = /^\d{4}-\d{2}-\d{2}$/.test(text);
    const ms = Date.parse(day ? `${text}T00:00:00Z` : text);

    if (!Number.isFinite(ms)) {
        throw new UsageError(`not a date: ${text}`);
    }

    return day && end ? ms + DAY : ms;
}

/** The default `gh`: read-only `gh pr view` calls, stdout as text. */
export async function realGh(args) {
    const { stdout } = await execFileP("gh", args, { maxBuffer: 256 * 1024 * 1024 });

    return stdout;
}

/**
 * The candidates of the desk threads, per bench repository, and the dropped threads. A candidate: exactly 1 PR, in a
 * bench repository (and in `repos` when given), named by no other thread, and a brief. A thread with 2 or more PRs is
 * dropped for each bench PR it names.
 */
export function selectCandidates(threads, { repos = null } = {}) {
    const wanted = (repo) => {
        const entry = benchRepo(repo);

        return entry && (!repos || repos.has(entry.repo)) ? entry.repo : null;
    };

    const claims = new Map();

    for (const thread of threads) {
        for (const ref of new Set(thread.prs.map((r) => r.toLowerCase()))) {
            claims.set(ref, (claims.get(ref) ?? 0) + 1);
        }
    }

    const byRepo = new Map();
    const dropped = new Map();
    const drop = (repo, thread, pr, reason) =>
        dropped.set(repo, [...(dropped.get(repo) ?? []), { thread: thread.id, pr, reason }]);

    for (const thread of threads) {
        if (thread.prs.length > 1) {
            for (const pr of thread.prs) {
                const repo = wanted(parseRef(pr)?.repo);

                if (repo) {
                    drop(repo, thread, pr, `the thread has ${thread.prs.length} PRs`);
                }
            }

            continue;
        }

        if (thread.prs.length !== 1) {
            continue;
        }

        const [pr] = thread.prs;
        const parsed = parseRef(pr);
        const repo = parsed && wanted(parsed.repo);

        if (!repo) {
            continue;
        }

        const count = claims.get(pr.toLowerCase());

        if (count > 1) {
            drop(repo, thread, pr, `the PR is named by ${count} threads`);
        } else if (!thread.brief) {
            drop(repo, thread, pr, "the thread has no brief");
        } else {
            byRepo.set(repo, [
                ...(byRepo.get(repo) ?? []),
                { thread, pr: `${repo}#${parsed.number}`, number: parsed.number, repo },
            ]);
        }
    }

    return { byRepo, dropped };
}

/** The candidates of 1 stratum in validation order: night shifts first, then other delegations, each shuffled. */
export function stratumOrder(list, seed = SEED) {
    const byThread = (a, b) => a.thread.id.localeCompare(b.thread.id, "en", { numeric: true });
    const night = list.filter((c) => c.thread.nightShift).sort(byThread);
    const other = list.filter((c) => !c.thread.nightShift).sort(byThread);

    return [...seededShuffle(night, seed), ...seededShuffle(other, seed)];
}

/** Run `fn` on each item, `limit` at a time; the results keep the items' order. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const index = next;

            next += 1;
            results[index] = await fn(items[index], index);
        }
    });

    await Promise.all(workers);

    return results;
}

/** The cache folder of a repository's candidates in the data dir. */
const cacheDir = (data, repo) => join(data, "harvest-cache", ...repo.split("/"));

/** The facts of a PR from `gh pr view` (cached once merged: they no longer change). */
export async function prFacts(ctx, repo, number) {
    const file = join(cacheDir(ctx.data, repo), `${number}.gh.json`);
    const cached = await readJson(file, null);

    if (cached) {
        return cached;
    }

    const raw = JSON.parse(
        await ctx.gh(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]),
    );
    const facts = {
        state: raw.state ?? null,
        mergedAt: raw.mergedAt ?? null,
        merge: raw.mergeCommit?.oid ?? null,
        additions: Number(raw.additions) || 0,
        deletions: Number(raw.deletions) || 0,
        headRefOid: raw.headRefOid ?? null,
        files: (raw.files ?? []).map((f) => ({ path: f.path, changeType: f.changeType ?? null })),
    };

    if (facts.state === "MERGED") {
        await writeJsonAtomic(file, facts);
    }

    return facts;
}

/** The SHA-256 of a text, in hex. */
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The commands of a task at its merge commit, read from the checkout. */
export async function commandsAt(checkout, merge) {
    const files = await topNames(checkout, merge);

    return proposeCommands({
        files,
        makefile: files.includes("Makefile") ? await fileAt(checkout, merge, "Makefile") : null,
        packageJson: files.includes("package.json")
            ? await fileAt(checkout, merge, "package.json")
            : null,
    });
}

/** Run a discovery command and return its output (the junit file for pytest). */
async function discover(ctx, { work, cache, command, language, logFile }) {
    if (language === "python") {
        await rm(join(cache, "hidden-junit.xml"), { force: true });
    }

    const run = await runInSandbox(ctx.sandbox, {
        work,
        cache,
        command,
        timeoutMs: ctx.timeouts.hidden,
        logFile,
    });

    if (language === "python") {
        return readFile(join(cache, JUNIT.replace(/^\/cache\//, "")), "utf8").catch(() => "");
    }

    return run.stdout;
}

/**
 * The outcome of 1 language's hidden tests in a tree: its discovery command (with the machine-readable reporter)
 * run in the sandbox, then parsed per file (`{ units, broken }`). Null when the language has no discovery command.
 */
export async function languageOutcome(
    ctx,
    { language, files, goNames, module, prefix, tree, logFile },
) {
    const command = discoveryCommand(language, files, { prefix, goNames });

    if (!command || (language === "go" && !module)) {
        return null;
    }

    const text = await discover(ctx, { ...tree, command, language, logFile });

    if (language === "node") {
        return nodeOutcome(text, files);
    }

    if (language === "go") {
        return goFileOutcome(text, { files, goNames, module });
    }

    return pytestOutcome(text, files);
}

/**
 * Find the hidden tests of a task: the PR's test and support files copied from the merge over the parent tree (it
 * holds them afterwards), each language's tests run at both, then the valid names. Returns `{ hiddenTests,
 * hiddenCommand, dropped, languages }`; with no valid name, `hiddenTests: []` and `hiddenCommand: null`.
 */
export async function findHidden(
    ctx,
    { checkout, parent, merge, mergeTree, parentTree, prefix, logFile },
) {
    const changed = parseNameStatus(await nameStatus(checkout, parent, merge));
    const { tests, support } = hiddenFiles(changed);
    const none = { hiddenTests: [], hiddenCommand: null, dropped: [], languages: [] };

    if (tests.length === 0) {
        return none;
    }

    await overlayFiles({
        checkout,
        rev: merge,
        files: [...tests.map((t) => t.file), ...support],
        work: parentTree.work,
    });

    const languages = [...new Set(tests.map((t) => t.language))].sort();
    const valid = [];
    const dropped = [];
    const goModPath = goModule(await fileAt(checkout, merge, "go.mod"));

    for (const language of languages) {
        const files = tests.filter((t) => t.language === language).map((t) => t.file);
        const goNames = {};

        if (language === "go") {
            for (const file of files) {
                goNames[file] = goTestNames(await fileAt(checkout, merge, file));
            }
        }

        const facts = { language, files, goNames, module: goModPath, prefix, logFile };
        const atMerge = await languageOutcome(ctx, { ...facts, tree: mergeTree });

        if (!atMerge) {
            continue;
        }

        const atParent = await languageOutcome(ctx, { ...facts, tree: parentTree });
        const result = classify({ files, parent: atParent, merge: atMerge });

        if (language === "node") {
            dropSharedNames(result.valid, result.dropped);
        }

        dropped.push(...result.dropped);

        for (const [file, names] of result.valid) {
            valid.push({ file, language, names });
        }
    }

    if (valid.length === 0) {
        return { ...none, dropped, languages };
    }

    const dirOf = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
    const validDirs = new Set(valid.map((v) => dirOf(v.file)));
    const validFiles = new Map(valid.map((v) => [v.file, v.names]));
    // A test file of a folder with a valid name goes with it (it may hold helpers); support files always do.
    const hiddenTests = [
        ...tests
            .filter((t) => validFiles.has(t.file) || validDirs.has(dirOf(t.file)))
            .map((t) => ({ file: t.file, names: validFiles.get(t.file) ?? [] })),
        ...support.map((file) => ({ file, names: [] })),
    ].sort((a, b) => a.file.localeCompare(b.file));

    return { hiddenTests, hiddenCommand: hiddenCommand(valid, { prefix }), dropped, languages };
}

/** The step names of the validation, as the log's header lines name them. */
const STEP_NAMES = {
    setupMerge: "setup at the merge",
    checkMerge: "check at the merge",
    setupParent: "setup at the parent",
    hiddenMerge: "hidden command at the merge",
    hiddenParent: "hidden command at the parent",
};

/** The scratch trees of 1 validation: `{ work, cache }` at the merge and at the parent. */
const treesOf = (base) => ({
    merge: { work: join(base, "merge", "work"), cache: join(base, "merge", "cache") },
    parent: { work: join(base, "parent", "work"), cache: join(base, "parent", "cache") },
});

/**
 * Validate 1 candidate in the sandbox: a clone at the merge (setup, then the check, which must pass), a clone at the
 * parent (setup, the features, the hidden tests), and the hidden command (it must pass at the merge and fail at the
 * parent). Returns `{ ok, reason, fields, validation }`; `fields` are the task fields the validation found. The
 * result is cached in the data dir by the merge commit, the commands and the brief.
 */
export async function validateCandidate(ctx, candidate) {
    const { repo, number, thread, checkout, merge, parent } = candidate;
    const commands = await commandsAt(checkout, merge);
    const key = validationKey({
        merge,
        parent,
        commands,
        brief: thread.brief,
        route: thread.route,
    });
    const cacheFile = join(cacheDir(ctx.data, repo), `${number}.json`);
    const cached = await readJson(cacheFile, null);

    if (cached?.key === key && !isValidationError(cached.outcome)) {
        return { ...cached.outcome, cached: true };
    }

    const base = join(ctx.data, "harvest-work", ...repo.split("/"), String(number));
    const logFile = join(cacheDir(ctx.data, repo), `${number}.log`);
    const trees = treesOf(base);
    const validation = { at: new Date(ctx.now()).toISOString(), commands };
    const outcome = (ok, reason, fields = null) => ({ ok, reason, fields, validation });
    let result;

    await removeTree(base);
    await privateDir(cacheDir(ctx.data, repo));
    await rm(logFile, { force: true });

    try {
        result = await (async () => {
            if (commands.check === null) {
                return outcome(false, "no check command fits the repository");
            }

            const step = async (name, tree, command) => {
                const run = await runInSandbox(ctx.sandbox, {
                    ...tree,
                    command,
                    timeoutMs: ctx.timeouts[name.startsWith("setup") ? "setup" : "check"],
                    logFile,
                    step: STEP_NAMES[name],
                });

                validation[name] = run.ok ? "pass" : failText(run);

                return run.ok;
            };

            await privateDir(join(base, "merge"));
            await scratchClone({ checkout, work: trees.merge.work, parent: merge, merge: null });
            await makeCache(trees.merge.cache);

            if (!(await step("setupMerge", trees.merge, commands.setup))) {
                return outcome(false, `setup failed at the merge (${validation.setupMerge})`);
            }

            if (!(await step("checkMerge", trees.merge, commands.check))) {
                return outcome(false, `check failed at the merge (${validation.checkMerge})`);
            }

            await privateDir(join(base, "parent"));
            await scratchClone({ checkout, work: trees.parent.work, parent, merge });
            await makeCache(trees.parent.cache);

            const analysis = thread.nightShift ? routeJudgments(thread.route) : undefined;
            const facts = features(thread.brief, [trees.parent.work], analysis, {
                roster: ctx.rosterNames,
                hostNames: ctx.hostNames,
            });

            if (!(await step("setupParent", trees.parent, commands.setup))) {
                return outcome(false, `setup failed at the parent (${validation.setupParent})`);
            }

            const hidden = await findHidden(ctx, {
                checkout,
                parent,
                merge,
                mergeTree: trees.merge,
                parentTree: trees.parent,
                prefix: commands.prefix,
                logFile,
            });

            validation.hiddenDropped = hidden.dropped;
            validation.hiddenLanguages = hidden.languages;

            let { hiddenTests, hiddenCommand: command } = hidden;

            if (command) {
                const atMerge = await runInSandbox(ctx.sandbox, {
                    ...trees.merge,
                    command,
                    timeoutMs: ctx.timeouts.hidden,
                    logFile,
                    step: STEP_NAMES.hiddenMerge,
                });
                const atParent = await runInSandbox(ctx.sandbox, {
                    ...trees.parent,
                    command,
                    timeoutMs: ctx.timeouts.hidden,
                    logFile,
                    step: STEP_NAMES.hiddenParent,
                });

                validation.hiddenMerge = atMerge.ok ? "pass" : failText(atMerge);
                validation.hiddenParent = atParent.ok ? "pass" : failText(atParent);

                if (!atMerge.ok || atParent.ok || atParent.timedOut) {
                    validation.hiddenNote =
                        "the hidden command did not pass at the merge and fail at the parent: no S2";
                    hiddenTests = [];
                    command = null;
                }
            }

            return outcome(true, null, {
                parent,
                setup: commands.setup,
                check: commands.check,
                hiddenTests,
                hiddenCommand: command,
                features: facts,
            });
        })();
    } catch (error) {
        result = outcome(false, `validation error: ${error.message.split("\n")[0]}`);
    } finally {
        await cleanupTree(base, ctx.log);
    }

    // An unexpected error is not cached: a later run validates the candidate again.
    if (!isValidationError(result)) {
        await writeJsonAtomic(cacheFile, { key, outcome: result });
    }

    return result;
}

/** A manifest task (schema v1, the fields of `TASK_FIELDS` in their order), not reviewed by its owner yet. */
export function taskOf(candidate, fields) {
    const name = candidate.repo.split("/")[1];
    const task = {
        id: `${name}-${candidate.number}`,
        repo: candidate.repo,
        thread: candidate.thread.id,
        pr: candidate.pr,
        parent: fields.parent,
        merge: candidate.merge,
        brief: candidate.thread.brief,
        briefSource: candidate.thread.briefSource,
        setup: fields.setup,
        check: fields.check,
        hiddenTests: fields.hiddenTests,
        hiddenCommand: fields.hiddenCommand,
        size: candidate.size,
        features: fields.features,
        owner: { keep: null, reason: "", scopeMatches: null, commandsConfirmed: null },
    };

    return Object.fromEntries(TASK_FIELDS.map((field) => [field, task[field]]));
}

/**
 * Harvest 1 repository: its candidates checked on GitHub and in the checkout, ordered per stratum, validated until
 * each stratum holds `PER_STRATUM` valid tasks. Returns the manifest (not written).
 */
export async function harvestRepo(ctx, repo, list, dropped) {
    const checkout = ctx.checkouts[repo] ?? null;
    const manifest = {
        schema: 1,
        repo,
        checkout,
        generatedAt: new Date(ctx.now()).toISOString(),
        since: ctx.since,
        until: ctx.until ?? null,
        tasks: [],
        dropped: [...dropped],
        notValidated: [],
        validation: {},
    };
    const drop = (c, reason) => manifest.dropped.push({ thread: c.thread.id, pr: c.pr, reason });

    if (!checkout) {
        list.forEach((c) => drop(c, "no local checkout of the repository on the roster"));

        return manifest;
    }

    if (ctx.fetch && list.length) {
        await gitBuffer(checkout, ["fetch", "--quiet", "origin"]);
    }

    const strata = new Map(STRATA.map((s) => [s, []]));

    for (const c of list) {
        let facts;

        try {
            facts = await prFacts(ctx, repo, c.number);
        } catch (error) {
            drop(c, `gh pr view failed: ${error.message.split("\n")[0]}`);
            continue;
        }

        const mergedAt = facts.mergedAt ? Date.parse(facts.mergedAt) : NaN;

        if (facts.state !== "MERGED" || !facts.merge) {
            drop(c, `not merged on GitHub (state ${facts.state})`);
        } else if (
            !(mergedAt >= ctx.sinceMs) ||
            (ctx.untilMs !== null && !(mergedAt < ctx.untilMs))
        ) {
            drop(c, `merged outside the window (${facts.mergedAt})`);
        } else if (!(await hasCommit(checkout, facts.merge))) {
            drop(c, `the merge commit ${facts.merge} is not in the local checkout`);
        } else {
            const size = facts.additions + facts.deletions;

            strata.get(stratumOf(size)).push({
                ...c,
                checkout,
                merge: facts.merge,
                parent: await revParse(checkout, `${facts.merge}^1`),
                size,
            });
        }
    }

    for (const stratum of STRATA) {
        const order = stratumOrder(strata.get(stratum), ctx.seed ?? SEED);
        const chosen = [];
        let next = 0;

        while (chosen.length < PER_STRATUM && next < order.length) {
            const batch = order.slice(
                next,
                next + Math.min(ctx.parallel, PER_STRATUM - chosen.length),
            );

            next += batch.length;

            const outcomes = await mapLimit(batch, ctx.parallel, (c) => {
                ctx.log(`${c.pr}: validating (${stratum}, ${c.thread.briefSource})`);

                return validateSafely(ctx, c);
            });

            batch.forEach((c, i) => {
                const result = outcomes[i];

                if (!result.ok) {
                    ctx.log(`${c.pr}: dropped: ${result.reason}`);
                    drop(c, result.reason);
                } else if (chosen.length < PER_STRATUM) {
                    const task = taskOf(c, result.fields);

                    chosen.push(task);
                    manifest.validation[task.id] = {
                        ...result.validation,
                        stratum,
                        cached: Boolean(result.cached),
                    };
                    ctx.log(`${c.pr}: kept as ${task.id}`);
                }
            });
        }

        manifest.tasks.push(...chosen);
        manifest.notValidated.push(
            ...order
                .slice(next)
                .map((c) => ({ thread: c.thread.id, pr: c.pr, stratum, reason: "stratum full" })),
        );
    }

    return manifest;
}

/**
 * Validate 1 candidate; an unexpected error (thrown anywhere, a cleanup too) drops this candidate with a reason, and
 * the harvest goes on with the next.
 */
export async function validateSafely(ctx, candidate) {
    try {
        return await (ctx.validate ?? validateCandidate)(ctx, candidate);
    } catch (error) {
        return {
            ok: false,
            reason: `validation error: ${String(error?.message ?? error).split("\n")[0]}`,
            validation: {},
        };
    }
}

/** The manifest file of a repository: `<out>/<github owner>/<name>.json`. */
export const manifestPath = (out, repo) => join(out, ...repo.split("/")) + ".json";

/**
 * Harvest every bench repository (or those of `ctx.repos`) from `threads`, and write each manifest. Returns the
 * written files.
 */
export async function harvest(ctx, threads) {
    const repos = ctx.repos?.size ? ctx.repos : null;
    const { byRepo, dropped } = selectCandidates(threads, { repos });
    const written = [];

    for (const { repo } of BENCH_REPOS) {
        if (repos && !repos.has(repo)) {
            continue;
        }

        const manifest = await harvestRepo(
            ctx,
            repo,
            byRepo.get(repo) ?? [],
            dropped.get(repo) ?? [],
        );
        const file = manifestPath(ctx.out, repo);

        await writeJsonAtomic(file, manifest);
        ctx.log(
            `${repo}: ${manifest.tasks.length} tasks, ${manifest.dropped.length} dropped: ${file}`,
        );
        written.push(file);
    }

    return written;
}

// ---------------------------------------------------------------------------------------------------------------
// --revalidate
// ---------------------------------------------------------------------------------------------------------------

/**
 * The named tests of a task's `hiddenTests` that are not valid: each must fail by an assertion at the parent (the
 * tree holds the hidden files) and pass at the merge, by the same reporters and rules as the harvest. The discovery
 * is the reviewed `hiddenCommand` itself with a reporter added at each runner (`reporterCommands`), so the owner's
 * settings (an environment variable, `-tags`, a loader, a venv path) stay. Returns `[{ file, name, reason }]`, or
 * `{ error }` when a segment of the command has no runner to add a reporter to.
 */
export async function namedTestsInvalid(ctx, { task, checkout, trees, logFile }) {
    const named = task.hiddenTests.filter((t) => t.names.length && testLanguage(t.file));
    const byLanguage = (language) => named.filter((t) => testLanguage(t.file) === language);
    const commands = reporterCommands(task.hiddenCommand, {
        nodeFiles: byLanguage("node").map((t) => t.file),
    });

    if (commands.error) {
        return { error: commands.error };
    }

    const module = goModule(await fileAt(checkout, task.merge, "go.mod"));
    const run = async (tree, command) =>
        (
            await runInSandbox(ctx.sandbox, {
                ...tree,
                command,
                timeoutMs: ctx.timeouts.hidden,
                logFile,
            })
        ).stdout;

    const outcome = async (language, tree, files, goNames) => {
        if (language === "node") {
            return nodeOutcome(await run(tree, commands.node.join("; ") || "true"), files);
        }

        if (language === "go") {
            return goFileOutcome(await run(tree, commands.go.join("; ") || "true"), {
                files,
                goNames,
                module,
            });
        }

        for (const { junit } of commands.python) {
            await rm(join(tree.cache, junit.replace(/^\/cache\//, "")), { force: true });
        }

        await run(tree, commands.python.map((p) => p.command).join("; ") || "true");

        const xml = await Promise.all(
            commands.python.map(({ junit }) =>
                readFile(join(tree.cache, junit.replace(/^\/cache\//, "")), "utf8").catch(() => ""),
            ),
        );

        return pytestOutcome(xml.join("\n"), files);
    };

    const invalid = [];

    for (const language of [...new Set(named.map((t) => testLanguage(t.file)))].sort()) {
        const entries = byLanguage(language);
        const files = entries.map((t) => t.file);
        const goNames = Object.fromEntries(entries.map((t) => [t.file, t.names]));
        const atMerge = await outcome(language, trees.merge, files, goNames);
        const atParent = await outcome(language, trees.parent, files, goNames);
        const { valid, dropped } = classify({ files, parent: atParent, merge: atMerge });

        for (const t of entries) {
            for (const name of t.names) {
                if (valid.get(t.file)?.includes(name)) {
                    continue;
                }

                const why = dropped.find((d) => d.file === t.file && d.name === name);

                invalid.push({
                    file: t.file,
                    name,
                    reason: why?.reason ?? "did not run at the parent or the merge",
                });
            }
        }
    }

    return invalid;
}

/** The log of a task's revalidation: kept after its scratch trees are removed. */
export const revalidateLog = (data, taskId) =>
    join(data, "harvest-cache", "revalidate", `${taskId}.log`);

/**
 * Run 1 task's commands as its manifest writes them: setup and check at the merge must pass; the hidden command must
 * pass at the merge, and fail at the parent (after its setup) with the task's hidden files copied over it. Returns the
 * validation entry `{ at, ok, reason, log, ... }`; `log` holds each command's stderr, and a failed command's stdout.
 */
export async function revalidateTask(ctx, task, checkout) {
    const base = join(ctx.data, "harvest-work", "revalidate", task.id);
    const trees = treesOf(base);
    const logFile = revalidateLog(ctx.data, task.id);
    const entry = { at: new Date(ctx.now()).toISOString(), ok: false, reason: null, log: logFile };

    await privateDir(join(logFile, ".."));
    await rm(logFile, { force: true });

    const step = async (name, tree, command, kind) => {
        const run = await runInSandbox(ctx.sandbox, {
            ...tree,
            command,
            timeoutMs: ctx.timeouts[kind],
            logFile,
            step: STEP_NAMES[name],
        });

        entry[name] = run.ok ? "pass" : failText(run);

        return run;
    };

    await removeTree(base);
    await privateDir(base);

    try {
        await scratchClone({ checkout, work: trees.merge.work, parent: task.merge, merge: null });
        await makeCache(trees.merge.cache);

        if (!(await step("setupMerge", trees.merge, task.setup, "setup")).ok) {
            entry.reason = `setup failed at the merge (${entry.setupMerge})`;

            return entry;
        }

        if (!(await step("checkMerge", trees.merge, task.check, "check")).ok) {
            entry.reason = `check failed at the merge (${entry.checkMerge})`;

            return entry;
        }

        if (task.hiddenCommand) {
            if (!(await step("hiddenMerge", trees.merge, task.hiddenCommand, "hidden")).ok) {
                entry.reason = `the hidden command failed at the merge (${entry.hiddenMerge})`;

                return entry;
            }

            await scratchClone({
                checkout,
                work: trees.parent.work,
                parent: task.parent,
                merge: task.merge,
            });
            await makeCache(trees.parent.cache);

            if (!(await step("setupParent", trees.parent, task.setup, "setup")).ok) {
                entry.reason = `setup failed at the parent (${entry.setupParent})`;

                return entry;
            }

            await overlayFiles({
                checkout,
                rev: task.merge,
                files: task.hiddenTests.map((t) => t.file),
                work: trees.parent.work,
            });

            const atParent = await step("hiddenParent", trees.parent, task.hiddenCommand, "hidden");

            if (atParent.ok || atParent.timedOut) {
                entry.reason = atParent.ok
                    ? "the hidden command passes at the parent"
                    : "the hidden command timed out at the parent";

                return entry;
            }

            // A non-zero exit at the parent is not enough (a test that does not load fails too): each named test
            // must fail by an assertion at the parent and pass at the merge, as the harvest classifies it.
            const invalid = await namedTestsInvalid(ctx, { task, checkout, trees, logFile });

            if (invalid.error) {
                entry.hiddenNames = "fail";
                entry.reason = invalid.error;

                return entry;
            }

            entry.hiddenNames = invalid.length ? "fail" : "pass";

            if (invalid.length) {
                entry.invalidNames = invalid;
                entry.reason = invalid
                    .map(({ file, name, reason }) => `hidden test ${file} "${name}" ${reason}`)
                    .join("; ");

                return entry;
            }
        }

        entry.ok = true;

        return entry;
    } catch (error) {
        entry.reason = `error: ${error.message.split("\n")[0]}`;

        return entry;
    } finally {
        await cleanupTree(base, ctx.log ?? ((line) => console.error(line)));
    }
}

/**
 * `--revalidate <file>`: run each task's commands again and write the outcome into the file's top-level `validation`
 * (the tasks and their `owner` stay as they are). Returns the exit code: 1 when a task the owner did not drop fails.
 */
export async function revalidate(ctx, file, { checkoutOf }) {
    const manifest = await loadManifest(file);
    const raw = JSON.parse(await readFile(file, "utf8"));
    let failed = false;

    raw.validation ??= {};

    for (const task of manifest.tasks) {
        const checkout = checkoutOf(ctx.checkout, manifest, task);
        const entry = await revalidateTask(ctx, task, checkout);
        const kept = task.owner?.keep !== false;

        raw.validation[task.id] = { ...entry, revalidated: true };
        failed ||= kept && !entry.ok;
        console.log(
            `${entry.ok ? "ok  " : "FAIL"} ${task.id}${entry.ok ? "" : `: ${entry.reason}`}${kept ? "" : " (dropped by the owner)"}`,
        );
        await writeJsonAtomic(file, raw);
    }

    return failed ? 1 : 0;
}

/** The default limits of the harvester's commands. */
export const TIMEOUTS = { setup: COMMAND_MS, check: COMMAND_MS, hidden: COMMAND_MS };

// ---------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------

export const HARVEST_USAGE = `usage: node bench/harvest.mjs --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <dir>]
         [--repo <owner/name>]... [--parallel <n>] [--bwrap <path>] [--pocket <dir>] [--fetch]
         [--db <pocket.sqlite>] [--roster <dir>] [--mise-installs <dir>]
       node bench/harvest.mjs --revalidate <file> [--checkout <dir>] [--bwrap <path>] [--pocket <dir>]`;

const HARVEST_OPTIONS = {
    since: { type: "string" },
    until: { type: "string" },
    out: { type: "string" },
    repo: { type: "string", multiple: true },
    parallel: { type: "string" },
    bwrap: { type: "string" },
    pocket: { type: "string" },
    fetch: { type: "boolean" },
    db: { type: "string" },
    roster: { type: "string" },
    "mise-installs": { type: "string" },
    revalidate: { type: "string" },
    checkout: { type: "string" },
};

/** The SSH host names the router masks: `PI_POCKET_TEAM_SSH_CONFIG`, else `~/.ssh/config`; none when unreadable. */
export async function hostNamesOf(env = process.env) {
    try {
        return sshHostNames(
            await readFile(
                env.PI_POCKET_TEAM_SSH_CONFIG ?? join(homedir(), ".ssh", "config"),
                "utf8",
            ),
        );
    } catch {
        return [];
    }
}

/**
 * The harvester's main: returns the exit code (0 done, 1 usage error or a failed revalidation). `deps`: `gh`, `now`,
 * `log` and `readThreads` replace the real ones in tests.
 */
export async function harvestMain(argv, env = process.env, deps = {}) {
    let values;

    try {
        ({ values } = parseArgs({ args: argv, options: HARVEST_OPTIONS, allowPositionals: false }));

        const bwrap = findProgram(values.bwrap ?? "bwrap", env);

        if (!bwrap) {
            throw new UsageError(`bwrap not found: ${values.bwrap ?? "bwrap"}`);
        }

        const parallel = values.parallel === undefined ? 1 : Number(values.parallel);

        if (!Number.isInteger(parallel) || parallel < 1) {
            throw new UsageError("--parallel must be an integer >= 1");
        }

        const ctx = {
            data: dataDir(env),
            now: deps.now ?? Date.now,
            log: deps.log ?? ((line) => console.error(line)),
            gh: deps.gh ?? realGh,
            parallel,
            fetch: Boolean(values.fetch),
            checkout: values.checkout,
            sandbox: {
                bwrap,
                data: dataDir(env),
                pocket: resolve(values.pocket ?? DEFAULTS.pocket),
                miseInstalls: resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls),
                killGraceMs: deps.killGraceMs,
            },
            timeouts: { ...TIMEOUTS, ...deps.timeouts },
        };

        if (values.revalidate) {
            return await revalidate(ctx, resolve(values.revalidate), { checkoutOf });
        }

        if (!values.since) {
            throw new UsageError("--since is required");
        }

        const repos = new Set();

        for (const name of values.repo ?? []) {
            const entry = benchRepo(name);

            if (!entry) {
                throw new UsageError(`${name} is not a bench repository`);
            }

            repos.add(entry.repo);
        }

        const roster = readRoster(values.roster ?? rosterDir(env));

        Object.assign(ctx, {
            since: values.since,
            until: values.until ?? null,
            sinceMs: dateOption(values.since),
            untilMs: dateOption(values.until, { end: true }),
            repos,
            out: resolve(values.out ?? join(ctx.data, "manifests")),
            checkouts: roster.checkouts,
            rosterNames: roster.names,
            hostNames: await hostNamesOf(env),
        });

        const threads = (deps.readThreads ?? readThreads)(values.db ?? pocketDb(env));

        await harvest(ctx, threads);

        return 0;
    } catch (error) {
        if (error instanceof UsageError || error?.code?.startsWith?.("ERR_PARSE_ARGS")) {
            console.error(`${error.message}\n${HARVEST_USAGE}`);

            return 1;
        }

        throw error;
    }
}
