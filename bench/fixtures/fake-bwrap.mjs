#!/usr/bin/env node
// A fake `bwrap` for the bench tests that run where bwrap cannot (CI): it reads the bind mounts, the setenv list and
// the chdir of a bwrap argv, then runs the command on the host with each sandbox path mapped back to its source.
// It is no sandbox: the tests that check isolation use the real bwrap.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const binds = [];
const env = {};
let chdir = "/";
let i = 0;
const ARITY = {
    "--proc": 1,
    "--dev": 1,
    "--tmpfs": 1,
    "--symlink": 2,
    "--chdir": 1,
    "--setenv": 2,
};

while (i < argv.length && argv[i] !== "--") {
    const flag = argv[i];

    if (/^--(ro-)?bind(-try)?$/.test(flag)) {
        binds.push([argv[i + 1], argv[i + 2]]);
        i += 3;
    } else if (flag === "--setenv") {
        env[argv[i + 1]] = argv[i + 2];
        i += 3;
    } else if (flag === "--chdir") {
        chdir = argv[i + 1];
        i += 2;
    } else {
        i += 1 + (ARITY[flag] ?? 0);
    }
}

const map = (path) => {
    let best = null;

    for (const [source, target] of binds) {
        if (
            (path === target || path.startsWith(`${target}/`)) &&
            (!best || target.length > best[1].length)
        ) {
            best = [source, target];
        }
    }

    return best ? best[0] + path.slice(best[1].length) : path;
};

const [command, ...args] = argv.slice(i + 1);

// The sandbox's umask wrapper (`/bin/sh -c 'umask 022 && exec "$@"' sh <command...>`): its command `node` is this
// Node, as a bare `node` command is.
if (command === "/bin/sh" && args[0] === "-c" && args[2] === "sh" && args[3] === "node") {
    args[3] = process.execPath;
}

const childEnv = { ...env, PATH: process.env.PATH, HOME: tmpdir() };

for (const key of ["PI_CODING_AGENT_DIR", "GOMODCACHE", "npm_config_cache", "PIP_CACHE_DIR"]) {
    if (childEnv[key]) {
        childEnv[key] = map(childEnv[key]);
    }
}

const child = spawn(
    command === "node" ? process.execPath : command,
    // An `@/path` argument (Pi's file argument) names a sandbox path too.
    args.map((arg) =>
        arg.startsWith("/") ? map(arg) : arg.startsWith("@/") ? `@${map(arg.slice(1))}` : arg,
    ),
    { cwd: map(chdir), env: childEnv, stdio: "inherit" },
);

child.on("error", (error) => {
    process.stderr.write(`fake-bwrap: ${error.message}\n`);
    process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
