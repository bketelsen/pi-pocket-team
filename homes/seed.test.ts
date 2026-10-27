// The seed script of the agents' homes, on temporary folders and real git. Nothing here reads or writes Brian's
// profiles, his homes or his data: every folder comes from `fs.mkdtempSync`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    GITIGNORE,
    HOME_FOLDERS,
    displayPath,
    homeAgentsText,
    parseArgs,
    resolveFolder,
    seedHomes,
} from "./seed.mjs";

/** 2026-10-27 14:00 UTC: 10:00 in New York. */
const NOW = Date.UTC(2026, 9, 27, 14, 0);
const DATE = "2026-10-27";

/** A git that needs no setting of the machine: identity and signing come from the environment, not from a config. */
const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Seed test",
    GIT_AUTHOR_EMAIL: "seed@example.invalid",
    GIT_COMMITTER_NAME: "Seed test",
    GIT_COMMITTER_EMAIL: "seed@example.invalid",
};

/** The seed's runner: real git, with the test's identity. */
const gitRun = (command: string, args: string[]) =>
    execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv,
    });

/** 1 git command's stdout, trimmed. */
const git = (folder: string, args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", env: gitEnv }).trim();

/** Every file under a folder, with its hash. */
function snapshot(dir: string, base: string = dir): Record<string, string> {
    const out: Record<string, string> = {};

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            Object.assign(out, snapshot(file, base));
        } else {
            out[path.relative(base, file)] = createHash("sha256")
                .update(fs.readFileSync(file))
                .digest("hex");
        }
    }

    return out;
}

const IRULAN = `---
model: github-copilot/claude-opus-5.5
role: agent
home: ~/agents/irulan
repositories:
  frostyard/frostmail: /var/home/bjk/projects/frostyard/frostmail
  frostyard/lodge: ~/projects/frostyard/lodge
---

# Irulan

You are Princess Irulan, scholar and chronicler.

## Responsibilities

- frostyard's productivity suite, built as one family.
- Keep the three in step.

## Not the charter

- This line is not a responsibility.
`;

/** A profile with a home, for `--agent`. */
const MONEO = `---
model: github-copilot/claude-opus-5.5
role: agent
home: ~/agents/moneo
---

# Moneo

## Responsibilities

- The TrueNAS NAS.
`;

/** A profile with no home: Odrade's home is her desk. */
const ODRADE = `---
model: github-copilot/claude-opus-5.5
role: supervisor
workspace: /var/home/bjk/projects/odrade
---

# Odrade

## Responsibilities

- The team.
`;

/** A temporary root with a profiles folder and a user home folder. */
function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homes-seed-"));
    const profilesDir = path.join(root, "profiles");
    const userHome = path.join(root, "home");

    fs.mkdirSync(profilesDir);
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(profilesDir, "irulan.md"), IRULAN);
    fs.writeFileSync(path.join(profilesDir, "moneo.md"), MONEO);
    fs.writeFileSync(path.join(profilesDir, "odrade.md"), ODRADE);

    return { root, profilesDir, userHome, home: path.join(userHome, "agents", "irulan") };
}

