// The bench repositories, their language and owner (the plan's table "Bench repositories and owners"), the team
// roster's checkout folders, the SSH host names that the router masks, and a seeded shuffle (mulberry32, seed 1064).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mulberry32 } from "../analyze.mjs";
import { COMMAND_MS } from "./exec.mjs";

/**
 * The bench repositories: repository, language, owner (roster id), and an optional `commandMinutes`: the time limit of
 * the repository's check and hidden-test commands, when its suite needs more than `COMMAND_MS` (fleet's check takes
 * about 10 minutes on a quiet host, and more under load).
 */
export const BENCH_REPOS = [
    { repo: "bketelsen/pi-pocket-team", language: "ts", owner: "sheeana" },
    { repo: "frostyard/frostmail", language: "go", owner: "irulan" },
    { repo: "frostyard/lodge", language: "go", owner: "irulan" },
    { repo: "frostyard/porter", language: "go", owner: "irulan" },
    { repo: "frostyard/updex", language: "go", owner: "lucilla" },
    { repo: "frostyard/core", language: "js", owner: "lucilla" },
    { repo: "frostyard/nsl", language: "go", owner: "duncan" },
    { repo: "frostyard/chairlift", language: "go", owner: "duncan" },
    { repo: "bketelsen/fleet", language: "python", owner: "teg", commandMinutes: 30 },
];

/** The owners, in a fixed order. */
export const OWNERS = ["sheeana", "irulan", "lucilla", "duncan", "teg"];

/** The seed of every seeded choice of the bench. */
export const SEED = 1064;

/** The bench entry of a repository (case-insensitive), or undefined. */
export const benchRepo = (repo) =>
    BENCH_REPOS.find((entry) => entry.repo.toLowerCase() === String(repo).toLowerCase());

/** The time limit of a repository's check and hidden-test commands, in ms: its `commandMinutes`, else `COMMAND_MS`. */
export const commandMsOf = (repo) => {
    const minutes = benchRepo(repo)?.commandMinutes;

    return minutes ? minutes * 60_000 : COMMAND_MS;
};

/**
 * The command limits of a repository's harvest, revalidation or scoring: `{ setup, check, hidden }` in ms. The
 * precedence, for each kind: an explicit limit in `timeouts` (a caller's or a test's `deps.timeouts`) first; then, for
 * the check and the hidden tests, the repository's own limit (`commandMsOf`); then `COMMAND_MS`. Setup has no
 * repository limit.
 */
export const commandLimits = (timeouts = {}, repo) => ({
    setup: timeouts.setup ?? COMMAND_MS,
    check: timeouts.check ?? commandMsOf(repo),
    hidden: timeouts.hidden ?? commandMsOf(repo),
});

/** The bench repositories of an owner. */
export const reposOf = (owner) =>
    BENCH_REPOS.filter((entry) => entry.owner === owner).map((e) => e.repo);

/** A folder with `~/` expanded. */
export const expandHome = (path, home = homedir()) =>
    path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

/** The roster folder: env `PI_POCKET_TEAM_AGENTS`, else `~/.config/pi-pocket-team/agents`. */
export const rosterDir = (env = process.env) =>
    env.PI_POCKET_TEAM_AGENTS || join(homedir(), ".config", "pi-pocket-team", "agents");

/**
 * The `repositories:` map of a profile's front matter (`owner/name: ~/path` lines), as plain text: the bench reads
 * only this block, so it needs no YAML parser.
 */
export function repositoriesOf(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

    if (!match) {
        return {};
    }

    const found = {};
    let inside = false;

    for (const line of match[1].split(/\r?\n/)) {
        if (/^repositories:\s*$/.test(line)) {
            inside = true;
            continue;
        }

        if (!inside) {
            continue;
        }

        const entry = /^\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(line);

        if (entry) {
            found[entry[1]] = entry[2].replace(/^["']|["']$/g, "");
        } else if (!/^\s/.test(line) && line.trim() !== "") {
            inside = false;
        }
    }

    return found;
}

/**
 * The roster: every repository name (the router's `roster` option) and each repository's checkout folder (`~`
 * expanded). Profiles are the `<id>.md` files, as the team module reads them (backups such as `x.md.bak` are not).
 */
export function readRoster(dir = rosterDir(), home = homedir()) {
    let names;

    try {
        names = readdirSync(dir);
    } catch {
        return { names: [], checkouts: {} };
    }

    const checkouts = {};

    for (const file of names.sort()) {
        if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(file)) {
            continue;
        }

        const repos = repositoriesOf(readFileSync(join(dir, file), "utf8"));

        for (const [repo, folder] of Object.entries(repos)) {
            checkouts[repo] ??= expandHome(folder, home);
        }
    }

    return { names: Object.keys(checkouts), checkouts };
}

/** A copy of `items` in a seeded order (Fisher-Yates with mulberry32). */
export function seededShuffle(items, seed = SEED) {
    const rng = mulberry32(seed);
    const out = [...items];

    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));

        [out[i], out[j]] = [out[j], out[i]];
    }

    return out;
}
