// The scratch clone "with no future": at the parent, with no merge commit, ref, tag, remote or reflog.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkClone, scratchClone } from "./lib/clone.mjs";
import { git, makeFixture } from "./fixtures/helpers.mjs";

const fixture = makeFixture();

after(() => rm(fixture.root, { recursive: true, force: true }));

test("the scratch clone has no future", async () => {
    const work = join(fixture.root, "clone");

    await scratchClone({
        checkout: fixture.repo,
        work,
        parent: fixture.parent,
        merge: fixture.merge,
    });

    assert.equal(git(work, "rev-parse", "HEAD"), fixture.parent);
    assert.throws(() => git(work, "cat-file", "-e", `${fixture.merge}^{commit}`), "merge absent");
    assert.equal(git(work, "for-each-ref"), "", "no ref");
    assert.equal(git(work, "tag"), "", "no tag");
    assert.equal(git(work, "remote"), "", "no remote");
    assert.equal(git(work, "reflog"), "", "empty reflog");
    assert.equal(existsSync(join(work, "future.txt")), false);
    assert.equal(existsSync(join(work, "README.md")), true);

    for (const leftover of ["ORIG_HEAD", "FETCH_HEAD", "packed-refs"]) {
        assert.equal(existsSync(join(work, ".git", leftover)), false, leftover);
    }
});

test("the checks fail on a clone that still reaches the merge commit", async () => {
    const work = join(fixture.root, "plain");

    git(fixture.root, "clone", "--quiet", "--no-local", fixture.repo, work);
    git(work, "checkout", "--quiet", "--detach", fixture.parent);

    await assert.rejects(
        checkClone({ work, parent: fixture.parent, merge: fixture.merge }),
        /merge commit .* still reachable/,
    );
});
