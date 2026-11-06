// The runner's command line, with a fake `pi` behind a fake `bwrap` (so these tests run where bwrap cannot): dry
// runs, usage errors, limits, provider errors, a missing final event, harness failures, the budget guard and
// idempotence. The sandbox's isolation is tested with the real bwrap in sandbox.test.mjs.
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { rm } from "node:fs/promises";
import {
    BENCH,
    PRICED,
    UNPRICED,
    fixtureArgs,
    fixtureTask,
    makeFixture,
    processesWith,
    readResult,
    runScript,
    setBudget,
    sleepMarker,
    testEnv,
    waitFor,
    writeManifest,
} from "./fixtures/helpers.mjs";

const PILOT = join(BENCH, "pilot.json");
let fixture;
let manifest;
const markers = { cost: sleepMarker(), wall: sleepMarker() };

before(async () => {
    fixture = makeFixture();
    manifest = writeManifest(fixture, [
        fixtureTask(fixture, "ok", { name: "ok" }),
        fixtureTask(fixture, "ok-again", { name: "ok" }),
        fixtureTask(fixture, "cost", { name: "cost", marker: markers.cost }),
        fixtureTask(fixture, "wall", { name: "hang", marker: markers.wall }),
        fixtureTask(fixture, "error-then-ok", { name: "error-then-ok" }),
        fixtureTask(fixture, "always-error", { name: "always-error" }),
        fixtureTask(fixture, "no-final", { name: "no-final" }),
        fixtureTask(fixture, "bad-setup", { name: "ok" }, { setup: "exit 1" }),
        fixtureTask(fixture, "budget", { name: "ok" }),
    ]);
    await setBudget(fixture, 100);
});

after(() => rm(fixture.root, { recursive: true, force: true }));

/** Run the runner on the fixture. */
const run = (task, model = PRICED, extra = []) =>
    runScript(
        "run.mjs",
        [...fixtureArgs(fixture, manifest), "--task", task, "--model", model, ...extra],
        testEnv(fixture),
    );

/** The spend file of the fixture. */
const spend = () => JSON.parse(readFileSync(join(fixture.data, "spend.json"), "utf8"));

