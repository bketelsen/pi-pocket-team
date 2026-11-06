// The bench runner: 1 attempt of 1 model on 1 task, in the bwrap sandbox, under the budget guard and the slots.
// Exit codes: 0 attempt recorded (or the result exists), 1 usage error, 2 budget refused (or DeepSeek peak hours),
// 3 harness failure after retries.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    STAGES,
    dataDir,
    delay,
    privateDir,
    providerOf,
    readJson,
    resultPath,
    resultsDir,
    runBase,
    writeJsonAtomic,
} from "./common.mjs";
import { describeSpend, readSpend, reserve, settle } from "./budget.mjs";
import { SLOT_POLL_MS, acquireSlots } from "./slots.mjs";
import { scratchClone } from "./clone.mjs";
import { DEFAULTS, bwrapArgs, findProgram, piCommand, setupCommand } from "./sandbox.mjs";
import {
    UsageError,
    holdsHalogenLease,
    inPeak,
    leaseDir,
    loadManifest,
    loadModels,
    peakEnds,
} from "./manifest.mjs";
import { addUsage, zeroUsage } from "./stream.mjs";
import { killAll, runLogged, runStreamed } from "./proc.mjs";
import { takeAttemptLock } from "./lock.mjs";

/** The limits of an attempt. */
export const LIMITS = {
    wallMs: 45 * 60_000,
    costUsd: 8,
    tokens: 4_000_000,
    setupMs: 10 * 60_000,
    killGraceMs: 10_000,
};

/** Tries in all after harness failures (1 + 2 repeats), and after provider errors (1 + 1 retry). */
export const HARNESS_TRIES = 3;
export const PROVIDER_TRIES = 2;

/** The bench header version and its prompt text. */
export const HEADER_VERSION = 1;

const USAGE = `usage: node bench/run.mjs --manifest <file> --task <id> --model <provider/id>
         --stage <${STAGES.join("|")}> [--dry-run] [--run-id <s>] [--checkout <dir>] [--pocket <dir>]
         [--results <dir>] [--wall-limit <ms>] [--cost-limit <usd>] [--token-limit <n>]
         [--agent-src <dir>] [--mise-installs <dir>] [--bwrap <path>] [--no-auth-preflight]
         [--max-provider <n>]`;

const OPTIONS = {
    manifest: { type: "string" },
    task: { type: "string" },
    model: { type: "string" },
    stage: { type: "string" },
    "dry-run": { type: "boolean" },
    "run-id": { type: "string" },
    checkout: { type: "string" },
    pocket: { type: "string" },
    results: { type: "string" },
    "wall-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "token-limit": { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    bwrap: { type: "string" },
    "no-auth-preflight": { type: "boolean" },
    "max-provider": { type: "string" },
    "kill-grace": { type: "string" },
    "setup-timeout": { type: "string" },
};

/** A positive number option, or its default. */
function numberOption(values, name, fallback, { integer = false } = {}) {
    const raw = values[name];

    if (raw === undefined) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        throw new UsageError(`--${name} must be a number >= 0, not ${raw}`);
    }

    return value;
}

