// Concurrency slots: 2 per provider, 4 on the host, halogen's own cap, and dead-pid slots are free.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireSlots, halogenConcurrency, tryAcquire } from "./lib/slots.mjs";

const root = mkdtempSync(join(tmpdir(), "bench-slots-"));
let n = 0;
const fresh = () => join(root, `data-${(n += 1)}`);

after(() => rm(root, { recursive: true, force: true }));

/** Fake pids: each test owns a set of live ones. */
const live = new Set();
const alive = (pid) => live.has(pid);

const as = (pid) => {
    live.add(pid);

    return { pid, alive };
};

test("at most 2 per provider and 4 on the host", async () => {
    const data = fresh();

    assert.ok(await tryAcquire(data, "github-copilot", as(1001)));
    assert.ok(await tryAcquire(data, "github-copilot", as(1002)));
    assert.equal(await tryAcquire(data, "github-copilot", as(1003)), null, "provider cap 2");
    assert.ok(await tryAcquire(data, "anthropic", as(1004)));
    assert.ok(await tryAcquire(data, "deepseek", as(1005)));
    assert.equal(await tryAcquire(data, "openai", as(1006)), null, "global cap 4");

    live.delete(1001);
    assert.ok(await tryAcquire(data, "openai", as(1007)), "a dead pid frees its slots");
});

test("acquire waits with the injected wait until a slot is released", async () => {
    const data = fresh();
    const first = await acquireSlots(data, "github-copilot", as(2001));
    const second = await acquireSlots(data, "github-copilot", as(2002));
    let waits = 0;
    const third = await acquireSlots(data, "github-copilot", {
        ...as(2003),
        wait: async () => {
            waits += 1;

            if (waits === 2) {
                await first.release();
            }
        },
    });

    assert.equal(waits, 2);
    assert.equal(third.paths.length, 2);
    await second.release();
    await third.release();
});

test("halogen's cap comes from halogen.json, 1 by default", async () => {
    const data = fresh();

    assert.equal(await halogenConcurrency(data), 1);
    assert.ok(await tryAcquire(data, "halogen", as(3001)));
    assert.equal(await tryAcquire(data, "halogen", as(3002)), null);

    writeFileSync(join(data, "halogen.json"), JSON.stringify({ concurrency: 3 }));
    assert.ok(await tryAcquire(data, "halogen", as(3003)));
    assert.ok(await tryAcquire(data, "halogen", as(3004)));
    assert.equal(await tryAcquire(data, "halogen", as(3005)), null);

    // --max-provider (load test only) overrides the cap.
    assert.ok(await tryAcquire(data, "halogen", { ...as(3006), maxProvider: 4 }));
});

test("--max-provider raises only halogen's cap: other providers stay at 2", async () => {
    const data = fresh();
    const override = (pid) => ({ ...as(pid), maxProvider: 4 });

    assert.ok(await tryAcquire(data, "github-copilot", override(4001)));
    assert.ok(await tryAcquire(data, "github-copilot", override(4002)));
    assert.equal(await tryAcquire(data, "github-copilot", override(4003)), null);
    assert.ok(await tryAcquire(data, "halogen", override(4004)));
    assert.ok(await tryAcquire(data, "halogen", override(4005)));
});

test("a slot file of a dead process is free (real pids)", async () => {
    const data = fresh();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;

    mkdirSync(join(data, "slots"), { recursive: true });

    for (const name of ["global-0", "global-1", "global-2", "global-3", "github-copilot-0"]) {
        writeFileSync(join(data, "slots", name), String(dead));
    }

    const slots = await tryAcquire(data, "github-copilot");

    assert.ok(slots);
    assert.ok(slots[0].endsWith("global-0"));
});
