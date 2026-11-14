// The daily audit's "due" list: a finding that repeats 7 days in a row gets 1 concrete owner, unless an unexpired
// recorded action holds it. Odrade routes each due finding; this file only lists them (`dueLines` in report.mjs
// renders them).
//
// 2 sync readers (the roster's profile files, and Odrade's actions file) that never throw, and pure functions on
// their results. Date math is UTC on the `YYYY-MM-DD` strings: no wall clock.
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { moduleOf, ownerOf } from "./report.mjs";

/** The actions file, relative to Odrade's folder. */
export const ACTIONS_FILE = "decisions/audit-actions.json";
/** A finding is a candidate when it was in this many earlier days in a row: 7 days with today. */
export const DUE_REPEAT_DAYS = 6;
/** An entry may hold a finding at most this many days after the run's date. */
export const MAX_HOLD_DAYS = 30;
/** The repository whose owner fixes the live modules (rule 4). */
export const TEAM_REPO = "bketelsen/pi-pocket-team";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE = /^[a-z0-9][a-z0-9_-]*\.md$/;
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;
const MAX_REASON = 300;

const message = (error) => String(error?.message ?? error);

// ---------- The roster ----------

/**
 * The agents of a profile folder, read like `team.ts` `roster()`: 1 `<id>.md` file per agent, its role, the names of
 * its repositories, and its name (the first `# ` heading of the body, else the id). Never throws.
 */
export function readRoster(dir) {
    let names;

    try {
        names = fs.readdirSync(dir);
    } catch (error) {
        return error?.code === "ENOENT"
            ? { status: "missing", agents: [] }
            : { status: "error", reason: message(error), agents: [] };
    }

    try {
        const agents = names
            .filter((file) => PROFILE.test(file))
            .sort()
            .map((file) => {
                const { frontmatter, body } = parseFrontmatter(
                    fs.readFileSync(path.join(dir, file), "utf8"),
                );
                const id = file.slice(0, -3);
                const repositories = frontmatter.repositories;

                return {
                    id,
                    name: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id,
                    role:
                        frontmatter.role === "supervisor"
                            ? "supervisor"
                            : frontmatter.role === "clerk"
                              ? "clerk"
                              : "agent",
                    repositories:
                        repositories && typeof repositories === "object"
                            ? Object.keys(repositories)
                            : [],
                };
            });

        return { status: "ok", agents };
    } catch (error) {
        return { status: "error", reason: message(error), agents: [] };
    }
}

// ---------- The actions file ----------

/** The UTC day number of a real `YYYY-MM-DD` date, or null (2026-02-30 is null). */
export function dayNumber(text) {
    const match = typeof text === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;

    if (!match) {
        return null;
    }

    const [year, month, day] = match.slice(1).map(Number);
    const ms = Date.UTC(year, month - 1, day);
    const back = new Date(ms);

    return back.getUTCFullYear() === year &&
        back.getUTCMonth() === month - 1 &&
        back.getUTCDate() === day
        ? ms / DAY_MS
        : null;
}

/** Why an action text is not valid, or null when it is `issue <url>`, `row <n>` or `accepted`. */
function actionError(action) {
    if (typeof action !== "string") {
        return "action is not a string";
    }

    if (action === "accepted" || /^row [1-9]\d*$/.test(action)) {
        return null;
    }

    if (action.startsWith("issue ")) {
        return ISSUE_URL.test(action.slice("issue ".length))
            ? null
            : "action has no valid GitHub issue URL";
    }

    return "action is not issue <url>, row <n> or accepted";
}

/** Why an entry is refused, or null when it is valid. `today` is the run's day number. */
function entryError(entry, date, today) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return "entry is not an object";
    }

    if (typeof entry.id !== "string" || entry.id === "") {
        return "id is not a non-empty string";
    }

    const action = actionError(entry.action);

    if (action) {
        return action;
    }

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        return "reason is empty";
    }

    if (entry.reason.length > MAX_REASON) {
        return `reason is longer than ${MAX_REASON} characters`;
    }

    const until = dayNumber(entry.until);

    if (until === null) {
        return "until is not a date YYYY-MM-DD";
    }

    if (until - today > MAX_HOLD_DAYS) {
        return `until is more than ${MAX_HOLD_DAYS} days after ${date}`;
    }

    return null;
}

/**
 * Odrade's recorded actions (`decisions/audit-actions.json`), checked against the run's `date`. A bad file gives no
 * entries; a bad entry is refused and the others stay. Never throws.
 */
export function readActions(file, date) {
    let text;

    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        return error?.code === "ENOENT"
            ? { status: "missing", entries: [], refused: [] }
            : { status: "invalid", reason: message(error), entries: [], refused: [] };
    }

    let json;

    try {
        json = JSON.parse(text);
    } catch {
        return { status: "invalid", reason: "not JSON", entries: [], refused: [] };
    }

    if (!json || typeof json !== "object" || Array.isArray(json)) {
        return { status: "invalid", reason: "not an object", entries: [], refused: [] };
    }

    if (json.version !== 1) {
        return { status: "invalid", reason: "version is not 1", entries: [], refused: [] };
    }

    if (!Array.isArray(json.entries)) {
        return { status: "invalid", reason: "entries is not an array", entries: [], refused: [] };
    }

    const today = dayNumber(date);
    const entries = [];
    const refused = [];

    json.entries.forEach((entry, index) => {
        const reason = entryError(entry, date, today);

        if (reason) {
            refused.push({
                index,
                id: typeof entry?.id === "string" && entry.id !== "" ? entry.id : null,
                reason,
            });
        } else {
            entries.push({
                id: entry.id,
                action: entry.action,
                reason: entry.reason.trim(),
                until: entry.until,
            });
        }
    });

    return { status: "ok", entries, refused };
}

