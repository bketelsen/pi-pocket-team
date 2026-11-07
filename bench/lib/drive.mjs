// Helpers of the batch driver and the load test: the halogen lease, run.mjs children, and the options they pass on.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BENCH_DIR } from "./common.mjs";
import { LEASE_RESOURCE, LEASE_THREAD } from "./manifest.mjs";

/** The lease tool (not on PATH). */
export const LEASE_BIN = join(homedir(), ".pi", "agent", "bin", "lease");

/** The options of run.mjs that a driver passes on to each child, as parseArgs options. */
export const PASS_OPTIONS = {
    checkout: { type: "string" },
    pocket: { type: "string" },
    results: { type: "string" },
    "wall-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "token-limit": { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    bwrap: { type: "string" },
    "no-auth-preflight": { type: "boolean" },
    "kill-grace": { type: "string" },
};

/** The parsed pass-on options as run.mjs arguments. */
export function passArgs(values) {
    const args = [];

    for (const [name, spec] of Object.entries(PASS_OPTIONS)) {
        if (values[name] === undefined || values[name] === false) {
            continue;
        }

        args.push(`--${name}`);

        if (spec.type === "string") {
            args.push(values[name]);
        }
    }

    return args;
}

/** Run the lease tool; resolves true on exit 0. Its output goes to stderr. */
export function lease(bin, action, note) {
    const args = [action, LEASE_RESOURCE, LEASE_THREAD];

    if (note !== undefined) {
        args.push(note);
    }

    return new Promise((done) => {
        execFile(bin, args, (error, stdout, stderr) => {
            process.stderr.write(stdout + stderr);
            done(!error);
        });
    });
}

/**
 * Hold the halogen lease for a driver: take it, renew it every 30 minutes with `progress()`, and release it at the
 * end and on SIGINT or SIGTERM (`onSignal` runs first, to end the children). Returns `{ ok, release }`.
 */
export async function holdLease(bin, note, progress, onSignal = () => {}) {
    if (!(await lease(bin, "take", note))) {
        return { ok: false, release: async () => {} };
    }

    const timer = setInterval(() => lease(bin, "renew", progress()), 30 * 60_000);
    let released = false;

    const release = async () => {
        if (released) {
            return;
        }

        released = true;
        clearInterval(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await lease(bin, "release");
    };

    const stop = async (signal) => {
        onSignal(signal);
        await release();
        process.exit(signal === "SIGINT" ? 130 : 143);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    return { ok: true, release };
}

/** Start a run.mjs child; resolves its exit code. `children` tracks the live ones. */
export function runChild(args, children) {
    return new Promise((done) => {
        const child = spawn(process.execPath, [join(BENCH_DIR, "run.mjs"), ...args], {
            stdio: ["ignore", "inherit", "inherit"],
        });

        children.add(child);
        child.on("error", () => {
            children.delete(child);
            done(1);
        });
        child.on("close", (code) => {
            children.delete(child);
            done(code ?? 1);
        });
    });
}

/** Send SIGTERM to every live child. */
export function stopChildren(children) {
    for (const child of children) {
        child.kill("SIGTERM");
    }
}
