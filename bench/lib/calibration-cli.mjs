// The command line of the judge calibration's instrument (`bench/calibration.mjs`): `plan`, `run`, `status` and
// `packs`. The library is `bench/lib/calibration.mjs`; the contract is the T1064 plan, section Scoring.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, dataDir, delay, readJson, writeJsonAtomic } from "./common.mjs";
import {
    CALIBRATION_STAGE,
    buildPacks,
    buildPlan,
    calibrationDir,
    copyPilotResult,
    drive,
    itemResultPath,
    loadPlanTasks,
    manifestPath,
    outcomeOnDisk,
    readText,
    resolveTask,
    summarizeState,
    summaryMarkdown,
    writePacks,
} from "./calibration.mjs";
import {
    LEASE_BIN,
    PASS_OPTIONS,
    benchChild,
    holdLease,
    passArgs,
    stopChildren,
} from "./drive.mjs";
import { UsageError, loadManifest, loadModels, peakEnds } from "./manifest.mjs";
import { expandHome } from "./owners.mjs";

export const CALIBRATION_USAGE = `usage: node bench/calibration.mjs <plan|run|status|packs> [--dir <dir>] [--pool <file>] [--pilot <file>]
         [--pilot-results <dir>] [--home <dir>]
  plan     write <dir>/plan.json (the tasks, their dev or held-out set, 4 models each); frozen once written
  run      run the attempts (stage ${CALIBRATION_STAGE}) and check them (score.mjs --checks-only), with replacements:
           [--parallel 4] [--wait-peak] [--lease-bin <path>] and the run.mjs options --checkout, --pocket,
           --cost-limit, --token-limit, --wall-limit, --agent-src, --mise-installs, --bwrap, --no-auth-preflight
  status   the outcome of each slot, the items per owner and model, the spend (no diff is shown)
  packs    write 1 pack per owner (packs/<owner>/) and 1 key per owner (keys/<owner>.json)
exit codes: 0 done, 1 usage error or an attempt that cannot go on, 2 budget refused, 4 attempts wait (peak hours)`;

const OPTIONS = {
    dir: { type: "string" },
    pool: { type: "string" },
    pilot: { type: "string" },
    "pilot-results": { type: "string" },
    home: { type: "string" },
    parallel: { type: "string", default: "4" },
    "wait-peak": { type: "boolean" },
    "lease-bin": { type: "string", default: LEASE_BIN },
    ...PASS_OPTIONS,
};

/** The score.mjs options that a check passes on. */
const SCORE_PASS = ["checkout", "pocket", "agent-src", "mise-installs", "bwrap"];

/** Read the plan, or stop with a usage error. */
async function readPlan(dir) {
    const plan = await readJson(join(dir, "plan.json"), null);

    if (!plan) {
        throw new UsageError(`no plan: run \`node bench/calibration.mjs plan\` first (${dir})`);
    }

    return plan;
}

/** The plan from the pool and the pilot manifest. */
async function makePlan(values, home) {
    const poolFile = resolve(values.pool ?? join(BENCH_DIR, "pool-v1.json"));
    const pool = await readJson(poolFile, null);

    if (!pool) {
        throw new UsageError(`cannot read the pool: ${poolFile}`);
    }

    const pilot = await loadManifest(resolve(values.pilot ?? join(BENCH_DIR, "pilot.json")));
    const where = new Map();

    for (const input of pool.inputs ?? []) {
        const manifest = await loadManifest(expandHome(input.file, home));

        for (const task of manifest.tasks) {
            where.set(task.id, input.file);
        }
    }

    const plan = buildPlan(
        pool,
        pilot.tasks.map((t) => t.id),
        (id) => {
            if (!where.has(id)) {
                throw new UsageError(`calibration task ${id} is in no input manifest of the pool`);
            }

            return where.get(id);
        },
    );

    if (values.pilot) {
        for (const task of plan.tasks) {
            if (task.source === "pilot") {
                task.manifest = resolve(values.pilot);
            }
        }
    }

    return plan;
}

/** The outcome of each task's slots on disk. */
async function statesOnDisk(plan, ctx) {
    const states = [];

    for (const task of plan.tasks) {
        const manifestTask = ctx.tasks.get(task.id).manifestTask;
        const outcomes = new Map();

        for (const model of new Set([
            ...plan.groups.cheap,
            ...plan.groups.middle,
            ...plan.groups.dear,
        ])) {
            outcomes.set(
                model,
                await outcomeOnDisk(ctx.dir, ctx.pilotResults, task, manifestTask, model),
            );
        }

        states.push({ task, ...resolveTask(task, plan.groups, (m) => outcomes.get(m)) });
    }

    return states;
}

/** Every calibration-stage attempt on disk (for the spend). */
async function attemptsOnDisk(plan, dir) {
    const out = [];

    for (const task of plan.tasks.filter((t) => t.source === "pool")) {
        for (const model of [...plan.groups.cheap, ...plan.groups.middle, ...plan.groups.dear]) {
            const result = await readJson(itemResultPath(dir, task, model), null);

            if (result) {
                out.push(result);
            }
        }
    }

    return out;
}

/**
 * The instrument's main: returns the exit code. `deps`: `now`, `wait`, `log`, `print` replace the defaults in tests.
 */
