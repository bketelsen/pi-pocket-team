// Installs the drop-ins into Pi Pocket's extensions folder. Only files whose bytes differ are written: each write
// reloads that module into the running server, so an install of unchanged source touches nothing.
// `node install.mjs --check` only lists what would change.
import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const MODULES = [
    "team.ts",
    "team-web",
    "homewiki.ts",
    "homewiki-web",
    "night-shift.ts",
    "night-shift-web",
    "desk.ts",
    "desk-web",
];
const check = process.argv.includes("--check");
const source = import.meta.dirname;
const target = join(process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket"), "extensions");

/** Every file of a module, relative to the project: the file itself, or the files in its folder. */
async function filesOf(name) {
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
async function extras(name, known) {
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

if (!check) {
    await mkdir(target, { recursive: true });
    await access(join(target, "node_modules", "@earendil-works", "pi-durable"));
}

const changed = [];
const unknown = [];

for (const name of MODULES) {
    const files = await filesOf(name);

    for (const file of files) {
        const wanted = await readFile(join(source, file));
        const installed = await bytes(join(target, file));

        if (installed !== undefined && installed.equals(wanted)) {
            continue;
        }

        changed.push(`${installed === undefined ? "new" : "changed"}  ${file}`);

        if (!check) {
            await mkdir(dirname(join(target, file)), { recursive: true });
            await copyFile(join(source, file), join(target, file));
        }
    }

    if (name.endsWith("-web")) {
        unknown.push(...(await extras(name, new Set(files))));
    }
}

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
