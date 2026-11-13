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
import {
    ANSWER,
    blockingItems,
    guardCacheOf,
    headIn,
    prRefsIn,
    reviewPoints,
    verdictIn,
} from "./reviews.mjs";

export const BOT = "frostyard-machines";
/** The most `gh` calls a run may make. */
export const GH_CAP = 40;
/** The live modules whose install time the report compares with a finding's last case. */
export const MODULE_FILES = ["desk.ts", "team.ts", "night-shift.ts"];
/** The tools whose errors check A4 reads. `plan` is the desk's plan tool (pi-pocket-team#119, M1 and M3). */
export const TEAM_TOOLS = [
    "desk",
    "team",
    "team_delegate",
    "team_message",
    "team_sessions",
    "plan",
];
/** A tool call whose arguments name one of these reads the desk's or Pocket's source (pi-pocket-team#119, M2). */
export const SOURCE_READ_MARKS = ["desk.ts", "pi-pocket/src"];
/**
 * The tools of a source read, as the entries name them. A `plan`, `desk` or `team_message` call whose text names
 * `desk.ts` writes about the source; it does not read it.
 */
export const SOURCE_READ_TOOLS = ["bash", "read"];

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
export const docsOfKind = (db, kind, { retired = false } = {}) =>
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

/**
 * The planning sessions: the `session` of each desk thread with `origin: "plan"` (a consult or task thread is not
 * one). For each session, from `since` on: every `plan` tool result (`{ id, at, isError, text }`; `text` is the
 * first 600 characters of a refusal, "" for a result that is no error), and every `bash` or `read` call whose arguments
 * name `desk.ts` or `pi-pocket/src` (`{ id, at, tool }`, no argument text kept). A session with neither in the
 * window is left out. Sorted by thread id.
 */
export function loadPlanSessions(db, threads, since) {
    const bySession = new Map();

    for (const thread of Object.values(threads)) {
        if (
            thread?.origin === "plan" &&
            typeof thread.session === "number" &&
            !bySession.has(thread.session)
        ) {
            bySession.set(thread.session, thread.id);
        }
    }

    const results = db.prepare(
        `select id, record from entries where conversation_id=? and json_extract(record,'$.kind')='pi.tool-result'
         and ${ts} >= ? and json_extract(record,'$.model[0].toolName')='plan' order by id`,
    );
    const marks = SOURCE_READ_MARKS.map(() => "record like ?").join(" or ");
    const reads = db.prepare(
        `select id, record from entries where conversation_id=? and json_extract(record,'$.kind')='pi.assistant'
         and ${ts} >= ? and (${marks}) order by id`,
    );
    const out = [];

    for (const [session, thread] of bySession) {
        const planResults = results.all(session, since).map((row) => {
            const entry = parseEntry(row);
            const isError = entry.model[0].isError === true;

            return {
                id: row.id,
                at: entry.model[0].timestamp,
                isError,
                text: isError ? textOf(entry).slice(0, 600) : "",
            };
        });
        const sourceReads = [];

        for (const row of reads.all(session, since, ...SOURCE_READ_MARKS.map((m) => `%${m}%`))) {
            const entry = parseEntry(row);

            for (const part of entry.model[0].content ?? []) {
                const args =
                    part.type === "toolCall" && SOURCE_READ_TOOLS.includes(part.name)
                        ? JSON.stringify(part.arguments ?? {})
                        : "";

                if (SOURCE_READ_MARKS.some((mark) => args.includes(mark))) {
                    sourceReads.push({
                        id: row.id,
                        at: entry.model[0].timestamp,
                        tool: String(part.name),
                    });
                }
            }
        }

        if (planResults.length > 0 || sourceReads.length > 0) {
            out.push({ thread, session, results: planResults, sourceReads });
        }
    }

    return out.sort((a, b) => a.thread.localeCompare(b.thread, "en", { numeric: true }));
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
                    thinking:
                        typeof part.arguments.thinking === "string"
                            ? part.arguments.thinking
                            : null,
                });
            }
        }
    }

    return out;
}

/**
 * R2's parent hand fixes: for each of some sessions, with no time limit, the time of the first subagent answer (a user
 * entry that `ANSWER` matches) and the number of `edit` and `write` tool calls of the session after it. A row is
 * `{ c, firstAnswerAt, edits, editTimes }`: `firstAnswerAt` is null when no subagent answered, and `edits` is then 0.
 * `editTimes` holds the sorted times of ALL the session's `edit` and `write` calls (1 time per call), for R2's
 * evidence of work after a close. Every session gets a row. No file path and no text is kept.
 */
