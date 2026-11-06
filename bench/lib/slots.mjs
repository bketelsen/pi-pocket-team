// Concurrency slots: at most 4 tries at a time on this host, at most 2 per provider, and halogen at most the
// `concurrency` of `<data>/halogen.json` (1 when the file is absent). A slot is a file `<data>/slots/<name>-<i>`
// made with O_EXCL that holds the pid of its owner; a slot whose pid is dead is free. Each scan and take holds a
// mkdir lock, so 2 runners never reclaim the same dead slot.
import { join } from "node:path";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { delay, pidAlive, privateDir, readJson, withDirLock } from "./common.mjs";

/** The global cap: tries at a time on this host. */
export const MAX_GLOBAL = 4;

/** The default cap per provider. */
export const MAX_PROVIDER = 2;

/** How often a waiting runner looks again, in production. */
export const SLOT_POLL_MS = 5_000;

/** The halogen concurrency set by the load test, or 1 when it has not run. */
export async function halogenConcurrency(data) {
    const file = await readJson(join(data, "halogen.json"), null);
    const value = Number(file?.concurrency);

    return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** The cap of a provider: `maxProvider` when given (load test only), else halogen's file, else 2. */
export async function providerCap(data, provider, maxProvider) {
    if (maxProvider != null) {
        return maxProvider;
    }

    return provider === "halogen" ? halogenConcurrency(data) : MAX_PROVIDER;
}

/** The pid that a slot file holds, or null. */
async function slotPid(path) {
    try {
        return Number.parseInt(await readFile(path, "utf8"), 10);
    } catch {
        return null;
    }
}

/** The live slots of a group (`global` or a provider): their indexes. Dead slots are removed. */
async function liveSlots(folder, group, alive) {
    const live = new Set();

    for (const name of await readdir(folder)) {
        const match = /^(.+)-(\d+)$/.exec(name);

        if (!match || match[1] !== group) {
            continue;
        }

        const path = join(folder, name);

        if (alive(await slotPid(path))) {
            live.add(Number(match[2]));
        } else {
            await unlink(path).catch(() => {});
        }
    }

    return live;
}

/** The first index not in a set. */
const freeIndex = (taken) => {
    let index = 0;

    while (taken.has(index)) {
        index += 1;
    }

    return index;
};

/** Take a global slot and a provider slot at once, or none. Returns the 2 paths, or null when one is full. */
export async function tryAcquire(
    data,
    provider,
    { pid = process.pid, maxGlobal = MAX_GLOBAL, maxProvider, alive = pidAlive } = {},
) {
    const folder = await privateDir(join(data, "slots"));
    const cap = await providerCap(data, provider, maxProvider);

    return withDirLock(join(folder, ".lock"), async () => {
        const global = await liveSlots(folder, "global", alive);
        const own = await liveSlots(folder, provider, alive);

        if (global.size >= maxGlobal || own.size >= cap) {
            return null;
        }

        const paths = [
            join(folder, `global-${freeIndex(global)}`),
            join(folder, `${provider}-${freeIndex(own)}`),
        ];

        for (const path of paths) {
            await writeFile(path, String(pid), { flag: "wx", mode: 0o600 });
        }

        return paths;
    });
}

/**
 * Wait for a global and a provider slot. `wait` is called between scans (5 s in production; tests inject it).
 * Returns a handle with `release()`.
 */
export async function acquireSlots(data, provider, options = {}) {
    const { wait = () => delay(SLOT_POLL_MS), pid = process.pid } = options;

    for (;;) {
        const paths = await tryAcquire(data, provider, options);

        if (paths) {
            return {
                paths,
                release: () => releaseSlots(data, paths, pid),
            };
        }

        await wait();
    }
}

/** Remove slot files that still hold this pid. */
export async function releaseSlots(data, paths, pid = process.pid) {
    await withDirLock(join(data, "slots", ".lock"), async () => {
        for (const path of paths) {
            if ((await slotPid(path)) === pid) {
                await unlink(path).catch(() => {});
            }
        }
    });
}
