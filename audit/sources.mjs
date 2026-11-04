// Every read of the daily audit: Pocket's database, GitHub, git, Odrade's notes and the agents' home folders.
//
// Everything is read-only. The database opens with `readOnly: true`. `gh` gets only GET requests, GraphQL
// queries and `gh search prs`, and stops after 40 calls. `git` gets only `log`, `status` and `show`.
// The checks never read anything themselves: they get the plain `data` object that `loadData` builds.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";
import { DAY, HOUR, branchLeft, refsIn } from "./common.mjs";

export const BOT = "frostyard-machines";
/** The most `gh` calls a run may make. */
export const GH_CAP = 40;
/** The live modules whose install time the report compares with a finding's last case. */
export const MODULE_FILES = ["desk.ts", "team.ts", "night-shift.ts"];
/** The tools whose errors check A4 reads. */
export const TEAM_TOOLS = ["desk", "team", "team_delegate", "team_message", "team_sessions"];

// ---------- Process runner ----------

/** Run a command and return its stdout. A command that fails throws an error with `stdout`. */
export function defaultRun(command, args) {
    return execFileSync(command, args, {
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 120_000,
    });
}

// ---------- gh, read-only ----------

const GH_VALUE_FLAGS = new Set(["--jq", "-q", "--cache", "--limit", "--json", "--created"]);

/** Refuse every `gh` call that could write. Throws an Error; returns nothing. */
export function checkGhArgs(args) {
    if (args.some((arg) => /\b(mutation|subscription)\b/i.test(String(arg)))) {
        throw new Error("gh: the audit only reads (no mutation)");
    }

    if (args.some((arg) => /^(-X|--method|--input)/.test(String(arg)))) {
        throw new Error("gh: the audit only reads (no -X, --method or --input)");
    }

    if (args[0] === "search" && args[1] === "prs") {
        return;
    }

    if (args[0] !== "api" || typeof args[1] !== "string" || args[1].startsWith("-")) {
        throw new Error("gh: the audit only runs `gh api <path>` and `gh search prs`");
    }

    const graphql = args[1] === "graphql";

    for (let i = 2; i < args.length; i += 1) {
        const arg = String(args[i]);

        if (/^(-f|-F|--field|--raw-field)/.test(arg)) {
            if (!graphql) {
                throw new Error("gh: -f and -F are only for graphql queries");
            }

            i += arg === "-f" || arg === "-F" || /^--(raw-)?field$/.test(arg) ? 1 : 0;
        } else if (GH_VALUE_FLAGS.has(arg)) {
            i += 1;
        } else if (arg !== "--paginate") {
            throw new Error(`gh: the audit does not use ${arg}`);
        }
    }
}

/**
 * A read-only `gh`. `run(command, args)` is injected (the tests never call the real one). After `cap` calls it returns
 * nothing and sets `state.capReached`.
 */
export function makeGh(run = defaultRun, cap = GH_CAP) {
    const state = { calls: 0, failures: 0, capReached: false };

    const call = (args) => {
        checkGhArgs(args);

        if (state.calls >= cap) {
            state.capReached = true;

            return "";
        }

        state.calls += 1;

        try {
            return String(run("gh", args) ?? "");
        } catch (error) {
            state.failures += 1;

            return typeof error?.stdout === "string" ? error.stdout : "";
        }
    };

    return {
        state,
        call,
        api: (apiPath, extra = []) => call(["api", apiPath, ...extra]),
        graphql: (query) => call(["api", "graphql", "-f", `query=${query}`]),
        searchPrs: (flags) => call(["search", "prs", ...flags]),
    };
}

// ---------- git, read-only ----------

const GIT_ALLOWED = new Set(["log", "status", "show"]);

/** Refuse every `git` call but `log`, `status` and `show`. */
export function checkGitArgs(args) {
    if (!GIT_ALLOWED.has(args[0])) {
        throw new Error("git: the audit only runs log, status and show");
    }

    if (args.some((arg) => /^--(output|ext-diff|textconv|exec)/.test(String(arg)))) {
        throw new Error("git: that option is not allowed");
    }
}

/**
 * The settings every audit git call gets: no hook and no filesystem monitor runs the user's code. A read must never
 * run a program that a repository names.
 */
export const GIT_SAFE_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * A read-only `git` in 1 folder. `--no-optional-locks` keeps `status` from refreshing the index, and `GIT_SAFE_ARGS`
 * keeps a hook or a filesystem monitor from running.
 */
export function makeGit(run = defaultRun) {
    return {
        call(dir, args) {
            checkGitArgs(args);

            return String(
                run("git", ["--no-optional-locks", ...GIT_SAFE_ARGS, "-C", dir, ...args]) ?? "",
            );
        },
    };
}

// ---------- Pocket documents (base revision + deltas, as Pi Durable folds them) ----------

