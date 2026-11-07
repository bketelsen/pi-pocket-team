#!/usr/bin/env node
// The halogen load test: the smallest pilot task on halogen at 1, 2, 3 and 4 parallel attempts, under the lease.
// For each level and round, `<data>/halogen.json` holds `{ concurrency: level }` while L children run. Then the rule
// of `lib/loadtest.mjs` picks the bench's halogen concurrency, written to `<data>/halogen.json` with the table.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, readJson, resultPath, resultsDir, writeJsonAtomic } from "./lib/common.mjs";
import { UsageError, loadManifest, loadModels } from "./lib/manifest.mjs";
import {
    LEASE_BIN,
    PASS_OPTIONS,
    holdLease,
    passArgs,
    runChild,
    stopChildren,
} from "./lib/drive.mjs";
import { chooseConcurrency, loadTable } from "./lib/loadtest.mjs";

const USAGE = `usage: node bench/load-test.mjs --manifest bench/pilot.json --task pilot-small
         [--levels 1,2,3,4] [--rounds 2] [--wall-limit 600000] [--prefix <s>] [--lease-bin <path>]
         and the run.mjs options --checkout, --pocket, --results, --agent-src, --bwrap, ...`;

/** A list of positive integers. */
function integers(text, what) {
    const list = text.split(",").map(Number);

    if (!list.length || list.some((n) => !Number.isInteger(n) || n < 1 || n > 4)) {
        throw new UsageError(`${what} must be integers from 1 to 4`);
    }

    return list;
}

async function main() {
    let values;
    let levels;
    let rounds;
    let model;

    try {
        ({ values } = parseArgs({
            options: {
                manifest: { type: "string" },
                task: { type: "string" },
                levels: { type: "string", default: "1,2,3,4" },
                rounds: { type: "string", default: "2" },
                prefix: { type: "string" },
                "lease-bin": { type: "string", default: LEASE_BIN },
                ...PASS_OPTIONS,
                "wall-limit": { type: "string", default: "600000" },
            },
        }));

        if (!values.manifest || !values.task) {
            throw new UsageError("--manifest and --task are required");
        }

        levels = integers(values.levels, "--levels");
        rounds = Number(values.rounds);

        if (!Number.isInteger(rounds) || rounds < 1) {
            throw new UsageError("--rounds must be an integer >= 1");
        }

        if (values.prefix !== undefined && !/^[A-Za-z0-9._-]{1,32}$/.test(values.prefix)) {
            throw new UsageError("--prefix must be 1 to 32 of A-Z a-z 0-9 . _ -");
        }

        const manifest = await loadManifest(values.manifest);

        if (!manifest.tasks.some((task) => task.id === values.task)) {
            throw new UsageError(`unknown task ${values.task}`);
        }

        model = (await loadModels()).find((m) => m.id.startsWith("halogen/"));

        if (!model) {
            throw new UsageError("no halogen model in bench/models.json");
        }
    } catch (error) {
        console.error(`${error.message}\n${USAGE}`);

        return 1;
    }

    const data = dataDir();
    const halogenFile = join(data, "halogen.json");
    const before = await readJson(halogenFile, null);
    const children = new Set();
    const total = levels.reduce((sum, level) => sum + level * rounds, 0);
    let done = 0;
    const lease = await holdLease(
        values["lease-bin"],
        "bench loadtest",
        () => `${done} of ${total} done`,
        () => stopChildren(children),
    );

    if (!lease.ok) {
        console.error("cannot take the halogen lease: the load test does not start");

        return 1;
    }

    const rows = [];
    let finished = false;

    try {
        for (const level of levels) {
            for (let round = 1; round <= rounds; round += 1) {
                await writeJsonAtomic(halogenFile, { concurrency: level });

                const runs = [];

                for (let attempt = 1; attempt <= level; attempt += 1) {
                    const runId = `${values.prefix ? `${values.prefix}-` : ""}L${level}-r${round}-${attempt}`;

                    runs.push(
                        runChild(
                            [
                                "--manifest",
                                values.manifest,
                                "--task",
                                values.task,
                                "--model",
                                model.id,
                                "--stage",
                                "loadtest",
                                "--run-id",
                                runId,
                                ...passArgs(values),
                            ],
                            children,
                        ).then(async (code) => {
                            done += 1;

                            const result = await readJson(
                                resultPath(resultsDir(values.results), {
                                    stage: "loadtest",
                                    task: values.task,
                                    model: model.id,
                                    runId,
                                }),
                                null,
                            );
                            let error = null;

                            if (!result) {
                                error = `no result (exit ${code})`;
                            } else if (result.harness) {
                                error = "harness";
                            } else if (result.failure === "provider") {
                                error = "provider";
                            }

                            return {
                                level,
                                round,
                                attempt,
                                outputTps: result?.stream?.outputTps ?? null,
                                ttftMs: result?.stream?.ttftMsFirst ?? null,
                                error,
                            };
                        }),
                    );
                }

                rows.push(...(await Promise.all(runs)));
            }
        }

        finished = true;
    } finally {
        if (!finished) {
            if (before) {
                await writeJsonAtomic(halogenFile, before);
            } else {
                await writeJsonAtomic(halogenFile, { concurrency: 1 });
            }
        }

        await lease.release();
    }

    const choice = chooseConcurrency(rows);

    await writeJsonAtomic(halogenFile, {
        concurrency: choice.concurrency,
        measuredAt: new Date().toISOString(),
        baselineTps: choice.baselineTps,
        table: rows,
    });

    console.log(`\n# Halogen load test: ${values.task}\n`);
    console.log(loadTable(rows));
    console.log(`\nChosen concurrency: ${choice.concurrency}`);

    for (const [level, { ok, why }] of Object.entries(choice.levels)) {
        console.log(`- level ${level}: ${ok ? "ok" : why}`);
    }

    return 0;
}

process.exitCode = await main();
