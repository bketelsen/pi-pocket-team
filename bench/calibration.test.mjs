// The judge calibration's instrument: the plan (4 models per task by price group, seeded), the replacements, the
// driver (budget, peak hours, a stuck action), and an end-to-end run with the fake `pi` and the fake `bwrap`: the
// attempts in stage `calibration`, their checks with no judge, a pilot task from pilot results, the blind packs and
// the keys. No network, no model.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    ITEM_FIELDS,
    MAX_REPLACEMENTS,
    PRICE_GROUPS,
    buildPlan,
    drive,
    nextModel,
    outcomeOf,
    rankPilot,
    resolveTask,
} from "./lib/calibration.mjs";
import { calibrationMain } from "./lib/calibration-cli.mjs";
import { seededShuffle } from "./lib/owners.mjs";
import {
    FAKE_BWRAP,
    fixtureTask,
    makeFixture,
    runScript,
    setBudget,
    testEnv,
} from "./fixtures/helpers.mjs";

const FAKE_LEASE = join(import.meta.dirname, "fixtures", "fake-lease.sh");

// A decoy data dir for this process: a child that does not get the CLI's environment writes here, never to a real one.
const LEAK = mkdtempSync(join(tmpdir(), "bench-calibration-leak-"));

process.env.BENCH_DATA = LEAK;
const POOL = JSON.parse(readFileSync(join(import.meta.dirname, "pool-v1.json"), "utf8"));
const ALL = [...PRICE_GROUPS.cheap, ...PRICE_GROUPS.middle, ...PRICE_GROUPS.dear];
const groupOf = (model) => Object.keys(PRICE_GROUPS).find((g) => PRICE_GROUPS[g].includes(model));