/** Parse and check the arguments, the manifest task and the model. */
export async function prepare(argv, env = process.env) {
    let values;

    try {
        ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
    } catch (error) {
        throw new UsageError(error.message);
    }

    for (const name of ["manifest", "task", "model", "stage"]) {
        if (!values[name]) {
            throw new UsageError(`--${name} is required`);
        }
    }

    if (!STAGES.includes(values.stage)) {
        throw new UsageError(`--stage must be one of ${STAGES.join(", ")}`);
    }

    const runId = values["run-id"];

    if (runId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(runId)) {
        throw new UsageError("--run-id must be 1 to 64 of A-Z a-z 0-9 . _ -");
    }

    const manifest = await loadManifest(resolve(values.manifest));
    const task = manifest.tasks.find((t) => t.id === values.task);

    if (!task) {
        throw new UsageError(`unknown task ${values.task} in ${values.manifest}`);
    }

    const models = await loadModels();
    const model = models.find((m) => m.id === values.model);

    if (!model) {
        throw new UsageError(`model ${values.model} is not in bench/models.json`);
    }

    const maxProviderRaw = values["max-provider"] ?? env.BENCH_MAX_PROVIDER;
    const maxProvider =
        maxProviderRaw === undefined ? undefined : Number.parseInt(maxProviderRaw, 10);

    if (maxProvider !== undefined && !(maxProvider >= 1)) {
        throw new UsageError("--max-provider must be an integer >= 1");
    }

    const [, repoName] = task.repo.split("/");
    const limits = {
        wallMs: numberOption(values, "wall-limit", LIMITS.wallMs),
        costUsd: numberOption(values, "cost-limit", LIMITS.costUsd),
        tokens: numberOption(values, "token-limit", LIMITS.tokens, { integer: true }),
        setupMs: numberOption(values, "setup-timeout", LIMITS.setupMs),
        killGraceMs: numberOption(values, "kill-grace", LIMITS.killGraceMs),
    };

    // The limit that counts must leave room for a try: a priced model's cost, an unpriced model's tokens.
    if (model.priced && !(limits.costUsd > 0)) {
        throw new UsageError(`--cost-limit must be above 0 for the priced model ${model.id}`);
    }

    if (!model.priced && !(limits.tokens > 0)) {
        throw new UsageError(`--token-limit must be above 0 for the unpriced model ${model.id}`);
    }

    return {
        task,
        model,
        provider: providerOf(model.id),
        stage: values.stage,
        runId,
        ids: { stage: values.stage, task: task.id, model: model.id, runId },
        dryRun: Boolean(values["dry-run"]),
        data: dataDir(env),
        results: resultsDir(values.results),
        checkout: resolve(values.checkout ?? join(homedir(), "projects", repoName ?? task.repo)),
        pocket: resolve(values.pocket ?? DEFAULTS.pocket),
        agentSrc: resolve(values["agent-src"] ?? DEFAULTS.agentSrc),
        miseInstalls: resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls),
        bwrap: values.bwrap ?? "bwrap",
        authPreflight: !values["no-auth-preflight"],
        maxProvider,
        slotPollMs:
            Number(env.BENCH_SLOT_POLL_MS) > 0 ? Number(env.BENCH_SLOT_POLL_MS) : SLOT_POLL_MS,
        limits,
        env,
    };
}

/** The host paths of 1 try, and of the shared agent dir. */
export function tryPaths(ctx, tryNo) {
    const dir = join(runBase(ctx.data, ctx.ids), `try-${tryNo}`);

    return {
        dir,
        work: join(dir, "work"),
        session: join(dir, "session"),
        cache: join(dir, "cache"),
        events: join(dir, "events.jsonl"),
        stderr: join(dir, "stderr.log"),
        agentDir: join(ctx.data, "agent"),
        settings: join(ctx.data, "agent-files", "settings.json"),
        models: join(ctx.agentSrc, "models.json"),
        auth: join(ctx.agentSrc, "auth.json"),
        header: DEFAULTS.header,
        hosts: DEFAULTS.hosts,
        pocket: ctx.pocket,
        miseInstalls: ctx.miseInstalls,
    };
}

/** The prompt: the header, a blank line, then the brief. */
export async function promptOf(task) {
    const header = (await readFile(DEFAULTS.header, "utf8")).trim();

    return `${header}\n\n${String(task.brief).trim()}`;
}

/** The `type` of a provider's entry in the auth file. Only this field is read; nothing is logged. */
export async function authType(authFile, provider) {
    const auth = await readJson(authFile, {});
    const type = auth?.[provider]?.type;

    return typeof type === "string" ? type : null;
}

/**
 * Refresh an OAuth token on the host, under the host's own lock, so the sandbox needs no refresh for 45 minutes.
 * The token is printed to stdout, which is ignored: never read, logged or stored.
 */
export function authPreflight(ctx) {
    return new Promise((done) => {
        const child = spawn(
            process.execPath,
            [
                join(ctx.pocket, "node_modules", ".bin", "pi"),
                "auth",
                "print-bearer-token",
                "--provider",
                ctx.provider,
                "--min-expiry",
                "60m",
            ],
            {
                stdio: "ignore",
                env: { ...process.env, PI_CODING_AGENT_DIR: ctx.agentSrc },
                timeout: 120_000,
            },
        );

        child.on("error", () => done(false));
        child.on("close", (code) => done(code === 0));
    });
}