/** The `x` of a stored document `kind`: the database keeps the kind as a JSON string. */
const docsOfKind = (db, kind, { retired = false } = {}) =>
    db
        .prepare(
            `select id, owner_id from documents where kind=?${retired ? "" : " and retired_at is null"}`,
        )
        .all(JSON.stringify(kind));

/** Call `visit(value)` with a document after its base revision and after each delta. */
function eachRevision(db, id, visit) {
    const base = db
        .prepare(
            "select seq, content from document_revisions where document_id=? and kind='base' order by seq desc limit 1",
        )
        .get(id);

    if (!base) {
        return undefined;
    }

    let value = JSON.parse(base.content);

    visit(value);

    for (const row of db
        .prepare(
            "select content from document_revisions where document_id=? and seq>? order by seq",
        )
        .all(id, base.seq)) {
        value = apply(value, JSON.parse(row.content));
        visit(value);
    }

    return value;
}

/** The value of a document now: its last base revision plus each delta. */
export const foldDocument = (db, id) => eachRevision(db, id, () => undefined);

/**
 * The thread document keeps the last 50 events of a thread; the history keeps all of them: the events of every base
 * revision, and every event that a delta pushed.
 */
export function allEvents(db, deskId, threads) {
    const out = [];
    const seen = new Set();

    const add = (thread, event) => {
        const id = `${thread}|${event.at}|${event.key}|${event.text}`;

        if (!seen.has(id)) {
            seen.add(id);
            out.push({ thread, at: event.at, key: event.key, text: event.text });
        }
    };

    for (const row of db
        .prepare("select kind, content from document_revisions where document_id=? order by seq")
        .all(deskId)) {
        const value = JSON.parse(row.content);

        if (row.kind === "base") {
            for (const thread of Object.values(value?.threads ?? {})) {
                (thread.events ?? []).forEach((event) => add(thread.id, event));
            }

            continue;
        }

        for (const op of value) {
            const [kind, at] = op;

            if (kind === "p" && at[0] === "threads" && at[2] === "events") {
                op[4].forEach((event) => add(at[1], event));
            } else if (kind === "s" && at[0] === "threads" && at.length === 2 && op[2]?.events) {
                op[2].events.forEach((event) => add(at[1], event));
            }
        }
    }

    for (const thread of Object.values(threads)) {
        (thread.events ?? []).forEach((event) => add(thread.id, event));
    }

    return out.sort((a, b) => a.at - b.at);
}

/** A thread session's reports document keeps the last 10; the deltas keep every report. */
export function allReports(db, id) {
    const byKey = new Map();

    for (const row of db
        .prepare("select content from document_revisions where document_id=? order by seq")
        .all(id)) {
        const value = JSON.parse(row.content);
        const items = Array.isArray(value)
            ? value.flatMap((op) =>
                  op[1]?.[0] === "reports" && op[1].length === 1
                      ? op[0] === "p"
                          ? op[4]
                          : op[0] === "s"
                            ? op[2]
                            : []
                      : [],
              )
            : (value?.reports ?? []);

        items.forEach((report) => report?.key && byKey.set(report.key, report));
    }

    return [...byKey.values()].map((report) => ({
        key: report.key,
        at: report.at,
        from: report.from,
        text: String(report.text ?? ""),
    }));
}

/** The plain text of a stored message. */
export const textOf = (entry) => {
    const content = entry.model?.[0]?.content;

    return typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
};

const parseEntry = (row) => ({ id: row.id, ...JSON.parse(row.record) });

/** A user entry, cut short: the checks read the first lines only (and the whole `Desk queue:` text). */
const shortUser = (entry) => {
    const text = textOf(entry);

    return {
        id: entry.id,
        at: entry.model[0].timestamp,
        text: text.startsWith("Desk queue:") ? text.slice(0, 4000) : text.slice(0, 600),
    };
};

// ---------- The database ----------

/** Open Pocket's database read-only. A write on this handle throws. */
export const openPocket = (file) => new DatabaseSync(file, { readOnly: true });

/** The desk's threads, grants and every event (not only the last 50 of each thread). */
export function loadDesk(db) {
    const deskDoc = docsOfKind(db, "x.desk.threads")[0];

    if (!deskDoc) {
        throw new Error("no x.desk.threads document");
    }

    const desk = foldDocument(db, deskDoc.id);

    return {
        threads: desk.threads ?? {},
        grants: desk.grants ?? [],
        events: allEvents(db, deskDoc.id, desk.threads ?? {}),
    };
}

/** Each agent's id by session, from Team's identity documents. */
function loadAgents(db) {
    const agentOf = {};

    for (const doc of docsOfKind(db, "x.team.identity")) {
        const value = foldDocument(db, doc.id);

        if (value?.persona?.id) {
            agentOf[doc.owner_id] = value.persona.id;
        }
    }

    return agentOf;
}

