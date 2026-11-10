// The drivers: the load test's concurrency rule, and smoke runs of batch.mjs, load-test.mjs and report.mjs with
// the fake `pi`, the fake `bwrap` and a fake lease tool.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chooseConcurrency } from "./lib/loadtest.mjs";
import { inPeak, peakEnds } from "./lib/manifest.mjs";
import {
    PRICED,
    UNPRICED,
    fixtureArgs,
    fixtureTask,
    makeFixture,
    runScript,
    setBudget,
    testEnv,
    writeManifest,
} from "./fixtures/helpers.mjs";

const FAKE_LEASE = join(import.meta.dirname, "fixtures", "fake-lease.sh");

const row = (level, attempt, outputTps, error = null) => ({
    level,
    round: 1,
    attempt,
    outputTps,
    ttftMs: 100,
    error,
});

test("concurrency: the highest level with no error and every attempt at 70% of level 1", () => {
    const rows = [
        row(1, 1, 100),
        row(1, 2, 80),
        row(2, 1, 70),
        row(2, 2, 64),
        row(3, 1, 63),
        row(3, 2, 70),
        row(4, 1, 90),
        row(4, 2, 30),
    ];
    const choice = chooseConcurrency(rows);

    // Mean level 1 = 90; 70% = 63.
    assert.equal(choice.baselineTps, 90);
    assert.equal(choice.concurrency, 3);
    assert.equal(choice.levels[2].ok, true);
    assert.equal(choice.levels[4].ok, false);
});

test("concurrency: an error fails its level; at least 1; never above 4", () => {
    assert.equal(chooseConcurrency([row(1, 1, 50), row(2, 1, 50, "provider")]).concurrency, 1);
    assert.equal(chooseConcurrency([row(1, 1, null, "harness")]).concurrency, 1);
    assert.equal(chooseConcurrency([]).concurrency, 1);
    assert.equal(chooseConcurrency([row(1, 1, 50), row(4, 1, 50), row(5, 1, 50)]).concurrency, 4);
    assert.equal(chooseConcurrency([row(1, 1, 50), row(2, 1, null)]).concurrency, 1);
});

test("DeepSeek's peak hours (UTC 01-04 and 06-10)", () => {
    const model = {
        peakUtc: [
            [1, 4],
            [6, 10],
        ],
    };

    assert.equal(inPeak(model, new Date("2026-11-06T00:59:00Z")), false);
    assert.equal(inPeak(model, new Date("2026-11-06T01:00:00Z")), true);
    assert.equal(inPeak(model, new Date("2026-11-06T04:00:00Z")), false);
    assert.equal(inPeak(model, new Date("2026-11-06T09:59:00Z")), true);
    assert.equal(
        peakEnds(model, new Date("2026-11-06T07:30:00Z")).toISOString(),
        "2026-11-06T10:00:00.000Z",
    );
    assert.equal(inPeak({}, new Date("2026-11-06T02:00:00Z")), false);
});

let fixture;
let manifest;

before(async () => {
    fixture = makeFixture();
    manifest = writeManifest(fixture, [
        fixtureTask(fixture, "a", { name: "ok" }),
        fixtureTask(fixture, "b", { name: "ok" }),
        fixtureTask(fixture, "small", { name: "slow-ok" }),
    ]);
    await setBudget(fixture, 100);
});

after(() => rm(fixture.root, { recursive: true, force: true }));

/** The runner options for a driver: the fixture's, without --stage and --manifest. */
const driverArgs = () =>
    fixtureArgs(fixture, manifest).filter(
        (arg, i, all) =>
            !["--stage", "--manifest"].includes(arg) &&
            !["--stage", "--manifest"].includes(all[i - 1]),
    );

