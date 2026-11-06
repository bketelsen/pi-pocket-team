// Child processes of a try: a plain sandboxed command (setup) and the streamed Pi run. Each runs in its own
// process group (`detached`), so a limit or a timeout ends the whole group: SIGTERM, then SIGKILL after a grace.
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { lineSplitter, usageTracker } from "./stream.mjs";

/** Send a signal to a process group; a group that is gone is fine. */
export function killGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    } catch {
        // The group already ended.
    }
}

/** The children running now, so a signal to the runner can end them. */
export const running = new Set();

/** End every running child group at once (the runner got SIGINT or SIGTERM). */
export function killAll() {
    for (const pid of running) {
        killGroup(pid, "SIGKILL");
    }
}

/** Start a child in its own group; stdout piped or to the log, stderr to the log file. */
function start(bin, args, logFd, pipeStdout) {
    const child = spawn(bin, args, {
        detached: true,
        stdio: ["ignore", pipeStdout ? "pipe" : logFd, logFd],
    });

    if (child.pid) {
        running.add(child.pid);
    }

    return child;
}

/**
 * Run a command with a timeout; its output goes to `logFile`. Returns `{ code, signal, timedOut, error }`.
 */
export function runLogged({ bin, args, logFile, timeoutMs, killGraceMs = 10_000 }) {
    const logFd = openSync(logFile, "a", 0o600);

    return new Promise((resolve) => {
        const child = start(bin, args, logFd, false);
        let timedOut = false;
        let graceTimer = null;
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup(child.pid, "SIGTERM");
            graceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), killGraceMs);
        }, timeoutMs);
        let settled = false;

        const finish = (result) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            clearTimeout(graceTimer);
            running.delete(child.pid);
            closeSync(logFd);
            resolve({ timedOut, ...result });
        };

        child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
        child.on("close", (code, signal) => finish({ code, signal, error: null }));
    });
}

/**
 * Run Pi in the sandbox and read its JSON stream. Each line goes to `eventsFile` (mode 0600) as it comes.
 * Limits: `wallMs`; `costLeft` for a priced model, `tokensLeft` for an unpriced one. At a limit the whole group
 * gets SIGTERM, then SIGKILL after `killGraceMs`.
 * Returns `{ summary, code, signal, limit, wallMs, error }` (`limit`: null, "wall", "cost" or "tokens").
 */
export function runStreamed({
    bin,
    args,
    eventsFile,
    logFile,
    wallMs,
    priced,
    costLeft,
    tokensLeft,
    killGraceMs = 10_000,
    now = () => performance.now(),
}) {
    const logFd = openSync(logFile, "a", 0o600);
    const eventsFd = openSync(eventsFile, "a", 0o600);
    const tracker = usageTracker();
    const split = lineSplitter();
    const began = now();

    return new Promise((resolve) => {
        const child = start(bin, args, logFd, true);
        let limit = null;
        let graceTimer = null;

        const stop = (why) => {
            if (limit) {
                return;
            }

            limit = why;
            killGroup(child.pid, "SIGTERM");
            graceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), killGraceMs);
        };

        const wallTimer = setTimeout(() => stop("wall"), Math.max(0, wallMs));

        const take = (line) => {
            writeSync(eventsFd, `${line}\n`);

            let event;

            try {
                event = JSON.parse(line);
            } catch {
                return;
            }

            tracker.push(event, now());

            const usage = tracker.usage();

            if (priced && usage.cost > costLeft) {
                stop("cost");
            } else if (!priced && usage.tokens > tokensLeft) {
                stop("tokens");
            }
        };

        child.stdout?.on("data", (chunk) => split.push(chunk).forEach(take));

        let settled = false;

        const finish = (code, signal, error) => {
            if (settled) {
                return;
            }

            settled = true;
            split.end().forEach(take);
            clearTimeout(wallTimer);
            clearTimeout(graceTimer);
            running.delete(child.pid);
            closeSync(eventsFd);
            closeSync(logFd);
            resolve({
                summary: tracker.summary(),
                code,
                signal,
                limit,
                wallMs: Math.round(now() - began),
                error,
            });
        };

        child.on("error", (error) => finish(null, null, error.message));
        child.on("close", (code, signal) => finish(code, signal, null));
    });
}
