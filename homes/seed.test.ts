// The seed script of the agents' homes, on temporary folders and real git. Nothing here reads or writes Brian's
// profiles, his homes or his data: every folder comes from `fs.mkdtempSync`, and git runs with an environment of its
// own (a temporary config, no GIT_DIR-type variable, an empty template).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    GITIGNORE,
    GIT_LOCATION_VARS,
    HOME_FOLDERS,
    cleanGitEnv,
    displayPath,
    homeAgentsText,
    parseArgs,
    resolveFolder,
    seedHomes,
} from "./seed.mjs";

/** 2026-10-27 14:00 UTC: 10:00 in New York. */
const NOW = Date.UTC(2026, 9, 27, 14, 0);
const DATE = "2026-10-27";

/**
 * A git environment that no setting of this machine reaches: a temporary home, config file and XDG folder with a test
 * identity, no system config, an empty template folder, no system attributes, and none of the variables that point at
 * another repository or set a configuration in the environment.
 */
function gitEnvironment(extraConfig = "") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homes-git-"));
    const home = path.join(root, "home");
    const config = path.join(root, "gitconfig");
    const template = path.join(root, "template");
    const xdg = path.join(root, "xdg");

    for (const folder of [home, template, xdg]) {
        fs.mkdirSync(folder);
    }

    fs.writeFileSync(
        config,
        `[user]\n\tname = Seed test\n\temail = seed@example.invalid\n${extraConfig}`,
    );

    const env = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined || GIT_LOCATION_VARS.includes(name)) {
            continue;
        }

        if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) {
            continue;
        }

        env[name] = value;
    }

    return {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: config,
        GIT_TEMPLATE_DIR: template,
        GIT_ATTR_NOSYSTEM: "1",
    };
}

const gitEnv = gitEnvironment();

/** A runner for the seed: real git, with `env`, and the environment the seed passes laid over it. */
const makeRun =
    (env = gitEnv) =>
    (command, args, options = {}) =>
        execFileSync(command, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...env, ...(options.env ?? {}) },
        });

const gitRun = makeRun();

/** 1 git command's stdout, trimmed, in the isolated environment. */
const git = (folder, args) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", env: gitEnv }).trim();