function loadReports(db) {
    const reports = {};

    for (const doc of docsOfKind(db, "x.desk.reports")) {
        reports[doc.owner_id] = allReports(db, doc.id);
    }

    return reports;
}

function loadGoals(db) {
    return docsOfKind(db, "x.night-shift.goal").flatMap((doc) => {
        const goal = foldDocument(db, doc.id)?.goal;

        return goal ? [{ session: doc.owner_id, goal }] : [];
    });
}

/** Schedule tasks and their outcomes; the first due time of each schedule comes from its document's history. */
function loadSchedules(db) {
    const known = new Map();

    for (const doc of docsOfKind(db, "pocket.schedules", { retired: true })) {
        const last = eachRevision(db, doc.id, (value) => {
            for (const [id, item] of Object.entries(value?.items ?? {})) {
                if (!known.has(id)) {
                    known.set(id, { firstNext: item.next, every: item.every !== undefined });
                }
            }
        });

        for (const [id, item] of Object.entries(last?.items ?? {})) {
            known.set(id, { ...known.get(id), next: item.next });
        }
    }

    return db
        .prepare("select id, record from tasks where kind=? order by id")
        .all(JSON.stringify("pocket.schedule"))
        .map((row) => {
            const task = JSON.parse(row.record);
            const scheduleId = task.input?.scheduleId;

            return {
                taskId: row.id,
                conversation: task.conversationId,
                scheduleId,
                startedAt: task.startedAt ?? 0,
                endedAt: task.endedAt,
                status: task.state?.outcome?.status ?? task.state?.status ?? "?",
                ...known.get(scheduleId),
            };
        });
}

const ts = "json_extract(record,'$.model[0].timestamp')";

/** Tool errors of the team tools, and `The desk is full` refusals, in the window. */
function loadToolErrors(db, since) {
    const names = TEAM_TOOLS.map((name) => `'${name}'`).join(",");

    return db
        .prepare(
            `select id, conversation_id c, record from entries where json_extract(record,'$.kind')='pi.tool-result'
             and ${ts} >= ? and json_extract(record,'$.model[0].toolName') in (${names})
             and (json_extract(record,'$.model[0].isError')=1 or record like '%The desk is full%')`,
        )
        .all(since)
        .map((row) => {
            const entry = parseEntry(row);

            return {
                id: row.id,
                c: row.c,
                tool: entry.model[0].toolName,
                at: entry.model[0].timestamp,
                isError: entry.model[0].isError === true,
                text: textOf(entry).slice(0, 600),
            };
        });
}

const COST_SQL = `select conversation_id c, ${ts} at, json_extract(record,'$.model[0].usage.cost.total') cost
             from entries where json_extract(record,'$.kind')='pi.assistant' and `;

/** The model cost of assistant entries, from `since` on. */
function loadCosts(db, since) {
    return db
        .prepare(`${COST_SQL}${ts} >= ?`)
        .all(since)
        .filter((row) => row.cost)
        .map((row) => ({ c: row.c, at: row.at, cost: row.cost }));
}

/**
 * The cost rows of some sessions, with no time limit: R1 compares a routed thread for its whole life, and the 8-day
 * horizon of `loadCosts` would hide an older session's spend.
 */
function loadRouteCosts(db, sessions) {
    const ids = [...sessions];

    if (ids.length === 0) {
        return [];
    }

    return db
        .prepare(`${COST_SQL}conversation_id in (${ids.map(() => "?").join(",")})`)
        .all(...ids)
        .filter((row) => row.cost)
        .map((row) => ({ c: row.c, at: row.at, cost: row.cost }));
}

const SPAWN_SQL = `select id, conversation_id c, record from entries where json_extract(record,'$.kind')='pi.assistant'
             and `;

/** `subagent` spawn calls: the model each one named (null when it named none), its name, its tools and the start of its brief. */
function loadSpawns(db, since) {
    return spawnRows(db, `${ts} >= ?`, [since]);
}

/** The spawn calls of some sessions, with no time limit: the same rows as `loadSpawns`, for R1's routed threads. */
function loadRouteSpawns(db, sessions) {
    const ids = [...sessions];

    if (ids.length === 0) {
        return [];
    }

    return spawnRows(db, `conversation_id in (${ids.map(() => "?").join(",")})`, ids);
}

/** The `subagent` spawn calls that `where` selects, as `loadSpawns` gives them. */
function spawnRows(db, where, params) {
    const out = [];

    for (const row of db
        .prepare(`${SPAWN_SQL}${where} and record like '%"name":"subagent"%'`)
        .all(...params)) {
        const entry = parseEntry(row);

        for (const part of entry.model[0].content ?? []) {
            if (
                part.type === "toolCall" &&
                part.name === "subagent" &&
                part.arguments?.action === "spawn"
            ) {
                out.push({
                    id: row.id,
                    c: row.c,
                    at: entry.model[0].timestamp,
                    model: typeof part.arguments.model === "string" ? part.arguments.model : null,
                    name: typeof part.arguments.name === "string" ? part.arguments.name : null,
                    tools: Array.isArray(part.arguments.tools)
                        ? part.arguments.tools.filter((tool) => typeof tool === "string")
                        : null,
                    review:
                        typeof part.arguments.message === "string" &&
                        /review/i.test(part.arguments.message),
                    brief:
                        typeof part.arguments.message === "string"
                            ? part.arguments.message.slice(0, 300)
                            : "",
                });
            }
        }
    }

    return out;
}

