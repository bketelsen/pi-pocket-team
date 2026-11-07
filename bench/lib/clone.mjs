// The scratch clone "with no future": a fresh clone at the task's parent commit, with no branch, tag, remote or
// reflog, and no object that only the future (the merge commit) can reach.
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Git with no system or global config, so a host setting (hooks, URL rewrites) cannot leak in. */
const gitEnv = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
});

/** Run git in a folder; returns stdout. */
export async function git(cwd, args) {
    const { stdout } = await run("git", args, {
        cwd,
        env: gitEnv(),
        maxBuffer: 64 * 1024 * 1024,
    });

    return stdout;
}

/** True when git succeeds. */
async function gitOk(cwd, args) {
    try {
        await git(cwd, args);

        return true;
    } catch {
        return false;
    }
}

/**
 * Clone `checkout` into `work` at `parent`, then remove every way to reach a later commit.
 * Throws when the clone fails or when the checks after it fail (`merge` still reachable, a ref, a remote, a reflog).
 */
export async function scratchClone({ checkout, work, parent, merge }) {
    await run("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", checkout, work], {
        env: gitEnv(),
        maxBuffer: 64 * 1024 * 1024,
    });
    await git(work, ["checkout", "--quiet", "--detach", parent]);

    const refs = (await git(work, ["for-each-ref", "--format=%(refname)"]))
        .split("\n")
        .filter(Boolean);

    for (const ref of refs) {
        await git(work, ["update-ref", "-d", ref]);
    }

    if ((await git(work, ["remote"])).trim()) {
        await git(work, ["remote", "remove", "origin"]);
    }

    for (const leftover of ["ORIG_HEAD", "FETCH_HEAD", "packed-refs"]) {
        await rm(join(work, ".git", leftover), { force: true });
    }

    await git(work, ["reflog", "expire", "--expire=now", "--all"]);
    await git(work, ["gc", "--prune=now", "--quiet"]);
    // gc writes an empty packed-refs again: remove it.
    await rm(join(work, ".git", "packed-refs"), { force: true });

    await checkClone({ work, parent, merge });
}

/** The checks after a scratch clone. Throws with the first failed check. */
export async function checkClone({ work, parent, merge }) {
    const head = (await git(work, ["rev-parse", "HEAD"])).trim();

    if (head !== parent) {
        throw new Error(`scratch clone: HEAD is ${head}, not the parent ${parent}`);
    }

    if (merge && (await gitOk(work, ["cat-file", "-e", `${merge}^{commit}`]))) {
        throw new Error(`scratch clone: the merge commit ${merge} is still reachable`);
    }

    if ((await git(work, ["for-each-ref"])).trim()) {
        throw new Error("scratch clone: a ref is left");
    }

    if ((await git(work, ["remote"])).trim()) {
        throw new Error("scratch clone: a remote is left");
    }

    if ((await git(work, ["reflog"])).trim()) {
        throw new Error("scratch clone: the reflog is not empty");
    }
}