test("the plan: 4 models per task (2 cheap, 1 middle, 1 dear), seeded, balanced, and the pilot for Sheeana", () => {
    const pilot = ["pilot-small", "pilot-medium", "pilot-large"];
    const plan = buildPlan(POOL, pilot, (id) => `~/agents/x/bench/${id.split("-")[0]}.json`);
    const pool = plan.tasks.filter((t) => t.source === "pool");
    const fromPilot = plan.tasks.filter((t) => t.source === "pilot");

    assert.equal(plan.seed, 1064);
    assert.equal(plan.maxReplacements, MAX_REPLACEMENTS);
    assert.deepEqual(
        pool.map((t) => t.id),
        POOL.calibration.ids,
    );
    assert.equal(pool.length, 12);
    assert.deepEqual(
        fromPilot.map((t) => [t.id, t.owner, t.set, t.manifest]),
        rankPilot(pilot).map((id, i) => [
            id,
            "sheeana",
            i < 2 ? "heldOut" : "dev",
            "bench/pilot.json",
        ]),
    );

    for (const task of plan.tasks) {
        assert.deepEqual(task.models.map(groupOf), ["cheap", "cheap", "middle", "dear"]);
        assert.equal(new Set(task.models).size, 4, `${task.id}: 4 different models`);
    }

    // Each owner: 1 dev task and 2 held-out tasks, as the pool says.
    for (const [owner, sets] of Object.entries(POOL.calibration.owners)) {
        const mine = plan.tasks.filter((t) => t.owner === owner);

        assert.deepEqual(
            mine.filter((t) => t.set === "dev").map((t) => t.id),
            sets.dev,
        );
        assert.deepEqual(
            mine
                .filter((t) => t.set === "heldOut")
                .map((t) => t.id)
                .sort(),
            [...sets.heldOut].sort(),
        );
    }

    // The 48 attempts: every model has 4 to 6 of them; in a group, the counts differ by 1 at most.
    const count = (tasks) => {
        const out = Object.fromEntries(ALL.map((m) => [m, 0]));

        for (const task of tasks) {
            for (const model of task.models) {
                out[model] += 1;
            }
        }

        return out;
    };

    const attempts = count(pool);

    assert.equal(
        Object.values(attempts).reduce((a, b) => a + b),
        48,
    );

    for (const [group, models] of Object.entries(PRICE_GROUPS)) {
        const counts = models.map((m) => attempts[m]);

        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${group}: ${counts}`);
        assert.ok(
            counts.every((n) => n >= 4 && n <= 6),
            `${group}: ${counts}`,
        );
    }

    // The same inputs give the same plan.
    assert.deepEqual(
        buildPlan(POOL, pilot, (id) => `~/agents/x/bench/${id.split("-")[0]}.json`),
        plan,
    );
});

test("the next model of a group: after the failed one, in the group's order, not used on the task", () => {
    const order = ["a", "b", "c", "d"];

    assert.equal(nextModel(order, "b", new Set(["a", "b"])), "c");
    assert.equal(nextModel(order, "d", new Set(["d", "a"])), "b");
    assert.equal(nextModel(order, "a", new Set(order)), null);
});

const GROUPS = { cheap: ["c1", "c2", "c3", "c4"], middle: ["m1", "m2"], dear: ["d1", "d2", "d3"] };
const TASK = {
    id: "t",
    slots: ["cheap", "cheap", "middle", "dear"],
    models: ["c1", "c2", "m1", "d1"],
};

test("replacements: the next model of the group; at most 2 per task; never while a slot waits", () => {
    const states = (outcomes) => resolveTask(TASK, GROUPS, (m) => outcomes[m] ?? "run");

    // All checked: 4 items, no replacement.
    const ok = states({ c1: "ok", c2: "ok", m1: "ok", d1: "ok" });

    assert.deepEqual(
        ok.slots.map((s) => s.state),
        ["ok", "ok", "ok", "ok"],
    );
    assert.equal(ok.replacements, 0);

    // A slot waits (d1 not run): the excluded c1 gets no replacement yet.
    const early = states({ c1: "excluded", c2: "ok", m1: "ok" });

    assert.deepEqual(early.waiting, [{ model: "d1", need: "run" }]);
    assert.deepEqual(early.slots[0].chain, ["c1"]);

    // c1 excluded: c3 replaces it (c2 is used); then c3 waits for its run.
    const one = states({ c1: "excluded", c2: "ok", m1: "ok", d1: "ok" });

    assert.deepEqual(one.slots[0].chain, ["c1", "c3"]);
    assert.deepEqual(one.waiting, [{ model: "c3", need: "run" }]);
    assert.equal(one.replacements, 1);

    // c1, m1 and d1 excluded: 2 replacements in slot order (c3, m2), then d1's item is missing.
    const capped = states({
        c1: "excluded",
        c2: "ok",
        m1: "excluded",
        d1: "excluded",
        c3: "ok",
        m2: "ok",
    });

    assert.deepEqual(
        capped.slots.map((s) => [s.chain, s.state]),
        [
            [["c1", "c3"], "ok"],
            [["c2"], "ok"],
            [["m1", "m2"], "ok"],
            [["d1"], "missing"],
        ],
    );
    assert.equal(capped.replacements, 2);
    assert.deepEqual(capped.waiting, []);

    // A replacement that fails too takes the 2nd replacement; then the slot is missing.
    const chain = states({
        c1: "excluded",
        c2: "ok",
        m1: "ok",
        d1: "ok",
        c3: "excluded",
        c4: "excluded",
    });

    assert.deepEqual(chain.slots[0].chain, ["c1", "c3", "c4"]);
    assert.equal(chain.slots[0].state, "missing");

    // The middle group has 2 models: with both used, a failed middle slot is missing.
    const none = states({ c1: "ok", c2: "ok", m1: "excluded", d1: "ok", m2: "excluded" });

    assert.deepEqual(none.slots[2].chain, ["m1", "m2"]);
    assert.equal(none.slots[2].state, "missing");
});

test("outcomes: no result runs, failures are excluded, unchecked results wait for the check", () => {
    const task = { hiddenCommand: null };

    assert.equal(outcomeOf(null, task), "run");
    assert.equal(outcomeOf({ harness: true }, task), "excluded");

    for (const failure of ["limit", "provider", "protocol"]) {
        assert.equal(outcomeOf({ failure, s0: { protocol: false } }, task), "excluded");
    }

    assert.equal(outcomeOf({ failure: null, s0: null }, task), "check");
    assert.equal(outcomeOf({ failure: null, s0: {}, s1: true, diffFile: "x" }, task), "ok");
    assert.equal(
        outcomeOf({ failure: null, s0: {}, s1: true, diffFile: "x", scoreError: "e" }, task),
        "check",
    );
    assert.equal(
        outcomeOf({ failure: null, s0: {}, s1: true, diffFile: "x" }, { hiddenCommand: "x" }),
        "check",
    );
});

/** A driver on a plan of 1 task, with outcomes in a map and fake actions. */
function fakeDrive({
    models = {},
    onRun = () => 0,
    onCheck = () => 0,
    now = Date.UTC(2026, 10, 7, 12),
} = {}) {
    const outcomes = new Map();
    const calls = [];
    const plan = { groups: GROUPS, tasks: [{ ...TASK, source: "pool" }] };

    return {
        calls,
        outcomes,
        run: () =>
            drive(plan, {
                parallel: 2,
                waitPeak: false,
                now: () => now,
                wait: async () => {},
                log: () => {},
                peakEnds: () => new Date(now + 3_600_000),
                model: (id) => ({ id, priced: true, ...models[id] }),
                lease: async () => true,
                outcome: (task, model) => outcomes.get(model) ?? "run",
                run: async (task, model) => {
                    calls.push(["run", model]);

                    const code = onRun(model);

                    if (code === 0) {
                        outcomes.set(model, model === "c1" ? "excluded" : "check");
                    }

                    return code;
                },
                check: async (task, model) => {
                    calls.push(["check", model]);

                    const code = onCheck(model);

                    if (code === 0) {
                        outcomes.set(model, "ok");
                    }

                    return code;
                },
            }),
    };
}

test("the driver: runs, checks, a replacement after a failure, and the end state", async () => {
    const fake = fakeDrive();
    const result = await fake.run();

    assert.deepEqual(
        result.tasks[0].slots.map((s) => [s.chain, s.state]),
        [
            [["c1", "c3"], "ok"],
            [["c2"], "ok"],
            [["m1"], "ok"],
            [["d1"], "ok"],
        ],
    );
    assert.equal(fake.calls.filter(([what]) => what === "run").length, 5);
    assert.deepEqual(
        fake.calls
            .filter(([what]) => what === "check")
            .map(([, m]) => m)
            .sort(),
        ["c2", "c3", "d1", "m1"],
    );
    assert.equal(result.stuck.size, 0);
    assert.equal(result.budgetRefused, false);
});

test("the driver: a budget refusal stops priced runs; peak hours defer; a usage error is stuck", async () => {
    const refused = await fakeDrive({ onRun: (m) => (m === "c2" ? 2 : 0) }).run();

    assert.equal(refused.budgetRefused, true);
    assert.ok(refused.tasks[0].waiting.some((w) => w.model === "c2" && w.need === "run"));

    const peak = fakeDrive({ models: { d1: { peakUtc: [[0, 24]] } } });
    const deferred = await peak.run();

    assert.deepEqual(deferred.deferred, ["t\nd1"]);
    assert.ok(!peak.calls.some(([what, m]) => what === "run" && m === "d1"));

    const usage = await fakeDrive({ onCheck: (m) => (m === "m1" ? 1 : 0) }).run();

    assert.deepEqual([...usage.stuck.keys()], ["t\nm1"]);

    // A scoring error gets 1 more check; a second one is stuck.
    const flaky = fakeDrive({ onCheck: (m) => (m === "d1" ? 3 : 0) });
    const twice = await flaky.run();

    assert.equal(flaky.calls.filter(([what, m]) => what === "check" && m === "d1").length, 2);
    assert.deepEqual([...twice.stuck.keys()], ["t\nd1"]);
});

test("the driver: a disk-low run (exit 4) stops every new run, priced or not", async () => {
    const fake = fakeDrive({ onRun: (m) => (m === "c1" ? 4 : 0) });
    const result = await fake.run();
    const runs = fake.calls.filter(([what]) => what === "run").map(([, m]) => m);

    assert.equal(result.diskLow, true);
    assert.equal(result.budgetRefused, false);
    assert.equal(result.stuck.size, 0, "a low disk is no stuck action");
    assert.ok(!runs.includes("c3"), "no replacement run starts");
    assert.ok(runs.length <= 2, `only the runs already live end: ${runs}`);
    assert.ok(result.tasks[0].waiting.some((w) => w.model === "c1" && w.need === "run"));
});

// ---------------------------------------------------------------------------------------------------------------
// End to end: the CLI with the fake pi and the fake bwrap.
// ---------------------------------------------------------------------------------------------------------------

let fixture;
let dir;
const E2E_GROUPS = {
    cheap: [
        "github-copilot/gpt-6-luna",
        "github-copilot/mai-code-2-flash",
        "halogen/halogen-qwen3.8-flash-next",
    ],
    middle: ["github-copilot/gemini-3.8-flash", "github-copilot/grok-4.7"],
    dear: ["github-copilot/claude-sonnet-5.5", "github-copilot/gpt-6.1-sol"],
};
const FAILS = "github-copilot/mai-code-2-flash";

before(async () => {
    fixture = makeFixture();
    dir = join(fixture.root, "calibration");
    await setBudget(fixture, 100);

    const scenario = { name: "ok", byModel: { [FAILS]: "always-error" } };
    const manifest = join(fixture.root, "owner.json");
    const pilotManifest = join(fixture.root, "pilot.json");

    writeFileSync(
        manifest,
        JSON.stringify({
            schema: 1,
            checkout: fixture.repo,
            tasks: ["a", "b", "c"].map((id) => fixtureTask(fixture, id, scenario)),
        }),
    );
    writeFileSync(
        pilotManifest,
        JSON.stringify({
            schema: 1,
            stage: "pilot",
            checkout: fixture.repo,
            tasks: [fixtureTask(fixture, "p", { name: "ok" })],
        }),
    );

    // The pilot ran 2 models on task p; Claude Sonnet ended at a limit there.
    for (const [model, name] of [
        ["github-copilot/gpt-6-luna", "ok"],
        ["github-copilot/claude-sonnet-5.5", "always-error"],
    ]) {
        const pilotTask = fixtureTask(fixture, "p", { name });

        writeFileSync(
            join(fixture.root, `pilot-${name}.json`),
            JSON.stringify({ schema: 1, checkout: fixture.repo, tasks: [pilotTask] }),
        );

        const ran = await runScript(
            "run.mjs",
            [
                "--manifest",
                join(fixture.root, `pilot-${name}.json`),
                "--task",
                "p",
                "--model",
                model,
                "--stage",
                "pilot",
                "--results",
                join(fixture.root, "pilot-results"),
                "--checkout",
                fixture.repo,
                "--pocket",
                fixture.pocket,
                "--agent-src",
                fixture.agent,
                "--no-auth-preflight",
                "--bwrap",
                FAKE_BWRAP,
            ],
            testEnv(fixture),
        );

        assert.equal(ran.code, 0, ran.stderr);
    }

    // Luna's pilot result was scored before, with an S1 that the current manifest does not give: it must not count.
    const lunaPilot = join(
        fixture.root,
        "pilot-results",
        "pilot",
        "p",
        "github-copilot__gpt-6-luna.json",
    );

    writeFileSync(
        lunaPilot,
        JSON.stringify({
            ...JSON.parse(readFileSync(lunaPilot, "utf8")),
            s0: { protocol: false, leakTry: false },
            s1: false,
            s2: null,
            diffFile: "/nowhere.diff",
            checksOnly: true,
            judgePending: true,
            grades: [null, null],
        }),
    );

    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "plan.json"),
        JSON.stringify({
            schema: 1,
            seed: 1064,
            groups: E2E_GROUPS,
            maxReplacements: 2,
            tasks: [
                ...[
                    ["a", "heldOut", "github-copilot/gpt-6-luna", FAILS],
                    ["b", "heldOut", FAILS, "halogen/halogen-qwen3.8-flash-next"],
                    ["c", "dev", "github-copilot/gpt-6-luna", "halogen/halogen-qwen3.8-flash-next"],
                ].map(([id, set, c1, c2]) => ({
                    id,
                    owner: "irulan",
                    set,
                    source: "pool",
                    manifest,
                    slots: ["cheap", "cheap", "middle", "dear"],
                    models: [
                        c1,
                        c2,
                        "github-copilot/gemini-3.8-flash",
                        "github-copilot/gpt-6.1-sol",
                    ],
                })),
                {
                    id: "p",
                    owner: "sheeana",
                    set: "dev",
                    source: "pilot",
                    manifest: pilotManifest,
                    slots: ["cheap", "cheap", "middle", "dear"],
                    models: [
                        "github-copilot/gpt-6-luna",
                        FAILS,
                        "github-copilot/gemini-3.8-flash",
                        "github-copilot/claude-sonnet-5.5",
                    ],
                },
            ],
        }),
    );
});

after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(LEAK, { recursive: true, force: true });
});

/** Run the CLI on the fixture. */
const cli = (args) => {
    const out = [];
    const err = [];

    return calibrationMain(
        [...args, "--dir", dir, "--pilot-results", join(fixture.root, "pilot-results")],
        testEnv(fixture),
        { log: (line) => err.push(line), print: (text) => out.push(text) },
    ).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
};

// A timeout: a driver that never ends (a lease that is never taken, say) fails here at once, never hangs the suite.
test(
    "end to end: attempts in stage calibration, checks with no judge, replacements, pilot items, packs and keys",
    { timeout: 120_000 },
    async () => {
        // In this process, with the fixture's environment: every child (run.mjs, score.mjs, the lease tool) must get it.
        const run = await cli([
            "run",
            "--parallel",
            "3",
            "--lease-bin",
            FAKE_LEASE,
            "--checkout",
            fixture.repo,
            "--pocket",
            fixture.pocket,
            "--agent-src",
            fixture.agent,
            "--no-auth-preflight",
            "--bwrap",
            FAKE_BWRAP,
            "--kill-grace",
            "2000",
        ]);

        assert.equal(run.code, 0, `${run.out}\n${run.err}`);
        assert.ok(
            existsSync(join(fixture.data, "runs", "calibration", "a")),
            "the runs are in the fixture's data dir",
        );
        assert.deepEqual(
            readdirSync(LEAK),
            [],
            "no child wrote to the data dir of this process's environment",
        );
        assert.match(
            readFileSync(join(fixture.leases, "calls.log"), "utf8"),
            /^take halogen T1064 bench calibration$/m,
        );

        const results = join(dir, "results");
        const calibration = join(results, "calibration");
        const read = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

        // Every attempt of a pool task is in stage calibration; MAI-Code's provider failures stay in the record.
        for (const task of ["a", "b", "c"]) {
            for (const name of readdirSync(join(calibration, task))) {
                assert.equal(read(calibration, task, name).stage, "calibration");
            }
        }

        const failed = read(calibration, "a", "github-copilot__mai-code-2-flash.json");

        assert.equal(failed.failure, "provider");
        assert.equal(failed.checksOnly, undefined, "a failed attempt is not checked");

        // a: MAI-Code failed, halogen (next cheap after it, not used on a) replaced it.
        const a = read(calibration, "a", "halogen__halogen-qwen3.8-flash-next.json");

        assert.equal(a.checksOnly, true);
        assert.equal(a.s1, true);
        assert.deepEqual(a.grades, [null, null]);
        assert.equal(a.judgePending, true);
        assert.equal(existsSync(join(fixture.data, "judges")), false, "no judge ran");

        // b: MAI-Code failed, Luna replaced it (halogen is used on b).
        assert.equal(read(calibration, "b", "github-copilot__gpt-6-luna.json").checksOnly, true);

        // p (pilot): Luna's pilot result is copied and checked. MAI-Code and Gemini have no pilot attempt, and Sonnet's
        // ended in a provider failure: halogen replaces MAI-Code and Grok replaces Gemini (the 2 replacements), both
        // with no pilot attempt either, so those slots and Sonnet's are missing.
        const pilotCopy = read(results, "pilot", "p", "github-copilot__gpt-6-luna.json");

        assert.equal(pilotCopy.stage, "pilot");
        assert.equal(pilotCopy.checksOnly, true);
        assert.equal(pilotCopy.s1, true, "checked again by the current manifest");
        assert.equal(
            read(fixture.root, "pilot-results", "pilot", "p", "github-copilot__gpt-6-luna.json").s1,
            false,
            "the pilot's own result never changes",
        );

        const status = await cli(["status"]);

        assert.equal(status.code, 0);
        assert.match(
            status.out,
            /\| a \| irulan \| heldOut \| cheap: github-copilot\/gpt-6-luna -> ok; cheap: github-copilot\/mai-code-2-flash > halogen\/halogen-qwen3\.8-flash-next -> ok;/,
        );
        assert.match(status.out, /\| irulan \| 4 \| 8 \| 0 \|/);

        // The packs: 1 per owner, items in a seeded order, exactly the judge's input; the keys hold the models.
        const packs = await cli(["packs"]);

        assert.equal(packs.code, 0, packs.err);
        assert.match(packs.out, /irulan: 12 items \(4 dev, 8 held-out\): written/);

        const pack = join(dir, "packs", "irulan");
        const items = read(pack, "items.json").items;
        const labels = read(pack, "labels.json");
        const key = read(dir, "keys", "irulan.json");

        assert.equal(items.length, 12);
        assert.deepEqual(
            items.map((i) => i.id),
            items.map((_, i) => `irulan-${String(i + 1).padStart(2, "0")}`),
        );

        for (const item of items) {
            assert.deepEqual(Object.keys(item), ITEM_FIELDS);
            assert.deepEqual(Object.keys(item.submitted), ["text", "cut"]);
        }

        // The fixture's brief names a model (its fake-pi scenario): every other field must not.
        const shown = JSON.stringify([items.map(({ brief, ...rest }) => rest), labels]);

        for (const model of ALL) {
            assert.ok(!shown.includes(model), `no model id in the pack: ${model}`);
            assert.ok(!shown.includes(model.split("/")[1]), `no model name in the pack: ${model}`);
        }

        assert.doesNotMatch(shown, /cost|wallMs|tries|startedAt/);
        assert.match(
            readFileSync(join(pack, "items", "irulan-01.md"), "utf8"),
            /## The submitted change[\s\S]*pi-ran\.txt[\s\S]*## The merged change[\s\S]*future\.txt/,
        );
        assert.deepEqual(labels.labels[0], {
            id: "irulan-01",
            set: items[0].set,
            label: null,
            note: "",
            blind: true,
            reason: "",
        });
        assert.deepEqual(Object.keys(key.items).sort(), items.map((i) => i.id).sort());

        // The order: the items in plan order (task, then slot) shuffled 1 time with seed 1064; not the plan order.
        const planOrder = ["a", "b", "c"].flatMap((task) =>
            [0, 1, 2, 3].map((slot) => `${task}/${slot}`),
        );
        const expected = seededShuffle(planOrder, 1064);
        const actual = items.map((i) => `${key.items[i.id].task}/${key.items[i.id].slot}`);

        assert.deepEqual(actual, expected);
        assert.notDeepEqual(actual, planOrder);
        assert.equal(Object.values(key.items).filter((k) => k.set === "dev").length, 4);
        assert.ok(Object.values(key.items).every((k) => ALL.includes(k.model)));
        assert.equal(statSync(join(dir, "keys", "irulan.json")).mode & 0o777, 0o600);

        // Split by task: no task gives both dev and held-out items.
        const sets = new Map();

        for (const entry of Object.values(key.items)) {
            sets.set(entry.task, new Set([...(sets.get(entry.task) ?? []), entry.set]));
        }

        assert.ok([...sets.values()].every((s) => s.size === 1));

        // Sheeana's pack: only Luna's pilot item (MAI-Code and Sonnet had no finished pilot attempt; Gemini none).
        const sheeana = read(dir, "packs", "sheeana", "items.json").items;

        assert.equal(sheeana.length, 1);
        assert.equal(sheeana[0].s1, true, "the item's S1 is the copy's, not the stale original's");

        // The same packs again: unchanged. Labels, then other items: refused, nothing written.
        assert.equal((await cli(["packs"])).code, 0);

        labels.labels[0].label = "pass";
        writeFileSync(join(pack, "labels.json"), JSON.stringify(labels));

        const same = await cli(["packs"]);

        assert.equal(same.code, 0);
        assert.match(same.out, /irulan: .*kept \(labelled\)/);

        const plan = read(dir, "plan.json");

        plan.tasks[0].set = "dev";
        writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));

        const changed = await cli(["packs"]);

        assert.equal(changed.code, 1);
        assert.equal(read(pack, "labels.json").labels[0].label, "pass", "the labels stay");
    },
);

test("usage: no command, an unknown command, no plan, --results", { timeout: 60_000 }, async () => {
    assert.equal(
        await calibrationMain(
            ["run", "--results", join(fixture.root, "elsewhere"), "--dir", dir],
            testEnv(fixture),
            {
                print: () => {},
            },
        ),
        1,
        "--results would put the attempts where the driver never looks",
    );
    assert.equal(await calibrationMain([], testEnv(fixture), { print: () => {} }), 1);
    assert.equal(await calibrationMain(["nope"], testEnv(fixture), { print: () => {} }), 1);
    assert.equal(
        await calibrationMain(["status", "--dir", join(fixture.root, "none")], testEnv(fixture), {
            print: () => {},
        }),
        1,
    );
});