test("the seed makes a home with 1 commit, every folder and no remote", () => {
    const t = setup();
    const logs: string[] = [];
    const result = seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        log: (line: string) => logs.push(line),
    });

    // The profile with no home is skipped and listed.
    assert.deepEqual(
        result.skipped.map((profile: { id: string }) => profile.id),
        ["odrade"],
    );
    assert.deepEqual(
        result.homes.map((home: { id: string }) => home.id),
        ["irulan", "moneo"],
    );
    assert.equal(result.homes[0].shown, "~/agents/irulan");

    // The files.
    assert.ok(
        fs.readFileSync(path.join(t.home, "AGENTS.md"), "utf8").startsWith("# Irulan's home\n"),
    );

    for (const name of [
        ".gitignore",
        ...HOME_FOLDERS.map((folder) => path.join(folder, ".gitkeep")),
    ]) {
        assert.ok(fs.existsSync(path.join(t.home, name)), name);
    }

    assert.equal(fs.readFileSync(path.join(t.home, ".gitignore"), "utf8"), GITIGNORE);

    // 1 repository, on main, with 1 commit and nothing uncommitted.
    assert.equal(fs.existsSync(path.join(t.home, ".git")), true);
    assert.equal(git(t.home, ["symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(git(t.home, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(t.home, ["log", "--format=%s"]), "Seed Irulan's home");
    assert.equal(git(t.home, ["status", "--porcelain"]), "");
    assert.equal(git(t.home, ["remote"]), "");

    // The commit holds every seeded file.
    const tracked = git(t.home, ["ls-files"]).split("\n").sort();

    assert.deepEqual(tracked, [
        ".gitignore",
        "AGENTS.md",
        "notes/.gitkeep",
        "plans/.gitkeep",
        "reports/.gitkeep",
    ]);
    assert.match(
        logs.join("\n"),
        /irulan: make the folder; write AGENTS\.md; .*\(~\/agents\/irulan\)\./,
    );
    assert.match(logs.join("\n"), /odrade: skipped, because the profile names no home\./);
});

test("a second run changes nothing, and never makes a second commit", () => {
    const t = setup();
    const options = {
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        log: () => undefined,
    };

    seedHomes(options);

    const first = snapshot(t.home);

    assert.deepEqual(snapshot(t.home), first);

    const logs: string[] = [];

    seedHomes({ ...options, log: (line: string) => logs.push(line) });

    assert.deepEqual(snapshot(t.home), first);
    assert.equal(git(t.home, ["rev-list", "--count", "HEAD"]), "1");
    assert.match(
        logs.join("\n"),
        /irulan: already a git repository, left as it is \(~\/agents\/irulan\)\./,
    );
});

test("an existing AGENTS.md is never overwritten, and the folder still gets git", () => {
    const t = setup();

    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(path.join(t.home, "AGENTS.md"), "# My own home\n\nThe agent wrote this.\n");

    seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        log: () => undefined,
    });

    assert.equal(
        fs.readFileSync(path.join(t.home, "AGENTS.md"), "utf8"),
        "# My own home\n\nThe agent wrote this.\n",
    );
    assert.equal(git(t.home, ["show", "HEAD:AGENTS.md"]), "# My own home\n\nThe agent wrote this.");
});

test("a home that is already a git repository is left as it is: no new folder, no new file, no commit", () => {
    const t = setup();

    // An existing repository with 1 commit and no `notes/`: Odrade's desk is like this.
    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(path.join(t.home, "AGENTS.md"), "# Odrade's desk\n");
    git(t.home, ["init", "-b", "main"]);
    git(t.home, ["add", "-A"]);
    git(t.home, ["commit", "-m", "desk"]);

    const before = snapshot(t.home);
    const logs: string[] = [];

    seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        log: (line: string) => logs.push(line),
    });

    assert.deepEqual(snapshot(t.home), before);
    assert.equal(fs.existsSync(path.join(t.home, "notes")), false);
    assert.equal(fs.existsSync(path.join(t.home, "plans")), false);
    assert.equal(fs.existsSync(path.join(t.home, "reports")), false);
    assert.equal(fs.existsSync(path.join(t.home, ".gitignore")), false);
    assert.equal(git(t.home, ["status", "--porcelain"]), "");
    assert.equal(git(t.home, ["rev-list", "--count", "HEAD"]), "1");
    assert.match(
        logs.join("\n"),
        /irulan: already a git repository, left as it is \(~\/agents\/irulan\)\./,
    );
});

test("--check writes nothing and prints what it would do, with each AGENTS.md text", () => {
    const t = setup();
    const logs: string[] = [];
    const result = seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        check: true,
        log: (line: string) => logs.push(line),
    });

    assert.equal(fs.existsSync(path.join(t.userHome, "agents")), false);
    assert.deepEqual(fs.readdirSync(t.userHome), []);
    assert.equal(result.homes.length, 2);

    const text = logs.join("\n");

    assert.match(text, /irulan: would make the folder; write AGENTS\.md;/);
    assert.match(text, /--- AGENTS\.md of ~\/agents\/irulan ---\n# Irulan's home/);
    assert.match(text, /--- AGENTS\.md of ~\/agents\/moneo ---\n# Moneo's home/);
});

test("--check on a seeded home reports it as it is, and still writes nothing", () => {
    const t = setup();
    const options = {
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        log: () => undefined,
    };

    seedHomes(options);

    const before = snapshot(t.home);
    const logs: string[] = [];

    seedHomes({ ...options, check: true, log: (line: string) => logs.push(line) });

    assert.deepEqual(snapshot(t.home), before);

    const text = logs.join("\n");

    assert.match(text, /irulan: already a git repository, left as it is \(~\/agents\/irulan\)\./);
    // Nothing would be written there, so no AGENTS.md text is printed for it.
    assert.ok(!text.includes("--- AGENTS.md of ~/agents/irulan ---"));
});

