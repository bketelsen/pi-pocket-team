#!/usr/bin/env node
// Seed each named agent's home folder: `~/agents/<id>/`, a local git repository with no remote.
//
//     node homes/seed.mjs [--check] [--agent <id>]
//
// Environment: PI_POCKET_TEAM_AGENTS (default ~/.config/pi-pocket-team/agents) and HOME (the folder `~/` means).
// A home gets an AGENTS.md, the folders `notes/`, `plans/` and `reports/`, a .gitignore, and 1 commit
// "Seed <Name>'s home". A folder that is already a git repository is left as it is (Odrade's desk is one). The script
// never overwrites a file, never deletes one, and never adds a remote. `--check` writes nothing: it prints what it
// would do, and each AGENTS.md text. See homes/README.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const USAGE = "usage: node homes/seed.mjs [--check] [--agent <id>]";

/** The folders inside a home. Each one is made with a `.gitkeep`, so git keeps it. */
export const HOME_FOLDERS = ["notes", "plans", "reports"];

/** The `.gitignore` of a home: editor and operating-system files only. Notes, plans and reports go in git. */
export const GITIGNORE = [
    "# Editor and operating-system files",
    ".DS_Store",
    "Thumbs.db",
    "*.swp",
    "*~",
    "",
].join("\n");

/** A profile file name: lowercase id, then `.md`. */
const PROFILE_FILE = /^[a-z0-9][a-z0-9_-]*\.md$/;

/** An agent id, as `--agent` takes it. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// ---------- Paths ----------

/** A folder as `~/...` when it is under the user's home folder, else as it is. */
export function displayPath(folder, userHome) {
    const home = String(userHome).replace(/\/+$/, "");

    if (folder === home) {
        return "~";
    }

    return folder.startsWith(`${home}/`) ? `~/${folder.slice(home.length + 1)}` : folder;
}

/** `~/agents/x` and `/home/x/agents/x` as absolute paths. A relative folder is an error: it would write anywhere. */
export function resolveFolder(value, userHome) {
    if (typeof value !== "string" || value === "") {
        throw new Error("a home must be an absolute path or start with ~/.");
    }

    if (value.startsWith("~/")) {
        return path.join(userHome, value.slice(2));
    }

    if (path.isAbsolute(value)) {
        return value;
    }

    throw new Error(`the home ${value} must be an absolute path or start with ~/.`);
}

// ---------- Profiles ----------

/** The text of a profile's `## Responsibilities` section, or "" when it has none. */
export function responsibilitiesOf(body) {
    const heading = /^##\s+Responsibilities\s*$/m.exec(body);

    if (!heading) {
        return "";
    }

    const rest = body.slice(heading.index + heading[0].length);
    const next = /^##\s+/m.exec(rest);

    return (next ? rest.slice(0, next.index) : rest).trim();
}

/** The `AGENTS.md` of 1 home. Pure: the same arguments give the same text. */
export function homeAgentsText({ name, charter, date, repositories = {}, userHome }) {
    const rows = Object.entries(repositories).map(([repository, folder]) => {
        const shown = displayPath(folder, userHome);

        return `| \`${repository}\` | \`${shown}\` | \`${shown}/AGENTS.md\` |`;
    });
    const table =
        rows.length === 0
            ? "The profile names no repositories."
            : ["| Repository | Folder | AGENTS.md |", "| --- | --- | --- |", ...rows].join("\n");
    const responsibilities =
        charter.trim() === ""
            ? "The profile has no `## Responsibilities` section."
            : [
                  `This charter is a copy of the \`## Responsibilities\` section of ${name}'s profile, made on ${date}. When this copy and a session's identity section differ, the identity section wins.`,
                  "",
                  charter.trim(),
              ].join("\n");

    return `# ${name}'s home

This folder is ${name}'s home: notes, plans and reports across all ${name}'s repositories. It is not a
repository you ship.

## Charter

${responsibilities}

## Repositories

${table}

These folders and their AGENTS.md files also come from the identity section of a session ("Your
repositories").

## Rules

1. Change a repository only in a new repository session. From a top-level home session, start it with
   \`team_work\`. In a linked session, report the plan to the session that started you instead.
2. Read a repository's AGENTS.md, and each nested one that \`git -C <folder> ls-files '*AGENTS.md'\`
   lists, before you answer about it or plan work in it.
3. Read-only commands in a repository are fine from here (\`git log\`, \`gh\`, \`rg\`).

## This folder

- \`notes/YYYY-MM-DD-topic.md\`, \`plans/\`, and \`reports/YYYY-MM-DD-topic/README.md\`.
- Commit this folder at the end of each task, with a short message.
- Never add a remote and never push.
- Lessons about 1 repository go in the memory tool, from a session in that repository. Lessons about
  the role go in \`team_memory\`.
`;
}

/**
 * Every profile in a folder: its id, name, charter (its `## Responsibilities`), home and repositories. A profile
 * with no `home` keeps `home: undefined`: the caller lists it and skips it.
 */
export function readProfiles(directory) {
    let files;

    try {
        files = fs.readdirSync(directory);
    } catch (error) {
        throw new Error(`no profiles in ${directory}: ${String(error?.message ?? error)}`);
    }

    return files
        .filter((file) => PROFILE_FILE.test(file))
        .sort()
        .map((file) => {
            const { frontmatter, body } = parseFrontmatter(
                fs.readFileSync(path.join(directory, file), "utf8"),
            );
            const repositories = isRecord(frontmatter.repositories)
                ? Object.fromEntries(
                      Object.entries(frontmatter.repositories).filter(
                          ([, folder]) => typeof folder === "string",
                      ),
                  )
                : {};

            return {
                id: file.slice(0, -3),
                name: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? file.slice(0, -3),
                charter: responsibilitiesOf(body),
                home: typeof frontmatter.home === "string" ? frontmatter.home : undefined,
                repositories,
            };
        });
}

