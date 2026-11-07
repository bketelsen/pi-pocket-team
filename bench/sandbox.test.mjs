// The sandbox: the bwrap argv (everywhere), and with the real bwrap (skipped where it cannot run): a fake `pi`
// tries to read a host file and to reach github.com, looks for the home folder, and lists its environment.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ALLOWED_ENV, bwrapArgs, nodePlacement, piCommand } from "./lib/sandbox.mjs";
import {
    PRICED,
    bwrapWorks,
    fixtureArgs,
    fixtureTask,
    makeFixture,
    processesWith,
    readResult,
    runScript,
    setBudget,
    sleepMarker,
    testEnv,
    waitFor,
    writeManifest,
} from "./fixtures/helpers.mjs";

const HOST_PATHS = {
    work: "/x/try-1/work",
    session: "/x/try-1/session",
    cache: "/x/try-1/cache",
    agentDir: "/x/agent",
    settings: "/x/agent-files/settings.json",
    models: "/h/.pi/agent/models.json",
    auth: "/h/.pi/agent/auth.json",
    header: "/r/bench/header-v1.md",
    hosts: "/r/bench/hosts",
    pocket: "/p/pi-pocket",
    miseInstalls: "/h/mise/installs",
};

test("the bwrap argv has the required flags, mounts and only the allowed variables", () => {
    const args = bwrapArgs(HOST_PATHS, {
        tryNo: 2,
        command: piCommand(PRICED, "brief"),
        execPath: "/h/mise/installs/node/24.1.0/bin/node",
        exists: (path) => path !== "/etc/pki",
        realpath: () => "/run/resolv.conf",
    });
    const pairs = (flag) =>
        args.flatMap((arg, i) => (arg === flag ? [[args[i + 1], args[i + 2]]] : []));
    const end = args.indexOf("--");

    for (const flag of [
        "--unshare-pid",
        "--unshare-ipc",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
    ]) {
        assert.ok(args.slice(0, end).includes(flag), flag);
    }

    assert.ok(!args.includes("--unshare-net"));
    assert.ok(!args.includes("--unshare-all"));

    const binds = Object.fromEntries(pairs("--bind").map(([from, to]) => [to, from]));
    const roBinds = Object.fromEntries(pairs("--ro-bind").map(([from, to]) => [to, from]));

    assert.deepEqual(binds, {
        "/agent": "/x/agent",
        "/agent/auth.json": "/h/.pi/agent/auth.json",
        "/work": "/x/try-1/work",
        "/session": "/x/try-1/session",
        "/cache": "/x/try-1/cache",
    });
    assert.deepEqual(roBinds, {
        "/usr": "/usr",
        "/etc/ssl": "/etc/ssl",
        "/etc/resolv.conf": "/run/resolv.conf",
        "/etc/nsswitch.conf": "/etc/nsswitch.conf",
        "/etc/hosts": "/r/bench/hosts",
        "/tools": "/h/mise/installs",
        "/pocket": "/p/pi-pocket",
        "/agent/AGENTS.md": "/r/bench/header-v1.md",
        "/agent/settings.json": "/x/agent-files/settings.json",
        "/agent/models.json": "/h/.pi/agent/models.json",
    });

    const env = Object.fromEntries(pairs("--setenv"));

    assert.deepEqual(Object.keys(env).sort(), [...ALLOWED_ENV].sort());
    assert.equal(env.PATH.split(":")[0], "/tools/node/24.1.0/bin");
    assert.ok(env.PATH.endsWith(":/usr/bin:/bin"));
    assert.equal(env.BENCH_TRY, "2");
    assert.equal(env.PI_CODING_AGENT_DIR, "/agent");
    assert.equal(args[args.indexOf("--chdir") + 1], "/work");
    assert.deepEqual(args.slice(end + 1, end + 3), ["node", "/pocket/node_modules/.bin/pi"]);
    assert.ok(args.slice(end + 1).includes(`${PRICED}:high`));
});

test("node outside the mise installs is bound at /node, never at its host path", () => {
    assert.deepEqual(nodePlacement("/opt/node/bin/node", "/h/mise/installs"), {
        pathDir: "/node/bin",
        bind: ["/opt/node", "/node"],
    });
    assert.deepEqual(nodePlacement("/usr/bin/node", null), { pathDir: "/usr/bin", bind: null });
});

const skip = bwrapWorks() ? false : "bwrap cannot run here (missing, or no user namespaces)";

let fixture;
let manifest;
let secret;
const marker = sleepMarker();

before(async () => {
    fixture = makeFixture();
    secret = join(mkdtempSync(join(tmpdir(), "bench-secret-")), "secret.txt");
    writeFileSync(secret, "not for the sandbox\n");
    manifest = writeManifest(fixture, [
        fixtureTask(fixture, "probe", { name: "probe", hostFile: secret, hostHome: homedir() }),
        fixtureTask(fixture, "cost", { name: "cost", marker }),
    ]);
    await setBudget(fixture, 100);
});

after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(join(secret, ".."), { recursive: true, force: true });
});

/** Run the runner with the real bwrap. */
const run = (task, extra = []) =>
    runScript(
        "run.mjs",
        [
            ...fixtureArgs(fixture, manifest, { fakeBwrap: false }),
            "--task",
            task,
            "--model",
            PRICED,
            ...extra,
        ],
        testEnv(fixture),
    );

test(
    "bwrap: no host file, no GitHub, no home folder, only the allowed variables",
    { skip },
    async () => {
        const result = await run("probe");

        assert.equal(result.code, 0, result.stderr);

        const record = readResult(fixture, "pilot", "probe", PRICED);

        assert.equal(record.failure, null);

        const probe = JSON.parse(readFileSync(join(record.workDir, "probe.json"), "utf8"));

        assert.notEqual(probe.cat.status, 0, "the host file is not readable");
        assert.match(probe.cat.stderr, /No such file/);
        assert.notEqual(probe.curl.status, 0, "github.com is not reachable");
        assert.equal(probe.varHome, false, "/var/home does not exist inside");
        assert.equal(probe.hostHome, false, "the host home does not exist inside");

        // bwrap itself sets PWD after --chdir; nothing else is outside the list.
        const extra = probe.envKeys.filter((key) => !ALLOWED_ENV.includes(key) && key !== "PWD");

        assert.deepEqual(extra, []);
        assert.ok(!probe.envKeys.includes("GH_TOKEN"));
        assert.ok(!probe.envKeys.includes("SSH_AUTH_SOCK"));
    },
);

test("bwrap: a limit ends the whole sandbox", { skip }, async () => {
    const result = await run("cost", ["--cost-limit", "0.5"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readResult(fixture, "pilot", "cost", PRICED).failure, "limit");
    await waitFor(() => processesWith(marker).length === 0, 10_000, "the sandboxed child to end");
});
