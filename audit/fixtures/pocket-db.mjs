// A small invented Pocket database with the tables the audit reads (same columns as Pocket's schema). The rows
// are made up: a desk with 3 threads, a reports document, an identity, a night shift goal, a schedule, entries.
import { DatabaseSync } from "node:sqlite";
import { HOUR, MINUTE } from "../common.mjs";

const SCHEMA = [
    `CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        head INTEGER,
        commit_seq INTEGER NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record))
    ) STRICT`,
    `CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
        abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
        background INTEGER NOT NULL CHECK (background IN (0, 1)),
        record TEXT NOT NULL CHECK (json_valid(record))
    ) STRICT`,
    `CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        family INTEGER NOT NULL CHECK (family IN (0, 1)),
        key_value TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
        owner_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        retired_at INTEGER,
        record TEXT NOT NULL CHECK (json_valid(record))
    ) STRICT`,
    `CREATE TABLE document_revisions (
        document_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
        version INTEGER NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content)),
        PRIMARY KEY (document_id, seq)
    ) STRICT`,
];

/** The ids of the invented conversations. */
export const SUPERVISOR = 10;
export const SESSION_T1 = 11;
export const SESSION_T2 = 12;

/**
 * Create the fixture database in `file`. Times are relative to `now`. Returns the times that tests check.
 */
