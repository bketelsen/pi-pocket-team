// The budget guard: reserve and settle math, refusal, the lock under parallel reserves, reap of a dead pid, and a
// stale lock.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { describeSpend, readSpend, reap, reserve, setBudget, settle } from "./lib/budget.mjs";

const root = mkdtempSync(join(tmpdir(), "bench-budget-"));
let n = 0;
const fresh = () => join(root, `data-${(n += 1)}`);
const entry = (cap, pid = process.pid) => ({
    task: "t",
    model: "m/x",
    stage: "pilot",
    try: 1,
    cap,
    pid,
});

/** The pid of a process that has ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

after(() => rm(root, { recursive: true, force: true }));

test("reserve refuses with no budget", async () => {
    const data = fresh();
    const result = await reserve(data, entry(8));

    assert.equal(result.ok, false);
    assert.match(result.reason, /no budget set/);
    assert.equal(describeSpend(await readSpend(data)), "no budget set");
});

test("reserve and settle math", async () => {
    const data = fresh();

    await setBudget(data, 20);

    const a = await reserve(data, entry(8));
    const b = await reserve(data, entry(8));

    assert.ok(a.ok && b.ok);

    // 0 settled + 16 reserved + 8 > 20.
    const refused = await reserve(data, entry(8));

    assert.equal(refused.ok, false);
    assert.match(refused.reason, /budget refused/);

    await settle(data, a.id, { cost: 1.25, tokens: 1000 });

    let spend = await readSpend(data);

    assert.equal(spend.settled, 1.25);
    assert.equal(spend.reservations.length, 1);
    assert.deepEqual(
        spend.entries.map((e) => [e.cost, e.tokens]),
        [[1.25, 1000]],
    );

    // 1.25 + 8 + 8 = 17.25 <= 20.
    const c = await reserve(data, entry(8));

    assert.ok(c.ok);

    // An unpriced try reserves 0 and settles 0, but its tokens are kept.
    const free = await reserve(data, entry(0));

    assert.ok(free.ok);
    await settle(data, free.id, { cost: 3, tokens: 5000 });
    spend = await readSpend(data);
    assert.equal(spend.settled, 1.25);
    assert.deepEqual(spend.entries.at(-1).tokens, 5000);
    assert.equal(spend.entries.at(-1).cost, 0);
});

test("parallel reserves in 10 processes never pass the budget", async () => {
    const data = fresh();

    await setBudget(data, 50);

    const script = `import { reserve } from ${JSON.stringify(join(import.meta.dirname, "lib", "budget.mjs"))};
const r = await reserve(process.env.DATA, { task: "t", model: "m/x", stage: "pilot", try: 1, cap: 8 });
process.stdout.write(r.ok ? "ok" : "refused");`;
    const outputs = await Promise.all(
        Array.from(
            { length: 10 },
            () =>
                new Promise((done, fail) =>
                    execFile(
                        process.execPath,
                        ["--input-type=module", "-e", script],
                        { env: { ...process.env, DATA: data } },
                        (error, stdout) => (error ? fail(error) : done(stdout)),
                    ),
                ),
        ),
    );

    assert.equal(outputs.filter((o) => o === "ok").length, 6);

    const spend = await readSpend(data);

    assert.equal(spend.reservations.length, 6);
    assert.ok(spend.reservations.reduce((sum, r) => sum + r.cap, 0) <= spend.budget);

    // Their processes ended: reap settles each at its full cap.
    const reaped = await reap(data);

    assert.equal(reaped.length, 6);

    const after = await readSpend(data);

    assert.equal(after.reservations.length, 0);
    assert.equal(after.settled, 48);
});

test("reap settles only the reservations of dead pids", async () => {
    const data = fresh();

    await setBudget(data, 100);
    await reserve(data, entry(8, deadPid()));
    await reserve(data, entry(5, process.pid));

    const reaped = await reap(data);

    assert.equal(reaped.length, 1);

    const spend = await readSpend(data);

    assert.equal(spend.settled, 8);
    assert.deepEqual(
        spend.reservations.map((r) => r.cap),
        [5],
    );
    assert.equal(spend.entries[0].reaped, true);
});

test("a stale lock (older than 60 s) is taken over", async () => {
    const data = fresh();
    const lock = join(data, "spend.json.lock");

    mkdirSync(lock, { recursive: true });

    const old = new Date(Date.now() - 120_000);

    utimesSync(lock, old, old);
    await setBudget(data, 5);
    assert.equal((await readSpend(data)).budget, 5);
});

test("a fresh lock is waited for", async () => {
    const data = fresh();
    const lock = join(data, "spend.json.lock");
    let waits = 0;

    mkdirSync(lock, { recursive: true });
    await setBudget(data, 7, {
        wait: async () => {
            waits += 1;

            if (waits === 3) {
                await rm(lock, { recursive: true });
            }
        },
    });
    assert.equal(waits, 3);
    assert.equal((await readSpend(data)).budget, 7);
});
