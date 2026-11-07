// Shared helpers of the replay bench: the data and results paths, atomic writes, a mkdir lock, and pid checks.
// The bench keeps its private files (spend, slots, run dirs, transcripts) in the data dir, mode 0700 for folders and
// 0600 for files; only the result files go to the repository's ignored `bench/results/`.
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The repository root (the parent of `bench/`). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** The bench folder of the repository. */
export const BENCH_DIR = join(REPO_ROOT, "bench");

/** The stages a result can belong to. */
export const STAGES = ["pilot", "stage1", "stage2", "loadtest"];

/** The data dir: env `BENCH_DATA`, else `~/.local/share/pi-pocket-team/bench`. */
export const dataDir = (env = process.env) =>
    env.BENCH_DATA
        ? resolve(env.BENCH_DATA)
        : join(homedir(), ".local", "share", "pi-pocket-team", "bench");

/** The results dir: `--results`, else `<repo>/bench/results`. */
export const resultsDir = (option) => (option ? resolve(option) : join(BENCH_DIR, "results"));

/** A model id as a file name: `/` and `:` become `__`. */
export const modelSlug = (model) => model.replaceAll("/", "__").replaceAll(":", "__");

/** The provider of a `provider/model` id. */
export const providerOf = (model) => model.split("/")[0];

/** The base name of an attempt: the model slug, with `--<runId>` when a run id is set. */
export const attemptName = (model, runId) =>
    runId ? `${modelSlug(model)}--${runId}` : modelSlug(model);

/** The result file of an attempt. */
export const resultPath = (results, { stage, task, model, runId }) =>
    join(results, stage, task, `${attemptName(model, runId)}.json`);

/** The run folder of an attempt (it holds 1 `try-<n>` folder per try). */
export const runBase = (data, { stage, task, model, runId }) =>
    join(data, "runs", stage, task, attemptName(model, runId));

/** Make a private folder (and its parents), mode 0700. */
export async function privateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });

    return path;
}

/** The sync form of `privateDir`. */
export function privateDirSync(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });

    return path;
}

/** Write a file atomically: a temp file (mode 0600) in the same folder, then a rename over the target. */
export async function writeAtomic(path, text) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
}

/** Write JSON atomically, with a final newline. */
export const writeJsonAtomic = (path, value) =>
    writeAtomic(path, `${JSON.stringify(value, null, 4)}\n`);

/** Read a JSON file, or `fallback` when it does not exist. */
export async function readJson(path, fallback) {
    let text;

    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return fallback;
        }

        throw error;
    }

    return JSON.parse(text);
}

/** The sync form of `readJson`. */
export function readJsonSync(path, fallback) {
    let text;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return fallback;
        }

        throw error;
    }

    return JSON.parse(text);
}

/** True when a process with this pid exists (EPERM counts as alive). */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

/** Wait for `ms` milliseconds. Production retry loops use it; tests inject their own wait. */
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Run `fn` while holding a lock folder made with `mkdir`. A lock older than `staleMs` is removed and taken again.
 * `now` and `wait` are injectable for tests.
 */
export async function withDirLock(
    lock,
    fn,
    { staleMs = 60_000, now = Date.now, wait = () => delay(10 + Math.random() * 20) } = {},
) {
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });

    for (;;) {
        try {
            await mkdir(lock, { mode: 0o700 });
            break;
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }

        try {
            const info = await stat(lock);

            if (now() - info.mtimeMs > staleMs) {
                await rmdir(lock).catch(() => {});
                continue;
            }
        } catch {
            continue;
        }

        await wait();
    }

    try {
        return await fn();
    } finally {
        await rmdir(lock).catch(() => {});
    }
}

/** The median of a list of numbers, or null for an empty list. */
export function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);

    if (sorted.length === 0) {
        return null;
    }

    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