/** Every file under a folder, with its hash. */
function snapshot(dir, base = dir) {
    const out = {};

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

/** Seed every profile of `t`, in the isolated environment, and keep the log. */
function seed(t, over = {}) {
    const logs = [];
    const result = seedHomes({
        profilesDir: t.profilesDir,
        userHome: t.userHome,
        now: NOW,
        run: gitRun,
        env: {},
        log: (line) => logs.push(line),
        ...over,
    });

    return { result, logs };
}

test("the seed makes a home with 1 commit, every folder and no remote", () => {
    const t = setup();
    const { result, logs } = seed(t);

    // The profile with no home is skipped and listed.
    assert.deepEqual(
        result.skipped.map((profile) => profile.id),
        ["odrade"],
    );
    assert.deepEqual(
        result.homes.map((home) => home.id),
        ["irulan", "moneo"],
    );
    assert.equal(result.homes[0].shown, "~/agents/irulan");
    assert.deepEqual(result.refused, []);

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
    assert.deepEqual(git(t.home, ["ls-files"]).split("\n").sort(), [
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

    seed(t);

    const first = snapshot(t.home);

    assert.deepEqual(snapshot(t.home), first);

    const { logs } = seed(t);

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

    seed(t);

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
    const { logs } = seed(t);

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

test("a home inside a git work tree is left as it is, so a parent repository gets no new file", () => {
    const t = setup();
    const repo = path.join(t.root, "repo");

    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "repo"]);

    // `~/agents/irulan` is now `repo/agents/irulan`, which does not exist yet, inside the repository.
    const { result, logs } = seed(t, { userHome: repo });

    assert.equal(fs.existsSync(path.join(repo, "agents")), false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.deepEqual(
        result.homes.map((home) => home.actions),
        [[], []],
    );
    assert.match(
        logs.join("\n"),
        /irulan: inside a git work tree, left as it is \(~\/agents\/irulan\)\./,
    );
});

test("a home that is a bare git repository is left as it is", () => {
    const t = setup();
    const bare = path.join(t.root, "agents", "irulan");

    fs.mkdirSync(path.join(t.root, "agents"));
    git(t.root, ["init", "--bare", "-b", "main", bare]);

    const before = snapshot(bare);
    const { result, logs } = seed(t, { userHome: t.root });

    assert.deepEqual(snapshot(bare), before);
    assert.equal(fs.existsSync(path.join(bare, "AGENTS.md")), false);
    assert.equal(git(bare, ["rev-parse", "--is-bare-repository"]), "true");
    // The bare repository gets no action; Moneo's home is a plain folder, so it is seeded.
    assert.deepEqual(result.homes[0].actions, []);
    assert.match(
        logs.join("\n"),
        /irulan: a bare git repository, left as it is \(~\/agents\/irulan\)\./,
    );
});

test("a core.hooksPath hook is never run", () => {
    const t = setup();
    const hooks = path.join(t.root, "hooks");
    const marker = path.join(t.root, "hook-ran");

    fs.mkdirSync(hooks);

    for (const name of ["pre-commit", "post-commit", "reference-transaction"]) {
        fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, {
            mode: 0o755,
        });
    }

    // The user's own configuration holds the hook: it is the identity's, so the seed keeps it.
    const env = gitEnvironment(`[core]\n\thooksPath = ${hooks}\n`);

    seed(t, { run: makeRun(env) });

    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(t.home, ["rev-list", "--count", "HEAD"]), "1");
});

test("the seed runs no signing and no filter from the user's configuration, and the commit exists", () => {
    const t = setup();
    const marker = path.join(t.root, "ran");
    const clean = path.join(t.root, "clean.sh");
    const gpg = path.join(t.root, "gpg.sh");

    fs.writeFileSync(clean, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    fs.writeFileSync(gpg, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });

    // The user's configuration signs every commit and runs a clean filter for every file.
    const env = gitEnvironment(
        `[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${gpg}\n[filter "leak"]\n\tclean = ${clean}\n\trequired = true\n`,
    );
    const run = makeRun(env);

    // It runs for a plain `git add`, so this test means something.
    const scratch = path.join(t.root, "scratch");

    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, ".gitattributes"), "* filter=leak\n");
    fs.writeFileSync(path.join(scratch, "a.txt"), "a\n");
    run("git", ["-C", scratch, "init", "-b", "main"]);
    run("git", ["-C", scratch, "add", "-A"]);
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker);

    // The home carries the same attribute, so the seed's own `git add -A` would run the filter too.
    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(path.join(t.home, ".gitattributes"), "* filter=leak\n");

    const { result } = seed(t, { run });

    assert.deepEqual(result.refused, []);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(t.home, ["log", "--format=%s"]), "Seed Irulan's home");
});

test("a discovery failure that is not 'not a git repository' refuses the home before any write", () => {
    const t = setup();

    const run = (_: string, args: string[]) => {
        if (args.includes("config")) {
            return args.at(-1) === "user.name" ? "Seed test" : "seed@example.invalid";
        }

        if (args.includes("rev-parse")) {
            throw Object.assign(new Error("Command failed: git rev-parse"), {
                status: 128,
                stderr: "fatal: detected dubious ownership in repository at '/home/x'\n",
            });
        }

        throw new Error(`the seed ran git ${args.join(" ")}`);
    };

    const { result, logs } = seed(t, { run });

    assert.deepEqual(
        result.refused.map((home) => home.id),
        ["irulan", "moneo"],
    );
    assert.match(logs.join("\n"), /dubious ownership/);
    // Nothing was written, not even the home folder.
    assert.equal(fs.existsSync(path.join(t.userHome, "agents")), false);
});

test("a missing user.name or user.email refuses the home with words a person can read", () => {
    const t = setup();

    const run = (_: string, args: string[]) => {
        if (args.includes("config")) {
            return "";
        }

        if (args.includes("rev-parse")) {
            // The one failure that means the folder is free.
            throw Object.assign(new Error("Command failed: git rev-parse"), {
                status: 128,
                stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
            });
        }

        throw new Error(`the seed ran git ${args.join(" ")}`);
    };

    const { result, logs } = seed(t, { run });

    assert.deepEqual(
        result.refused.map((home) => home.id),
        ["irulan", "moneo"],
    );
    assert.match(logs.join("\n"), /user\.name and user\.email are not both set/);
    assert.equal(fs.existsSync(path.join(t.userHome, "agents")), false);
});