/**
 * Q1's review rounds: every `subagent` call with the action `spawn` or `send` from `since` on, oldest first. A row is
 * `{ id, c, at, action, name }`; a spawn row also has `model`, `tools`, `review` and `brief`, as `spawnRows` makes
 * them (so `isCrossReviewSpawn` reads it). No message text is kept but the first 300 characters of a spawn's brief.
 */
export function loadReviewCalls(db, since) {
    const out = [];

    for (const row of db
        .prepare(`${SPAWN_SQL}${ts} >= ? and record like '%"name":"subagent"%' order by id`)
        .all(since)) {
        const entry = parseEntry(row);

        for (const part of entry.model[0].content ?? []) {
            const action = part.arguments?.action;

            if (
                part.type !== "toolCall" ||
                part.name !== "subagent" ||
                (action !== "spawn" && action !== "send")
            ) {
                continue;
            }

            const call = {
                id: row.id,
                c: row.c,
                at: entry.model[0].timestamp,
                action,
                name: typeof part.arguments.name === "string" ? part.arguments.name : null,
            };

            if (action === "spawn") {
                Object.assign(call, {
                    model: typeof part.arguments.model === "string" ? part.arguments.model : null,
                    tools: Array.isArray(part.arguments.tools)
                        ? part.arguments.tools.filter((tool) => typeof tool === "string")
                        : null,
                    review:
                        typeof part.arguments.message === "string" &&
                        /review/i.test(part.arguments.message),
                    brief:
                        typeof part.arguments.message === "string"
                            ? part.arguments.message.slice(0, 300)
                            : "",
                });
            }

            out.push(call);
        }
    }

    return out;
}

/** The detail that Night shift writes in `why` when the same check failure stops a goal (pi-pocket-team#108). */
const SAME_FAILURE_STOP = /the same check failure came \d+ times in a row/;

/**
 * Q1's 3-failure stops. The goal document holds 1 goal per session, and a new goal writes over the old one: so every
 * revision of every `x.night-shift.goal` document (retired ones too) is walked from the first one, and the newest
 * state seen of each goal id is that goal's last state. A goal whose last state is `status: "ended"`,
 * `reason: "blocked"` and the same-failure detail is 1 stop: `{ session, id, at }`. A goal in its summary round
 * (`status: "summary"`) is not a stop yet: Night shift sets `reason` and `why` before the summary, and `endedAt` and
 * `status: "ended"` only after it. Neither `why` nor the failure fingerprint is kept.
 */
