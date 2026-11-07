// Git reads of the harvester and the scorer in a local checkout (no fetch unless asked), and the copy of the hidden
// test files from the merge commit over a tree.
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { removeTree } from "./common.mjs";

const run = promisify(execFile);

/** Git with no system or global config (as `clone.mjs` runs it). */
const gitEnv = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
});

/**
 * `git fetch --quiet origin` in a trusted local checkout, with the host's own git config (its credential helper, such
 * as gh, for a private repository) and no terminal prompt. Every other git call of the bench runs with no system or
 * global config (`gitEnv`).
 */
export async function fetchOrigin(checkout) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    await run("git", ["fetch", "--quiet", "origin"], {
        cwd: checkout,
        env,
        maxBuffer: 64 * 1024 * 1024,
    });
}

/** Run git in a folder; returns stdout as a Buffer. */
export async function gitBuffer(cwd, args) {
    const { stdout } = await run("git", args, {
        cwd,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
    });

    return stdout;
}

/** Run git in a folder; returns stdout as text. */
export const gitText = async (cwd, args) => (await gitBuffer(cwd, args)).toString("utf8");

/** True when the commit exists in the checkout. */
export async function hasCommit(checkout, sha) {
    try {
        await gitBuffer(checkout, ["cat-file", "-e", `${sha}^{commit}`]);

        return true;
    } catch {
        return false;
    }
}

/** The full id of a revision. */
export const revParse = async (checkout, rev) =>
    (await gitText(checkout, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();

/** The top-level names of a commit's tree. */
export const topNames = async (checkout, rev) =>
    (await gitText(checkout, ["ls-tree", "--name-only", rev])).split("\n").filter(Boolean);

/** A file of a commit as text, or null when it is not there. */
export async function fileAt(checkout, rev, path) {
    try {
        return await gitText(checkout, ["show", `${rev}:${path}`]);
    } catch {
        return null;
    }
}

/** `git diff --no-renames --name-status a b`. */
export const nameStatus = (checkout, a, b) =>
    gitText(checkout, ["diff", "--no-renames", "--name-status", a, b]);

/** True when `child` is inside `parent`. */
const inside = (child, parent) => {
    const rel = relative(parent, child);

    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

/** True when `path` exists as a symbolic link. */
async function isLink(path) {
    try {
        return (await lstat(path)).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * Copy `files` (paths in the repository) as they are at `rev` in `checkout` over the tree `work`, on the host. Only
 * for a tree the bench made itself (the harvester's scratch clones, a staging folder): a worker's tree is overlaid
 * inside the sandbox (`bench/lib/score.mjs`). A path that leaves `work`, or that meets a symbolic link on its way
 * (a folder or the file itself), is refused: `mkdir` and `writeFile` would follow it. Each file gets its mode at
 * `rev` (0755, 0644; a symbolic link of the reference is written as a link). `git` (cwd, args) -> Buffer is injectable.
 */
export async function overlayFiles({ checkout, rev, files, work, git = gitBuffer }) {
    const root = resolve(work);

    for (const file of files) {
        const target = resolve(root, file);

        if (!inside(target, root)) {
            throw new Error(`hidden file ${file} is outside the tree`);
        }

        const parts = relative(root, target).split(sep);

        for (let i = 1; i <= parts.length; i += 1) {
            if (await isLink(join(root, ...parts.slice(0, i)))) {
                throw new Error(`hidden file ${file} meets a symbolic link in the tree`);
            }
        }

        const mode = await modeAt(checkout, rev, file, git);
        const content = await git(checkout, ["show", `${rev}:${file}`]);

        await mkdir(dirname(target), { recursive: true });

        // A folder where the reference has a file or a link goes first (`writeFile` and `symlink` cannot replace it).
        if ((await lstat(target).catch(() => null))?.isDirectory()) {
            await removeTree(target);
        }

        if (mode === "120000") {
            // A symbolic link of the reference: written as a link (its blob is the target), in the bench's own tree.
            await rm(target, { force: true });
            await symlink(content.toString("utf8"), target);
        } else {
            await writeFile(target, content);
            await chmod(target, FILE_MODES[mode]);
        }
    }
}

/** The file modes of git's regular files. */
const FILE_MODES = { 100644: 0o644, 100755: 0o755 };

/**
 * A file's git mode at `rev` (`git ls-tree`): `100644`, `100755` or `120000`. Any other (a submodule, a folder, no
 * entry) is refused.
 */
export async function modeAt(checkout, rev, file, git = gitBuffer) {
    const entry = (await git(checkout, ["ls-tree", "-z", rev, "--", file])).toString("utf8");
    const mode = /^(\d{6}) /.exec(entry)?.[1];

    if (mode !== "120000" && !(mode in FILE_MODES)) {
        throw new Error(
            `hidden file ${file} has the mode ${mode ?? "none"} at ${rev}: not a file or a link`,
        );
    }

    return mode;
}
