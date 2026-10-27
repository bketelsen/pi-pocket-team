#!/usr/bin/env node
// Step 6 of docs/team-vm-cutover.md: rewrite the configuration that names /var/home/bjk, for the team VM.
//
//   node rewrite-paths.mjs --check          # print what would change, write nothing
//   node rewrite-paths.mjs                  # rewrite; keep <file>.bak (once) outside git folders; verify
//   node rewrite-paths.mjs --root DIR       # work on a copy laid out like the team user's home (a test)
//
// It never opens the database (pocket.sqlite): Pocket's data is not edited. It is safe to run again: a second run
// changes nothing. It plans every change and checks the planned profiles before it writes anything.
// It never reads Pocket's data folder (.pi-pocket) or a *.sqlite file, also not through a link.
// Exit 0: done (or, with --check, a plan with no problem). Exit 1: a file it cannot convert, an active file or link
// that still names /var/home/bjk, or a link into Pocket's data. Exit 2: a usage error. Other errors stop the run.
import {
    copyFile,
    lstat,
    readdir,
    readFile,
    readlink,
    realpath,
    stat,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

const OLD = "/var/home/bjk";
const NEW = "/var/home/team";
const USAGE = "usage: node rewrite-paths.mjs [--check] [--root DIR]";

function parseArgs(argv) {
    const options = { check: false, root: undefined };

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--check" && !options.check) {
            options.check = true;
        } else if (
            argv[i] === "--root" &&
            options.root === undefined &&
            argv[i + 1] !== undefined &&
            !argv[i + 1].startsWith("-")
        ) {
            options.root = argv[++i];
        } else {
            return undefined;
        }
    }

    return options;
}

const options = parseArgs(process.argv.slice(2));

if (options === undefined || options.root === "") {
    console.error(USAGE);
    process.exit(2);
}

const { check } = options;
const root = options.root ?? homedir();