test("--agent seeds 1 home only", () => {
    const t = setup();

    seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        agent: "moneo",
        log: () => undefined,
    });

    assert.equal(fs.existsSync(path.join(t.userHome, "agents", "moneo", "AGENTS.md")), true);
    assert.equal(fs.existsSync(path.join(t.userHome, "agents", "irulan")), false);
    // 1 agent means 1 home, and no list of the profiles it did not seed.
    assert.throws(
        () =>
            seedHomes({
                profilesDir: t.profilesDir,
                userHome: t.userHome,
                run: gitRun,
                agent: "nobody",
                log: () => undefined,
            }),
        /no profile for nobody/,
    );
});

test("the text holds the charter, the repositories table and the rules", () => {
    const text = homeAgentsText({
        name: "Irulan",
        charter: "- frostyard's productivity suite.\n- Keep the three in step.",
        date: DATE,
        userHome: "/var/home/bjk",
        repositories: {
            "frostyard/frostmail": "/var/home/bjk/projects/frostyard/frostmail",
            "frostyard/snosi": "/srv/snosi",
        },
    });

    assert.ok(text.startsWith("# Irulan's home\n"));
    // The charter: the copy, its day, and the identity section that wins.
    assert.match(text, /## Charter/);
    assert.match(
        text,
        /a copy of the `## Responsibilities` section of Irulan's profile, made on 2026-10-27/,
    );
    assert.match(text, /the identity section wins/);
    assert.match(text, /- Keep the three in step\./);
    // The table: name, folder as ~/..., and the AGENTS.md path.
    assert.match(text, /\| Repository \| Folder \| AGENTS\.md \|/);
    assert.match(
        text,
        /\| `frostyard\/frostmail` \| `~\/projects\/frostyard\/frostmail` \| `~\/projects\/frostyard\/frostmail\/AGENTS\.md` \|/,
    );
    assert.match(text, /\| `frostyard\/snosi` \| `\/srv\/snosi` \| `\/srv\/snosi\/AGENTS\.md` \|/);
    // The rules.
    assert.match(text, /## Rules/);
    assert.match(text, /start it with\s+`team_work`/);
    assert.match(text, /report the plan to the session that started you/);
    assert.match(text, /`git -C <folder> ls-files '\*AGENTS\.md'`/);
    assert.match(text, /Read-only commands in a repository are fine/);
    assert.match(text, /## This folder/);
    assert.match(
        text,
        /`notes\/YYYY-MM-DD-topic\.md`, `plans\/`, and `reports\/YYYY-MM-DD-topic\/README\.md`/,
    );
    assert.match(text, /Commit this folder at the end of each task/);
    assert.match(text, /Never add a remote and never push/);
    assert.match(text, /Lessons about 1 repository go in the memory tool/);
    assert.match(text, /the role go in `team_memory`/);
    // Only the Responsibilities section is copied.
    assert.ok(!text.includes("Not the charter"));

    // A profile with no repositories and no charter still gives a whole file.
    const bare = homeAgentsText({
        name: "Teg",
        charter: "",
        date: DATE,
        userHome: "/var/home/bjk",
    });

    assert.match(bare, /The profile names no repositories\./);
    assert.match(bare, /The profile has no `## Responsibilities` section\./);
});

test("a home must be absolute or start with ~/", () => {
    assert.equal(resolveFolder("~/agents/x", "/home/b"), "/home/b/agents/x");
    assert.equal(resolveFolder("/srv/agents/x", "/home/b"), "/srv/agents/x");
    assert.throws(() => resolveFolder("agents/x", "/home/b"), /absolute path or start with ~\//);
    assert.equal(displayPath("/home/b/projects/x", "/home/b"), "~/projects/x");
    assert.equal(displayPath("/home/b", "/home/b"), "~");
    assert.equal(displayPath("/srv/x", "/home/b"), "/srv/x");
});

test("parseArgs reads the 2 flags and refuses anything else", () => {
    assert.deepEqual(parseArgs([]), { check: false });
    assert.deepEqual(parseArgs(["--check", "--agent", "irulan"]), { check: true, agent: "irulan" });
    assert.throws(() => parseArgs(["--nope"]), /unknown option --nope/);
    assert.throws(() => parseArgs(["--agent"]), /--agent needs an agent id/);
    assert.throws(() => parseArgs(["--agent", "../etc"]), /--agent needs an agent id/);
});
