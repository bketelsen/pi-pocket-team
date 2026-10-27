#!/usr/bin/env node
// Step 6 of docs/team-vm-cutover.md: rewrite the configuration that names /var/home/bjk, for the team VM.
//
//   node rewrite-paths.mjs --check          # print what would change, write nothing
//   node rewrite-paths.mjs                  # rewrite; keep <file>.bak (once) outside git folders; verify
//   node rewrite-paths.mjs --root DIR       # work on a copy laid out like the team user's home (a test)
//
// It never opens the database (pocket.sqlite): Pocket's data is not edited. It is safe to run again: a second run
// changes nothing. It plans every change and checks the planned profiles before it writes anything.
// Exit 0: done (or, with --check, a plan with no problem). Exit 1: a profile it cannot convert, or an active file
// or link that still names /var/home/bjk. Exit 2: a usage error.
import { copyFile, lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

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
            argv[i + 1] !== undefined
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

const replaceAll = (text, pairs) => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);

/** Planned writes: { path, before, after, backup }. Nothing is written until every check passes. */
const plan = [];
const problems = [];

// 1. Agent profiles: folders become ~/..., Odrade's desk goes to her home, and the front matter gets home:.
const agentsDir = join(root, ".config/pi-pocket-team/agents");
/** Front matter lines this script understands: `key: plain value`, `key:`, and `  owner/name: plain value`. */
const PLAIN_LINE =
    /^(?:[a-z]+:(?: [^\s"'][^"']*)?|  [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+: [^\s"'][^"']*)$/;
const profiles = (await readdir(agentsDir))
    .filter((f) => /^[a-z0-9][a-z0-9_-]*\.md$/.test(f))
    .sort();

for (const file of profiles) {
    const id = file.slice(0, -3);
    const path = join(agentsDir, file);
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

if (await entry(deskPath)) {
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

    if (await entry(path)) {
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
/** Files and links under `dir`, without `.git` folders; a missing `dir` has none, a read error stops the run. */
async function* walk(dir) {
    let entries;

    try {
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
                yield* walk(path);
            }
        } else {
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
    if (!(await entry(path))?.isFile()) {
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
    console.log(`STOPPED, nothing written: ${problems.length} profile problem(s)`);
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
// folders are not configuration. With --check, the planned text counts, not the text on disk.
const planned = new Map(plan.map((p) => [p.path, p.after]));
const leftovers = [];

for (const top of [
    join(root, ".config/pi-pocket-team"),
    join(root, ".pi/agent"),
    join(odrade, "AGENTS.md"),
    join(odrade, "plans"),
]) {
    const kind = await entry(top);
    const paths = [];

    if (kind?.isDirectory()) {
        for await (const path of walk(top)) {
            if (
                !path.endsWith(".bak") &&
                !relative(join(root, ".pi/agent"), path).startsWith("sessions/")
            ) {
                paths.push(path);
            }
        }
    } else if (kind) {
        paths.push(top);
    }

    for (const path of paths) {
        const item = await lstat(path);
        const text = item.isSymbolicLink()
            ? await readlink(path)
            : item.isFile()
              ? (planned.get(path) ?? (await readFile(path, "utf8")))
              : "";

        if (text.includes(OLD)) {
            leftovers.push(`${relative(root, path)}${item.isSymbolicLink() ? " (a link)" : ""}`);
        }
    }
}

if (leftovers.length > 0) {
    console.log(`${check ? "would still name" : "LEFT naming"} ${OLD}: ${leftovers.length}`);
    leftovers.forEach((l) => console.log(`  ${l}`));
}

if (!check) {
    console.log(
        leftovers.length === 0 ? "REWRITE OK" : "REWRITE INCOMPLETE: fix the files above by hand",
    );
}

process.exit(leftovers.length === 0 ? 0 : 1);
