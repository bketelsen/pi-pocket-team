// The bwrap sandbox of a try. The whole Pi CLI runs inside it, with only the mounts of the plan's sandbox table,
// a cleared environment, and no host path under the home folder. The network stays open (no --unshare-net): the
// model providers, the halogen LAN endpoint and module registries must stay reachable; /etc/hosts maps GitHub to
// 127.0.0.1.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { BENCH_DIR, writeAtomic } from "./common.mjs";

/** The variables a sandbox may hold; nothing else is set (no GH_TOKEN, no SSH_AUTH_SOCK). */
export const ALLOWED_ENV = [
    "PI_CODING_AGENT_DIR",
    "HOME",
    "PATH",
    "GOMODCACHE",
    "npm_config_cache",
    "PIP_CACHE_DIR",
    "BENCH_TRY",
];

/** The default host paths; each one is an option. */
export const DEFAULTS = {
    pocket: "/var/home/team/projects/pi-pocket",
    agentSrc: join(homedir(), ".pi", "agent"),
    miseInstalls: join(homedir(), ".local", "share", "mise", "installs"),
    header: join(BENCH_DIR, "header-v1.md"),
    hosts: join(BENCH_DIR, "hosts"),
};

/** True when `child` is `parent` or inside it. */
const inside = (child, parent) => {
    const rel = relative(parent, child);

    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
};

/** A version string as numbers, for sorting (`1.27.3` before `1.30.0`). */
const versionKey = (name) => name.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);

/** The newest real version folder of a tool under the mise installs dir (symlinks such as `latest` skipped). */
export function newestTool(installs, tool) {
    const folder = join(installs, tool);
    let names;

    try {
        names = readdirSync(folder, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
            .map((entry) => entry.name);
    } catch {
        return null;
    }

    names.sort((a, b) => {
        const [x, y] = [versionKey(a), versionKey(b)];

        for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
            if ((x[i] ?? 0) !== (y[i] ?? 0)) {
                return (x[i] ?? 0) - (y[i] ?? 0);
            }
        }

        return 0;
    });

    const newest = names.at(-1);

    return newest && existsSync(join(folder, newest, "bin")) ? newest : null;
}

/**
 * How node reaches the sandbox. Under the mise installs dir: its bin dir mapped into /tools. Under /usr: as it is.
 * Elsewhere (a CI runner): its install prefix bound read-only at /node.
 */
export function nodePlacement(execPath, installs) {
    const binDir = dirname(execPath);

    if (installs && inside(binDir, installs)) {
        return { pathDir: join("/tools", relative(installs, binDir)), bind: null };
    }

    if (inside(binDir, "/usr")) {
        return { pathDir: binDir, bind: null };
    }

    return { pathDir: "/node/bin", bind: [dirname(binDir), "/node"] };
}

/**
 * The bwrap argv (without `bwrap` itself) for 1 command of a try.
 * `paths`: { work, session, cache, agentDir, settings, models, auth, header, hosts, pocket, miseInstalls, passwd,
 * group, overlay?, trustedGit? }.
 * `exists` and `realpath` are injectable, so a dry run in CI builds the same argv with no host file.
 * `agent: false` leaves out the `/agent` mounts and `PI_CODING_AGENT_DIR`: a check or hidden-test command needs no
 * credential, so it gets none (`paths` then needs no agent files). With no `paths.session`, `/session` is left out.
 */