export function loadParentEdits(db, sessions) {
    const ids = [...sessions];

    if (ids.length === 0) {
        return [];
    }

    const marks = ids.map(() => "?").join(",");
    const firstAnswer = new Map();

    for (const row of db
        .prepare(
            `select id, conversation_id c, record from entries where json_extract(record,'$.kind')='pi.user'
             and conversation_id in (${marks}) and record like '%[subagent %answered%'`,
        )
        .all(...ids)) {
        const entry = parseEntry(row);
        const at = entry.model?.[0]?.timestamp;

        if (typeof at === "number" && ANSWER.test(textOf(entry))) {
            firstAnswer.set(row.c, Math.min(firstAnswer.get(row.c) ?? Infinity, at));
        }
    }

    const edits = new Map();
    const times = new Map();

    for (const row of db
        .prepare(
            `${SPAWN_SQL}conversation_id in (${marks})
             and (record like '%"name":"edit"%' or record like '%"name":"write"%')`,
        )
        .all(...ids)) {
        const first = firstAnswer.get(row.c);
        const entry = parseEntry(row);
        const at = entry.model?.[0]?.timestamp;

        if (typeof at !== "number") {
            continue;
        }

        const content = entry.model[0].content;
        const count = (Array.isArray(content) ? content : []).filter(
            (part) => part?.type === "toolCall" && (part.name === "edit" || part.name === "write"),
        ).length;

        if (count > 0) {
            times.set(row.c, [...(times.get(row.c) ?? []), ...Array(count).fill(at)]);
        }

        if (first !== undefined && at > first) {
            edits.set(row.c, (edits.get(row.c) ?? 0) + count);
        }
    }

    return ids
        .sort((a, b) => a - b)
        .map((c) => ({
            c,
            firstAnswerAt: firstAnswer.get(c) ?? null,
            edits: edits.get(c) ?? 0,
            editTimes: (times.get(c) ?? []).sort((a, b) => a - b),
        }));
}

/**
 * Q1's review rounds: every `subagent` call with the action `spawn` or `send` from `since` on, oldest first. A row is
 * `{ id, c, at, action, name, refs, bare, head }`; a spawn row also has `model`, `tools`, `review` and `brief`, as
 * `spawnRows` makes them (so `isCrossReviewSpawn` reads it). `refs` and `bare` are the PRs the whole message names
 * (`prRefsIn`), `head` the reviewed head it names (`headIn`). No message text is kept but the first 300 characters of
 * a spawn's brief.
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

            const message =
                typeof part.arguments.message === "string" ? part.arguments.message : "";
            const { refs, bare } = prRefsIn(message);
            const call = {
                id: row.id,
                c: row.c,
                at: entry.model[0].timestamp,
                action,
                name: typeof part.arguments.name === "string" ? part.arguments.name : null,
                refs,
                bare,
                head: headIn(message),
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

/**
 * The answers of subagents from `since` on, by id: user entries that start with `[subagent NAME answered`. A row is
 * `{ id, c, at, name, ready, items }`: the verdict (`verdictIn`) and the labels of the blocking points
 * (`blockingItems`). No answer text is kept.
 */
export function loadReviewAnswers(db, since) {
    const out = [];

    for (const row of db
        .prepare(
            `select id, conversation_id c, record from entries where json_extract(record,'$.kind')='pi.user'
             and ${ts} >= ? and record like '%[subagent %answered%' order by id`,
        )
        .all(since)) {
        const entry = parseEntry(row);
        const text = textOf(entry);
        const name = ANSWER.exec(text)?.[1];

        if (name !== undefined) {
            out.push({
                id: row.id,
                c: row.c,
                at: entry.model[0].timestamp,
                name,
                ready: verdictIn(text),
                items: blockingItems(text),
            });
        }
    }

    return out.sort((a, b) => a.id - b.id);
}

/** The detail that Night shift writes in `why` when the same check failure stops a goal (pi-pocket-team#108). */
const SAME_FAILURE_STOP = /the same check failure came \d+ times in a row/;

/** The start of a failure fingerprint made from `gh pr checks` rows (`checkFingerprint` in `night-shift.ts`). */
const CHECKS_FINGERPRINT = "checks failed: ";

const OWNER_NAME = /^[^/\s]+\/[^/\s]+$/;

/**
 * The failing jobs of a stopped goal, as new plain objects: from `goal.stopChecks` (`checksFrom: "record"`), else the
 * names in a `checks failed: [...]` fingerprint (`"fingerprint"`), else none (`null`).
 */
function stopChecksOf(goal) {
    const recorded = (Array.isArray(goal.stopChecks) ? goal.stopChecks : [])
        .filter((each) => typeof each?.name === "string" && each.name !== "")
        .map((each) => {
            const check = { name: each.name };

            if (typeof each.repo === "string" && OWNER_NAME.test(each.repo)) {
                check.repo = each.repo;
            }

            if (Number.isSafeInteger(each.run)) {
                check.run = each.run;
            }

            if (Number.isSafeInteger(each.job)) {
                check.job = each.job;
            }

            return check;
        });

    if (recorded.length > 0) {
        return { checks: recorded, checksFrom: "record" };
    }

    const fingerprint = goal.failures?.fingerprint;

    if (typeof fingerprint === "string" && fingerprint.startsWith(CHECKS_FINGERPRINT)) {
        try {
            const names = JSON.parse(fingerprint.slice(CHECKS_FINGERPRINT.length));

            if (Array.isArray(names)) {
                const checks = names
                    .filter((name) => typeof name === "string" && name !== "")
                    .map((name) => ({ name }));

                if (checks.length > 0) {
                    return { checks, checksFrom: "fingerprint" };
                }
            }
        } catch {
            // A fingerprint that is not a JSON list gives no checks.
        }
    }

    return { checks: [], checksFrom: null };
}

