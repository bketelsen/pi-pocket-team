#!/usr/bin/env node
// The batch driver: every (task, model) pair of a manifest as a child `node bench/run.mjs`, at most `--parallel` at
// a time (the slots enforce the provider caps). It stops starting priced pairs after a budget refusal (exit 2), stops
// starting every pair after a disk-low exit of a child (exit 4: the disk is nearly full), holds the halogen lease when a halogen model is in the batch, and keeps DeepSeek pairs out of DeepSeek's peak hours.
// At the end it prints a Markdown table per model.
import { parseArgs } from "node:util";
import { delay, providerOf, resultPath, resultsDir, readJson } from "./lib/common.mjs";
import { UsageError, inPeak, loadManifest, loadModels, peakEnds } from "./lib/manifest.mjs";
import {
    LEASE_BIN,
    PASS_OPTIONS,
    holdLease,
    passArgs,
    runChild,
    stopChildren,
} from "./lib/drive.mjs";
import { markdownTable, summarize } from "./lib/report.mjs";
import { DISK_LOW_EXIT } from "./lib/runner.mjs";

const USAGE = `usage: node bench/batch.mjs --manifest <file> --stage <s> [--models a,b|all] [--tasks a,b|all]
         [--parallel 4] [--run-id <s>] [--wall-limit <ms>] [--wait-peak] [--lease-bin <path>]
         and the run.mjs options --checkout, --pocket, --results, --cost-limit, --token-limit,
         --agent-src, --mise-installs, --bwrap, --no-auth-preflight`;

/** Pick names from a list: "all" (or nothing) is every one; an unknown name is a usage error. */
function pick(list, wanted, what) {
    if (!wanted || wanted === "all") {
        return list;
    }

    const names = wanted.split(",").filter(Boolean);
    const unknown = names.filter((name) => !list.some((item) => item.id === name));

    if (unknown.length) {
        throw new UsageError(`unknown ${what}: ${unknown.join(", ")}`);
    }

    return list.filter((item) => names.includes(item.id));
}

async function main() {
    let values;
    let pairs;

    try {
        ({ values } = parseArgs({
            options: {
                manifest: { type: "string" },
                stage: { type: "string" },
                models: { type: "string" },
                tasks: { type: "string" },
                parallel: { type: "string", default: "4" },
                "run-id": { type: "string" },
                "wait-peak": { type: "boolean" },
                "lease-bin": { type: "string", default: LEASE_BIN },
                ...PASS_OPTIONS,
            },
        }));

        if (!values.manifest || !values.stage) {
            throw new UsageError("--manifest and --stage are required");
        }

        const parallel = Number(values.parallel);

        if (!Number.isInteger(parallel) || parallel < 1) {
            throw new UsageError("--parallel must be an integer >= 1");
        }

        values.parallel = parallel;

        const manifest = await loadManifest(values.manifest);
        const tasks = pick(manifest.tasks, values.tasks, "task");
        const models = pick(await loadModels(), values.models, "model");

        pairs = tasks.flatMap((task) => models.map((model) => ({ task, model })));
    } catch (error) {
        console.error(`${error.message}\n${USAGE}`);

        return 1;
    }

    const common = [
        "--manifest",
        values.manifest,
        "--stage",
        values.stage,
        ...(values["run-id"] ? ["--run-id", values["run-id"]] : []),
        ...passArgs(values),
    ];
    const children = new Set();
    const finished = [];
    const deferred = [];
    const budgetSkipped = [];
    const diskSkipped = [];
    let lease = null;

    if (pairs.some(({ model }) => providerOf(model.id) === "halogen")) {
        lease = await holdLease(
            values["lease-bin"],
            `bench ${values.stage}`,
            () => `${finished.length} of ${pairs.length} done`,
            () => stopChildren(children),
        );

        if (!lease.ok) {
            console.error("cannot take the halogen lease: the batch does not start");

            return 1;
        }
    } else {
        process.on("SIGINT", () => {
            stopChildren(children);
            process.exit(130);
        });
        process.on("SIGTERM", () => {
            stopChildren(children);
            process.exit(143);
        });
    }

    const queue = [...pairs];
    const live = new Set();
    let stopPriced = false;
    let diskLow = false;

    /** Start 1 pair; on its end, record its exit code. */
    const launch = (pair) => {
        const promise = runChild(
            [...common, "--task", pair.task.id, "--model", pair.model.id],
            children,
        ).then((code) => {
            live.delete(promise);

            // The disk is nearly full: nothing was spent, and no new pair starts (priced or unpriced).
            if (code === DISK_LOW_EXIT) {
                diskLow = true;
                diskSkipped.push(pair);

                return;
            }

            if (code === 2 && pair.model.peakUtc && inPeak(pair.model, new Date())) {
                queue.push(pair);

                return;
            }

            if (code === 2 && pair.model.priced) {
                stopPriced = true;
                budgetSkipped.push(pair);

                return;
            }

            finished.push({ ...pair, code });
        });

        live.add(promise);
    };

    try {
        while (queue.length || live.size) {
            while (live.size < values.parallel) {
                if (diskLow) {
                    diskSkipped.push(...queue.splice(0));
                    break;
                }

                for (let i = queue.length - 1; i >= 0; i -= 1) {
                    if (stopPriced && queue[i].model.priced) {
                        budgetSkipped.push(...queue.splice(i, 1));
                    }
                }

                const index = queue.findIndex(({ model }) => !inPeak(model, new Date()));

                if (index < 0) {
                    break;
                }

                launch(queue.splice(index, 1)[0]);
            }

            if (live.size) {
                await Promise.race(live);
                continue;
            }

            if (!queue.length) {
                break;
            }

            // Only pairs in their peak hours are left.
            if (!values["wait-peak"]) {
                deferred.push(...queue.splice(0));
                break;
            }

            const until = Math.max(...queue.map(({ model }) => peakEnds(model, new Date())));

            console.error(`waiting for the end of peak hours: ${new Date(until).toISOString()}`);
            await delay(Math.max(1_000, until - Date.now() + 60_000));
        }
    } finally {
        await lease?.release();
    }

    const results = [];

    for (const { task, model, code } of finished) {
        const file = resultPath(resultsDir(values.results), {
            stage: values.stage,
            task: task.id,
            model: model.id,
            runId: values["run-id"],
        });
        const result = await readJson(file, null);

        if (result) {
            results.push(result);
        } else {
            console.error(`no result: ${task.id} ${model.id} (exit ${code})`);
        }
    }

    console.log(
        `\n# Batch ${values.stage}: ${results.length} of ${pairs.length} pair(s) recorded\n`,
    );
    console.log(markdownTable(summarize(results)));

    for (const [what, list] of [
        ["Deferred (DeepSeek peak hours)", deferred],
        ["Not run (budget refused)", budgetSkipped],
        ["Not run (disk low)", diskSkipped],
    ]) {
        if (list.length) {
            console.log(
                `\n${what}: ${list.map(({ task, model }) => `${task.id} ${model.id}`).join("; ")}`,
            );
        }
    }

    return diskSkipped.length ? DISK_LOW_EXIT : budgetSkipped.length ? 2 : 0;
}

process.exitCode = await main();