export async function calibrationMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));
    const print = deps.print ?? ((text) => console.log(text));
    const now = deps.now ?? Date.now;

    try {
        let values;
        let positionals;

        try {
            ({ values, positionals } = parseArgs({
                args: argv,
                options: OPTIONS,
                allowPositionals: true,
            }));
        } catch (error) {
            throw new UsageError(error.message);
        }

        const command = positionals[0];

        // The results of the attempts are always in `<dir>/results`: a run.mjs `--results` would put them where the
        // driver never looks.
        if (values.results !== undefined) {
            throw new UsageError("--results is not an option here: the results go to <dir>/results");
        }

        if (positionals.length !== 1 || !["plan", "run", "status", "packs"].includes(command)) {
            throw new UsageError("give 1 command: plan, run, status or packs");
        }

        const data = dataDir(env);
        const dir = calibrationDir(data, values.dir);
        const home = values.home ? resolve(values.home) : homedir();
        const pilotResults = resolve(values["pilot-results"] ?? join(data, "results-t1"));

        if (command === "plan") {
            const plan = await makePlan(values, home);
            const file = join(dir, "plan.json");
            const before = await readJson(file, null);

            if (before && JSON.stringify(before) !== JSON.stringify(plan)) {
                throw new UsageError(`${file} exists and differs: the plan is frozen once written`);
            }

            if (!before) {
                await writeJsonAtomic(file, plan);
            }

            print(
                `${before ? "unchanged" : "written"}: ${file}: ${plan.tasks.length} tasks, ${plan.tasks.length * 4} slots`,
            );

            return 0;
        }

        const plan = await readPlan(dir);
        const tasks = await loadPlanTasks(plan, home);
        const ctx = { dir, pilotResults, tasks };

        if (command === "status") {
            const states = await statesOnDisk(plan, ctx);

            print(summaryMarkdown(summarizeState(states, await attemptsOnDisk(plan, dir)), states));

            return 0;
        }

        if (command === "packs") {
            const states = await statesOnDisk(plan, ctx);
            const built = await buildPacks(
                states,
                async (task, model) => ({
                    result: await readJson(itemResultPath(dir, task, model), null),
                    manifestTask: tasks.get(task.id).manifestTask,
                    file: itemResultPath(dir, task, model),
                }),
                readText,
            );
            const { written, kept } = await writePacks(dir, built);

            for (const [owner, pack] of Object.entries(built.packs)) {
                const dev = pack.items.filter((i) => i.set === "dev").length;

                print(
                    `${owner}: ${pack.items.length} items (${dev} dev, ${pack.items.length - dev} held-out): ${written.includes(owner) ? "written" : "kept (labelled)"}: ${join(dir, "packs", owner)}`,
                );
            }

            if (kept.length) {
                log(`kept with their labels: ${kept.join(", ")}`);
            }

            return 0;
        }

        // run
        const parallel = Number(values.parallel);

        if (!Number.isInteger(parallel) || parallel < 1) {
            throw new UsageError("--parallel must be an integer >= 1");
        }

        const models = await loadModels();
        const children = new Set();
        const runArgs = passArgs(values);
        const scoreArgs = SCORE_PASS.flatMap((name) =>
            values[name] === undefined ? [] : [`--${name}`, values[name]],
        );
        let lease = null;

        const result = await drive(plan, {
            parallel,
            waitPeak: Boolean(values["wait-peak"]),
            now,
            wait: deps.wait ?? delay,
            log,
            peakEnds,
            model: (id) => models.find((m) => m.id === id),
            lease: async () => {
                lease = await holdLease(
                    values["lease-bin"],
                    `bench ${CALIBRATION_STAGE}`,
                    () => "calibration attempts",
                    () => stopChildren(children),
                    env,
                );

                return lease.ok;
            },
            run: (task, model) =>
                benchChild(
                    "run.mjs",
                    [
                        "--manifest",
                        tasks.get(task.id).file,
                        "--task",
                        task.id,
                        "--model",
                        model,
                        "--stage",
                        CALIBRATION_STAGE,
                        "--results",
                        join(dir, "results"),
                        ...runArgs,
                    ],
                    children,
                    env,
                ),
            check: async (task, model) => {
                const file =
                    task.source === "pilot"
                        ? await copyPilotResult(dir, pilotResults, task, model)
                        : itemResultPath(dir, task, model);

                return benchChild(
                    "score.mjs",
                    [
                        "--checks-only",
                        "--result",
                        file,
                        "--manifest",
                        tasks.get(task.id).file,
                        ...(values["no-auth-preflight"] ? ["--no-auth-preflight"] : []),
                        ...scoreArgs,
                    ],
                    children,
                    env,
                );
            },
            ...outcomeDeps(plan, ctx),
        }).finally(() => lease?.release());

        print(
            summaryMarkdown(
                summarizeState(result.tasks, await attemptsOnDisk(plan, dir)),
                result.tasks,
            ),
        );

        for (const [key, why] of result.stuck) {
            print(`cannot go on: ${key.replace("\n", " ")}: ${why}`);
        }

        if (result.deferred.length) {
            print(
                `waits for the end of peak hours: ${result.deferred.map((k) => k.replace("\n", " ")).join("; ")}`,
            );
        }

        return result.stuck.size ? 1 : result.budgetRefused ? 2 : result.deferred.length ? 4 : 0;
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${CALIBRATION_USAGE}`);

            return 1;
        }

        throw error;
    }
}

/**
 * The driver's `outcome` reads a cache of the result files; the driver calls `refresh()` before each step, so each
 * step sees the files as they are.
 */
function outcomeDeps(plan, ctx) {
    const cache = new Map();
    const all = [...plan.groups.cheap, ...plan.groups.middle, ...plan.groups.dear];

    const refresh = async () => {
        for (const task of plan.tasks) {
            const manifestTask = ctx.tasks.get(task.id).manifestTask;

            for (const model of all) {
                cache.set(
                    `${task.id}\n${model}`,
                    await outcomeOnDisk(ctx.dir, ctx.pilotResults, task, manifestTask, model),
                );
            }
        }
    };

    return {
        refresh,
        outcome: (task, model) => cache.get(`${task.id}\n${model}`),
    };
}