/**
 * Q1's 3-failure stops. The goal document holds 1 goal per session, and a new goal writes over the old one: so every
 * revision of every `x.night-shift.goal` document (retired ones too) is walked from the first one, and the newest
 * state seen of each goal id is that goal's last state. A goal whose last state is `status: "ended"`,
 * `reason: "blocked"` and the same-failure detail is 1 stop: `{ session, id, at, checks, checksFrom }`. A goal in its summary round
 * (`status: "summary"`) is not a stop yet: Night shift sets `reason` and `why` before the summary, and `endedAt` and
 * `status: "ended"` only after it. Each stop also has `checks` and `checksFrom` (`stopChecksOf`): the failing jobs from
 * `goal.stopChecks`, or the job names of the failure fingerprint. `why` and the fingerprint text are not kept.
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
            const stop =
                goal.status === "ended" &&
                goal.reason === "blocked" &&
                typeof goal.why === "string" &&
                SAME_FAILURE_STOP.test(goal.why);

            last.set(String(goal.id), {
                id: String(goal.id),
                stop,
                ...(stop ? stopChecksOf(goal) : { checks: [], checksFrom: null }),
                endedAt: typeof goal.endedAt === "number" ? goal.endedAt : undefined,
                roundAt: typeof lastRound?.at === "number" ? lastRound.at : undefined,
                setAt: typeof goal.setAt === "number" ? goal.setAt : undefined,
            });
        }

        for (const goal of last.values()) {
            const at = goal.endedAt ?? goal.roundAt ?? goal.setAt;

            if (goal.stop && at !== undefined) {
                stops.push({
                    session: doc.owner_id,
                    id: goal.id,
                    at,
                    checks: goal.checks,
                    checksFrom: goal.checksFrom,
                });
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

// ---------- Q1: guards of blocking review points ----------

/** At most this many PR state queries (40 PRs each) of `loadBlockerGuards` in 1 run. */
export const BLOCKER_MAX_PR_QUERIES = 8;
/** At most this many object lookups in 1 blob query. */
export const BLOCKER_LOOKUPS = 150;
/** At most this many blob queries in 1 run. */
export const BLOCKER_MAX_QUERIES = 4;
/** At most this many files of a PR are read; a PR with more is "too many files". */
const BLOCKER_PR_FILES = 100;
const CORRECTIONS_FILE = ".memory/corrections.jsonl";
/** 1 record file of the new form: 1 JSON object with `date`, `scope`, `correction`, `evidence` and `promoted_to`. */
const RECORD_FILE = /^\.memory\/corrections\/[^/]+\.json$/;

/** The words that `checkGhArgs` refuses in a `gh` argument. */
const READ_ONLY_REFUSED = /\b(mutation|subscription)\b/i;

const BLOCKER_PR_QUERY =
    "state mergedAt closedAt headRefOid files(first: 100) { totalCount nodes { path additions } }";

const TEST_PATHS = [
    /(^|\/)(tests?|__tests__|spec|testdata)\//,
    /[._-](test|spec)\.[^/]+$/,
    /(^|\/)test_[^/]+\.py$/,
    /_test\.go$/,
];

/**
 * The files of a PR's own diff that can guard a blocking point: test files, `AGENTS.md` files (any folder),
 * `.memory/corrections.jsonl` (the old form of a correction record) and `.memory/corrections/<name>.json` files (the
 * new form). Each is `{ path, test, agents, corrections, record }`. A record file is never a test file, even when its
 * name matches a test pattern.
 */
export function guardCandidates(prFiles) {
    return [
        ...new Set(prFiles.map((file) => file?.path).filter((path) => typeof path === "string")),
    ]
        .map((path) => {
            const record = RECORD_FILE.test(path);

            return {
                path,
                test: !record && TEST_PATHS.some((pattern) => pattern.test(path)),
                agents: /(^|\/)AGENTS\.md$/.test(path),
                corrections: path === CORRECTIONS_FILE,
                record,
            };
        })
        .filter((file) => file.test || file.agents || file.corrections || file.record);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The non-empty lines of a text. */
const linesOf = (text) =>
    String(text)
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.trim() !== "");

/** The lines of `after` that are not in `before`, as a multiset: a line 2 times after and 1 time before is 1 line. */
function addedLines(before, after) {
    const counts = new Map();

    for (const line of linesOf(before)) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
    }

    return linesOf(after).filter((line) => {
        const left = counts.get(line) ?? 0;

        counts.set(line, left - 1);

        return left <= 0;
    });
}

/** The text of a blob lookup: "" with no blob, null when GitHub gave no whole text. */
const blobText = (blob) =>
    blob === null || blob === undefined
        ? ""
        : typeof blob.text === "string" && blob.isTruncated !== true
          ? blob.text
          : null;

/** A plain JSON object: not null, not an array. */
const isPlainObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The key of a correction record: every field but `promoted_to`, which a filled record may change. */
const recordKey = (record) =>
    JSON.stringify([record.date, record.scope, record.correction, record.evidence]);