export function createFixtureDb(file, now) {
    const db = new DatabaseSync(file);
    let seq = 1;

    SCHEMA.forEach((sql) => db.exec(sql));

    const document = (id, kind, ownerId, scope = "session") =>
        db
            .prepare(
                "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) values (?,?,?,?,?,?,?,?)",
            )
            .run(id, JSON.stringify(kind), 0, "", scope, ownerId, 1, "{}");
    const revision = (id, kind, value) =>
        db
            .prepare(
                "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
            )
            .run(id, (seq += 1), kind, 1, JSON.stringify(value));
    const event = (at, key, text) => ({ at, key, text });
    const e = {
        opened: event(now - 30 * HOUR, "opened", "opened by delegation"),
        closed1: event(now - 20 * HOUR, "closed:1", "closed: all parts closed"),
        reopen1: event(now - 5 * HOUR, "reopened:1", "reopened: its session is busy"),
        closed2: event(now - 4 * HOUR, "closed:2", "closed: all parts closed"),
        reopen2: event(now - 2 * HOUR, "reopened:2", "reopened: new work in its session"),
    };

    // The desk: T1 and T2 are in the base; T3 comes in whole by a delta; T1's events are trimmed by a delta.
    document(1, "x.desk.threads", 0);
    revision(1, "base", {
        next: { T: 4, F: 1 },
        threads: {
            T1: {
                id: "T1",
                state: "open",
                supervisor: SUPERVISOR,
                session: SESSION_T1,
                startedAt: now - 30 * HOUR,
                lastEventAt: e.closed1.at,
                prs: {},
                asks: [],
                run: { returnAddress: "session-aaa" },
                events: [e.opened, e.closed1],
            },
            T2: {
                id: "T2",
                state: "open",
                supervisor: SUPERVISOR,
                session: SESSION_T2,
                startedAt: now - 10 * HOUR,
                lastEventAt: now - HOUR,
                prs: {},
                asks: [],
                run: {},
                events: [event(now - 10 * HOUR, "opened", "opened by delegation")],
            },
        },
        grants: [],
        seen: {},
    });
    revision(1, "delta", [
        ["p", ["threads", "T1", "events"], 2, 0, [e.reopen1, e.closed2]],
        ["s", ["threads", "T1", "lastEventAt"], e.closed2.at],
    ]);
    revision(1, "delta", [
        [
            "s",
            ["threads", "T3"],
            {
                id: "T3",
                state: "open",
                supervisor: SUPERVISOR,
                startedAt: now - 3 * HOUR,
                lastEventAt: now - 3 * HOUR,
                prs: {},
                asks: [],
                run: {},
                events: [event(now - 3 * HOUR, "found", "found: a PR with no thread")],
            },
        ],
    ]);
    // The document keeps the last 3 events of T1; the first 2 are only in the earlier deltas.
    revision(1, "delta", [
        ["p", ["threads", "T1", "events"], 3, 0, [e.reopen2]],
        ["p", ["threads", "T1", "events"], 0, 2, []],
    ]);

    // The reports of T1's session: 1 in the base, 1 added by a delta that the document then drops.
    document(2, "x.desk.reports", SESSION_T1);
    revision(2, "base", {
        reports: [
            { key: "r1", at: now - 6 * HOUR, from: "team_message", text: "First report text" },
        ],
    });
    revision(2, "delta", [
        [
            "p",
            ["reports"],
            0,
            0,
            [{ key: "r2", at: now - 5 * HOUR, from: "night-shift", text: "Second" }],
        ],
    ]);

    document(3, "x.team.identity", SUPERVISOR);
    revision(3, "base", { persona: { id: "odrade" } });

    document(4, "x.night-shift.goal", SESSION_T1, "conversation");
    revision(4, "base", {
        goal: {
            id: "g1",
            status: "ended",
            reason: "blocked",
            why: "needs a person",
            setAt: now - 8 * HOUR,
            endedAt: now - 7 * HOUR,
            maxRounds: 5,
            round: 1,
            worker: "deepseek/deepseek-flash",
            rounds: [{ n: 1, verdict: "blocked", reason: "", at: now - 7 * HOUR }],
        },
    });

    // A one-shot schedule that was due 3 h before it ran, then deleted; a recurring one that stays.
    const due = now - 6 * HOUR;

    document(5, "pocket.schedules", SESSION_T1, "conversation");
    revision(5, "base", {
        items: {
            abc: { id: "abc", text: "check", next: due, runs: 0, taskId: 70 },
            rec: { id: "rec", text: "daily", every: "day", next: now + HOUR, runs: 0, taskId: 71 },
        },
    });
    revision(5, "delta", [["d", ["items", "abc"]]]);

    const task = (id, state, extra = {}) =>
        db
            .prepare(
                "insert into tasks (id, conversation_id, kind, status, abort_requested, background, record) values (?,?,?,?,?,?,?)",
            )
            .run(
                id,
                SESSION_T1,
                JSON.stringify("pocket.schedule"),
                state.status === "terminal" ? "terminal" : "running",
                0,
                1,
                JSON.stringify({
                    id,
                    conversationId: SESSION_T1,
                    kind: "pocket.schedule",
                    input: { scheduleId: extra.scheduleId },
                    state,
                    startedAt: now - 24 * HOUR,
                    ...(extra.endedAt ? { endedAt: extra.endedAt } : {}),
                }),
            );

    task(
        70,
        { status: "terminal", outcome: { status: "completed", result: null } },
        { scheduleId: "abc", endedAt: due + 3 * HOUR },
    );
    task(71, { status: "running", checkpoint: { phase: "wait" } }, { scheduleId: "rec" });

    // Entries: a user message, assistant rows with cost, a subagent spawn call, and tool results.
    let entryId = 0;
    const entry = (conversation, record) =>
        db
            .prepare(
                "insert into entries (id, conversation_id, head, commit_seq, record) values (?,?,?,?,?)",
            )
            .run((entryId += 1), conversation, null, entryId, JSON.stringify(record));
    const user = (conversation, at, content) =>
        entry(conversation, { kind: "pi.user", model: [{ role: "user", content, timestamp: at }] });
    const assistant = (conversation, at, cost, content = [{ type: "text", text: "ok" }]) =>
        entry(conversation, {
            kind: "pi.assistant",
            model: [
                {
                    role: "assistant",
                    content,
                    usage: { input: 1, output: 1, cost: { total: cost } },
                    timestamp: at,
                },
            ],
        });
    const toolResult = (conversation, at, toolName, text, isError) =>
        entry(conversation, {
            kind: "pi.tool-result",
            model: [
                {
                    role: "toolResult",
                    toolName,
                    isError,
                    content: [{ type: "text", text }],
                    timestamp: at,
                },
            ],
        });

    user(
        SESSION_T1,
        now - 5 * HOUR - MINUTE,
        "[via linked session session-aaa]\n<linked-session-message>\nNew task: do it",
    );
    assistant(SESSION_T1, now - 5 * HOUR + MINUTE, 1.25);
    assistant(SESSION_T1, now - 2 * HOUR, 0.75);
    assistant(SUPERVISOR, now - HOUR, 2, [
        {
            type: "toolCall",
            id: "c1",
            name: "subagent",
            arguments: {
                action: "spawn",
                name: "w",
                model: "other/model",
                tools: ["read", "bash"],
                message: "do",
            },
        },
        {
            type: "toolCall",
            id: "c2",
            name: "subagent",
            arguments: {
                action: "spawn",
                name: "audit",
                model: "other/model",
                tools: ["read", "bash"],
                message: `${"x".repeat(320)} This is a cross-review.`,
            },
        },
    ]);
    assistant(SUPERVISOR, now - 40 * 24 * HOUR, 99);
    toolResult(
        SESSION_T1,
        now - 3 * HOUR,
        "team_message",
        "<harness>\n[error] No linked session has that address here.\n</harness>",
        true,
    );
    toolResult(
        SESSION_T2,
        now - 3 * HOUR,
        "team_delegate",
        "The desk is full: 12 of 12 threads count.",
        true,
    );
    toolResult(SESSION_T2, now - 3 * HOUR, "bash", "[error] the desk is nothing", true);
    toolResult(SESSION_T2, now - 3 * HOUR, "desk", "fine", false);

    db.close();

    return { ...e, due, ranAt: due + 3 * HOUR };
}
