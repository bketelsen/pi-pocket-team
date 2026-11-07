// Git reads of the harvester and the scorer in a local checkout (no fetch unless asked), and the copy of the hidden
// test files from the merge commit over a tree.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Git with no system or global config (as `clone.mjs` runs it). */
const gitEnv = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
});

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

/**
 * Copy `files` (paths in the repository) as they are at `rev` in `checkout` over the tree `work`. A path that leaves
 * `work` is refused.
 */
export async function overlayFiles({ checkout, rev, files, work }) {
    for (const file of files) {
        const target = resolve(work, file);

        if (!inside(target, resolve(work))) {
            throw new Error(`hidden file ${file} is outside the tree`);
        }

        const content = await gitBuffer(checkout, ["show", `${rev}:${file}`]);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}