/** The regex that finds a mention of `ref` (`owner/name#N`, also without the owner) in a text, or null. */
function mentionOf(ref) {
    const [, owner, name, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref) ?? [];

    if (name === undefined) {
        return null;
    }

    return new RegExp(
        `(?<![\\w./-])(?:${escapeRegExp(owner)}\\/)?${escapeRegExp(name)}#${number}(?!\\d)`,
        "i",
    );
}

/** The result of a guard whose correction records cannot be read (a missing or truncated text, invalid JSON). */
const textMissing = (test, agentsRule, skipped) => ({
    final: true,
    state: "merged",
    guarded: null,
    test,
    agentsRule,
    corrections: null,
    correctionsLegacy: null,
    correctionsFiles: null,
    correctionsSkipped: skipped,
    namesPr: null,
    reason: "corrections text missing",
});

/**
 * The guard of 1 blocking point, from blob lookups at the reviewed head H and the PR's final head F. `lookup` is
 * `{ head, files, skipped }`: `head` is GitHub's object of H (null when GitHub does not have it); each file is a
 * candidate of `guardCandidates` with `atHead` and `atFinal`, the blob at H and at F (`{ oid, text?, isTruncated? }`,
 * or null with no blob); `skipped` lists record files that the read-only `gh` refuses (default none). A file changed
 * when it has a blob at F with another oid than at H (no blob at H: a new file); a deleted file did not change.
 *
 * `correctionsLegacy` counts the non-empty lines of `.memory/corrections.jsonl` at F that are not at H.
 * `correctionsFiles` counts the new record files under `.memory/corrections/` whose record is not moved from the old
 * file: a record whose `date`, `scope`, `correction` and `evidence` match a line of the old file at H is a moved
 * record and counts for nothing. `corrections` is their sum; `namesPr` is true when an added old line or a counted
 * record file names the PR.
 */
export function guardOf(ref, { head, files, skipped = [] }) {
    if (!head) {
        return { final: true, state: "merged", guarded: null, reason: "head not found" };
    }

    const changed = (file) =>
        Boolean(file.atFinal) && (!file.atHead || file.atHead.oid !== file.atFinal.oid);
    const test = files.some((file) => file.test && changed(file));
    const agentsRule = files.some((file) => file.agents && changed(file));
    const log = files.find((file) => file.corrections && changed(file));
    const mention = mentionOf(ref);
    let correctionsLegacy = 0;
    let namesPr = false;

    if (log) {
        const before = blobText(log.atHead);
        const after = blobText(log.atFinal);

        if (before === null || after === null) {
            return textMissing(test, agentsRule, skipped);
        }

        const lines = addedLines(before, after);

        correctionsLegacy = lines.length;
        namesPr = mention !== null && lines.some((line) => mention.test(line));
    }

    // A record file that is new at the final head: no blob at the reviewed head. Sorted, so the reads are stable.
    const added = files
        .filter((file) => file.record && file.atFinal && !file.atHead)
        .sort((a, b) => a.path.localeCompare(b.path));
    let correctionsFiles = 0;

    if (added.length > 0) {
        // The old file's text at the reviewed head finds the records moved into the new form.
        const old = files.find((file) => file.path === CORRECTIONS_FILE);
        const before = old ? blobText(old.atHead) : null;

        if (before === null) {
            return textMissing(test, agentsRule, skipped);
        }

        // The keys of the old file's records, as a multiset: a record may be in it more than once.
        const keys = new Map();

        for (const line of linesOf(before)) {
            let record;

            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }

            if (!isPlainObject(record)) {
                continue;
            }

            const key = recordKey(record);

            keys.set(key, (keys.get(key) ?? 0) + 1);
        }

        for (const file of added) {
            const text = blobText(file.atFinal);
            let record;

            try {
                record = text === null ? null : JSON.parse(text);
            } catch {
                record = null;
            }

            if (!isPlainObject(record)) {
                return textMissing(test, agentsRule, skipped);
            }

            const key = recordKey(record);
            const left = keys.get(key) ?? 0;

            if (left > 0) {
                // Moved from the old file after the reviewed head: not a new record.
                keys.set(key, left - 1);
            } else {
                correctionsFiles += 1;

                if (mention !== null && mention.test(text)) {
                    namesPr = true;
                }
            }
        }
    }

    const corrections = correctionsLegacy + correctionsFiles;

    return {
        final: true,
        state: "merged",
        guarded: (test || agentsRule) && corrections > 0,
        test,
        agentsRule,
        corrections,
        correctionsLegacy,
        correctionsFiles,
        correctionsSkipped: skipped,
        namesPr,
    };
}

/**
 * 1 GraphQL call of `loadBlockerGuards`, as `{ data, errors }` (`data` null when the answer has none). A failed call,
 * an answer with errors, or the cap is named in `errors` once, by `label` and kind: no text from GitHub.
 */
