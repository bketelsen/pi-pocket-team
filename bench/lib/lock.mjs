// The attempt lock: 2 runners of the same (stage, task, model, run id) never run at once. The lock is the folder
// `<run base>.lock` with a file `pid`; a lock whose pid is dead is free. Each check-and-take holds the short mkdir
// lock `<data>/runs/.locks.lock`, so 2 runners never take over the same dead lock.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pidAlive, privateDir, runBase, withDirLock } from "./common.mjs";

/** The lock folder of an attempt. */
export const attemptLockPath = (data, ids) => `${runBase(data, ids)}.lock`;

/** The pid in a lock folder, or null. */
async function holderOf(lock) {
    try {
        const pid = Number.parseInt(await readFile(join(lock, "pid"), "utf8"), 10);

        return Number.isInteger(pid) ? pid : null;
    } catch {
        return null;
    }
}

/**
 * Take the lock of an attempt. Returns `{ ok: true, path, release }`, or `{ ok: false, path, pid }` when a live
 * process holds it. A lock with a dead pid, or with no pid (a crash), is taken over.
 */
export async function takeAttemptLock(data, ids, { pid = process.pid, alive = pidAlive } = {}) {
    const lock = attemptLockPath(data, ids);

    await privateDir(dirname(lock));

    return withDirLock(join(data, "runs", ".locks.lock"), async () => {
        const holder = await holderOf(lock);

        if (holder != null && holder !== pid && alive(holder)) {
            return { ok: false, path: lock, pid: holder };
        }

        await rm(lock, { recursive: true, force: true });
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, "pid"), String(pid), { mode: 0o600 });

        return {
            ok: true,
            path: lock,
            release: async () => {
                if ((await holderOf(lock)) === pid) {
                    await rm(lock, { recursive: true, force: true });
                }
            },
        };
    });
}
