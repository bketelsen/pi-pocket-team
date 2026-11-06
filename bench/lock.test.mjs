// The attempt lock: a take that overlaps a release waits for it (both hold the short lock), with no error and 1
// holder at a time.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { takeAttemptLock } from "./lib/lock.mjs";

const root = mkdtempSync(join(tmpdir(), "bench-lock-"));
const ids = { stage: "pilot", task: "t", model: "m/x" };
const alive = () => true;

after(() => rm(root, { recursive: true, force: true }));

test("a take during a release waits for it: no ENOENT or ENOTEMPTY, and 1 holder", async () => {
    const data = join(root, "overlap");
    let markWaited;
    const waited = new Promise((done) => (markWaited = done));
    let openGate;
    const gate = new Promise((done) => (openGate = done));
    let second;
    const first = await takeAttemptLock(data, ids, {
        pid: 111,
        alive,
        hooks: {
            // Between the removal of the pid file and of the folder: a second runner takes the lock.
            beforeRemove: async () => {
                second = takeAttemptLock(data, ids, {
                    pid: 222,
                    alive,
                    wait: async () => {
                        markWaited();
                        await gate;
                    },
                });
                // The release holds the short lock, so the take waits; a take that does not wait ends here.
                await Promise.race([waited, second]);
            },
        },
    });

    assert.equal(first.ok, true);
    await first.release();
    openGate();

    const taken = await second;

    assert.equal(taken.ok, true);
    assert.equal(readFileSync(join(taken.path, "pid"), "utf8"), "222");

    // The first holder's release does not remove the new holder's lock.
    await first.release();
    assert.equal(readFileSync(join(taken.path, "pid"), "utf8"), "222");
    await taken.release();
    assert.equal(existsSync(taken.path), false);
});

test("a held lock is refused; a lock folder with no pid file (a crash) is taken over", async () => {
    const data = join(root, "held");
    const first = await takeAttemptLock(data, ids, { pid: 333, alive });
    const refused = await takeAttemptLock(data, ids, { pid: 444, alive });

    assert.deepEqual([refused.ok, refused.pid], [false, 333]);
    await rm(join(first.path, "pid"));

    const taken = await takeAttemptLock(data, ids, { pid: 444, alive });

    assert.equal(taken.ok, true);
    assert.equal(readFileSync(join(taken.path, "pid"), "utf8"), "444");
});