export function bwrapArgs(
    paths,
    {
        tryNo,
        command,
        agent = true,
        execPath = process.execPath,
        exists = existsSync,
        realpath = realpathSync,
    },
) {
    const installs = paths.miseInstalls && exists(paths.miseInstalls) ? paths.miseInstalls : null;
    const node = nodePlacement(execPath, installs);
    const pathDirs = [node.pathDir];

    if (installs) {
        for (const tool of ["go", "python"]) {
            const version = newestTool(installs, tool);

            if (version) {
                pathDirs.push(`/tools/${tool}/${version}/bin`);
            }
        }
    }

    pathDirs.push("/usr/bin", "/bin");

    let resolv = "/etc/resolv.conf";

    try {
        resolv = realpath(resolv);
    } catch {
        // Keep the plain path: bwrap reports a missing source.
    }

    const args = [
        "--unshare-pid",
        "--unshare-ipc",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/sbin",
        "/sbin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/home/bench",
    ];

    for (const etc of ["/etc/ssl", "/etc/pki"]) {
        if (exists(etc)) {
            args.push("--ro-bind", etc, etc);
        }
    }

    args.push(
        "--ro-bind",
        resolv,
        "/etc/resolv.conf",
        "--ro-bind",
        "/etc/nsswitch.conf",
        "/etc/nsswitch.conf",
        "--ro-bind",
        paths.hosts,
        "/etc/hosts",
    );

    // The sandbox's own user (see `identityFiles`); a caller with no such paths gets no bind.
    if (paths.passwd) {
        args.push("--ro-bind", paths.passwd, "/etc/passwd");
    }

    if (paths.group) {
        args.push("--ro-bind", paths.group, "/etc/group");
    }

    if (installs) {
        args.push("--ro-bind", installs, "/tools");
    }

    if (node.bind) {
        args.push("--ro-bind", ...node.bind);
    }

    args.push("--ro-bind", paths.pocket, "/pocket");

    if (agent) {
        args.push(
            "--bind",
            paths.agentDir,
            "/agent",
            "--ro-bind",
            paths.header,
            "/agent/AGENTS.md",
            "--ro-bind",
            paths.settings,
            "/agent/settings.json",
            "--ro-bind",
            paths.models,
            "/agent/models.json",
            "--bind",
            paths.auth,
            "/agent/auth.json",
        );
    }

    args.push("--bind", paths.work, "/work");

    if (paths.session) {
        args.push("--bind", paths.session, "/session");
    }

    args.push("--bind", paths.cache, "/cache");

    // A staging folder of trusted files (the reference's hidden tests), copied over `/work` inside the sandbox.
    if (paths.overlay) {
        args.push("--ro-bind", paths.overlay, "/overlay");
    }

    // The bench's own git directory for the submitted diff (a disposable clone at the parent): the worker's `.git`
    // is never read.
    if (paths.trustedGit) {
        args.push("--bind", paths.trustedGit, "/trusted.git");
    }

    args.push("--chdir", "/work");

    const env = {
        ...(agent ? { PI_CODING_AGENT_DIR: "/agent" } : {}),
        HOME: "/home/bench",
        PATH: pathDirs.join(":"),
        GOMODCACHE: "/cache/go",
        npm_config_cache: "/cache/npm",
        PIP_CACHE_DIR: "/cache/pip",
        BENCH_TRY: String(tryNo),
    };

    for (const [key, value] of Object.entries(env)) {
        args.push("--setenv", key, value);
    }

    args.push("--", ...command);

    return args;
}

/** The sandbox's `/etc/passwd` and `/etc/group` in the data dir. */
export const identityPaths = (data) => ({
    passwd: join(data, "agent-files", "passwd"),
    group: join(data, "agent-files", "group"),
});

/**
 * Write the sandbox's `/etc/passwd` and `/etc/group` (mode 0600, atomically, only when missing or different): 1 user
 * `bench` with the host's uid and gid, home `/home/bench`. Without them, `os.userInfo()` fails in the sandbox
 * (`uv_os_get_passwd returned ENOENT`), and so does any code that calls it. bwrap keeps the host uid, because it does
 * not unshare the user namespace. Returns the paths for `bwrapArgs`.
 */
export async function identityFiles(data, { uid = process.getuid(), gid = process.getgid() } = {}) {
    const paths = identityPaths(data);
    const wanted = {
        passwd: `bench:x:${uid}:${gid}:bench:/home/bench:/bin/bash\n`,
        group: `bench:x:${gid}:\n`,
    };

    for (const [name, text] of Object.entries(wanted)) {
        const now = await readFile(paths[name], "utf8").catch(() => null);

        if (now !== text) {
            await writeAtomic(paths[name], text);
        }
    }

    return paths;
}

/** The Pi command of an attempt, inside the sandbox. */
export const piCommand = (model, prompt) => [
    "node",
    "/pocket/node_modules/.bin/pi",
    "-p",
    "--mode",
    "json",
    "--model",
    `${model}:high`,
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
    "--session-dir",
    "/session",
    prompt,
];

/** The setup command of a task, inside the sandbox. */
export const setupCommand = (setup) => ["bash", "-c", setup];

/** True when `path` is an executable file. */
export function isExecutable(path) {
    try {
        return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

/** Find a program: a path with a slash as it is, else the first match on PATH. */
export function findProgram(name, env = process.env) {
    if (name.includes("/")) {
        return isExecutable(name) ? name : null;
    }

    for (const folder of (env.PATH ?? "").split(":").filter(Boolean)) {
        if (isExecutable(join(folder, name))) {
            return join(folder, name);
        }
    }

    return null;
}