// ---------- Git ----------

/** Run a command and return its stdout. A command that fails throws an error with `stderr`. */
export function defaultRun(command, args) {
    return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
    });
}

/** The first line of a failed command's error, for a message a person can read. */
function reasonOf(error) {
    const text = String(error?.stderr ?? error?.message ?? error);

    return (
        text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "") ?? "git failed"
    );
}

// ---------- Seeding ----------

/** `YYYY-MM-DD` in America/New_York: the day the copy of the charter is made. */
const dayOf = (now) =>
    new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);

/** Write a file, and only when it is missing: an existing file is never overwritten. */
function writeNew(file, text) {
    if (fs.existsSync(file)) {
        return false;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);

    return true;
}

/**
 * Seed the home of each profile that names one. Options: `profilesDir`, `userHome` (the folder `~/` means),
 * `check` (write nothing), `agent` (1 id), `now`, `log` and `run` (a process runner, for tests).
 *
 * Returns `{ homes, skipped }`: each home with its id, name, folder and the actions it lists, and each skipped
 * profile with the reason.
 */
export function seedHomes({
    profilesDir = process.env.PI_POCKET_TEAM_AGENTS ??
        path.join(os.homedir(), ".config", "pi-pocket-team", "agents"),
    userHome = process.env.HOME ?? os.homedir(),
    check = false,
    agent,
    now = Date.now(),
    log = console.log,
    run = defaultRun,
} = {}) {
    const date = dayOf(now);
    const profiles = readProfiles(profilesDir);

    if (agent !== undefined && !profiles.some((profile) => profile.id === agent)) {
        throw new Error(`no profile for ${agent} in ${profilesDir}.`);
    }

    const git = (folder, args) => {
        try {
            return String(run("git", ["-C", folder, ...args]) ?? "");
        } catch (error) {
            throw new Error(`${folder}: git ${args.join(" ")} failed: ${reasonOf(error)}`);
        }
    };

    const homes = [];
    const skipped = [];

    for (const profile of agent === undefined ? profiles : profiles.filter((p) => p.id === agent)) {
        if (profile.home === undefined) {
            skipped.push({ id: profile.id, reason: "the profile names no home" });
            log(`${profile.id}: skipped, because the profile names no home.`);

            continue;
        }

        const folder = resolveFolder(profile.home, userHome);
        const shown = displayPath(folder, userHome);

        // A folder that is already a git repository is left as it is: Odrade's desk is one, and a new file in it
        // would stay uncommitted. The seed adds nothing there, and never commits.
        if (fs.existsSync(path.join(folder, ".git"))) {
            homes.push({ id: profile.id, name: profile.name, folder, shown, actions: [] });
            log(`${profile.id}: already a git repository, left as it is (${shown}).`);

            continue;
        }

        const actions = [];
        const work = [];

        if (!fs.existsSync(folder)) {
            actions.push("make the folder");
            work.push(() => fs.mkdirSync(folder, { recursive: true }));
        }

        const text = homeAgentsText({
            name: profile.name,
            charter: profile.charter,
            date,
            repositories: profile.repositories,
            userHome,
        });
        const agentsFile = path.join(folder, "AGENTS.md");

        if (!fs.existsSync(agentsFile)) {
            actions.push("write AGENTS.md");
            work.push(() => writeNew(agentsFile, text));
        }

        for (const name of HOME_FOLDERS) {
            const keep = path.join(folder, name, ".gitkeep");

            if (fs.existsSync(keep)) {
                continue;
            }

            actions.push(`make ${name}/`);
            work.push(() => writeNew(keep, ""));
        }

        const gitignore = path.join(folder, ".gitignore");

        if (!fs.existsSync(gitignore)) {
            actions.push("write .gitignore");
            work.push(() => writeNew(gitignore, GITIGNORE));
        }

        const message = `Seed ${profile.name}'s home`;

        actions.push(`git init -b main, git add -A, 1 commit "${message}"`);
        work.push(() => {
            git(folder, ["init", "-b", "main"]);
            git(folder, ["add", "-A"]);
            git(folder, ["commit", "-m", message]);
        });

        homes.push({ id: profile.id, name: profile.name, folder, shown, actions });

        if (check) {
            log(
                actions.length === 0
                    ? `${profile.id}: up to date (${shown}).`
                    : `${profile.id}: would ${actions.join("; ")} (${shown}).`,
            );
            log(`--- AGENTS.md of ${shown} ---`);
            log(text);
            log(`--- end of ${shown} ---`);

            continue;
        }

        if (actions.length === 0) {
            log(`${profile.id}: up to date (${shown}).`);

            continue;
        }

        work.forEach((step) => step());
        log(`${profile.id}: ${actions.join("; ")} (${shown}).`);
    }

    return { homes, skipped };
}

// ---------- Command line ----------

/** Read the command line. Throws an Error with the usage on a bad option. */
export function parseArgs(argv) {
    const options = { check: false };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--check") {
            options.check = true;
        } else if (arg === "--agent") {
            i += 1;

            if (argv[i] === undefined || !AGENT_ID.test(argv[i])) {
                throw new Error(`--agent needs an agent id, such as irulan. ${USAGE}`);
            }

            options.agent = argv[i];
        } else {
            throw new Error(`unknown option ${arg}. ${USAGE}`);
        }
    }

    return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        seedHomes(parseArgs(process.argv.slice(2)));
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 2;
    }
}