function ghAnswer(gh, query, label, errors) {
    const failures = gh.state.failures;
    const out = gh.graphql(query);

    const capped = gh.state.capReached && out === "";
    const failed = gh.state.failures > failures;

    if (capped) {
        errors.add("GitHub call cap reached");
    } else if (failed) {
        errors.add(`${label} failed`);
    }

    const answer = json(out, {});
    const list = Array.isArray(answer?.errors) ? answer.errors : [];
    const data =
        answer?.data && typeof answer.data === "object" && !Array.isArray(answer.data)
            ? answer.data
            : null;

    if (list.length > 0) {
        errors.add(`${label} returned errors`);
    }

    // A call that ends well with invalid JSON, a non-object or no `data`.
    if (data === null && !capped && !failed && list.length === 0) {
        errors.add(`${label} returned no data`);
    }

    return { data, errors: list };
}

/** The top-level aliases that GraphQL errors name; `all` when an error has no path. */
function errorAliases(list) {
    const names = new Set();
    let all = false;

    for (const error of list) {
        const first = Array.isArray(error?.path) ? error.path[0] : undefined;

        if (typeof first === "string") {
            names.add(first);
        } else {
            all = true;
        }
    }

    return { names, all };
}

/**
 * A PR node that `loadBlockerGuards` can judge: a string `state`, and a whole file list (a number `totalCount`, an
 * array of nodes with a string `path`, as many as `totalCount`, or 100 of more than 100 files: "too many files").
 */
function isWholePr(node) {
    const files = node?.files;

    return (
        typeof node?.state === "string" &&
        typeof files?.totalCount === "number" &&
        Array.isArray(files.nodes) &&
        files.nodes.every((file) => typeof file?.path === "string") &&
        (files.nodes.length === files.totalCount || files.totalCount > BLOCKER_PR_FILES)
    );
}

/** The object lookups of 1 key in 1 blob query: H, and each candidate at H and at F. */
const lookupCount = (key) => 1 + 2 * key.files.length;

/** The files whose text the guard needs: the old corrections file, a record file, and the reference copy of the old file. */
const needsText = (file) => Boolean(file.corrections || file.record || file.reference);

/** 1 blob query: 1 `repository` alias per repository, and in it the lookups of each key. */
function blobQuery(batch) {
    const repos = new Map();

    batch.forEach((key, index) => {
        const lines = [`k${index}: object(oid: ${JSON.stringify(key.head)}) { oid }`];

        key.files.forEach((file, j) => {
            const blob = needsText(file) ? " ... on Blob { text isTruncated }" : "";

            for (const [mark, sha] of [
                ["h", key.head],
                ["f", key.final],
            ]) {
                lines.push(
                    `k${index}${mark}${j}: object(expression: ${JSON.stringify(`${sha}:${file.path}`)}) { oid${blob} }`,
                );
            }
        });

        const repo = key.ref.split("#")[0];

        repos.set(repo, [...(repos.get(repo) ?? []), ...lines]);
    });

    const aliases = new Map();
    const parts = [...repos.entries()].map(([repo, lines], n) => {
        const [owner, name] = repo.split("/");

        aliases.set(repo, `r${n}`);

        return `r${n}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${lines.join(" ")} }`;
    });

    return { text: `{ ${parts.join("\n")} }`, aliases };
}

/**
 * The guards of 1 blob query's keys, from its answer. A key whose aliases are missing, or that an error names (or an
 * error with no path), gets no result: it stays pending.
 */
function guardsOfAnswer(batch, aliases, answer, kinds) {
    const data = answer?.data && typeof answer.data === "object" ? answer.data : null;
    const errors = Array.isArray(answer?.errors) ? answer.errors : [];
    const badRepos = new Set();
    const badKeys = new Set();
    let allBad = data === null;

    for (const error of errors) {
        const path = Array.isArray(error?.path) ? error.path : [];
        const index = /^k(\d+)(?:[hf]\d+)?$/.exec(String(path[1] ?? ""))?.[1];

        if (path.length === 0) {
            allBad = true;
        } else if (index === undefined) {
            badRepos.add(path[0]);
        } else {
            badKeys.add(`${path[0]}:${index}`);
        }
    }

    const out = new Map();

    batch.forEach((key, index) => {
        const alias = aliases.get(key.ref.split("#")[0]);
        const repo = data?.[alias];
        const names = [
            `k${index}`,
            ...key.files.flatMap((_, j) => [`k${index}h${j}`, `k${index}f${j}`]),
        ];

        if (allBad || badRepos.has(alias) || badKeys.has(`${alias}:${index}`)) {
            return;
        }

        if (!repo || typeof repo !== "object" || !names.every((name) => name in repo)) {
            // No error names it, and the answer has no place for it.
            kinds.add("blob query missed a key");

            return;
        }

        out.set(
            key.key,
            guardOf(key.ref, {
                head: repo[`k${index}`],
                files: key.files.map((file, j) => ({
                    ...file,
                    atHead: repo[`k${index}h${j}`],
                    atFinal: repo[`k${index}f${j}`],
                })),
                skipped: key.skipped ?? [],
            }),
        );
    });

    return out;
}