test("a GIT_DIR in the environment never moves the seed's writes into another repository", () => {
    const t = setup();
    const other = path.join(t.root, "other");

    fs.mkdirSync(other);
    git(other, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(other, "keep.txt"), "keep\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "other"]);

    const before = snapshot(other);
    const { result } = seed(t, { env: { GIT_DIR: path.join(other, ".git") } });

    assert.deepEqual(snapshot(other), before);
    assert.deepEqual(result.refused, []);
    // The home is a repository of its own, with its own 1 commit.
    assert.equal(git(t.home, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(t.home, ["status", "--porcelain"]), "");
});

test("cleanGitEnv drops every variable that could point at another repository or configuration", () => {
    const env = Object.fromEntries(GIT_LOCATION_VARS.map((name) => [name, "/tmp/other"]));

    assert.deepEqual(
        cleanGitEnv({
            ...env,
            PATH: "/bin",
            HOME: "/home/b",
            XDG_CONFIG_HOME: "/home/b/.config",
            GIT_CONFIG_KEY_0: "commit.gpgSign",
            GIT_CONFIG_VALUE_0: "true",
            GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp/hooks'",
        }),
        {
            PATH: "/bin",
            HOME: "/home/b",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ATTR_NOSYSTEM: "1",
        },
    );
});

test("a dangling symlink at AGENTS.md is refused, and its target stays missing", () => {
    const t = setup();
    const missing = path.join(t.root, "elsewhere", "AGENTS.md");

    fs.mkdirSync(t.home, { recursive: true });
    fs.symlinkSync(missing, path.join(t.home, "AGENTS.md"));

    const { result, logs } = seed(t);

    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(
        result.refused.map((home) => home.id),
        ["irulan"],
    );
    assert.match(logs.join("\n"), /irulan: refused, .*AGENTS\.md is a symbolic link/);
    // Nothing else was written: no folder, no file, no repository.
    assert.equal(fs.existsSync(path.join(t.home, ".git")), false);
    assert.equal(fs.existsSync(path.join(t.home, "notes")), false);
    assert.equal(fs.existsSync(path.join(t.home, ".gitignore")), false);
    assert.equal(fs.readlinkSync(path.join(t.home, "AGENTS.md")), missing);
});

test("a notes/ symlink to another folder gets no .gitkeep, and the home is refused", () => {
    const t = setup();
    const other = path.join(t.root, "other-notes");

    fs.mkdirSync(other);
    fs.mkdirSync(t.home, { recursive: true });
    fs.symlinkSync(other, path.join(t.home, "notes"));

    const { result } = seed(t);

    assert.deepEqual(fs.readdirSync(other), []);
    assert.deepEqual(
        result.refused.map((home) => home.id),
        ["irulan"],
    );
    assert.equal(fs.existsSync(path.join(t.home, ".gitignore")), false);
    assert.equal(fs.existsSync(path.join(t.home, ".git")), false);
});

test("--check writes nothing and prints what it would do, with each AGENTS.md text", () => {
    const t = setup();
    const { result, logs } = seed(t, { check: true });

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

    seed(t);

    const before = snapshot(t.home);
    const { logs } = seed(t, { check: true });

    assert.deepEqual(snapshot(t.home), before);

    const text = logs.join("\n");

    assert.match(text, /irulan: already a git repository, left as it is \(~\/agents\/irulan\)\./);
    // Nothing would be written there, so no AGENTS.md text is printed for it.
    assert.ok(!text.includes("--- AGENTS.md of ~/agents/irulan ---"));
});

test("--agent seeds 1 home only", () => {
    const t = setup();

    seed(t, { agent: "moneo" });

    assert.equal(fs.existsSync(path.join(t.userHome, "agents", "moneo", "AGENTS.md")), true);
    assert.equal(fs.existsSync(path.join(t.userHome, "agents", "irulan")), false);
    // 1 agent means 1 home, and no list of the profiles it did not seed.
    assert.throws(() => seed(t, { agent: "nobody" }), /no profile for nobody/);
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

test("the CLI exits 1 when a home is refused, prints it, and seeds the other homes", () => {
    const t = setup();

    fs.mkdirSync(t.home, { recursive: true });
    fs.symlinkSync(path.join(t.root, "missing", "AGENTS.md"), path.join(t.home, "AGENTS.md"));

    const done = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./seed.mjs", import.meta.url))],
        {
            encoding: "utf8",
            env: { ...gitEnv, HOME: t.userHome, PI_POCKET_TEAM_AGENTS: t.profilesDir },
        },
    );

    assert.equal(done.status, 1, done.stderr);
    assert.match(done.stdout, /irulan: refused, .*AGENTS\.md is a symbolic link/);
    // The other home still seeded.
    assert.match(done.stdout, /moneo: make the folder/);
    assert.ok(fs.existsSync(path.join(t.userHome, "agents", "moneo", "AGENTS.md")));
});
