// The sandbox: the bwrap argv (everywhere), and with the real bwrap (skipped where it cannot run): a fake `pi`
// tries to read a host file and to reach github.com, looks for the home folder, and lists its environment.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeCache, runInSandbox } from "./lib/exec.mjs";
import {
    ALLOWED_ENV,
    DEFAULTS,
    bwrapArgs,
    identityFiles,
    nodePlacement,
    piCommand,
} from "./lib/sandbox.mjs";
import {
    FAKE_BWRAP,
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
    passwd: "/x/agent-files/passwd",
    group: "/x/agent-files/group",
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
        "/etc/passwd": "/x/agent-files/passwd",
        "/etc/group": "/x/agent-files/group",
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

test("a caller with no passwd or group path gets no /etc/passwd or /etc/group bind", () => {
    const { passwd, group, ...old } = HOST_PATHS;
    const args = bwrapArgs(old, {
        tryNo: 1,
        command: ["true"],
        exists: () => true,
        realpath: (path) => path,
    });

    assert.ok(passwd && group);
    assert.ok(!args.includes("/etc/passwd"));
    assert.ok(!args.includes("/etc/group"));
});

test("the identity files: 1 user bench with the host's uid and gid, mode 0600, written again only when they differ", async () => {
    const data = mkdtempSync(join(tmpdir(), "bench-identity-"));

    try {
        const paths = await identityFiles(data, { uid: 1234, gid: 567 });

        assert.equal(
            readFileSync(paths.passwd, "utf8"),
            "bench:x:1234:567:bench:/home/bench:/bin/bash\n",
        );
        assert.equal(readFileSync(paths.group, "utf8"), "bench:x:567:\n");
        assert.equal(statSync(paths.passwd).mode & 0o777, 0o600);

        const inode = statSync(paths.passwd).ino;

        await identityFiles(data, { uid: 1234, gid: 567 });
        assert.equal(statSync(paths.passwd).ino, inode, "the same content is not written again");
        await identityFiles(data, { uid: 1235, gid: 567 });
        assert.match(readFileSync(paths.passwd, "utf8"), /^bench:x:1235:567:/);
    } finally {
        await rm(data, { recursive: true, force: true });
    }
});

test("a failed sandbox command adds the last 200 lines of its stdout to its log, after a header that names the step", async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-tail-"));
    const work = join(root, "work");
    const cache = await makeCache(join(root, "cache"));
    const logFile = join(root, "x.log");
    const sandbox = {
        bwrap: FAKE_BWRAP,
        pocket: root,
        miseInstalls: join(root, "no-mise"),
        data: root,
    };

    mkdirSync(work);

    try {
        const failed = await runInSandbox(sandbox, {
            work,
            cache,
            command: "for i in $(seq 1 250); do echo out-$i; done; echo err-line >&2; exit 3",
            logFile,
            step: "check at the merge",
        });
        const log = readFileSync(logFile, "utf8");

        assert.equal(failed.ok, false);
        assert.match(log, /^err-line$/m, "stderr is in the log");
        assert.match(
            log,
            /^--- check at the merge failed \(exit 3\): the last 200 lines of its stdout ---$/m,
        );
        assert.match(log, /^out-51$/m);
        assert.match(log, /^out-250$/m);
        assert.doesNotMatch(log, /^out-50$/m);

        const passed = await runInSandbox(sandbox, {
            work,
            cache,
            command: "echo fine",
            logFile,
            step: "setup at the merge",
        });

        assert.equal(passed.ok, true);
        assert.equal(readFileSync(logFile, "utf8"), log, "a command that passes adds no stdout");
        await assert.rejects(
            runInSandbox({ ...sandbox, data: undefined }, { work, cache, command: "true" }),
            /sandbox\.data/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
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
        assert.equal(probe.user.status, 0, probe.user.stderr);
        assert.equal(probe.user.stdout.trim(), "bench", "os.userInfo() works inside");
    },
);

test(
    "bwrap: a check command sees the user bench, and still no host file under the home folder",
    { skip },
    async () => {
        const work = join(fixture.root, "check-work");
        const cache = join(fixture.root, "check-cache");

        mkdirSync(work, { recursive: true });
        await makeCache(cache);

        const run = (command) =>
            runInSandbox(
                {
                    bwrap: "bwrap",
                    pocket: fixture.pocket,
                    miseInstalls: DEFAULTS.miseInstalls,
                    data: fixture.data,
                },
                { work, cache, command, timeoutMs: 30_000 },
            );
        const user = await run(`node -e "console.log(require('os').userInfo().username)"`);

        assert.equal(user.code, 0);
        assert.equal(user.stdout.trim(), "bench");

        const ids = await run("id -u; id -g; ls /agent 2>&1 || true");

        assert.deepEqual(ids.stdout.split("\n").slice(0, 2), [
            String(process.getuid()),
            String(process.getgid()),
        ]);
        assert.match(ids.stdout, /No such file/, "no /agent for a check");
        assert.notEqual((await run(`cat ${secret}`)).code, 0, "the host file is not readable");
        assert.notEqual(
            (await run(`ls ${homedir()}`)).code,
            0,
            "the home folder does not exist inside",
        );
    },
);

test("bwrap: a limit ends the whole sandbox", { skip }, async () => {
    const result = await run("cost", ["--cost-limit", "0.5"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readResult(fixture, "pilot", "cost", PRICED).failure, "limit");
    await waitFor(() => processesWith(marker).length === 0, 10_000, "the sandboxed child to end");
});