test("a dry run of each pilot task exits 0 with no data dir and no bwrap", async () => {
    const data = join(fixture.root, "no-data");

    for (const task of ["pilot-small", "pilot-medium", "pilot-large"]) {
        const result = await runScript(
            "run.mjs",
            [
                "--manifest",
                PILOT,
                "--task",
                task,
                "--model",
                PRICED,
                "--stage",
                "pilot",
                "--dry-run",
                "--bwrap",
                "/nonexistent/bwrap",
                "--agent-src",
                join(fixture.root, "no-agent"),
                "--results",
                fixture.results,
            ],
            testEnv(fixture, { BENCH_DATA: data }),
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /budget: no budget set/);
        assert.match(result.stdout, /attempt argv: \["\/nonexistent\/bwrap","--unshare-pid"/);
        assert.match(result.stdout, /:high","--no-extensions","--no-skills","--no-mcp"/);
    }

    assert.equal(existsSync(data), false, "a dry run makes no data dir");
});

test("usage errors exit 1", async (t) => {
    const cases = {
        "a bad argument": ["--task", "ok", "--model", PRICED, "--bogus"],
        "an unknown task": ["--task", "nope", "--model", PRICED],
        "a model not in bench/models.json": ["--task", "ok", "--model", "openai/gpt-6-astra"],
        "halogen without the lease": ["--task", "ok", "--model", UNPRICED],
        "a bad stage": ["--task", "ok", "--model", PRICED, "--stage", "stage9"],
        "a missing bwrap": ["--task", "ok", "--model", PRICED, "--bwrap", "/nonexistent/bwrap"],
    };

    for (const [name, args] of Object.entries(cases)) {
        await t.test(name, async () => {
            const result = await runScript(
                "run.mjs",
                [...fixtureArgs(fixture, manifest), ...args],
                testEnv(fixture),
            );

            assert.equal(result.code, 1, result.stdout + result.stderr);
            assert.match(result.stderr, /usage: node bench\/run.mjs/);
        });
    }
});

test("halogen runs with the lease of thread T1064", async () => {
    mkdirSync(join(fixture.leases, "halogen"), { recursive: true });
    writeFileSync(join(fixture.leases, "halogen", "info"), "resource=halogen\nthread=T1064\n");

    try {
        const result = await run("ok", UNPRICED);

        assert.equal(result.code, 0, result.stderr);

        const record = readResult(fixture, "pilot", "ok", UNPRICED);

        assert.equal(record.priced, false);
        assert.equal(record.usage.tokens, 150);
        assert.equal(record.priceMissing, false);
    } finally {
        await rm(join(fixture.leases, "halogen"), { recursive: true, force: true });
    }
});

test("an attempt records its result, and a second run does nothing", async () => {
    const first = await run("ok-again");

    assert.equal(first.code, 0, first.stderr);

    const record = readResult(fixture, "pilot", "ok-again", PRICED);

    assert.deepEqual(
        {
            failure: record.failure,
            harness: record.harness,
            tries: record.tries,
            cost: record.usage.cost,
        },
        { failure: null, harness: false, tries: 1, cost: 0.01 },
    );
    assert.equal(record.thinking, "high");
    assert.equal(record.headerVersion, 1);
    assert.equal(record.priced, true);
    assert.equal(record.s0, null);
    assert.ok(existsSync(join(record.workDir, "pi-ran.txt")));

    const events = readFileSync(join(record.workDir, "..", "events.jsonl"), "utf8").split("\n");

    assert.ok(events.some((line) => line.includes('"agent_settled"')));

    // A bwrap that leaves a mark: the second run must not start it.
    const mark = join(fixture.root, "started");
    const tripwire = join(fixture.root, "tripwire.sh");

    writeFileSync(tripwire, `#!/bin/sh\ntouch '${mark}'\nexit 1\n`);
    chmodSync(tripwire, 0o755);

    const second = await run("ok-again", PRICED, ["--bwrap", tripwire]);

    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^exists /);
    assert.equal(existsSync(mark), false, "pi was not started");
});

test("a cost over the limit kills the whole process group: failure limit", async () => {
    const result = await run("cost", PRICED, ["--cost-limit", "0.5"]);

    assert.equal(result.code, 0, result.stderr);

    const record = readResult(fixture, "pilot", "cost", PRICED);

    assert.equal(record.failure, "limit");
    assert.equal(record.usage.partial, true);
    assert.ok(record.usage.cost > 0.5);
    assert.ok(Number(readFileSync(join(record.workDir, "bg.pid"), "utf8")) > 0);
    await waitFor(
        () => processesWith(markers.cost).length === 0,
        10_000,
        "the background child to end",
    );
});

test("a run past the wall limit is killed with its group: failure limit", async () => {
    const result = await run("wall", PRICED, ["--wall-limit", "1000"]);

    assert.equal(result.code, 0, result.stderr);

    const record = readResult(fixture, "pilot", "wall", PRICED);

    assert.equal(record.failure, "limit");
    assert.equal(record.tryLog[0].outcome, "limit");
    assert.ok(record.tryLog[0].signal === "SIGTERM" || record.tryLog[0].exitCode !== 0);
    await waitFor(
        () => processesWith(markers.wall).length === 0,
        10_000,
        "the background child to end",
    );
});

test("a provider error is retried once on a fresh clone; both tries count", async () => {
    const result = await run("error-then-ok");

    assert.equal(result.code, 0, result.stderr);

    const record = readResult(fixture, "pilot", "error-then-ok", PRICED);

    assert.equal(record.tries, 2);
    assert.equal(record.failure, null);
    assert.deepEqual(
        record.tryLog.map((entry) => entry.outcome),
        ["provider", "ok"],
    );
    assert.equal(record.usage.cost, 0.02);
    assert.equal(record.usage.tokens, 300);
    assert.match(record.workDir, /try-2\/work$/);
    assert.deepEqual(JSON.parse(readFileSync(join(record.workDir, "fresh.json"), "utf8")), {
        try1Present: false,
    });
});

test("a provider error on the retry too: failure provider", async () => {
    await run("always-error");

    const record = readResult(fixture, "pilot", "always-error", PRICED);

    assert.equal(record.failure, "provider");
    assert.equal(record.tries, 2);
    assert.equal(record.usage.tokens, 300);
});

test("a stream with no final event keeps the usage seen, flagged partial", async () => {
    await run("no-final");

    const record = readResult(fixture, "pilot", "no-final", PRICED);

    assert.equal(record.usage.partial, true);
    assert.equal(record.usage.tokens, 15);
    assert.equal(record.usage.cost, 0.002);
    assert.equal(record.failure, null);
});

test("a failing setup is a harness failure: 3 tries, then exit 3", async () => {
    const result = await run("bad-setup");

    assert.equal(result.code, 3, result.stderr);

    const record = readResult(fixture, "pilot", "bad-setup", PRICED);

    assert.equal(record.harness, true);
    assert.equal(record.tries, 3);
    assert.deepEqual(
        record.tryLog.map((entry) => entry.outcome),
        ["harness", "harness", "harness"],
    );
    assert.equal(spend().reservations.length, 0, "every try settled");
});

test("the budget guard refuses with exit 2 and spends nothing", async () => {
    const before = spend();
    const free = before.budget - before.settled;

    // A cap over what is left: refused before anything starts.
    const result = await run("budget", PRICED, ["--cost-limit", String(free + 1)]);

    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /budget refused/);
    assert.deepEqual(spend(), before);
    assert.equal(existsSync(join(fixture.data, "runs", "pilot", "budget")), false);
    assert.ok(!readdirSync(join(fixture.results, "pilot")).includes("budget"));
});