// ---------- The owner ----------

const REPO_IN_ID = /(?:^|:)repo:([\w.-]+\/[\w.-]+)/;
const REF_IN_ID = /([\w.-]+\/[\w.-]+)#\d+/;
const AGENT_IN_ID = /(?:^|:)agent:([^:\s]+)/;

const person = (agent, why) => ({ id: agent.id, name: agent.name, why });

/** The repository that a finding id names, or undefined. */
const repoOf = (id) => REPO_IN_ID.exec(id)?.[1] ?? REF_IN_ID.exec(id)?.[1];

/** The agent (role agent) whose repositories list `repo`, case-insensitive. */
const ownerOfRepo = (agents, repo) =>
    agents.find(
        (agent) =>
            agent.role === "agent" &&
            agent.repositories.some((name) => name.toLowerCase() === repo.toLowerCase()),
    );

const agentById = (agents, id) =>
    agents.find((agent) => agent.id.toLowerCase() === String(id).toLowerCase());

/**
 * The 1 owner `{ id, name, why }` of a finding, by the rules in order: H1 is Brian's; an H or Q finding goes to the
 * owner of its repository or to its agent; I3 to the agent of the home; a live module's check to the owner of
 * bketelsen/pi-pocket-team; the rest to the supervisor. With no roster, `id` is null and the name is the fixed
 * table's owner.
 */
export function dueOwner(finding, roster) {
    const table = ownerOf(finding.check);

    // Rule 1: repository settings are Brian's, roster or not.
    if (table.owner === "Brian") {
        return { id: "brian", name: "Brian", why: table.component };
    }

    if (roster?.status !== "ok") {
        return { id: null, name: table.owner, why: "roster unavailable" };
    }

    const agents = roster.agents;
    const supervisor = agents.find((agent) => agent.role === "supervisor");
    // When the rule's agent is not in the roster, the supervisor holds the finding.
    const fallback = (missing) =>
        supervisor
            ? person(supervisor, missing)
            : { id: null, name: table.owner, why: `${missing}, and no supervisor in the roster` };
    const group = finding.check[0];
    const id = finding.id ?? "";

    // Rule 2: the repository, else the agent, that an H or Q finding names.
    if (group === "H" || group === "Q") {
        const repo = repoOf(id);

        if (repo) {
            const owner = ownerOfRepo(agents, repo);

            return owner
                ? person(owner, `owns ${repo}`)
                : fallback(`${repo} has no owner in the roster`);
        }

        const name = AGENT_IN_ID.exec(id)?.[1];

        if (name) {
            const agent = agentById(agents, name);

            return agent
                ? person(agent, "the agent of the finding")
                : fallback(`agent ${name} is not in the roster`);
        }
    }

    // Rule 3: an agent's home is its own.
    if (finding.check === "I3") {
        const home = id.slice("I3:".length);
        const agent = agentById(agents, home);

        return agent
            ? person(agent, "its own home")
            : fallback(`agent ${home} is not in the roster`);
    }

    // Rule 4: a live module's check goes to the owner of the repository that holds the module.
    const file = moduleOf(finding.check);

    if (file) {
        const owner = ownerOfRepo(agents, TEAM_REPO);

        return owner
            ? person(owner, `owns ${TEAM_REPO} (${file})`)
            : fallback(`${TEAM_REPO} has no owner in the roster`);
    }

    // Rule 5: the rest is the supervisor's.
    return supervisor
        ? person(supervisor, table.component)
        : { id: null, name: table.owner, why: "no supervisor in the roster" };
}

// ---------- The due list ----------

/** The entry with the latest `until`, or undefined. */
const latest = (entries) =>
    entries.reduce((best, entry) => (!best || entry.until > best.until ? entry : best), undefined);

/**
 * The due findings, the held ones and the state of the actions file. `findings` are annotated rows (`repeatDays`,
 * `maybeFixed`); `roster` is `readRoster`'s result and `actions` is `readActions`'s.
 */
export function dueOf(findings, { date, roster, actions }) {
    const entries = actions?.entries ?? [];
    const due = [];
    const held = [];

    for (const finding of findings) {
        // A maybe-fixed finding already has its action: the install of the module that should fix it.
        if ((finding.repeatDays ?? 0) < DUE_REPEAT_DAYS || finding.maybeFixed) {
            continue;
        }

        const days = finding.repeatDays + 1;
        const own = entries.filter((entry) => entry.id === finding.id);
        const holding = latest(own.filter((entry) => date <= entry.until));

        if (holding) {
            held.push({
                id: finding.id,
                days,
                action: holding.action,
                reason: holding.reason,
                until: holding.until,
            });
            continue;
        }

        const last = latest(own);

        due.push({
            id: finding.id,
            check: finding.check,
            severity: finding.severity,
            days,
            repeatDays: finding.repeatDays,
            text: finding.text,
            owner: dueOwner(finding, roster),
            ...(last ? { lastEntry: { action: last.action, until: last.until } } : {}),
        });
    }

    due.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
    held.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));

    return {
        due,
        held,
        actions: {
            file: ACTIONS_FILE,
            status: actions?.status ?? "missing",
            ...(actions?.reason ? { reason: actions.reason } : {}),
            entries: entries.length,
            refused: actions?.refused ?? [],
        },
        roster: {
            status: roster?.status ?? "missing",
            ...(roster?.reason ? { reason: roster.reason } : {}),
        },
    };
}
