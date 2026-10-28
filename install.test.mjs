// install.mjs writes each target by renaming a dot-named temporary file over it, so a reload watcher never reads a
// target that is empty or half written.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { install } from "./install.mjs";

const run = promisify(execFile);
const FILES = ["team.ts", "team-web/index.js"];
const made = [];

/** A fresh temporary folder, removed when the tests end. */
async function folder() {
    const path = await mkdtemp(join(tmpdir(), "pi-pocket-install-"));

    made.push(path);

    return path;
}

after(async () => {
    for (const path of made) {
        await rm(path, { recursive: true, force: true });
    }
});

/** The same names and sizes in both versions, with a different fill: old and new never compare equal. */
const version = (size, seed) =>
    Object.fromEntries(FILES.map((file, at) => [file, Buffer.alloc(size, seed + at)]));

/** Writes `bytes` to `root/file`, making its folder. */
async function put(root, file, bytes) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), bytes);
}

/** An installed Pi Pocket extensions folder carries these packages: `install` checks for them. */
async function installed(root) {
    await mkdir(join(root, "node_modules", "@earendil-works", "pi-durable"), { recursive: true });

    return root;
}

/** Two folders: `source` with the new bytes, `target` with the old ones. */
async function pair(size = 300 * 1024) {
    const source = await folder();
    const target = await installed(await folder());
    const oldBytes = version(size, 0x61);
    const newBytes = version(size, 0x71);

    for (const file of FILES) {
        await put(target, file, oldBytes[file]);
        await put(source, file, newBytes[file]);
    }

    return { source, target, oldBytes, newBytes };
}

/** The file a temporary file will replace: `.team.ts.install-123` is `team.ts`. */
const targetOf = (temporary) =>
    join(
        dirname(temporary),
        basename(temporary)
            .slice(1)
            .replace(/\.install-\d+$/, ""),
    );

/** Every installed file whose name holds a temporary name. */
const leftovers = async (root) =>
    (await readdir(root, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.includes(".install-"))
        .map((entry) => join(entry.parentPath, entry.name));

/**
 * A write that puts the first half down, waits 400 ms (longer than Pocket's 300 ms reload debounce), then puts the
 * rest: the window in which a target must never be read. `during` runs while the hook waits.
 */
const slowWrite = (during) => async (path, bytes) => {
    await writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const waiting = new Promise((done) => setTimeout(done, 400));

    if (during !== undefined) {
        await during(path);
    }

    await waiting;
    await writeFile(path, bytes);
};

/** What `path` holds right now, or undefined when it is not there. */
const now = (path) => {
    try {
        return readFileSync(path);
    } catch {
        return undefined;
    }
};

test("a target keeps its old bytes until the rename, then holds the new ones whole", async () => {
    const { source, target, oldBytes, newBytes } = await pair();
    const during = [];

    const { changed } = await install({
        source,
        target,
        check: false,
        modules: ["team.ts", "team-web"],
        write: slowWrite(async (temporary) => {
            const file = relative(target, targetOf(temporary));

            during.push({ file, bytes: await readFile(join(target, file)) });
        }),
    });

    assert.equal(changed.length, FILES.length);
    assert.equal(during.length, FILES.length);

    for (const { file, bytes } of during) {
        assert.ok(
            bytes.equals(oldBytes[file]),
            `${file} still held the old bytes while the install wrote it`,
        );
    }

    for (const file of FILES) {
        assert.ok((await readFile(join(target, file))).equals(newBytes[file]), file);
    }

    assert.deepEqual(await leftovers(target), []);
});

test("a watcher never reads a target empty or partial", async () => {
    const { source, target, oldBytes, newBytes } = await pair();
    const topNames = [];
    const webNames = [];
    const views = [];

    const top = watch(target, (event, name) => {
        if (name === null) {
            return;
        }

        topNames.push(name);

        if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("_")) {
            views.push({ file: name, bytes: now(join(target, name)) });
        }
    });

    const web = watch(join(target, "team-web"), (event, name) => {
        if (name === null) {
            return;
        }

        webNames.push(name);

        if (!name.startsWith(".")) {
            views.push({ file: `team-web/${name}`, bytes: now(join(target, "team-web", name)) });
        }
    });

    try {
        await install({
            source,
            target,
            check: false,
            modules: ["team.ts", "team-web"],
            write: slowWrite(),
        });

        await new Promise((done) => setTimeout(done, 300));
    } finally {
        top.close();
        web.close();
    }

    assert.ok(topNames.includes("team.ts"), "the watcher saw the target");
    assert.ok(views.length > 0, "the watcher read a file while the install ran");

    for (const { file, bytes } of views) {
        assert.notEqual(bytes, undefined, `${file} was there when it was read`);
        assert.ok(
            bytes.equals(oldBytes[file]) || bytes.equals(newBytes[file]),
            `${file} held ${bytes.length} bytes: neither the old ${oldBytes[file].length} nor the new ${newBytes[file].length} ones`,
        );
    }

    for (const name of topNames) {
        assert.ok(
            name === "team.ts" || name.startsWith("."),
            `${name} is not the target, so Pocket's watcher must ignore it`,
        );
    }

    for (const name of webNames) {
        assert.ok(
            name === "index.js" || name.startsWith("."),
            `${name} is not a served file, so Pocket's watcher must ignore it`,
        );
    }
});

test("a failed write leaves the old bytes and no temporary file", async () => {
    const { source, target, oldBytes } = await pair();

    await assert.rejects(
        install({
            source,
            target,
            check: false,
            modules: ["team.ts", "team-web"],
            // Half a temporary file is on disk when the write fails: it must go too.
            write: async (path, bytes) => {
                await writeFile(path, bytes.subarray(0, 10));

                throw new Error("the disk is full");
            },
        }),
        /the disk is full/,
    );

    for (const file of FILES) {
        assert.ok((await readFile(join(target, file))).equals(oldBytes[file]), file);
    }

    assert.deepEqual(await leftovers(target), []);
});

test("the command line writes the files, then reports them up to date", async () => {
    const pocket = await folder();
    const script = join(import.meta.dirname, "install.mjs");
    const env = { ...process.env, PI_POCKET_DIR: pocket };

    await installed(join(pocket, "extensions"));

    const checked = await run(process.execPath, [script, "--check"], { env });

    assert.match(checked.stdout, /^Would write in .*extensions:/m);

    const first = await run(process.execPath, [script], { env });

    assert.match(first.stdout, /^Wrote in .*extensions:/m);

    const second = await run(process.execPath, [script], { env });

    assert.match(second.stdout, /^Up to date in /m);
});
