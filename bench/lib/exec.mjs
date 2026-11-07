// Commands of the harvester and the scorer: 1 command in the bwrap sandbox with no credential (setup, check,
// hidden tests), with a timeout that ends its whole process group, its stdout captured and its stderr in a log.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { killGroup, running } from "./proc.mjs";
import { DEFAULTS, bwrapArgs, identityFiles } from "./sandbox.mjs";

/** The most stdout kept from 1 command (a test reporter's output fits well under it). */
export const STDOUT_CAP = 64 * 1024 * 1024;

/** 10 minutes: the limit of a setup, a check or a hidden-test command. */
export const COMMAND_MS = 10 * 60_000;

/**
 * Run `bin args` in its own process group. Its stdout is captured (up to `STDOUT_CAP`), its stderr goes to `logFile`
 * (appended, mode 0600) or is dropped. At `timeoutMs`: SIGTERM to the group, SIGKILL after `killGraceMs`.
 * Returns `{ code, signal, timedOut, stdout, error }`.
 */
export function runCaptured({ bin, args, logFile, timeoutMs, killGraceMs = 10_000, cwd }) {
    const logFd = logFile ? openSync(logFile, "a", 0o600) : "ignore";

    return new Promise((done) => {
        const child = spawn(bin, args, {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", logFd],
        });
        const chunks = [];
        let size = 0;
        let timedOut = false;
        let graceTimer = null;
        let settled = false;

        if (child.pid) {
            running.add(child.pid);
        }

        const timer = setTimeout(() => {
            timedOut = true;
            killGroup(child.pid, "SIGTERM");
            graceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), killGraceMs);
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
            if (size < STDOUT_CAP) {
                chunks.push(chunk);
                size += chunk.length;
            }
        });

        const finish = (code, signal, error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            clearTimeout(graceTimer);
            running.delete(child.pid);

            if (typeof logFd === "number") {
                closeSync(logFd);
            }

            done({
                code,
                signal,
                timedOut,
                stdout: Buffer.concat(chunks).toString("utf8"),
                error,
            });
        };

        child.on("error", (error) => finish(null, null, error.message));
        child.on("close", (code, signal) => finish(code, signal, null));
    });
}

/** Make a cache folder for `/cache`, with the `go`, `npm` and `pip` folders the sandbox's variables name. */
export async function makeCache(cache) {
    for (const name of ["go", "npm", "pip"]) {
        await mkdir(join(cache, name), { recursive: true, mode: 0o700 });
    }

    return cache;
}

/** The most stdout lines a failed command adds to its log. */
export const STDOUT_TAIL_LINES = 200;

/** The last `count` lines of a text (a final newline does not count as a line). */
export function lastLines(text, count = STDOUT_TAIL_LINES) {
    const lines = String(text ?? "").split("\n");

    if (lines.at(-1) === "") {
        lines.pop();
    }

    return lines.slice(-count);
}

/**
 * Run 1 shell command in the sandbox with no credential: `work` at `/work`, `cache` at `/cache`, and the sandbox's
 * own `/etc/passwd` and `/etc/group` (made in `sandbox.data` first). `sandbox`: `{ bwrap, pocket, miseInstalls, data,
 * hosts?, killGraceMs? }`. Returns what `runCaptured` returns; `ok` is exit 0 in time. When the command fails and
 * `step` names it, the last 200 lines of its stdout go to `logFile` after a header line (stderr is there already;
 * npm and the test reporters print their failures on stdout). `overlay`: a host folder bound read-only at `/overlay`. `argv`: a
 * program and its arguments, instead of the shell command.
 */
export async function runInSandbox(
    sandbox,
    { work, cache, command, argv, timeoutMs = COMMAND_MS, logFile, step, overlay },
) {
    if (!sandbox.data) {
        throw new Error(
            "runInSandbox needs sandbox.data (the sandbox's /etc/passwd and /etc/group)",
        );
    }

    const paths = {
        work,
        cache,
        hosts: sandbox.hosts ?? DEFAULTS.hosts,
        pocket: sandbox.pocket,
        miseInstalls: sandbox.miseInstalls,
        ...(await identityFiles(sandbox.data)),
        ...(overlay ? { overlay } : {}),
    };
    const args = bwrapArgs(paths, {
        tryNo: 0,
        command: argv ?? ["bash", "-c", command],
        agent: false,
    });
    const run = await runCaptured({
        bin: sandbox.bwrap,
        args,
        logFile,
        timeoutMs,
        killGraceMs: sandbox.killGraceMs ?? 10_000,
    });
    const ok = run.code === 0 && !run.timedOut;

    if (!ok && step && logFile) {
        const tail = lastLines(run.stdout);

        await appendFile(
            logFile,
            `\n--- ${step} failed (${failText(run)}): the last ${tail.length} lines of its stdout ---\n${tail.join("\n")}${tail.length ? "\n" : ""}`,
            { mode: 0o600 },
        );
    }

    return { ...run, ok };
}

/** A one-line account of a failed command. */
export const failText = (run) =>
    run.timedOut ? "timed out" : `exit ${run.code ?? run.signal ?? run.error ?? "unknown"}`;