export function loadGoalStops(db) {
    const revisions = db.prepare(
        "select kind, content from document_revisions where document_id=? order by seq",
    );
    const stops = [];

    for (const doc of docsOfKind(db, "x.night-shift.goal", { retired: true })) {
        const last = new Map();
        let value;

        for (const row of revisions.all(doc.id)) {
            const content = JSON.parse(row.content);

            value = row.kind === "base" ? content : apply(value, content);

            const goal = value?.goal;

            if (!goal || typeof goal !== "object" || goal.id === undefined || goal.id === null) {
                continue;
            }

            const rounds = Array.isArray(goal.rounds) ? goal.rounds : [];
            const lastRound = rounds.at(-1);

            // Copies of plain values only: a later `apply` cannot change them.
            last.set(String(goal.id), {
                id: String(goal.id),
                stop:
                    goal.status === "ended" &&
                    goal.reason === "blocked" &&
                    typeof goal.why === "string" &&
                    SAME_FAILURE_STOP.test(goal.why),
                endedAt: typeof goal.endedAt === "number" ? goal.endedAt : undefined,
                roundAt: typeof lastRound?.at === "number" ? lastRound.at : undefined,
                setAt: typeof goal.setAt === "number" ? goal.setAt : undefined,
            });
        }

        for (const goal of last.values()) {
            const at = goal.endedAt ?? goal.roundAt ?? goal.setAt;

            if (goal.stop && at !== undefined) {
                stops.push({ session: doc.owner_id, id: goal.id, at });
            }
        }
    }

    return stops.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The user entries of the sessions that checks A1 and A2 read: the threads' sessions and their supervisors. */
function loadUserEntries(db, threads) {
    const conversations = new Set();

    for (const thread of Object.values(threads)) {
        [thread.session, thread.supervisor].forEach(
            (id) => typeof id === "number" && conversations.add(id),
        );
    }

    const statement = db.prepare(
        "select id, record from entries where conversation_id=? and json_extract(record,'$.kind')='pi.user' order by id",
    );
    const out = {};

    for (const id of conversations) {
        out[id] = statement
            .all(id)
            .map(parseEntry)
            .filter((entry) => typeof entry.model?.[0]?.timestamp === "number")
            .map(shortUser);
    }

    return out;
}

/** When each live module was last written (ms), or null. */
function installedTimes(pocketDir) {
    return Object.fromEntries(
        MODULE_FILES.map((file) => {
            try {
                return [file, fs.statSync(path.join(pocketDir, "extensions", file)).mtimeMs];
            } catch {
                return [file, null];
            }
        }),
    );
}

// ---------- GitHub ----------

const json = (text, fallback) => {
    try {
        return JSON.parse(text || "null") ?? fallback;
    } catch {
        return fallback;
    }
};

const PR_QUERY = `state createdAt updatedAt mergedAt closedAt headRefName headRefOid url author { login }
    headRef { name }
    commits(first: 50) { totalCount nodes { commit { oid statusCheckRollup { state } } } }`;

/** The PRs by ref, 40 to a GraphQL query. A PR that GitHub did not return is null. */
function graphqlPrs(gh, refs) {
    const result = {};
    const list = [...new Set(refs)];

    for (let start = 0; start < list.length; start += 40) {
        const chunk = list.slice(start, start + 40);
        const parts = chunk.map((ref, index) => {
            const [, owner, name, number] = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);

            return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { ${PR_QUERY} } }`;
        });
        const data = json(gh.graphql(`{ ${parts.join("\n")} }`), {}).data ?? {};

        chunk.forEach((ref, index) => (result[ref] = data[`p${index}`]?.pullRequest ?? null));
    }

    return result;
}

/** At most this many pages of 100 check runs for 1 commit. */
const CHECK_PAGES = 5;

/**
 * Every check run of a commit, 100 a page, at most 5 pages. `null` when a page cannot be read, or when fewer runs
 * came than `total_count` says: partial data is never judged.
 */
function loadCheckRuns(gh, repo, oid) {
    const runs = [];
    let total = null;

    for (let page = 1; page <= CHECK_PAGES; page += 1) {
        const body = json(
            gh.api(`repos/${repo}/commits/${oid}/check-runs?per_page=100&filter=all&page=${page}`),
            {},
        );

        if (!Array.isArray(body.check_runs)) {
            return null;
        }

        total = typeof body.total_count === "number" ? body.total_count : total;
        runs.push(...body.check_runs);

        if (body.check_runs.length < 100 || (total !== null && runs.length >= total)) {
            break;
        }
    }

    return total !== null && runs.length < total ? null : runs;
}

/** The PRs and check runs the checks of groups B, C, D and H read. At most 40 `gh` calls. */
export function loadGithub(data, { gh, now, since }) {
    const day = new Date(since).toISOString().slice(0, 10);
    const found = json(
        gh.searchPrs([
            "--author",
            BOT,
            "--created",
            `>=${day}`,
            "--limit",
            "300",
            "--json",
            "repository,number,url",
        ]),
        undefined,
    );

    if (!Array.isArray(found)) {
        throw new Error("gh search found nothing: gh failed or is not signed in");
    }

    const botPrs = found.map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`);
    const refs = [...botPrs];
    const threads = Object.values(data.threads);

    for (const thread of threads) {
        if (thread.state !== "closed") {
            refs.push(...Object.keys(thread.prs ?? {}));
        }

        for (const ask of thread.asks ?? []) {
            if (ask.answer && ask.answer.at >= since && /^merged\b/i.test(ask.answer.words ?? "")) {
                refs.push(...refsIn(ask.text, thread.repo));
            }
        }
    }

    const prs = graphqlPrs(gh, refs);
    const checkRuns = {};

    for (const thread of threads) {
        for (const [key, value] of Object.entries(thread.run?.repairs ?? {})) {
            const [, ref, oid, kind] = key.match(/^repair:(.+#\d+):([0-9a-f]+):(\w+)$/) ?? [];

            if (kind === "FAILURE" && value.at >= since && value.at <= now) {
                const repo = ref.split("#")[0];

                checkRuns[`${repo}@${oid}`] = loadCheckRuns(gh, repo, oid);
            }
        }
    }

    const autoDelete = {};
    const repos = new Set(
        botPrs.filter((ref) => branchLeft(prs[ref], now)).map((ref) => ref.split("#")[0]),
    );

    for (const repo of repos) {
        const out = gh.api(`repos/${repo}`, ["--jq", ".delete_branch_on_merge"]).trim();

        autoDelete[repo] = out === "true" ? true : out === "false" ? false : null;
    }

    return { botPrs, prs, checkRuns, autoDelete };
}

// ---------- Q1: decided PRs ----------

/** The most `gh` calls of Q1's search, in 1 run (all owner groups share them). */
export const Q1_MAX_CALLS = 4;
/** At most this many owners in 1 search text; more owners make more groups. */
export const Q1_GROUP = 4;
/** GitHub's search gives at most 1000 results for 1 query. */
const SEARCH_LIMIT = 1000;

/** A time as GitHub's search reads it: `2026-10-23T14:00:00+00:00`. */
export const searchTime = (ms) => `${new Date(ms).toISOString().slice(0, 19)}+00:00`;

const ownerOfRepo = (repo) => /^([\w.-]+)\/[\w.-]+/.exec(String(repo ?? ""))?.[1];

/** The owners of every repository on the desk (any thread state) and of the bot's PRs, sorted, each once. */
export function decidedOwners(data) {
    const owners = new Set();

    const add = (repo) => {
        const owner = ownerOfRepo(repo);

        if (owner) {
            owners.add(owner);
        }
    };

    for (const thread of Object.values(data.threads ?? {})) {
        add(thread.repo);
        Object.keys(thread.prs ?? {}).forEach(add);
    }

    (data.github?.botPrs ?? []).forEach(add);

    return [...owners].sort();
}

const DECIDED_NODE =
    "... on PullRequest { number url title body mergedAt closedAt author { login } repository { nameWithOwner } }";

/** A search node Q1 can use: a PR with its number, its repository and its close time. */
const isDecidedNode = (node) =>
    Boolean(node) &&
    typeof node === "object" &&
    typeof node.number === "number" &&
    typeof node.repository?.nameWithOwner === "string" &&
    typeof node.closedAt === "string";

/**
 * Q1's source: the PRs of the desk's owners that GitHub closed (merged or not) from 1 hour before `since` (the search
 * index lags) to `now`. 1 GraphQL search a page, 100 nodes a page, at most `Q1_MAX_CALLS` calls for all owner groups.
 * Returns `{ from, until, complete, reason?, calls, nodes }`; `complete: false` says why, and partial data is never
 * judged.
 */
export function loadDecided(data, { gh, now, since }) {
    const fromMs = since - HOUR;
    const result = {
        from: new Date(fromMs).toISOString(),
        until: new Date(now).toISOString(),
        complete: true,
        calls: 0,
        nodes: [],
    };
    const owners = decidedOwners(data);
    const startCalls = gh.state.calls;

    const stop = (reason) => {
        result.complete = false;
        result.reason = reason;
    };

    if (owners.length === 0) {
        stop("no repository owners on the desk");
    }

    const groups = [];

    for (let start = 0; start < owners.length; start += Q1_GROUP) {
        groups.push(owners.slice(start, start + Q1_GROUP));
    }

    groups: for (const group of groups) {
        const text = `is:pr is:closed closed:${searchTime(fromMs)}..${searchTime(now)} ${group
            .map((owner) => `user:${owner}`)
            .join(" ")}`;
        let cursor = null;

        for (;;) {
            if (result.calls >= Q1_MAX_CALLS) {
                stop(`the search needs more than ${Q1_MAX_CALLS} calls`);

                break groups;
            }

            if (gh.state.capReached) {
                stop("GitHub call cap reached");

                break groups;
            }

            const after = cursor === null ? "" : `, after: ${JSON.stringify(cursor)}`;
            const failuresBefore = gh.state.failures;
            const out = gh.graphql(
                `{ search(query: ${JSON.stringify(text)}, type: ISSUE, first: 100${after}) { issueCount pageInfo { hasNextPage endCursor } nodes { ${DECIDED_NODE} } } }`,
            );

            result.calls = gh.state.calls - startCalls;

            if (gh.state.capReached && out === "") {
                stop("GitHub call cap reached");

                break groups;
            }

            // A failed call can still print JSON (`makeGh` keeps its stdout): it is never trusted.
            if (gh.state.failures > failuresBefore) {
                stop("a search call failed");

                break groups;
            }

            const answer = json(out, {});

            // GitHub can send `data` with top-level `errors`: a partial answer.
            if (Array.isArray(answer?.errors) && answer.errors.length > 0) {
                stop("a search returned errors");

                break groups;
            }

            const search = answer?.data?.search;

            if (!search || typeof search !== "object" || !Array.isArray(search.nodes)) {
                stop("a search returned no data");

                break groups;
            }

            if (typeof search.issueCount === "number" && search.issueCount > SEARCH_LIMIT) {
                stop(`more than ${SEARCH_LIMIT} results`);

                break groups;
            }

            if (typeof search.pageInfo?.hasNextPage !== "boolean") {
                stop("a search page had no page info");

                break groups;
            }

            if (!search.nodes.every(isDecidedNode)) {
                stop("a search returned a node that is not a whole PR");

                break groups;
            }

            result.nodes.push(...search.nodes);

            if (!search.pageInfo.hasNextPage) {
                break;
            }

            cursor = search.pageInfo.endCursor;

            if (typeof cursor !== "string" || cursor === "") {
                stop("a page had no cursor to the next one");

                break groups;
            }
        }
    }

    return result;
}

// ---------- Odrade's notes ----------

/** The notes folder: its index, its reports, its uncommitted files and its last commit. Never written. */
export function readOdrade(dir, git) {
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    const reports = fs.readdirSync(path.join(dir, "reports"));
    const dirty = git.call(dir, ["status", "--porcelain"]).split("\n").filter(Boolean);
    const last = Date.parse(git.call(dir, ["log", "-1", "--format=%cI"]).trim());

    return { readme, reports, dirty, lastCommitAt: Number.isNaN(last) ? null : last };
}

// ---------- The flaky-test scan (Q1's CI reruns) ----------

const FLAKY_FOLDER = /^\d{4}-\d{2}-\d{2}.*-flaky-scan$/;

/**
 * The newest flaky-test scan (core spec `docs/specs/flaky-test-scan.md`): `reports/<date>…-flaky-scan/scan.json` under
 * Odrade's folder, the greatest folder name that holds a `scan.json`. `null` when there is none. A file that is not
 * valid JSON, has another `schema_version` than 1, or has no `repos` list throws. Returns
 * `{ file, generatedAt, window, repos: { [repo]: rerunAttempts } }`; a repository with an `error`, or whose
 * `rerunAttempts` is not a whole number of 0 or more, is `null`, never `0`. Never written.
 */
export function readFlakyScan(odradeDir) {
    const reports = path.join(odradeDir, "reports");
    let names;

    try {
        names = fs.readdirSync(reports);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }

        throw error;
    }

    const folder = names
        .filter((name) => FLAKY_FOLDER.test(name))
        .sort()
        .reverse()
        .find((name) => fs.existsSync(path.join(reports, name, "scan.json")));

    if (folder === undefined) {
        return null;
    }

    const file = `reports/${folder}/scan.json`;
    let scan;

    try {
        scan = JSON.parse(fs.readFileSync(path.join(odradeDir, file), "utf8"));
    } catch {
        throw new Error(`${file} is not valid JSON`);
    }

    if (scan?.schema_version !== 1) {
        throw new Error(`${file} has schema_version ${scan?.schema_version}, not 1`);
    }

    if (!Array.isArray(scan.repos)) {
        throw new Error(`${file} has no repos list`);
    }

    const repos = {};

    for (const entry of scan.repos) {
        if (typeof entry?.repo !== "string" || entry.repo === "") {
            continue;
        }

        const value = entry.rerunAttempts;

        repos[entry.repo] =
            (entry.error === null || entry.error === undefined) &&
            Number.isInteger(value) &&
            value >= 0
                ? value
                : null;
    }

    return {
        file,
        generatedAt: typeof scan.generated_at === "string" ? scan.generated_at : null,
        window:
            scan.window && typeof scan.window === "object"
                ? {
                      from: typeof scan.window.from === "string" ? scan.window.from : null,
                      to: typeof scan.window.to === "string" ? scan.window.to : null,
                  }
                : null,
        repos,
    };
}

// ---------- The agents' homes ----------

/** A folder's real path, or its absolute path when it does not exist. */
const realPath = (folder) => {
    try {
        return fs.realpathSync(folder);
    } catch {
        return path.resolve(folder);
    }
};

/**
 * The agents' home folders: every subfolder of `dir` that holds `.git`, with its id, its uncommitted lines and its
 * last commit time. A folder in `exclude` (Odrade's: the checks of group I read it) is left out, compared by its
 * real path. A `dir` that does not exist gives no homes and no error: the homes are optional. 1 home whose git
 * fails does not fail the source: with no commit it has `lastCommitAt: null`, and when `status` fails it is skipped.
 */
export function readHomes(dir, git, { exclude = [] } = {}) {
    const skip = new Set(exclude.filter(Boolean).map(realPath));
    let entries;

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }

        throw error;
    }

    const homes = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // A name that starts with a dot is not a home, and it is not even looked at.
        if (entry.name.startsWith(".")) {
            continue;
        }

        const folder = path.join(dir, entry.name);

        try {
            // A home is a folder, or a link to one. A broken link, a link loop or a folder that cannot be read is
            // left out: 1 such entry must not fail the whole source.
            const stat = fs.statSync(folder, { throwIfNoEntry: false });

            if (!stat?.isDirectory() || !fs.existsSync(path.join(folder, ".git"))) {
                continue;
            }

            if (skip.has(realPath(folder))) {
                continue;
            }
        } catch {
            continue;
        }

        let dirty;

        try {
            dirty = git.call(folder, ["status", "--porcelain"]).split("\n").filter(Boolean);
        } catch {
            // Without `status` the home has no uncommitted lines to report: it is left out, not an error.
            continue;
        }

        let lastCommitAt = null;

        try {
            const last = Date.parse(git.call(folder, ["log", "-1", "--format=%cI"]).trim());

            lastCommitAt = Number.isNaN(last) ? null : last;
        } catch {
            // A repository with no commit yet has no log: the home has no last commit, and the rest still counts.
        }

        homes.push({ id: entry.name, folder, dirty, lastCommitAt });
    }

    return homes;
}

