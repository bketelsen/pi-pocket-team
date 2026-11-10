// link.mjs links through ../pi-pocket-live, the link to the release folder that the server runs, so the tests and the
// types follow the server to each new release; with no such link it keeps ../pi-pocket, and PI_POCKET_CHECKOUT wins.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readlink,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const made = [];

after(async () => {
    for (const folder of made) {
        await rm(folder, { recursive: true, force: true });
    }
});

/** A folder with the 3 paths link.mjs links to: test/helpers.ts, types/pocket.d.ts and node_modules. */
async function fakeCheckout(path) {
    await mkdir(join(path, "test"), { recursive: true });
    await mkdir(join(path, "types"), { recursive: true });
    await mkdir(join(path, "node_modules"), { recursive: true });
    await writeFile(join(path, "test", "helpers.ts"), "");
    await writeFile(join(path, "types", "pocket.d.ts"), "");
}

/** A temporary projects folder with a copy of link.mjs in `pi-pocket-team/`. */
async function projects() {
    const root = await mkdtemp(join(tmpdir(), "link-test-"));
    const repository = join(root, "pi-pocket-team");

    made.push(root);
    await mkdir(repository);
    await copyFile(join(import.meta.dirname, "link.mjs"), join(repository, "link.mjs"));

    return { root, repository };
}

/** Runs link.mjs in `repository` with no PI_POCKET_CHECKOUT. */
async function link(repository) {
    const env = { ...process.env };

    delete env.PI_POCKET_CHECKOUT;

    return run(process.execPath, [join(repository, "link.mjs")], { cwd: repository, env });
}

test("checkoutFor: PI_POCKET_CHECKOUT, else pi-pocket-live when it is a checkout, else pi-pocket", async () => {
    // Imported from a copy beside a fake checkout: a link.mjs that runs its links on import touches only that copy.
    const { root, repository: copy } = await projects();

    await fakeCheckout(join(root, "pi-pocket"));

    const { checkoutFor } = await import(join(copy, "link.mjs"));

    assert.equal(typeof checkoutFor, "function", "link.mjs exports checkoutFor");

    const repository = "/p/pi-pocket-team";

    assert.equal(
        checkoutFor(repository, { PI_POCKET_CHECKOUT: "/x/pocket" }, () => true),
        "/x/pocket",
    );
    assert.equal(
        checkoutFor(repository, {}, (path) => path === "/p/pi-pocket-live"),
        "/p/pi-pocket-live",
    );
    assert.equal(
        checkoutFor(repository, {}, () => false),
        "/p/pi-pocket",
    );
});

test("the links go through pi-pocket-live and follow it to the next release folder", async () => {
    const { root, repository } = await projects();
    const live = join(root, "pi-pocket-live");

    await fakeCheckout(join(root, "pi-pocket"));
    await fakeCheckout(join(root, "pi-pocket-releases", "v1-bk.1"));
    await fakeCheckout(join(root, "pi-pocket-releases", "v1-bk.2"));
    await symlink(join(root, "pi-pocket-releases", "v1-bk.1"), live);
    await link(repository);

    assert.equal(await readlink(join(repository, "node_modules")), join(live, "node_modules"));
    assert.equal(
        await readlink(join(repository, "_pocket.d.ts")),
        join(live, "types", "pocket.d.ts"),
    );
    assert.equal(await readlink(join(repository, "_pocket")), live);

    await rm(live);
    await symlink(join(root, "pi-pocket-releases", "v1-bk.2"), live);

    assert.equal(
        await realpath(join(repository, "node_modules")),
        await realpath(join(root, "pi-pocket-releases", "v1-bk.2", "node_modules")),
    );

    const again = await link(repository);

    assert.equal(again.stdout, "", "a second run with the links right prints nothing");
});

test("with no pi-pocket-live, the links go to pi-pocket, and a later run moves them to pi-pocket-live", async () => {
    const { root, repository } = await projects();
    const live = join(root, "pi-pocket-live");

    await fakeCheckout(join(root, "pi-pocket"));
    await link(repository);

    assert.equal(await readlink(join(repository, "_pocket")), join(root, "pi-pocket"));

    await fakeCheckout(join(root, "pi-pocket-releases", "v1-bk.1"));
    await symlink(join(root, "pi-pocket-releases", "v1-bk.1"), live);

    const moved = await link(repository);

    assert.equal(await readlink(join(repository, "_pocket")), live);
    assert.match(moved.stdout, /updated {2}_pocket -> /);
});
