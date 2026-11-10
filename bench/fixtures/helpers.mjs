// Fixtures of the bench tests: temp data, lease and results dirs, a fixture git repository, a fake Pocket checkout
// whose `pi` is `fake-pi.cjs`, a fixture agent dir, and a CLI runner. Nothing here touches the real data dir, the
// real leases or a model provider.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BENCH = join(import.meta.dirname, "..");
export const FAKE_BWRAP = join(import.meta.dirname, "fake-bwrap.mjs");
export const PRICED = "github-copilot/gpt-6-luna";
export const UNPRICED = "halogen/halogen-qwen3.8-flash-next";

const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "bench",
    GIT_AUTHOR_EMAIL: "bench@example.invalid",
    GIT_COMMITTER_NAME: "bench",
    GIT_COMMITTER_EMAIL: "bench@example.invalid",
};

/** Run git in a folder (sync), returns trimmed stdout. */
export const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** True when bwrap can run here (CI may lack it, or user namespaces). */
export function bwrapWorks() {
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" });

    return probe.status === 0;
}

/**
 * A fixture: temp dirs, a git repo with a parent and a merge commit (plus a branch and a tag on the merge), a fake
 * Pocket and a fixture agent dir.
 */
export function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), "bench-test-"));
    const repo = join(root, "repo");
    const pocket = join(root, "pocket");
    const agent = join(root, "agent");
    const fixture = {
        root,
        repo,
        pocket,
        agent,
        data: join(root, "data"),
        results: join(root, "results"),
        leases: join(root, "leases"),
    };

    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), "parent\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "parent");
    fixture.parent = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "future.txt"), "the answer\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "merge");
    fixture.merge = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "feature");
    git(repo, "tag", "v1");

    const bin = join(pocket, "node_modules", ".bin");

    mkdirSync(bin, { recursive: true });
    copyFileSync(join(import.meta.dirname, "fake-pi.cjs"), join(bin, "pi"));
    chmodSync(join(bin, "pi"), 0o755);
    mkdirSync(agent);
    writeFileSync(join(agent, "auth.json"), "{}\n");
    writeFileSync(join(agent, "models.json"), "{}\n");

    return fixture;
}

/** A manifest task of the fixture repo; the scenario goes in the brief. */
export function fixtureTask(fixture, id, scenario, extra = {}) {
    return {
        id,
        repo: "fixture/repo",
        thread: "T0",
        pr: "fixture/repo#1",
        parent: fixture.parent,
        merge: fixture.merge,
        brief: `Do the fixture task.\nSCENARIO ${JSON.stringify(scenario)}`,
        briefSource: "delegation",
        setup: "true",
        check: "true",
        hiddenTests: [],
        hiddenCommand: null,
        size: 1,
        features: null,
        owner: { keep: true, reason: "fixture", scopeMatches: true, commandsConfirmed: true },
        ...extra,
    };
}

/** Write a manifest of tasks; returns its path. */
export function writeManifest(fixture, tasks, name = "manifest.json") {
    const file = join(fixture.root, name);

    writeFileSync(file, JSON.stringify({ schema: 1, stage: "pilot", tasks }));

    return file;
}

/** The environment of a CLI under test: temp data and lease dirs only. */
export const testEnv = (fixture, extra = {}) => {
    const env = {
        ...process.env,
        BENCH_DATA: fixture.data,
        LEASE_DIR: fixture.leases,
        BENCH_SLOT_POLL_MS: "50",
        // The tests do not depend on the host's free disk space; a test that checks the minimum sets its own.
        BENCH_MIN_FREE_GB: "0",
        ...extra,
    };

    delete env.BENCH_MAX_PROVIDER;

    return env;
};

/** Run a bench script; resolves `{ code, stdout, stderr }` whatever the exit code. */
export function runScript(script, args, env) {
    return new Promise((done) => {
        execFile(
            process.execPath,
            [join(BENCH, script), ...args],
            { env, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }),
        );
    });
}

/** The arguments of a runner call on the fixture (the caller adds `--task`, `--model` and more). */
export const fixtureArgs = (fixture, manifest, { fakeBwrap = true } = {}) => [
    "--manifest",
    manifest,
    "--stage",
    "pilot",
    "--checkout",
    fixture.repo,
    "--pocket",
    fixture.pocket,
    "--results",
    fixture.results,
    "--agent-src",
    fixture.agent,
    "--no-auth-preflight",
    "--kill-grace",
    "2000",
    ...(fakeBwrap ? ["--bwrap", FAKE_BWRAP] : []),
];

/** Read a result file of the fixture. */
export const readResult = (fixture, stage, task, model, runId) =>
    JSON.parse(
        readFileSync(
            join(
                fixture.results,
                stage,
                task,
                `${model.replaceAll("/", "__")}${runId ? `--${runId}` : ""}.json`,
            ),
            "utf8",
        ),
    );

/** Set the fixture's budget. */
export const setBudget = (fixture, usd) =>
    runScript("budget.mjs", ["set", "--budget", String(usd)], testEnv(fixture));

/** The pids of processes whose command line holds `marker` (Linux /proc). */
export function processesWith(marker) {
    const found = [];

    for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) {
            continue;
        }

        try {
            const cmdline = readFileSync(join("/proc", name, "cmdline"), "utf8");

            if (cmdline.split("\0").includes(marker)) {
                found.push(Number(name));
            }
        } catch {
            // The process ended while we read.
        }
    }

    return found;
}

/** Wait until `check()` is true (it is polled), or fail after `timeoutMs`. */
export async function waitFor(check, timeoutMs = 10_000, what = "condition") {
    const end = Date.now() + timeoutMs;

    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error(`timed out waiting for ${what}`);
        }

        await new Promise((done) => setTimeout(done, 25));
    }
}

/** A unique `sleep` argument: a long duration with a random fraction. */
export const sleepMarker = () => `3600.${Math.floor(Math.random() * 1e9)}`;