// ---------- Everything ----------

/**
 * Load every source into one plain object. A source that cannot be read goes to `sourceErrors` by name, and the
 * checks that need it are skipped.
 *
 * Options: `pocketDir`, `odradeDir`, `homesDir`, `now`, `hours`, `useGithub`, `run` (a process runner, for tests).
 */
export function loadData({
    pocketDir,
    odradeDir,
    homesDir = path.join(os.homedir(), "agents"),
    now,
    hours,
    useGithub,
    run = defaultRun,
}) {
    const since = now - hours * HOUR;
    // J1 compares the window with the 7 days before it.
    const horizon = since - 7 * DAY;
    const sourceErrors = {};
    const data = {
        threads: {},
        grants: [],
        events: [],
        reports: {},
        agentOf: {},
        goals: [],
        schedules: [],
        userEntries: {},
        toolErrors: [],
        costRows: [],
        spawns: [],
        routeCosts: [],
        routeSpawns: [],
        installed: installedTimes(pocketDir),
        odrade: undefined,
        homes: [],
        github: undefined,
        decided: undefined,
        reviewCalls: [],
        goalStops: [],
        flakyScan: null,
        sourceErrors,
    };

    const attempt = (name, fn) => {
        try {
            fn();
        } catch (error) {
            sourceErrors[name] = String(error?.message ?? error).split("\n")[0];
        }
    };

    let db;

    try {
        db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    } catch (error) {
        const message = String(error?.message ?? error).split("\n")[0];

        for (const name of [
            "desk",
            "reports",
            "goals",
            "schedules",
            "entries",
            "costs",
            "routes",
            "reviews",
            "goalHistory",
        ]) {
            sourceErrors[name] = message;
        }
    }

    if (db) {
        attempt("desk", () => Object.assign(data, loadDesk(db)));
        // R1's own read, after the desk: every routed thread's session, with no time limit (see `checkR1`).
        attempt("routes", () => {
            const sessions = new Set(
                Object.values(data.threads)
                    .filter((thread) => thread.route !== undefined && thread.session !== undefined)
                    .map((thread) => thread.session),
            );

            data.routeCosts = loadRouteCosts(db, sessions);
            data.routeSpawns = loadRouteSpawns(db, sessions);
        });
        attempt("reports", () => (data.reports = loadReports(db)));
        attempt("goals", () => (data.goals = loadGoals(db)));
        attempt("schedules", () => (data.schedules = loadSchedules(db)));
        attempt("identities", () => (data.agentOf = loadAgents(db)));
        attempt("entries", () => {
            data.userEntries = loadUserEntries(db, data.threads);
            data.toolErrors = loadToolErrors(db, since);
            data.spawns = loadSpawns(db, horizon);
        });
        attempt("costs", () => (data.costRows = loadCosts(db, horizon)));
        // Q1's review rounds and 3-failure stops: 30 days of spawn and send calls, and every goal revision.
        attempt("reviews", () => (data.reviewCalls = loadReviewCalls(db, now - 30 * DAY)));
        attempt("goalHistory", () => (data.goalStops = loadGoalStops(db)));
        db.close();
    }

    const gh = makeGh(run);

    if (!useGithub) {
        sourceErrors.github = "disabled by --no-github";
    } else if (sourceErrors.desk) {
        sourceErrors.github = "needs the desk threads";
    } else {
        attempt("github", () => {
            data.github = loadGithub(data, { gh, now, since });
        });
    }

    // Q1's search comes after `loadGithub`, with the same `gh`: it shares the cap of 40 calls.
    if (!useGithub) {
        sourceErrors.decided = "disabled by --no-github";
    } else if (sourceErrors.desk) {
        sourceErrors.decided = "needs the desk threads";
    } else {
        attempt("decided", () => {
            data.decided = loadDecided(data, { gh, now, since });
        });
    }

    data.githubCalls = { calls: gh.state.calls, capReached: gh.state.capReached };

    if (gh.state.capReached) {
        data.githubCalls.note = "GitHub call cap reached";
    }

    const git = makeGit(run);

    attempt("odrade", () => {
        data.odrade = readOdrade(odradeDir, git);
    });
    attempt("homes", () => {
        data.homes = readHomes(homesDir, git, { exclude: [odradeDir] });
    });
    // Q1's CI reruns: the newest flaky-test scan in Odrade's reports. No scan is `null`, not an error.
    attempt("flakyScan", () => {
        data.flakyScan = readFlakyScan(odradeDir);
    });

    return data;
}
