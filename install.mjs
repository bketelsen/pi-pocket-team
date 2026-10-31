// Installs the drop-ins into Pi Pocket's extensions folder. Only files whose bytes differ are written: each write
// reloads that module into the running server, so an install of unchanged source touches nothing.
// Each file is written to a dot-named temporary file beside it and renamed over the target, so a reload never sees a
// partial file. `node install.mjs --check` only lists what would change.
import {
    access,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES = [
    "team.ts",
    "team-web",
    "homewiki.ts",
    "homewiki-web",
    "night-shift.ts",
    "night-shift-web",
    "model-router.ts",
    "_desk-dashboard.ts",
    "desk.ts",
    "desk-web",
    "terminal.ts",
    "terminal-web",
];

/**
 * Writes `bytes` to a dot-named temporary file in the target's own folder, then renames it over the target: a rename
 * is atomic, so a watcher sees the old file or the new one, never an empty or partial one.
 */
export async function writeAtomic(path, bytes, write = writeFile) {
    const temporary = join(dirname(path), `.${basename(path)}.install-${process.pid}`);

    try {
        await write(temporary, bytes);
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true });

        throw error;
    }
}

/** Every file of a module, relative to `source`: the file itself, or the files in its folder. */
async function filesOf(source, name) {
    const path = join(source, name);

    if (!name.endsWith("-web")) {
        return [name];
    }

    const entries = await readdir(path, { recursive: true, withFileTypes: true });

    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(source, join(entry.parentPath, entry.name)));
}

async function bytes(path) {
    try {
        return await readFile(path);
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

/** Installed files in a module's folder that the project does not have: reported, never deleted. */
async function extras(target, name, known) {
    try {
        const entries = await readdir(join(target, name), { recursive: true, withFileTypes: true });

        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => relative(target, join(entry.parentPath, entry.name)))
            .filter((file) => !known.has(file));
    } catch {
        return [];
    }
}

/**
 * Installs every module from `source` into `target`. Returns the one-line reports: `changed` says "new" or "changed"
 * and the file, and `unknown` lists installed files the project does not have. `write` is passed to `writeAtomic`.
 */
export async function install({ source, target, check, modules = MODULES, write = writeFile }) {
    if (!check) {
        await mkdir(target, { recursive: true });
        await access(join(target, "node_modules", "@earendil-works", "pi-durable"));
    }

    const changed = [];
    const unknown = [];

    for (const name of modules) {
        const files = await filesOf(source, name);

        for (const file of files) {
            const wanted = await readFile(join(source, file));
            const installed = await bytes(join(target, file));

            if (installed !== undefined && installed.equals(wanted)) {
                continue;
            }

            changed.push(`${installed === undefined ? "new" : "changed"}  ${file}`);

            if (!check) {
                await mkdir(dirname(join(target, file)), { recursive: true });
                await writeAtomic(join(target, file), wanted, write);
            }
        }

        if (name.endsWith("-web")) {
            unknown.push(...(await extras(target, name, new Set(files))));
        }
    }

    return { changed, unknown };
}

/** True when node was asked to run this file, so the CLI part runs only then. */
async function isEntry() {
    const run = process.argv[1];

    if (run === undefined) {
        return false;
    }

    const real = async (path) => {
        try {
            return await realpath(path);
        } catch {
            return resolve(path);
        }
    };

    return (await real(run)) === (await real(fileURLToPath(import.meta.url)));
}

if (await isEntry()) {
    const check = process.argv.includes("--check");
    const source = import.meta.dirname;
    const target = join(process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket"), "extensions");
    const { changed, unknown } = await install({ source, target, check });
    const verb = check ? "Would write" : "Wrote";

    console.log(
        changed.length === 0
            ? `Up to date in ${target}: nothing written.`
            : `${verb} in ${target}:\n  ${changed.join("\n  ")}`,
    );

    if (unknown.length > 0) {
        console.log(`Installed but not in the project (left alone):\n  ${unknown.join("\n  ")}`);
    }

    if (!check && changed.length > 0) {
        console.log(
            "Saved modules reload into the running server. Turn new ones on in Menu → Extensions.",
        );
    }
}