/** The first try number free in the run folder (run folders are kept, never reused). */
function firstTry(ctx) {
    const base = runBase(ctx.data, ctx.ids);

    if (!existsSync(base)) {
        return 1;
    }

    const used = readdirSync(base)
        .map((name) => /^try-(\d+)$/.exec(name)?.[1])
        .filter(Boolean)
        .map(Number);

    return used.length ? Math.max(...used) + 1 : 1;
}

/** The shared agent dir: bind targets for the files mounted over it, and `settings.json` = `{}`. */
async function prepareAgentDir(ctx) {
    const agent = await privateDir(join(ctx.data, "agent"));
    const files = await privateDir(join(ctx.data, "agent-files"));

    for (const name of ["AGENTS.md", "settings.json", "models.json", "auth.json"]) {
        await writeFile(join(agent, name), "", { mode: 0o600, flag: "a" });
    }

    await writeFile(join(files, "settings.json"), "{}\n", { mode: 0o600 });
}

/** The cap that an attempt reserves once, for all its tries: the cost limit for a priced model, 0 for an unpriced one. */
const capOf = (ctx) => (ctx.model.priced ? ctx.limits.costUsd : 0);

/**
 * The attempt allowance that the tries so far have used up, or null: "wall", or "cost" for a priced model, or
 * "tokens" for an unpriced one. A retry starts only when this is null.
 */
export function allowanceSpent(limits, used, priced) {
    if (used.wallMs >= limits.wallMs) {
        return "wall";
    }

    if (priced) {
        return used.cost >= limits.costUsd ? "cost" : null;
    }

    return used.tokens >= limits.tokens ? "tokens" : null;
}

/**
 * 1 try: take the slots, pre-flight, clone, setup, then Pi. The slots are released whatever happens.
 * Returns the try's log line, its usage and its stream.
 */
async function runTry(ctx, tryNo, used, prompt, log) {
    const paths = tryPaths(ctx, tryNo);
    const entry = {
        try: tryNo,
        outcome: null,
        wallMs: 0,
        cost: 0,
        tokens: 0,
        exitCode: null,
        signal: null,
    };
    let usage = zeroUsage();
    let stream = null;

    await privateDir(paths.dir);
    await privateDir(paths.session);

    for (const cache of ["go", "npm", "pip"]) {
        await privateDir(join(paths.cache, cache));
    }

    const slots = await acquireSlots(ctx.data, ctx.provider, {
        maxProvider: ctx.maxProvider,
        wait: () => delay(ctx.slotPollMs),
    });

    try {
        const harness = (why) => {
            log(`try ${tryNo}: harness failure: ${why}`);
            entry.outcome = "harness";

            return { entry, usage, stream };
        };

        if (
            ctx.authPreflight &&
            (await authType(paths.auth, ctx.provider)) === "oauth" &&
            !(await authPreflight(ctx))
        ) {
            return harness("auth pre-flight failed");
        }

        try {
            await scratchClone({
                checkout: ctx.checkout,
                work: paths.work,
                parent: ctx.task.parent,
                merge: ctx.task.merge,
            });
        } catch (error) {
            return harness(`scratch clone: ${error.message.split("\n")[0]}`);
        }

        const sandbox = (command) => bwrapArgs(paths, { tryNo, command });
        const setup = await runLogged({
            bin: ctx.bwrap,
            args: sandbox(setupCommand(ctx.task.setup)),
            logFile: paths.stderr,
            timeoutMs: ctx.limits.setupMs,
            killGraceMs: ctx.limits.killGraceMs,
        });

        if (setup.code !== 0) {
            return harness(
                setup.timedOut
                    ? "setup timed out"
                    : `setup failed (exit ${setup.code ?? setup.signal ?? setup.error})`,
            );
        }

        const run = await runStreamed({
            bin: ctx.bwrap,
            args: sandbox(piCommand(ctx.model.id, prompt)),
            eventsFile: paths.events,
            logFile: paths.stderr,
            wallMs: ctx.limits.wallMs - used.wallMs,
            priced: ctx.model.priced,
            costLeft: ctx.limits.costUsd - used.cost,
            tokensLeft: ctx.limits.tokens - used.tokens,
            killGraceMs: ctx.limits.killGraceMs,
        });

        usage = run.summary.usage;
        stream = run.summary.stream;
        Object.assign(entry, {
            wallMs: run.wallMs,
            cost: usage.cost,
            tokens: usage.tokens,
            exitCode: run.code,
            signal: run.signal,
        });

        if (run.limit) {
            log(`try ${tryNo}: ${run.limit} limit reached`);
            entry.outcome = "limit";
        } else if (!run.summary.sawAssistantStart) {
            return harness(
                `Pi ended before any assistant message (exit ${run.code ?? run.signal ?? run.error})`,
            );
        } else if (run.summary.providerError) {
            log(`try ${tryNo}: provider error`);
            entry.outcome = "provider";
        } else {
            entry.outcome = "ok";
        }

        return { entry, usage, stream };
    } finally {
        await slots.release();
    }
}

