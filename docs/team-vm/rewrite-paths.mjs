#!/usr/bin/env node
// Step 6 of docs/team-vm-cutover.md: rewrite the configuration that names /var/home/bjk, for the team VM.
//
//   node rewrite-paths.mjs --check          # print what would change, write nothing
//   node rewrite-paths.mjs                  # rewrite; keep <file>.bak (once) outside git folders; verify
//   node rewrite-paths.mjs --root DIR       # work on a copy laid out like the team user's home (a test)
//
// It never opens the database (pocket.sqlite): Pocket's data is not edited. It is safe to run again: a second run
// changes nothing. Exit 0 when every active file is free of /var/home/bjk, 1 when one is not, 2 on a usage error.
import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const OLD = "/var/home/bjk";
const NEW = "/var/home/team";
const args = process.argv.slice(2);
const check = args.includes("--check");
const rootAt = args.indexOf("--root");
const root = rootAt === -1 ? homedir() : args[rootAt + 1];

if (
    root === undefined ||
    args.some((a, i) => !["--check", "--root"].includes(a) && i !== rootAt + 1)
) {
    console.error("usage: node rewrite-paths.mjs [--check] [--root DIR]");
    process.exit(2);
}

const exists = (path) =>
    stat(path).then(
        () => true,
        () => false,
    );
const changes = [];

/** Write `text` to `path` when it differs; keep the first original as `.bak` unless the folder is in git. */
async function put(path, before, after, backup) {
    if (before === after) {
        return;
    }

    changes.push(relative(root, path));

    if (check) {
        return;
    }

    if (backup && !(await exists(`${path}.bak`))) {
        await copyFile(path, `${path}.bak`);
    }

    await writeFile(path, after);
}

const replaceAll = (text, pairs) => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);

// 1. Agent profiles: folders become ~/..., Odrade's desk goes to her home, and the front matter gets home:.
const agentsDir = join(root, ".config/pi-pocket-team/agents");

for (const file of (await readdir(agentsDir))
    .filter((f) => /^[a-z0-9][a-z0-9_-]*\.md$/.test(f))
    .sort()) {
    const id = file.slice(0, -3);
    const path = join(agentsDir, file);
    const before = await readFile(path, "utf8");
    let after = replaceAll(before, [
        [`${OLD}/projects/odrade`, "~/agents/odrade"],
        [`${OLD}/`, "~/"],
    ]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(after);

    if (!match) {
        console.error(`${file}: no front matter; front matter left as it is`);
    } else {
        let front = match[1];
        const role = /^role:\s*(\S+)/m.exec(front)?.[1] ?? "agent";

        if (id === "odrade") {
            front = front.replace(/^workspace: ~\/agents\/odrade$/m, "home: ~/agents/odrade");
        } else if (id === "moneo") {
            front = front.replace(
                /^workspace: ~\/projects\/truenas-mcp$/m,
                "repositories:\n  bketelsen/truenas-mcp: ~/projects/truenas-mcp",
            );
        }

        if (role !== "clerk" && !/^home:/m.test(front)) {
            front = `${front}\nhome: ~/agents/${id}`;
        }

        const workspace = /^workspace:.*$/m.exec(front)?.[0];

        if (workspace && role !== "clerk") {
            console.error(`${file}: keeps "${workspace}"; check it by hand`);
        }

        after = after.replace(match[0], `---\n${front}\n---\n`);
    }

    await put(path, before, after, true);
}

// 2. The desk configuration: the export goes to Odrade's home.
const deskPath = join(root, ".config/pi-pocket-team/desk.json");

if (await exists(deskPath)) {
    const before = await readFile(deskPath, "utf8");
    const after = replaceAll(before, [
        [`${OLD}/projects/odrade/desk`, `${NEW}/agents/odrade/desk`],
    ]);

    JSON.parse(after);
    await put(deskPath, before, after, true);
}

// 3. Pi's config: the cross-review prompt and the project trust.
for (const name of ["prompts/cross-review.md", "trust.json"]) {
    const path = join(root, ".pi/agent", name);

    if (await exists(path)) {
        const before = await readFile(path, "utf8");
        const after = replaceAll(before, [[`${OLD}/`, `${NEW}/`]]);

        if (name.endsWith(".json")) {
            JSON.parse(after);
        }

        await put(path, before, after, true);
    }
}

// 4. Odrade's AGENTS.md and plans/ (a git folder: no .bak, commit the change there). desk/, decisions/ and reports/
// are history and stay as they are.
async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            yield* walk(path);
        } else if (entry.isFile()) {
            yield path;
        }
    }
}

const odrade = join(root, "agents/odrade");
const odradeFiles = [join(odrade, "AGENTS.md")];

for await (const path of walk(join(odrade, "plans"))) {
    odradeFiles.push(path);
}

for (const path of odradeFiles) {
    if (!(await exists(path))) {
        continue;
    }

    const before = await readFile(path, "utf8");
    const after = replaceAll(before, [
        [`${OLD}/projects/odrade`, `${NEW}/agents/odrade`],
        [`${OLD}/`, `${NEW}/`],
    ]);

    await put(path, before, after, false);
}

// Verify: no active file names the old home. .bak copies keep it on purpose; sessions/ and git/ are not config.
const leftovers = [];
const scan = [
    join(root, ".config/pi-pocket-team"),
    join(root, ".pi/agent"),
    join(odrade, "AGENTS.md"),
    join(odrade, "plans"),
];

for (const top of scan) {
    const files = (await stat(top).catch(() => undefined))?.isFile() ? [top] : [];

    if (files.length === 0) {
        for await (const path of walk(top)) {
            const rel = relative(join(root, ".pi/agent"), path);

            if (path.endsWith(".bak") || /^(sessions|git)\//.test(rel)) {
                continue;
            }

            files.push(path);
        }
    }

    for (const path of files) {
        if ((await readFile(path)).includes(OLD)) {
            leftovers.push(relative(root, path));
        }
    }
}

console.log(`${check ? "would change" : "changed"}: ${changes.length} file(s)`);
changes.forEach((c) => console.log(`  ${c}`));

if (leftovers.length > 0) {
    console.log(`${check ? "still" : "LEFT"} naming ${OLD}: ${leftovers.length} file(s)`);
    leftovers.forEach((l) => console.log(`  ${l}`));
}

if (!check) {
    console.log(
        leftovers.length === 0 ? "REWRITE OK" : "REWRITE INCOMPLETE: fix the files above by hand",
    );
}

process.exit(check || leftovers.length === 0 ? 0 : 1);