test("batch: every pair, the halogen lease taken and released, and a table", async () => {
    const result = await runScript(
        "batch.mjs",
        [
            "--manifest",
            manifest,
            "--stage",
            "pilot",
            "--tasks",
            "a,b",
            "--models",
            `${PRICED},${UNPRICED}`,
            "--parallel",
            "2",
            "--lease-bin",
            FAKE_LEASE,
            ...driverArgs(),
        ],
        testEnv(fixture),
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /4 of 4 pair\(s\) recorded/);
    assert.match(
        result.stdout,
        /\| github-copilot\/gpt-6-luna \| 2 \| 0 \| 0 \| 0 \| 0 \| 0\.0200 \|/,
    );
    assert.match(result.stdout, /\| halogen\/halogen-qwen3\.8-flash-next \| 2 \|/);

    const calls = readFileSync(join(fixture.leases, "calls.log"), "utf8");

    assert.match(calls, /^take halogen T1064 bench pilot$/m);
    assert.match(calls, /^release halogen T1064/m);
    assert.equal(existsSync(join(fixture.leases, "halogen")), false);

    const report = await runScript(
        "report.mjs",
        ["--stage", "pilot", "--results", fixture.results],
        testEnv(fixture),
    );

    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /4 attempt\(s\)/);
    assert.match(report.stdout, /Total list cost: \$0\.0200/);
});

test("batch: unknown model is a usage error", async () => {
    const result = await runScript(
        "batch.mjs",
        ["--manifest", manifest, "--stage", "pilot", "--models", "nope/x"],
        testEnv(fixture),
    );

    assert.equal(result.code, 1);
});

test("batch: a child's disk-low exit (4) stops every new launch; the pairs left are listed; exit 4", async () => {
    const result = await runScript(
        "batch.mjs",
        [
            "--manifest",
            manifest,
            "--stage",
            "pilot",
            "--tasks",
            "a,b",
            // The unpriced pair (a, UNPRICED) waits after the first pair.
            "--models",
            `${PRICED},${UNPRICED}`,
            "--parallel",
            "1",
            "--run-id",
            "disk-low",
            "--lease-bin",
            FAKE_LEASE,
            ...driverArgs(),
        ],
        // 10^9 GB: more than any disk has, so every child exits 4.
        testEnv(fixture, { BENCH_MIN_FREE_GB: "1000000000" }),
    );

    assert.equal(result.code, 4, result.stderr);
    assert.equal(
        result.stderr.match(/^disk low: /gm)?.length,
        1,
        "only the first child ran: " + result.stderr,
    );
    assert.match(result.stdout, /0 of 4 pair\(s\) recorded/);
    assert.match(
        result.stdout,
        new RegExp(
            `^Not run \\(disk low\\): a ${PRICED}; a ${UNPRICED}; b ${PRICED}; b ${UNPRICED}$`,
            "m",
        ),
    );
});

test("load test: levels and rounds under the lease, then halogen.json", async () => {
    const result = await runScript(
        "load-test.mjs",
        [
            "--manifest",
            manifest,
            "--task",
            "small",
            "--levels",
            "1,2",
            "--rounds",
            "1",
            "--lease-bin",
            FAKE_LEASE,
            ...driverArgs(),
        ],
        testEnv(fixture),
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Chosen concurrency: [12]/);

    const halogen = JSON.parse(readFileSync(join(fixture.data, "halogen.json"), "utf8"));

    assert.ok([1, 2].includes(halogen.concurrency));
    assert.deepEqual(
        halogen.table.map((r) => [r.level, r.round, r.attempt, r.error]),
        [
            [1, 1, 1, null],
            [2, 1, 1, null],
            [2, 1, 2, null],
        ],
    );
    // The rate depends on when the runner reads each event line: on a loaded host 2 lines can come in 1 read, and then
    // a row has no rate (#182). The rate rule and the stream timing have their own tests with fixed numbers.
    assert.ok(
        halogen.table.every((r) => r.outputTps === null || r.outputTps > 0),
        JSON.stringify(halogen.table),
    );
    assert.ok(
        existsSync(
            join(
                fixture.results,
                "loadtest",
                "small",
                `${UNPRICED.replaceAll("/", "__")}--L2-r1-2.json`,
            ),
        ),
    );
    assert.equal(existsSync(join(fixture.leases, "halogen")), false, "lease released");
});