/**
 * The guards of Q1's blocking points ("Blocker to guard"). The points come from `reviewPoints`; a point whose
 * `ref@head` has a final result in `cache` (earlier days) needs no call. Step 1: the other PRs, newest points first,
 * 40 to a GraphQL query, at most `BLOCKER_MAX_PR_QUERIES` queries: their state and their files. Step 2: for each
 * merged `(ref, head)`, the candidate files of the PR's own diff (`guardCandidates`) are looked up at the reviewed
 * head and at the final head, with no compare call: at most `BLOCKER_LOOKUPS` object lookups a query, at most
 * `BLOCKER_MAX_QUERIES` queries a run, newest keys first. A record file under `.memory/corrections/` whose path holds
 * a word the read-only `gh` refuses is not looked up: it is dropped and listed in the guard's `correctionsSkipped`.
 * When a PR has a record file, the text of `.memory/corrections.jsonl` at the reviewed head is looked up too, as a
 * reference, to find the records moved from that file. Keys that do not fit, or whose answer is missing, stay
 * pending: the next run tries again. A closed PR is final with no lookup. A PR node is used only when no error names
 * its alias and its file list is whole (`isWholePr`); else its keys stay pending, never final. Returns
 * `{ prs, guards, calls, pending, errors }`: `pending` counts every distinct `ref@head` with no final result yet
 * (not cached, no result this run), whatever deferred it; `errors` names each kind of failed or partial call once,
 * with no text from GitHub.
 */