/**
 * Run the tries of an attempt and write its result. Returns the exit code. The attempt reserves its cap once, keeps
 * it across its retries, and settles the sum of all tries once at the end, whatever happens.
 */
export async function runAttempt(ctx, log = console.error) {
    const reservation = await reserve(ctx.data, {
        task: ctx.task.id,
        model: ctx.model.id,
        stage: ctx.stage,
        priced: Boolean(ctx.model.priced),
        cap: capOf(ctx),
    });

    if (!reservation.ok) {
        log(reservation.reason);

        return 2;
    }

    const tally = { usage: zeroUsage(), tries: 0 };

    try {
        return await runTries(ctx, tally, log);
    } finally {
        await settle(ctx.data, reservation.id, {
            cost: tally.usage.cost,
            tokens: tally.usage.tokens,
            tries: tally.tries,
        });
    }
}

/** The tries of an attempt, and its result file. `tally` holds the usage and tries so far, for the settlement. */
async function runTries(ctx, tally, log) {
    const prompt = await promptOf(ctx.task);
    const startedAt = new Date().toISOString();
    const used = { wallMs: 0, cost: 0, tokens: 0 };
    const tryLog = [];
    let usage = zeroUsage();
    let stream = null;
    let workDir = null;
    let harnessFails = 0;
    let providerFails = 0;
    let failure = null;
    let harness = false;
    let tryNo = firstTry(ctx);

    await prepareAgentDir(ctx);

    for (;;) {
        const spent = tryLog.length ? allowanceSpent(ctx.limits, used, ctx.model.priced) : null;

        if (spent) {
            log(`no retry: the attempt's ${spent} allowance is used up`);
            failure = "limit";
            break;
        }

        const result = await runTry(ctx, tryNo, used, prompt, log);

        tryLog.push(result.entry);
        usage = addUsage(usage, result.usage);
        tally.usage = usage;
        tally.tries = tryLog.length;
        stream = result.stream ?? stream;
        workDir = tryPaths(ctx, tryNo).work;
        used.wallMs += result.entry.wallMs;
        used.cost += result.usage.cost;
        used.tokens += result.usage.tokens;

        const { outcome } = result.entry;

        if (outcome === "harness") {
            harnessFails += 1;

            if (harnessFails < HARNESS_TRIES) {
                tryNo += 1;
                continue;
            }

            harness = true;
        } else if (outcome === "provider") {
            providerFails += 1;

            if (providerFails < PROVIDER_TRIES) {
                tryNo += 1;
                continue;
            }

            failure = "provider";
        } else if (outcome === "limit") {
            failure = "limit";
        }

        break;
    }

    const result = {
        task: ctx.task.id,
        model: ctx.model.id,
        stage: ctx.stage,
        thinking: "high",
        headerVersion: HEADER_VERSION,
        startedAt,
        wallMs: used.wallMs,
        tries: tryLog.length,
        harness,
        failure,
        usage,
        priced: Boolean(ctx.model.priced),
        priceMissing: Boolean(ctx.model.priced && usage.tokens > 0 && usage.cost === 0),
        stream,
        workDir,
        s0: null,
        s1: null,
        s2: null,
        grades: null,
        diffCut: null,
        judgePending: null,
        tryLog,
    };

    const file = resultPath(ctx.results, ctx.ids);

    await writeJsonAtomic(file, result);
    console.log(`recorded ${file}`);

    return harness ? 3 : 0;
}