/** The entry at `path`, or undefined when it does not exist; any other error stops the run. */
async function entry(path) {
    try {
        return await lstat(path);
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

/** What is at `path` behind any links, and its real path; undefined when it or a link's target does not exist. */
async function target(path) {
    try {
        return { stat: await stat(path), real: await realpath(path) };
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

const pocketData = (await target(join(root, ".pi-pocket")))?.real ?? join(root, ".pi-pocket");
/** Pocket's data folder and any database: the script never reads them. */
const isPocketData = (real) =>
    real === pocketData ||
    real.startsWith(`${pocketData}/`) ||
    /\.sqlite(?:-\w+)?$|\.db$/.test(basename(real));

/**
 * A file the plan reads and writes must be a plain file outside Pocket's data: a link would write through to somewhere
 * else, and a folder on the way can be a link too, so the real path is checked before any read.
 */
async function plainFile(path) {
    const item = await entry(path);

    if (item !== undefined && isPocketData((await target(path))?.real ?? path)) {
        problems.push(`${relative(root, path)}: in Pocket's data or a database; not read`);

        return false;
    }

    if (item !== undefined && !item.isFile()) {
        problems.push(`${relative(root, path)}: not a plain file (a link?); change it by hand`);

        return false;
    }

    return item !== undefined;
}

const replaceAll = (text, pairs) => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);

/** Planned writes: { path, before, after, backup }. Nothing is written until every check passes. */
const plan = [];
const problems = [];

// 1. Agent profiles: folders become ~/..., Odrade's desk goes to her home, and the front matter gets home:.
const agentsDir = join(root, ".config/pi-pocket-team/agents");
/** Front matter lines this script understands: `key: plain value`, `key:`, and `  owner/name: plain value`. */
const PLAIN_LINE =
    /^(?:[a-z]+:(?: [^\s"'][^"']*)?|  [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+: [^\s"'][^"']*)$/;

/** A folder the plan reads must not be in Pocket's data, also through a link: undefined when it is. */
async function planFolder(dir) {
    const found = await target(dir);

    if (found !== undefined && isPocketData(found.real)) {
        problems.push(`${relative(root, dir)}: in Pocket's data; not read`);

        return undefined;
    }

    return found;
}

const profiles = ((await planFolder(agentsDir)) === undefined ? [] : await readdir(agentsDir))
    .filter((f) => /^[a-z0-9][a-z0-9_-]*\.md$/.test(f))
    .sort();

for (const file of profiles) {
    const id = file.slice(0, -3);
    const path = join(agentsDir, file);

    if (!(await plainFile(path))) {
        continue;
    }

    const before = await readFile(path, "utf8");
    let after = replaceAll(before, [
        [`${OLD}/projects/odrade`, "~/agents/odrade"],
        [`${OLD}/`, "~/"],
    ]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(after);

    if (!match) {
        problems.push(`${file}: no front matter`);
        continue;
    }

    const odd = match[1].split("\n").filter((line) => !PLAIN_LINE.test(line));

    if (odd.length > 0) {
        problems.push(
            `${file}: front matter line(s) this script does not handle: ${odd.join(" | ")}`,
        );
        continue;
    }

    let front = match[1];
    const role = /^role: (\S+)$/m.exec(front)?.[1] ?? "agent";

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

    // The planned profile must be what the runbook asks for.
    const home = /^home: (.*)$/m.exec(front)?.[1];
    const workspace = /^workspace: (.*)$/m.exec(front)?.[1];

    if (role === "clerk") {
        if (home !== undefined || workspace !== "~/agents/odrade") {
            problems.push(`${file}: a Clerk keeps "workspace: ~/agents/odrade" and has no home:`);
        }
    } else if (home !== `~/agents/${id}` || workspace !== undefined) {
        problems.push(`${file}: wants "home: ~/agents/${id}" and no workspace:`);
    }

    if (id === "moneo" && !/^ {2}bketelsen\/truenas-mcp: ~\/projects\/truenas-mcp$/m.test(front)) {
        problems.push(
            `${file}: wants the repository bketelsen/truenas-mcp at ~/projects/truenas-mcp`,
        );
    }

    after = after.replace(match[0], `---\n${front}\n---\n`);
    plan.push({ path, before, after, backup: true });
}

// 2. The desk configuration: the export goes to Odrade's home.
const deskPath = join(root, ".config/pi-pocket-team/desk.json");

if (await plainFile(deskPath)) {
    const before = await readFile(deskPath, "utf8");
    const after = replaceAll(before, [
        [`${OLD}/projects/odrade/desk`, `${NEW}/agents/odrade/desk`],
    ]);

    JSON.parse(after);
    plan.push({ path: deskPath, before, after, backup: true });
}

// 3. Pi's config: the cross-review prompt and the project trust.
for (const name of ["prompts/cross-review.md", "trust.json"]) {
    const path = join(root, ".pi/agent", name);

    if (await plainFile(path)) {
        const before = await readFile(path, "utf8");
        const after = replaceAll(before, [[`${OLD}/`, `${NEW}/`]]);

        if (name.endsWith(".json")) {
            JSON.parse(after);
        }

        plan.push({ path, before, after, backup: true });
    }
}

// 4. Odrade's AGENTS.md and plans/ (a git folder: no .bak, commit the change there). desk/, decisions/ and reports/
// are history and stay as they are.
/** Links into Pocket's data, found by the verification: never read, and the run fails. */
const refused = new Set();

/**
 * Files and links under `dir`, without `.git` folders; a missing `dir` has none, any other error stops the run. With
 * `follow`, a link to a folder is walked too (each real folder once), because Pi loads resources through links; a
 * folder in Pocket's data is not walked.
 */
async function* walk(dir, follow = false, seen = new Set()) {
    let entries;

    try {
        if (follow) {
            const real = await realpath(dir);

            if (isPocketData(real)) {
                refused.add(dir);

                return;
            }

            if (seen.has(real)) {
                return;
            }

            seen.add(real);
        }

        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }

        throw error;
    }

    for (const item of entries) {
        const path = join(dir, item.name);

        if (item.isDirectory()) {
            if (item.name !== ".git") {
                yield* walk(path, follow, seen);
            }
        } else {
            yield path;

            if (follow && item.isSymbolicLink() && (await target(path))?.stat.isDirectory()) {
                yield* walk(path, follow, seen);
            }
        }
    }
}

const odrade = join(root, "agents/odrade");
const odradeFiles = [join(odrade, "AGENTS.md")];

for await (const path of (await planFolder(join(odrade, "plans"))) === undefined
    ? []
    : walk(join(odrade, "plans"))) {
    odradeFiles.push(path);
}

for (const path of odradeFiles) {
    if (!(await plainFile(path))) {
        continue;
    }

    const before = await readFile(path, "utf8");
    const after = replaceAll(before, [
        [`${OLD}/projects/odrade`, `${NEW}/agents/odrade`],
        [`${OLD}/`, `${NEW}/`],
    ]);

    plan.push({ path, before, after, backup: false });
}

const changes = plan.filter((p) => p.before !== p.after);

console.log(
    `${check ? "would change" : "changed"}: ${problems.length > 0 ? 0 : changes.length} file(s)`,
);

if (problems.length > 0) {
    console.log(`STOPPED, nothing written: ${problems.length} problem(s)`);
    problems.forEach((p) => console.log(`  ${p}`));
    process.exit(1);
}

changes.forEach((c) => console.log(`  ${relative(root, c.path)}`));

if (!check) {
    for (const { path, after, backup } of changes) {
        if (backup && !(await entry(`${path}.bak`))) {
            await copyFile(path, `${path}.bak`);
        }

        await writeFile(path, after);
    }
}

// Verify: no active file or link names the old home. .bak copies keep it on purpose; Pi CLI sessions/ and .git
// folders are not configuration. Links are followed, also at the top; only a missing target counts as a broken link.
// With --check, the planned text counts, not the text on disk.
const planned = new Map(plan.map((p) => [p.path, p.after]));
const leftovers = [];

for (const top of [
    join(root, ".config/pi-pocket-team"),
    join(root, ".pi/agent"),
    join(odrade, "AGENTS.md"),
    join(odrade, "plans"),
]) {
    const found = await target(top);
    const paths = [];

    if (found?.stat.isDirectory()) {
        for await (const path of walk(top, true)) {
            if (
                !path.endsWith(".bak") &&
                !relative(join(root, ".pi/agent"), path).startsWith("sessions/")
            ) {
                paths.push(path);
            }
        }
    } else if ((await entry(top)) !== undefined) {
        paths.push(top);
    }

    for (const path of paths) {
        const item = await lstat(path);
        const behind = await target(path);

        if (behind !== undefined && isPocketData(behind.real)) {
            refused.add(path);
            continue;
        }

        // A link counts by its own text and by the file behind it (a folder behind it is walked above).
        const text = [
            item.isSymbolicLink() ? await readlink(path) : "",
            behind?.stat.isFile() ? (planned.get(path) ?? (await readFile(path, "utf8"))) : "",
        ].join("\n");

        if (text.includes(OLD)) {
            leftovers.push(`${relative(root, path)}${item.isSymbolicLink() ? " (a link)" : ""}`);
        }
    }
}

if (leftovers.length > 0) {
    console.log(`${check ? "would still name" : "LEFT naming"} ${OLD}: ${leftovers.length}`);
    leftovers.forEach((l) => console.log(`  ${l}`));
}

if (refused.size > 0) {
    console.log(`NOT READ, a link into Pocket's data or a database: ${refused.size}`);
    refused.forEach((r) => console.log(`  ${relative(root, r)}`));
}

const ok = leftovers.length === 0 && refused.size === 0;

if (!check) {
    console.log(ok ? "REWRITE OK" : "REWRITE INCOMPLETE: fix the files above by hand");
}

process.exit(ok ? 0 : 1);