export function loadBlockerGuards(data, { gh, now, cache = {} }) {
    const startCalls = gh.state.calls;
    const { points } = reviewPoints(data, { now });
    const newest = [...points].reverse();
    const isFinal = (point) => cache[`${point.ref}@${point.head}`]?.final === true;
    const wanted = [
        ...new Set(
            newest
                .filter((point) => point.ref !== null && !(point.head !== null && isFinal(point)))
                .map((point) => point.ref),
        ),
    ];
    const nodes = {};
    const errors = new Set();
    // `checkGhArgs` refuses a whole query with such a word: 1 such repository name must not stop the others.
    const refused = wanted.filter((ref) => READ_ONLY_REFUSED.test(ref));

    if (refused.length > 0) {
        errors.add("repository name refused by the read-only gh");
    }

    const refs = wanted
        .filter((ref) => !READ_ONLY_REFUSED.test(ref))
        .slice(0, 40 * BLOCKER_MAX_PR_QUERIES);

    for (let start = 0; start < refs.length; start += 40) {
        const chunk = refs.slice(start, start + 40);

        if (gh.state.capReached) {
            errors.add("GitHub call cap reached");
            break;
        }

        const parts = chunk.map((ref, index) => {
            const [, owner, name, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);

            return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { ${BLOCKER_PR_QUERY} } }`;
        });
        const result = ghAnswer(gh, `{ ${parts.join("\n")} }`, "PR query", errors);
        const badAliases = errorAliases(result.errors);

        // A PR that GitHub cannot find is null with an error on its alias, and `gh` fails: the other PRs still count.
        chunk.forEach((ref, index) => {
            const alias = `p${index}`;
            const node = result.data?.[alias]?.pullRequest;

            // A ref with no whole node is not in `nodes`: its keys stay pending.
            if (badAliases.all || badAliases.names.has(alias)) {
                return;
            }

            if (!node) {
                // No error names it: GitHub left it out. With no data at all, `ghAnswer` named that.
                if (result.data !== null) {
                    errors.add("PR query missed a PR");
                }
            } else if (isWholePr(node)) {
                nodes[ref] = node;
            } else {
                errors.add("PR query returned an incomplete PR");
            }
        });
    }

    const prs = {};

    for (const [ref, node] of Object.entries(nodes)) {
        prs[ref] = {
            state: node.state.toLowerCase(),
            mergedAt: node.mergedAt ?? null,
            closedAt: node.closedAt ?? null,
            head: node.headRefOid ?? null,
        };
    }

    const guards = {};
    const keys = [];
    const tooMany = { final: true, state: "merged", guarded: null, reason: "too many files" };

    for (const point of newest) {
        const key = `${point.ref}@${point.head}`;
        const node = nodes[point.ref];

        if (
            point.ref === null ||
            point.head === null ||
            isFinal(point) ||
            key in guards ||
            keys.some((item) => item.key === key)
        ) {
            continue;
        }

        // A PR not read this run (not asked, an error, not whole) or still open: its key stays pending.
        if (!node) {
            continue;
        }

        if (node.state === "CLOSED") {
            guards[key] = { final: true, state: "closed", guarded: null };
            continue;
        }

        if (node.state !== "MERGED" || typeof node.headRefOid !== "string") {
            continue;
        }

        const files = guardCandidates(node.files.nodes);
        // A record file whose path holds a refused word is dropped from the lookup, not counted, and listed.
        const skipped = files
            .filter((file) => file.record && READ_ONLY_REFUSED.test(file.path))
            .map((file) => file.path);
        const looked = files.filter((file) => !(file.record && READ_ONLY_REFUSED.test(file.path)));

        if (node.files.totalCount > BLOCKER_PR_FILES) {
            guards[key] = tooMany;
        } else if (point.head === node.headRefOid) {
            // No commit after the reviewed head: nothing to look up, and no new record file.
            guards[key] = guardOf(point.ref, { head: { oid: point.head }, files: [] });
        } else if (looked.length === 0) {
            // No file that can guard: nothing to look up.
            guards[key] = guardOf(point.ref, { head: { oid: point.head }, files: [], skipped });
        } else {
            // A record file must be compared with the old file at H: its text is needed to find moved records.
            if (
                looked.some((file) => file.record) &&
                !looked.some((file) => file.path === CORRECTIONS_FILE)
            ) {
                looked.push({
                    path: CORRECTIONS_FILE,
                    test: false,
                    agents: false,
                    corrections: false,
                    record: false,
                    reference: true,
                });
            }

            const item = {
                key,
                ref: point.ref,
                head: point.head,
                final: node.headRefOid,
                files: looked,
                skipped,
            };

            if (lookupCount(item) > BLOCKER_LOOKUPS) {
                guards[key] = tooMany;
            } else if (looked.some((file) => READ_ONLY_REFUSED.test(file.path))) {
                // `checkGhArgs` refuses a query with these words: such a path cannot be looked up.
                guards[key] = {
                    final: true,
                    state: "merged",
                    guarded: null,
                    reason: "path refused by the read-only gh",
                };
            } else {
                keys.push(item);
            }
        }
    }

    // Newest keys first, in order: a key that does not fit starts the next query.
    const batches = [];

    for (const key of keys) {
        const last = batches.at(-1);

        if (last && last.size + lookupCount(key) <= BLOCKER_LOOKUPS) {
            last.keys.push(key);
            last.size += lookupCount(key);
        } else {
            batches.push({ keys: [key], size: lookupCount(key) });
        }
    }

    batches.forEach((batch, index) => {
        if (index >= BLOCKER_MAX_QUERIES) {
            return;
        }

        if (gh.state.capReached) {
            errors.add("GitHub call cap reached");

            return;
        }

        const query = blobQuery(batch.keys);
        const found = guardsOfAnswer(
            batch.keys,
            query.aliases,
            ghAnswer(gh, query.text, "blob query", errors),
            errors,
        );

        for (const key of batch.keys) {
            if (found.has(key.key)) {
                guards[key.key] = found.get(key.key);
            }
        }
    });

    // Every distinct key with no final result yet, whatever deferred it: the PR slice, the cap, the query limit, a
    // failed or partial answer, an unread PR, or a PR that is still open.
    const pending = new Set(
        points
            .filter((point) => point.ref !== null && point.head !== null && !isFinal(point))
            .map((point) => `${point.ref}@${point.head}`)
            .filter((key) => !(key in guards)),
    ).size;

    return { prs, guards, calls: gh.state.calls - startCalls, pending, errors: [...errors] };
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
 * 1 flaky-scan file, parsed and checked: a file that is not valid JSON, has another `schema_version` than 1, or has no
 * `repos` list throws.
 */
function readScanFile(odradeDir, file) {
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

    return scan;
}

/** The flaky-scan folders under `reports`, oldest first, or `null` when there is no reports folder. */
function flakyFolders(reports) {
    try {
        return fs
            .readdirSync(reports)
            .filter((name) => FLAKY_FOLDER.test(name))
            .sort();
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }

        throw error;
    }
}

/**
 * The newest flaky-test scan (core spec `docs/specs/flaky-test-scan.md`): `reports/<date>…-flaky-scan/scan.json` under
 * Odrade's folder, the greatest folder name that holds a `scan.json`. `null` when there is none. A file that is not
 * valid JSON, has another `schema_version` than 1, or has no `repos` list throws. Returns
 * `{ file, generatedAt, window, repos: { [repo]: rerunAttempts } }`; a repository with an `error`, or whose
 * `rerunAttempts` is not a whole number of 0 or more, is `null`, never `0`. Never written.
 */
export function readFlakyScan(odradeDir) {
    const reports = path.join(odradeDir, "reports");
    const names = flakyFolders(reports);

    if (names === null) {
        return null;
    }

    const folder = [...names]
        .reverse()
        .find((name) => fs.existsSync(path.join(reports, name, "scan.json")));

    if (folder === undefined) {
        return null;
    }

    const file = `reports/${folder}/scan.json`;
    const scan = readScanFile(odradeDir, file);
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

/**
 * The flaky keys of every flaky-test scan from the UTC date of `sinceMs` on (Q1's 3-failure stops join them with the
 * failing jobs): `reports/<date>…-flaky-scan/scan.json` whose folder date is that date or later. Each file is checked
 * as `readFlakyScan` checks it, and a bad file throws. Each `repos[].flaky[]` entry with a string `key` gives
 * `{ key, repo, workflow, job, test, jobIds, file }`; `jobIds` are the safe-integer `events[].job_id`. The same key in
 * 2 scans is 1 entry, with the newest folder's fields and the job ids of both. `repos` are the lower-case repositories
 * that at least 1 scan read with no `error`: only for those does no key mean "not flaky"; for another repository it is
 * unknown. Returns `{ files, repos, keys }`, sorted, or `null` when there is no reports folder or no scan in the
 * window. Never written.
 */
export function readFlakyKeys(odradeDir, sinceMs) {
    const reports = path.join(odradeDir, "reports");
    const names = flakyFolders(reports);

    if (names === null) {
        return null;
    }

    const from = new Date(sinceMs).toISOString().slice(0, 10);
    const files = names
        .filter((name) => name.slice(0, 10) >= from)
        .filter((name) => fs.existsSync(path.join(reports, name, "scan.json")))
        .map((name) => `reports/${name}/scan.json`);

    if (files.length === 0) {
        return null;
    }

    const text = (value) => (typeof value === "string" ? value : null);
    const keys = new Map();
    const scanned = new Set();

    // Oldest first: a newer scan's fields replace an older one's, and the job ids add up.
    for (const file of files) {
        const scan = readScanFile(odradeDir, file);

        for (const repo of scan.repos) {
            if (
                typeof repo?.repo === "string" &&
                repo.repo !== "" &&
                (repo.error === null || repo.error === undefined)
            ) {
                scanned.add(repo.repo.toLowerCase());
            }

            for (const flaky of Array.isArray(repo?.flaky) ? repo.flaky : []) {
                if (typeof flaky?.key !== "string") {
                    continue;
                }

                const jobIds = new Set(keys.get(flaky.key)?.jobIds ?? []);

                for (const event of Array.isArray(flaky.events) ? flaky.events : []) {
                    if (Number.isSafeInteger(event?.job_id)) {
                        jobIds.add(event.job_id);
                    }
                }

                keys.set(flaky.key, {
                    key: flaky.key,
                    repo: text(repo.repo),
                    workflow: text(flaky.workflow),
                    job: text(flaky.job),
                    test: text(flaky.test),
                    jobIds: [...jobIds].sort((a, b) => a - b),
                    file,
                });
            }
        }
    }

    return {
        files,
        repos: [...scanned].sort(),
        keys: [...keys.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
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
 * Options: `pocketDir`, `odradeDir`, `homesDir`, `now`, `hours`, `useGithub`, `run` (a process runner, for tests),
 * `earlier` (the earlier days' JSON, as `loadEarlier` gives it: their final guard results need no GitHub call).
 */
export function loadData({
    pocketDir,
    odradeDir,
    homesDir = path.join(os.homedir(), "agents"),
    now,
    hours,
    useGithub,
    run = defaultRun,
    earlier = [],
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
        parentEdits: [],
        installed: installedTimes(pocketDir),
        odrade: undefined,
        homes: [],
        github: undefined,
        decided: undefined,
        reviewCalls: [],
        reviewAnswers: [],
        blockerGuards: undefined,
        blockerCache: guardCacheOf(earlier),
        goalStops: [],
        flakyScan: null,
        flakyKeys: null,
        planSessions: [],
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
            "parentEdits",
            "reviews",
            "reviewAnswers",
            "goalHistory",
            "planSessions",
        ]) {
            sourceErrors[name] = message;
        }
    }

    if (db) {
        attempt("desk", () => Object.assign(data, loadDesk(db)));
        // R1's and R2's own read, after the desk: every routed thread's session, with no time limit (see `checkR1`).
        const routedSessions = () =>
            new Set(
                Object.values(data.threads)
                    .filter((thread) => thread.route !== undefined && thread.session !== undefined)
                    .map((thread) => thread.session),
            );

        attempt("routes", () => {
            const sessions = routedSessions();

            data.routeCosts = loadRouteCosts(db, sessions);
            data.routeSpawns = loadRouteSpawns(db, sessions);
        });
        // R2's hand fixes, in an attempt of their own: a failure here leaves R1 and R2 running, with hand fixes unknown.
        attempt("parentEdits", () => (data.parentEdits = loadParentEdits(db, routedSessions())));
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
        // Q1's review rounds and 3-failure stops: spawn and send calls, answers of 30 days, and every goal revision.
        // Every earlier call, with no lower time limit: a spawn of any age sets the round and the PR of a send or an
        // answer in the window. Q1's per-thread rounds keep their own 30-day filter.
        attempt("reviews", () => (data.reviewCalls = loadReviewCalls(db, 0)));
        attempt(
            "reviewAnswers",
            () => (data.reviewAnswers = loadReviewAnswers(db, now - 30 * DAY)),
        );
        attempt("goalHistory", () => (data.goalStops = loadGoalStops(db)));

        // P1's planning sessions come from the desk's plan threads: without the desk, they are unknown, not none.
        if (sourceErrors.desk) {
            sourceErrors.planSessions = "needs the desk threads";
        } else {
            attempt("planSessions", () => {
                data.planSessions = loadPlanSessions(db, data.threads, since);
            });
        }

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

    // Q1's guards of blocking review points, after the search, with the same `gh` and its cap.
    if (!useGithub) {
        sourceErrors.blockerGuards = "disabled by --no-github";
    } else if (sourceErrors.desk) {
        sourceErrors.blockerGuards = "needs the desk threads";
    } else {
        attempt("blockerGuards", () => {
            data.blockerGuards = loadBlockerGuards(data, { gh, now, cache: data.blockerCache });
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
    // Q1's 3-failure stops: the flaky keys of the scans of the last 30 days, to join with the failing jobs.
    attempt("flakyKeys", () => {
        data.flakyKeys = readFlakyKeys(odradeDir, now - 30 * DAY);
    });

    return data;
}