/** Print the plan of a dry run: the result path, the budget and the bwrap argv. Nothing is made or reserved. */
async function dryRun(ctx) {
    const paths = tryPaths(ctx, firstTry(ctx));
    const spend = await readSpend(ctx.data);
    const prompt = await promptOf(ctx.task);
    const sandbox = (command) => [ctx.bwrap, ...bwrapArgs(paths, { tryNo: 1, command })];
    const file = resultPath(ctx.results, ctx.ids);

    console.log(`dry run: stage ${ctx.stage}, task ${ctx.task.id}, model ${ctx.model.id}`);
    console.log(`result: ${file}${existsSync(file) ? " (exists: a real run does nothing)" : ""}`);
    console.log(`run dir: ${paths.dir}`);
    console.log(`checkout: ${ctx.checkout} at ${ctx.task.parent}`);
    console.log(`budget: ${describeSpend(spend)}`);
    console.log(`cap per try: $${capOf(ctx)}${ctx.model.priced ? "" : " (unpriced)"}`);
    console.log(
        `limits: wall ${ctx.limits.wallMs} ms, ${ctx.model.priced ? `cost $${ctx.limits.costUsd}` : `tokens ${ctx.limits.tokens}`}`,
    );

    if (inPeak(ctx.model, new Date())) {
        console.log(
            `peak hours now: a real run exits 2 until ${peakEnds(ctx.model, new Date()).toISOString()}`,
        );
    }

    if (!findProgram(ctx.bwrap)) {
        console.log("bwrap: not found (a real run exits 1)");
    }

    console.log(`setup argv: ${JSON.stringify(sandbox(setupCommand(ctx.task.setup)))}`);
    console.log(`attempt argv: ${JSON.stringify(sandbox(piCommand(ctx.model.id, prompt)))}`);

    return 0;
}

/** A usage error as exit 1; any other error is thrown. */
function usageFail(error) {
    if (error instanceof UsageError) {
        console.error(`${error.message}\n${USAGE}`);

        return 1;
    }

    throw error;
}

/** Halogen needs the lease of thread T1064. */
async function checkLease(ctx, env) {
    if (ctx.provider === "halogen" && !(await holdsHalogenLease(env))) {
        throw new UsageError(
            `halogen needs the lease: ~/.pi/agent/bin/lease take halogen T1064 "bench" (looked in ${leaseDir(env)})`,
        );
    }
}

/** The runner's main: returns the exit code. */
export async function main(argv = process.argv.slice(2), env = process.env) {
    let ctx;

    try {
        ctx = await prepare(argv, env);

        if (ctx.dryRun) {
            await checkLease(ctx, env);

            return await dryRun(ctx);
        }
    } catch (error) {
        return usageFail(error);
    }

    // The attempt lock comes before the result-exists check and the try selection, and holds until the result is
    // written: 2 runners of the same attempt never run at once.
    const lock = await takeAttemptLock(ctx.data, ctx.ids);

    if (!lock.ok) {
        console.error(
            `attempt already running: stage ${ctx.stage}, task ${ctx.task.id}, model ${ctx.model.id}${ctx.runId ? `, run id ${ctx.runId}` : ""} (pid ${lock.pid} holds ${lock.path})`,
        );

        return 1;
    }

    try {
        return await runLocked(ctx, env);
    } finally {
        await lock.release();
    }
}

/** The runner's work under the attempt lock. */
async function runLocked(ctx, env) {
    try {
        const file = resultPath(ctx.results, ctx.ids);

        if (existsSync(file)) {
            console.log(`exists ${file}`);

            return 0;
        }

        await checkLease(ctx, env);

        const bwrap = findProgram(ctx.bwrap, env);

        if (!bwrap) {
            throw new UsageError(`bwrap not found: ${ctx.bwrap}`);
        }

        ctx.bwrap = bwrap;

        for (const [what, path] of [
            ["checkout", join(ctx.checkout, ".git")],
            ["Pi Pocket checkout", join(ctx.pocket, "node_modules", ".bin", "pi")],
            ["models file", join(ctx.agentSrc, "models.json")],
            ["auth file", join(ctx.agentSrc, "auth.json")],
        ]) {
            if (!existsSync(path)) {
                throw new UsageError(`${what} not found: ${path}`);
            }
        }
    } catch (error) {
        return usageFail(error);
    }

    if (inPeak(ctx.model, new Date())) {
        console.error(
            `${ctx.model.id} runs only outside its peak hours (UTC ${JSON.stringify(ctx.model.peakUtc)}): try again after ${peakEnds(ctx.model, new Date()).toISOString()}. Nothing was spent.`,
        );

        return 2;
    }

    const onSignal = (signal) => {
        killAll();
        process.exit(signal === "SIGINT" ? 130 : 143);
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    return runAttempt(ctx);
}
