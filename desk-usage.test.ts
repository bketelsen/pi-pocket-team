// The dashboard's usage source: the links and attribution, the entry rules, the pages and their limits, the ledger
// checks, restart and replay safety, with a fake store, with Pi Durable's own MemoryStorage (forks, imports, children),
// and in Pocket's test harness with the faux model. Nothing reads Brian's data, and nothing goes to the network.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    createSession,
    MemoryStorage,
    UsageDoc,
    type ConversationId,
    type ConversationRecord,
    type EntryId,
    type EntryRecord,
    type Session,
    type TaskId,
    type UsageState as LedgerState,
} from "@earendil-works/pi-durable";
import {
    applyEntryPage,
    assignOf,
    CHILD_PAGE,
    CHILD_REFRESH_MS,
    DeskUsage,
    ENTRY_PAGE,
    ENTRY_REFRESH_MS,
    ledgerOf,
    MAX_LEDGER_CHECKS,
    MAX_SESSION_PAGES,
    ownTotals,
    planChecks,
    relink,
    usageLinks,
    usagePass,
    USAGE_ERROR_RETRY_MS,
    USAGE_HEARTBEAT_MS,
    type SessionUsage,
    type Totals,
    type UsageDeps,
    type UsageState,
    type UsageTx,
} from "./_desk-usage.ts";
import {
    BOUNDARY_DAYS,
    collectPass,
    PASS_MS,
    threadFacts,
    type DashboardState,
} from "./_desk-dashboard.ts";
import type { DeskState, Thread } from "./desk.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 2026-10-30T00:00:00Z. */
const T0 = Date.UTC(2026, 9, 30);
const BOUNDARY = T0 - BOUNDARY_DAYS * DAY;
const copy = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id,
    key: `x.test:${id}`,
    origin: "delegate",
    title: `thread ${id}`,
    agents: ["duncan"],
    repo: "frostyard/test",
    state: "open",
    startedAt: T0 - DAY,
    lastEventAt: T0 - DAY,
    prs: {},
    branches: [],
    asks: [],
    run: {},
    events: [],
    ...overrides,
});

const deskOf = (threads: Thread[], extra: Partial<DeskState> = {}): DeskState =>
    ({
        next: { T: 1, F: 1 },
        threads: Object.fromEntries(threads.map((each) => [each.id, each])),
        grants: [],
        seen: {},
        plans: {},
        ...extra,
    }) as unknown as DeskState;

/** What 1 fake entry reports. `cost: null` leaves the cost out; `at: null` leaves the time out. */
type Use = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    reasoning?: unknown;
    cacheWrite1h?: unknown;
    cost?: unknown;
    provider?: unknown;
    model?: unknown;
    at?: number | null;
    /** false: an imported copy, with no task. */
    byTask?: boolean;
    kind?: string;
    role?: string;
    /** false: the ledger does not get it. */
    ledger?: boolean;
};

/** A fake store: conversations, entries in id order, and `pi.usage` ledgers. */
type World = {
    conversations: Map<number, ConversationRecord>;
    entries: EntryRecord[];
    ledgers: Map<number, LedgerState>;
    next: number;
    /** Every `scanEntries` and `scanConversations` call, by conversation id. */
    scans: number[];
    childScans: number[];
    /** A scan of these throws. */
    failing: Set<number>;
    /** A ledger read of these throws. */
    ledgerFails: Set<number>;
    /** Runs at each scan: a test aborts or changes the world here. */
    onScan?: (id: number) => void;
};

const world = (): World => ({
    conversations: new Map(),
    entries: [],
    ledgers: new Map(),
    next: 1000,
    scans: [],
    childScans: [],
    failing: new Set(),
    ledgerFails: new Set(),
});

function conversation(w: World, id: number, extra: Partial<ConversationRecord> = {}): void {
    w.conversations.set(id, { id: id as ConversationId, ...extra });
}

/** Add `usage` to a ledger as generation does. */
function addToLedger(w: World, id: number, key: string, usage: Record<string, unknown>): void {
    const ledger = w.ledgers.get(id) ?? { models: {}, tools: {} };
    const old = ledger.models[key] as Record<string, unknown> | undefined;
    const num = (value: unknown) => (typeof value === "number" ? value : 0);
    const cost = (usage.cost as { total?: number } | undefined)?.total ?? 0;

    ledger.models[key] = {
        input: num(old?.input) + num(usage.input),
        output: num(old?.output) + num(usage.output),
        cacheRead: num(old?.cacheRead) + num(usage.cacheRead),
        cacheWrite: num(old?.cacheWrite) + num(usage.cacheWrite),
        totalTokens: num(old?.totalTokens) + num(usage.totalTokens),
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: num((old?.cost as { total?: number } | undefined)?.total) + cost,
        },
    } as never;
    w.ledgers.set(id, ledger);
}

/** 1 assistant entry, written as generation writes it (with a task, and in the ledger), unless `use` says otherwise. */
function add(w: World, id: number, use: Use = {}): EntryRecord {
    w.next += 1;

    const usage: Record<string, unknown> = {
        input: use.input ?? 10,
        output: use.output ?? 5,
        cacheRead: use.cacheRead ?? 0,
        cacheWrite: use.cacheWrite ?? 0,
        totalTokens: use.totalTokens ?? 15,
    };

    if (use.reasoning !== undefined) {
        usage.reasoning = use.reasoning;
    }

    if (use.cacheWrite1h !== undefined) {
        usage.cacheWrite1h = use.cacheWrite1h;
    }

    if (use.cost !== null) {
        usage.cost =
            use.cost !== undefined && typeof use.cost === "object"
                ? use.cost
                : {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: use.cost === undefined ? 0.01 : use.cost,
                  };
    }

    const message: Record<string, unknown> = {
        role: use.role ?? "assistant",
        content: [],
        api: "fake",
        provider: use.provider ?? "anthropic",
        model: use.model ?? "claude",
        usage,
        stopReason: "stop",
    };

    if (use.at !== null) {
        message.timestamp = use.at ?? T0 - HOUR;
    }

    const entry = {
        id: w.next as EntryId,
        conversationId: id as ConversationId,
        kind: use.kind ?? "pi.assistant",
        model: [message],
        ...(use.byTask === false ? {} : { byTaskId: 7 as TaskId }),
    } as unknown as EntryRecord;

    w.entries.push(entry);

    if (
        use.ledger !== false &&
        use.byTask !== false &&
        (use.kind ?? "pi.assistant") === "pi.assistant"
    ) {
        addToLedger(
            w,
            id,
            `${String(use.provider ?? "anthropic")}/${String(use.model ?? "claude")}`,
            usage,
        );
    }

    return entry;
}

/** A user entry: read, never counted. */
function user(w: World, id: number): void {
    w.next += 1;
    w.entries.push({
        id: w.next as EntryId,
        conversationId: id as ConversationId,
        kind: "pi.user",
        model: [{ role: "user", content: "hi", timestamp: T0 }],
    } as unknown as EntryRecord);
}

/** The fork-aware history of a conversation, as Pi Durable's storage gives it. */
function visible(w: World, id: number, upper = Infinity): EntryRecord[] {
    const record = w.conversations.get(id);

    if (record === undefined) {
        throw new Error(`Unknown conversation: ${String(id)}`);
    }

    const own = w.entries.filter((entry) => entry.conversationId === id && entry.id <= upper);
    const inherited =
        record.parent === undefined
            ? []
            : visible(w, record.parent.conversationId, Math.min(upper, record.parent.at));

    return [...inherited, ...own].sort((a, b) => a.id - b.id);
}

function fakeTx(w: World): UsageTx {
    return {
        conversation: async (id: ConversationId) => copy(w.conversations.get(id)),
        scanEntries: async (
            query: { conversationId: ConversationId; minEntryId?: EntryId },
            limit: number,
        ) => {
            w.scans.push(query.conversationId);
            w.onScan?.(query.conversationId);

            if (w.failing.has(query.conversationId)) {
                throw new Error("the storage read failed");
            }

            const list = visible(w, query.conversationId).filter(
                (entry) => entry.id >= (query.minEntryId ?? 0),
            );
            const items = list.slice(0, limit);

            return list.length > limit
                ? { items: copy(items), next: { after: items[items.length - 1]?.id ?? 0 } }
                : { items: copy(items) };
        },
        scanConversations: async (
            query: { ownerConversationId?: ConversationId },
            limit: number,
            cursor?: { after?: number },
        ) => {
            w.childScans.push(query.ownerConversationId ?? 0);

            const list = [...w.conversations.values()]
                .filter(
                    (each) =>
                        each.owner?.conversationId === query.ownerConversationId &&
                        each.id > (cursor?.after ?? 0),
                )
                .sort((a, b) => a.id - b.id);
            const items = list.slice(0, limit);

            return list.length > limit
                ? { items: copy(items), next: { after: items[items.length - 1]?.id ?? 0 } }
                : { items: copy(items) };
        },
    } as unknown as UsageTx;
}

/** The usage document and its commit log. */
type Store = { doc: UsageState; commits: number; writes: number; owned: boolean };

const store = (): Store => ({
    doc: { sessions: {}, sources: {} },
    commits: 0,
    writes: 0,
    owned: true,
});

/** Usage deps over the fake world: a commit runs on a copy, and lands only when it does not throw. */
function fakeDeps(w: World, s: Store, signal?: AbortSignal): UsageDeps {
    return {
        readUsage: async () => copy(s.doc),
        readLedger: async (id) => {
            if (w.ledgerFails.has(id)) {
                throw new Error("the ledger read failed");
            }

            const ledger = w.ledgers.get(id);

            return ledger === undefined ? undefined : copy(ledger);
        },
        commit: async (change) => {
            if (!s.owned) {
                return false;
            }

            s.commits += 1;

            const draft = copy(s.doc);

            await change(fakeTx(w), draft);

            if (JSON.stringify(draft) !== JSON.stringify(s.doc)) {
                s.writes += 1;
            }

            s.doc = draft;

            return true;
        },
        ...(signal === undefined ? {} : { signal }),
    };
}

/** 1 usage pass over the fake world. */
function pass(w: World, s: Store, desk: DeskState, now = T0, signal?: AbortSignal) {
    return usagePass(fakeDeps(w, s, signal), {
        desk,
        facts: threadFacts(desk),
        boundary: BOUNDARY,
        now,
        slot: Math.floor(now / PASS_MS),
    });
}

/** Passes until the source is complete, at most `limit`. */
async function settle(w: World, s: Store, desk: DeskState, now = T0, limit = 20): Promise<number> {
    for (let index = 1; index <= limit; index++) {
        await pass(w, s, desk, now);

        if (s.doc.sources.usage?.complete === true && settledAll(s.doc)) {
            return index;
        }
    }

    throw new Error("the usage source did not complete");
}

const settledAll = (doc: UsageState): boolean =>
    Object.values(doc.sessions).every(
        (session) =>
            session.shared === true ||
            session.unlinkedAt !== undefined ||
            session.missingAt !== undefined ||
            (session.residual !== undefined && session.residual.state !== "pending"),
    );

const session = (s: Store, id: number): SessionUsage => {
    const found = s.doc.sessions[String(id)];

    assert(found !== undefined, `session ${String(id)}`);

    return found;
};

/** The sum of all entries a session counted. */
const totals = (s: Store, id: number): Totals => ownTotals(session(s, id));

/** The sum by repository of every active session's own totals: what the dashboard charges. */
function byRepo(doc: UsageState): Record<string, number> {
    const sums: Record<string, number> = {};

    for (const each of Object.values(doc.sessions)) {
        if (each.shared === true || each.unlinkedAt !== undefined) {
            continue;
        }

        const repo =
            each.assign === undefined
                ? "?"
                : "repo" in each.assign
                  ? each.assign.repo
                  : `(${each.assign.none})`;

        sums[repo] = (sums[repo] ?? 0) + ownTotals(each).totalTokens;
    }

    return sums;
}

/** The cost by repository of every active session's own totals. */
function costByRepo(doc: UsageState): Record<string, number> {
    const sums: Record<string, number> = {};

    for (const each of Object.values(doc.sessions)) {
        if (each.shared === true || each.unlinkedAt !== undefined || each.assign === undefined) {
            continue;
        }

        const repo = "repo" in each.assign ? each.assign.repo : `(${each.assign.none})`;

        sums[repo] = (sums[repo] ?? 0) + ownTotals(each).cost;
    }

    return sums;
}

// ─── Links and attribution ───────────────────────────────────────────────────

describe("links and attribution", () => {
    test("thread sessions, consult sessions, and the shared sessions", () => {
        const desk = deskOf(
            [
                thread("T1", { session: 11, supervisor: 1 }),
                thread("T2", {
                    session: 12,
                    supervisor: 1,
                    state: "closed",
                    closed: { at: T0, why: "done", by: "sweep" },
                }),
                thread("T3", { session: 13, repo: "not a repo" }),
                thread("T10", { origin: "plan", session: 20, repo: "a/plan" }),
                thread("T11", {
                    session: 21,
                    repo: "a/task",
                    planTask: { plan: "T10", task: "t1" } as Thread["planTask"],
                }),
            ],
            {
                plans: {
                    T10: { thread: "T10", consults: [{ id: "k1", session: 22 }, { id: "k2" }] },
                } as never,
                clerks: { "1": { session: 2, address: "x", agent: "clerk", at: T0 } },
                sweepers: { "3": "99" },
            },
        );
        const links = usageLinks(desk, threadFacts(desk));

        assert.deepEqual(links.sessions, {
            "11": [{ id: "T1", repo: "frostyard/test" }],
            "12": [{ id: "T2", repo: "frostyard/test" }],
            "13": [{ id: "T3" }],
            "20": [{ id: "T10", repo: "a/plan" }],
            "21": [{ id: "T11", repo: "a/task" }],
            "22": [{ id: "T10:k1", repo: "a/plan" }],
        });
        assert.deepEqual(links.shared, [1, 2, 3]);
    });

    test("1 session in 2 threads of 1 repo; conflicting repos; no repo", async () => {
        const w = world();
        const s = store();

        for (const id of [11, 12, 13]) {
            conversation(w, id);
            add(w, id);
        }

        const desk = deskOf([
            thread("T1", { session: 11 }),
            thread("T2", { session: 11 }),
            thread("T3", { session: 12, repo: "a/one" }),
            thread("T4", { session: 12, repo: "a/two" }),
            thread("T5", { session: 13, repo: undefined }),
        ]);

        await settle(w, s, desk);
        assert.deepEqual(session(s, 11).assign, { repo: "frostyard/test", via: 11 });
        assert.deepEqual(session(s, 11).links, ["T1", "T2"]);
        assert.deepEqual(session(s, 12).assign, {
            none: "conflict",
            repos: ["a/one", "a/two"],
            via: 12,
        });
        assert.deepEqual(session(s, 13).assign, { none: "no-repo", via: 13 });
        assert.equal(totals(s, 11).totalTokens, 15, "1 session in 2 threads counts once");
    });

    test("assignOf: case variants of 1 repo agree, with 1 stable name; different repos still conflict", () => {
        const variants = [
            { id: "T1", repo: "frostyard/Test" },
            { id: "T2", repo: "Frostyard/test" },
            { id: "T3", repo: "frostyard/test" },
            { id: "T4" },
        ];

        // The name does not depend on the order of the links.
        for (const order of [
            variants,
            [...variants].reverse(),
            [variants[2], variants[0], variants[1]],
        ]) {
            assert.deepEqual(assignOf(order as never, 7), { repo: "Frostyard/test", via: 7 });
        }

        assert.deepEqual(
            assignOf(
                [
                    { id: "T1", repo: "a/One" },
                    { id: "T2", repo: "A/one" },
                    { id: "T3", repo: "a/two" },
                    { id: "T4", repo: "a/one" },
                ],
                7,
            ),
            { none: "conflict", repos: ["A/one", "a/two"], via: 7 },
            "2 real repos conflict, and each is named once",
        );
        assert.deepEqual(
            assignOf(
                [
                    { id: "T1", repo: "a/one" },
                    { id: "T2", repo: "b/one" },
                ],
                7,
            ),
            { none: "conflict", repos: ["a/one", "b/one"], via: 7 },
            "the same name under 2 owners is 2 repos",
        );
        assert.deepEqual(assignOf([{ id: "T1" }], 7), { none: "no-repo", via: 7 });
    });

    test("a session in 2 threads of 1 repo with 2 cases is attributed, its child too, and a stored false conflict heals", async () => {
        const w = world();
        const s = store();

        conversation(w, 11);
        conversation(w, 12, {
            owner: { conversationId: 11 as ConversationId, taskId: 1 as TaskId },
        });
        conversation(w, 13);
        add(w, 11, { totalTokens: 10 });
        add(w, 12, { totalTokens: 4 });
        add(w, 13, { totalTokens: 2 });

        const desk = deskOf([
            thread("T1", { session: 11, repo: "Frostyard/Test" }),
            thread("T2", { session: 11, repo: "frostyard/test" }),
            thread("T3", { session: 13, repo: "frostyard/test" }),
            thread("T4", { session: 13, repo: "frostyard/other" }),
        ]);

        await settle(w, s, desk);
        assert.deepEqual(session(s, 11).assign, { repo: "Frostyard/Test", via: 11 });
        assert.deepEqual(
            session(s, 12).assign,
            { repo: "Frostyard/Test", via: 11 },
            "the child inherits",
        );
        assert.deepEqual(session(s, 13).assign, {
            none: "conflict",
            repos: ["frostyard/other", "frostyard/test"],
            via: 13,
        });

        // A state that an older version stored: the case variants as a conflict. The next pass corrects it.
        session(s, 11).assign = {
            none: "conflict",
            repos: ["Frostyard/Test", "frostyard/test"],
            via: 11,
        };
        session(s, 12).assign = {
            none: "conflict",
            repos: ["Frostyard/Test", "frostyard/test"],
            via: 11,
        };
        await pass(w, s, desk, T0);
        assert.deepEqual(session(s, 11).assign, { repo: "Frostyard/Test", via: 11 });
        assert.deepEqual(session(s, 12).assign, { repo: "Frostyard/Test", via: 11 });
        assert.equal(totals(s, 11).totalTokens, 10, "the correction does not count again");
        assert.equal(totals(s, 12).totalTokens, 4);
    });

    test("a coordinator's cost goes to the plan's repo, a task's to its own: no double count", async () => {
        const w = world();
        const s = store();

        conversation(w, 20);
        // A task session the planning session started: it has its own link.
        conversation(w, 21, {
            owner: { conversationId: 20 as ConversationId, taskId: 1 as TaskId },
        });
        conversation(w, 22);
        add(w, 20, { totalTokens: 100, cost: 1.5 });
        add(w, 21, { totalTokens: 40, cost: 0.25 });
        add(w, 22, { totalTokens: 7, cost: 0.125 });

        const desk = deskOf(
            [
                thread("T10", { origin: "plan", session: 20, repo: "a/plan" }),
                thread("T11", {
                    session: 21,
                    repo: "a/task",
                    planTask: { plan: "T10", task: "t1" } as Thread["planTask"],
                }),
            ],
            { plans: { T10: { thread: "T10", consults: [{ id: "k1", session: 22 }] } } as never },
        );

        await settle(w, s, desk);
        assert.equal(threadFacts(desk).T10?.role, "coordinator");
        assert.deepEqual(byRepo(s.doc), { "a/plan": 107, "a/task": 40 });
        // The coordinator and its consult go to the plan's repo; the task to its own; each cost once.
        assert.deepEqual(costByRepo(s.doc), { "a/plan": 1.625, "a/task": 0.25 });
        assert.deepEqual(
            session(s, 21).assign,
            { repo: "a/task", via: 21 },
            "its own link decides",
        );
        assert.equal(session(s, 21).parent, 20, "the ownership edge is kept");
    });

    test("supervisor and Clerk sessions are never read or charged, also when a thread links them", async () => {
        const w = world();
        const s = store();

        for (const id of [1, 2, 11, 30]) {
            conversation(w, id);
            add(w, id);
        }

        // A child of the supervisor: not followed.
        conversation(w, 31, {
            owner: { conversationId: 1 as ConversationId, taskId: 1 as TaskId },
        });
        add(w, 31);

        const desk = deskOf(
            [thread("T1", { session: 11, supervisor: 1 }), thread("T2", { session: 1 })],
            {
                clerks: { "1": { session: 2, address: "x", agent: "clerk", at: T0 } },
            },
        );

        await settle(w, s, desk);
        assert.deepEqual([...new Set(w.scans)].sort(), [11]);
        assert.deepEqual([...new Set(w.childScans)].sort(), [11]);
        assert.equal(session(s, 1).shared, true);
        assert.equal(session(s, 1).scannedAt, undefined);
        assert.equal(s.doc.sessions["2"], undefined, "an unlinked Clerk gets no record");
        assert.equal(s.doc.sessions["31"], undefined);
        assert.deepEqual(byRepo(s.doc), { "frostyard/test": 15 });
    });

    test("nested children inherit the nearest linked ancestor; a cycle-shaped graph ends", async () => {
        const w = world();
        const s = store();
        const owned = (by: number) => ({
            owner: { conversationId: by as ConversationId, taskId: 1 as TaskId },
        });

        conversation(w, 1, owned(3));
        conversation(w, 2, owned(1));
        conversation(w, 3, owned(2));
        conversation(w, 4, owned(2));
        // A child with its own link keeps it.
        conversation(w, 5, owned(4));

        for (const id of [1, 2, 3, 4, 5]) {
            add(w, id, { totalTokens: id });
        }

        const desk = deskOf([
            thread("T1", { session: 1, repo: "a/root" }),
            thread("T5", { session: 5, repo: "a/own" }),
        ]);

        await settle(w, s, desk);
        assert.equal(session(s, 2).parent, 1);
        assert.equal(session(s, 3).parent, 2);
        assert.equal(session(s, 4).parent, 2);
        assert.equal(session(s, 4).root, 1);
        assert.equal(
            session(s, 1).parent,
            undefined,
            "a session in the tree keeps its first parent",
        );
        assert.equal(session(s, 5).parent, 4, "a linked child keeps its edge");
        assert.deepEqual(session(s, 3).assign, { repo: "a/root", via: 1 });
        assert.deepEqual(session(s, 5).assign, { repo: "a/own", via: 5 });
        assert.deepEqual(byRepo(s.doc), { "a/root": 10, "a/own": 5 });
    });

    test("a stored parent cycle ends: unlinked with no linked session, and inherited with 1", () => {
        const cycle = (): UsageState => ({
            sessions: {
                "1": { id: 1, parent: 2 },
                "2": { id: 2, parent: 1 },
                "3": { id: 3, parent: 2 },
            },
            sources: {},
        });
        const none = cycle();

        relink(none, { sessions: {}, shared: [] }, T0);

        for (const id of ["1", "2", "3"]) {
            assert.equal(none.sessions[id]?.unlinkedAt, T0);
            assert.equal(none.sessions[id]?.assign, undefined);
        }

        const one = cycle();

        relink(one, { sessions: { "1": [{ id: "T1", repo: "a/b" }] }, shared: [] }, T0);
        assert.deepEqual(one.sessions["1"]?.assign, { repo: "a/b", via: 1 });
        assert.deepEqual(one.sessions["2"]?.assign, { repo: "a/b", via: 1 });
        assert.deepEqual(one.sessions["3"]?.assign, { repo: "a/b", via: 1 });
        assert.equal(one.sessions["3"]?.unlinkedAt, undefined);
    });

    test("a linked child keeps its ownership edge, and inherits its parent when its own link goes", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        conversation(w, 2, { owner: { conversationId: 1 as ConversationId, taskId: 1 as TaskId } });
        add(w, 1);
        add(w, 2);

        await settle(
            w,
            s,
            deskOf([
                thread("T1", { session: 1, repo: "a/one" }),
                thread("T2", { session: 2, repo: "a/two" }),
            ]),
        );
        assert.equal(session(s, 2).parent, 1);
        assert.equal(session(s, 2).root, 1);
        assert.equal(session(s, 1).parent, undefined);
        assert.deepEqual(session(s, 2).assign, { repo: "a/two", via: 2 }, "its own link decides");

        await pass(w, s, deskOf([thread("T1", { session: 1, repo: "a/one" })]), T0 + PASS_MS);
        assert.equal(session(s, 2).unlinkedAt, undefined);
        assert.equal(session(s, 2).links, undefined);
        assert.deepEqual(session(s, 2).assign, { repo: "a/one", via: 1 });
        assert.deepEqual(byRepo(s.doc), { "a/one": 30 });
    });
});

// ─── Entry rules ─────────────────────────────────────────────────────────────

describe("entry rules", () => {
    test("malformed entries, subsets larger than their totals, zero and missing costs", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1, { input: -1, ledger: false });
        add(w, 1, { totalTokens: Number.NaN, ledger: false });
        add(w, 1, { provider: "", ledger: false });
        add(w, 1, { provider: "bad\u0000name", ledger: false });
        add(w, 1, { role: "user", ledger: false });
        add(w, 1, { provider: "__proto__", model: "x" });
        add(w, 1, { output: 10, reasoning: 4, cacheWrite: 6, cacheWrite1h: 6, cost: 0 });
        add(w, 1, { output: 10, reasoning: 11, cacheWrite: 6, cacheWrite1h: 7, cost: null });
        add(w, 1, { cost: { total: "x" } });
        add(w, 1, { cost: -1 });
        user(w, 1);

        await pass(w, s, deskOf([thread("T1", { session: 1 })]));

        const one = session(s, 1);
        const day = one.days?.[new Date(T0 - HOUR).toISOString().slice(0, 10)];

        assert.deepEqual(one.skipped, { malformed: 5, reasoning: 1, cacheWrite1h: 1 });
        assert.deepEqual(day?.["anthropic/claude"], {
            entries: 4,
            input: 40,
            output: 30,
            cacheRead: 0,
            cacheWrite: 12,
            totalTokens: 60,
            reasoning: 4,
            reasoningEntries: 1,
            cacheWrite1h: 6,
            cacheWrite1hEntries: 1,
            cost: 0,
            costEntries: 1,
            zeroCostEntries: 1,
        });
        assert.equal(
            day?.["__proto__/x"]?.entries,
            1,
            "a key with __proto__ in it is still its own key",
        );
        assert.equal(one.residual?.state, "mismatch");
        assert.equal(one.residual?.why, "5 malformed entries");
    });

    test("the boundary, UTC days, future and invalid times; an old session with recent usage", async () => {
        const w = world();
        const s = store();
        const midnight = Date.UTC(2026, 9, 29);

        conversation(w, 1);
        add(w, 1, { at: BOUNDARY - 1, totalTokens: 1 });
        add(w, 1, { at: BOUNDARY, totalTokens: 2 });
        add(w, 1, { at: midnight - 1, totalTokens: 4 });
        add(w, 1, { at: midnight, totalTokens: 8 });
        add(w, 1, { at: T0 + 2 * DAY, totalTokens: 16 });
        add(w, 1, { at: null, totalTokens: 32 });

        await settle(w, s, deskOf([thread("T1", { session: 1 })]));

        const one = session(s, 1);
        const key = "anthropic/claude";

        assert.equal(one.before?.totalTokens, 1);
        assert.equal(
            one.days?.[new Date(BOUNDARY).toISOString().slice(0, 10)]?.[key]?.totalTokens,
            2,
        );
        assert.equal(one.days?.["2026-10-28"]?.[key]?.totalTokens, 4);
        assert.equal(one.days?.["2026-10-29"]?.[key]?.totalTokens, 8);
        assert.equal(one.undated?.totalTokens, 48);
        assert.deepEqual(one.residual, {
            state: "settled",
            counters: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        });
    });
});

// ─── Durable semantics ───────────────────────────────────────────────────────

/** A MemoryStorage with tables written directly, and a Session over it for the documents. */
async function durableWorld() {
    const storage = new MemoryStorage();
    const session: Session = createSession(storage);
    const ids = async () => Number(await storage.mintId());

    const write = async (writes: unknown[]) => {
        await storage.commit(writes as never, context);
    };

    const entry = async (
        conversationId: number,
        totalTokens: number,
        byTaskId: number | undefined,
    ): Promise<number> => {
        const id = await ids();

        await write([
            {
                type: "entry",
                value: {
                    id,
                    conversationId,
                    kind: "pi.assistant",
                    ...(byTaskId === undefined ? {} : { byTaskId }),
                    model: [
                        {
                            role: "assistant",
                            content: [],
                            api: "faux",
                            provider: "faux",
                            model: "faux-1",
                            stopReason: "stop",
                            timestamp: T0 - HOUR,
                            usage: {
                                input: totalTokens,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                totalTokens,
                                cost: {
                                    input: 0,
                                    output: 0,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    total: 0,
                                },
                            },
                        },
                    ],
                },
            },
        ]);

        if (byTaskId !== undefined) {
            await session.commit(async (tx) => {
                const ledger = await tx.doc(UsageDoc, conversationId as ConversationId);
                const old = ledger.models["faux/faux-1"];

                ledger.models["faux/faux-1"] = {
                    input: (old?.input ?? 0) + totalTokens,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: (old?.totalTokens ?? 0) + totalTokens,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                };
            }, context);
        }

        return id;
    };

    const deps: UsageDeps = {
        readUsage: () => session.snapshot(DeskUsage, context),
        readLedger: (id) => session.snapshot(UsageDoc, id as ConversationId, context),
        commit: async (change) => {
            await session.commit(async (tx) => {
                await change(tx, (await tx.doc(DeskUsage)) as UsageState);
            }, context);

            return true;
        },
    };

    return { storage, session, ids, write, entry, deps };
}

describe("fork, import and child semantics on Pi Durable's storage", () => {
    test("a fork's inherited history is skipped; imported entries are skipped; a child is found", async () => {
        const d = await durableWorld();
        const parent = await d.ids();

        await d.write([{ type: "conversation", value: { id: parent } }]);

        const first = await d.entry(parent, 100, 5);

        await d.entry(parent, 200, 5);

        const fork = await d.ids();

        await d.write([
            {
                type: "conversation",
                value: { id: fork, parent: { conversationId: parent, at: first } },
            },
        ]);
        await d.entry(fork, 7, 6);
        // A copy that Pocket's Pi-session import wrote: no task, not in the ledger.
        await d.entry(fork, 1000, undefined);

        const child = await d.ids();

        await d.write([
            {
                type: "conversation",
                value: { id: child, owner: { conversationId: fork, taskId: 6 } },
            },
        ]);
        await d.entry(child, 3, 8);

        const desk = deskOf([thread("T1", { session: parent }), thread("T2", { session: fork })]);
        const input = { desk, facts: threadFacts(desk), boundary: BOUNDARY, now: T0, slot: 0 };

        for (let index = 0; index < 4; index++) {
            await usagePass(d.deps, input);
        }

        const doc = (await d.session.snapshot(DeskUsage, context)) as UsageState;
        const forked = doc.sessions[String(fork)];

        assert(forked !== undefined);
        assert.equal(forked.forkAt, first);
        assert.equal(ownTotals(forked).totalTokens, 7);
        assert.deepEqual(forked.skipped, { imported: 1 });
        assert.equal(ownTotals(doc.sessions[String(parent)] as SessionUsage).totalTokens, 300);
        assert.equal(doc.sessions[String(child)]?.parent, fork);
        assert.equal(ownTotals(doc.sessions[String(child)] as SessionUsage).totalTokens, 3);

        for (const id of [parent, fork, child]) {
            assert.deepEqual(doc.sessions[String(id)]?.residual, {
                state: "settled",
                counters: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: 0,
                },
            });
        }

        assert.equal(doc.sources.usage?.complete, true);
        await d.session.close(context);
    });
});

// ─── Pages, replays and failures ─────────────────────────────────────────────

describe("pages, replays and failures", () => {
    test("200 entries a page, 10 pages a pass; the next pass resumes to the same totals", async () => {
        const w = world();
        const s = store();
        const count = ENTRY_PAGE * MAX_SESSION_PAGES + 450;

        conversation(w, 1);

        for (let index = 0; index < count; index++) {
            add(w, 1, { totalTokens: index % 7, cost: 0.001 * (index % 3) });
        }

        const desk = deskOf([thread("T1", { session: 1 })]);
        const first = await pass(w, s, desk);

        assert.equal(first.pages, MAX_SESSION_PAGES);
        assert.equal(session(s, 1).caughtUp, false);
        assert.equal(totals(s, 1).totalTokens > 0, true);
        assert.equal(s.doc.sources.usage?.complete, false);
        assert.equal(s.doc.sources.usage?.pending, 1);

        const second = await pass(w, s, desk);

        // 3 entry pages and 1 child page.
        assert.equal(second.pages, 4);
        assert.equal(session(s, 1).caughtUp, true);

        // The same history read in 1 go gives the same totals.
        const once = store();
        const big = { ...w, scans: [] };

        await settle(big, once, desk);
        assert.deepEqual(totals(s, 1), totals(once, 1));
        assert.equal(session(s, 1).days?.["2026-10-29"]?.["anthropic/claude"]?.entries, count);
        assert.equal(session(s, 1).residual?.state, "settled");
    });

    test("more than 100 children: discovery pages share the 10-page limit, resume, and count each child once", async () => {
        const w = world();
        const s = store();
        const count = CHILD_PAGE + 50;
        const parent = 1;

        conversation(w, parent);
        add(w, parent, { totalTokens: 1000 });

        for (let index = 0; index < count; index++) {
            const id = 10 + index;

            conversation(w, id, {
                owner: { conversationId: parent as ConversationId, taskId: 1 as TaskId },
            });
            add(w, id, { totalTokens: 15 });
        }

        const desk = deskOf([thread("T1", { session: parent, repo: "a/b" })]);

        // Pass 1: the parent's entries, the first child page (committed), then the new children's scans.
        const first = await pass(w, s, desk);

        assert.equal(first.pages, MAX_SESSION_PAGES);
        assert.equal(w.childScans.length, 1);
        assert.equal(session(s, parent).children?.complete, false);
        assert.deepEqual(session(s, parent).children?.cursor, { after: 10 + CHILD_PAGE - 1 });
        assert.equal(Object.keys(s.doc.sessions).length, 1 + CHILD_PAGE);
        assert.equal(s.doc.sources.usage?.complete, false);

        // The second page is read in a later pass, from the stored cursor.
        let passes = 1;

        while (session(s, parent).children?.complete !== true) {
            const result = await pass(w, s, desk, T0 + passes * PASS_MS);

            assert.equal(result.pages <= MAX_SESSION_PAGES, true);
            passes += 1;
            assert.equal(passes < 40, true, "discovery ends");
        }

        assert.equal(w.childScans.filter((id) => id === parent).length, 2);
        await settle(w, s, desk, T0 + passes * PASS_MS, 40);
        assert.equal(Object.keys(s.doc.sessions).length, 1 + count);

        for (let index = 0; index < count; index++) {
            const child = session(s, 10 + index);

            assert.equal(child.parent, parent);
            assert.equal(
                totals(s, child.id).totalTokens,
                15,
                `child ${String(child.id)} counts once`,
            );
            assert.deepEqual(child.assign, { repo: "a/b", via: parent });
        }

        assert.deepEqual(byRepo(s.doc), { "a/b": 1000 + 15 * count });
        assert.equal(s.doc.sources.usage?.complete, true);
    });

    test("a pass cut off after a committed child page resumes from its cursor", async () => {
        const w = world();
        const cut = store();
        const clean = store();

        conversation(w, 1);
        add(w, 1);

        for (let index = 0; index < CHILD_PAGE + 5; index++) {
            conversation(w, 10 + index, {
                owner: { conversationId: 1 as ConversationId, taskId: 1 as TaskId },
            });
            add(w, 10 + index);
        }

        const desk = deskOf([thread("T1", { session: 1 })]);
        const stop = new AbortController();

        // The first child page commits; the next scan is cut off.
        w.onScan = (id) => {
            if (id !== 1) {
                stop.abort(new Error("restart"));

                throw new Error("restart");
            }
        };

        await assert.rejects(pass(w, cut, desk, T0, stop.signal), /restart/);
        w.onScan = undefined;
        assert.equal(session(cut, 1).children?.complete, false);
        assert.deepEqual(session(cut, 1).children?.cursor, { after: 10 + CHILD_PAGE - 1 });
        assert.equal(Object.keys(cut.doc.sessions).length, 1 + CHILD_PAGE);
        assert.equal(session(cut, 10).scannedAt, undefined);
        await settle(w, cut, desk, T0, 40);
        await settle(w, clean, desk, T0, 40);
        assert.deepEqual(cut.doc.sessions, clean.doc.sessions);
        assert.equal(Object.keys(cut.doc.sessions).length, 1 + CHILD_PAGE + 5);
    });

    test("the same page applied twice counts once", () => {
        const w = world();

        conversation(w, 1);
        add(w, 1);
        add(w, 1);

        const doc: UsageState = { sessions: { "1": { id: 1 } }, sources: {} };
        const page = {
            conversation: { id: 1 as ConversationId },
            entries: visible(w, 1),
            more: false,
        };
        const context = { boundary: BOUNDARY, now: T0 };

        assert.equal(applyEntryPage(doc, 1, page, context), true);

        const once = copy(doc);

        assert.equal(applyEntryPage(doc, 1, page, context), false);
        assert.deepEqual(doc, once);
        assert.equal(ownTotals(doc.sessions["1"] as SessionUsage).totalTokens, 30);
    });

    test("a pass cut off between a read and its commit loses nothing and repeats nothing", async () => {
        const w = world();
        const cut = store();
        const clean = store();

        conversation(w, 1);

        for (let index = 0; index < ENTRY_PAGE * 3; index++) {
            add(w, 1, { totalTokens: index });
        }

        const desk = deskOf([thread("T1", { session: 1 })]);
        const stop = new AbortController();
        let reads = 0;

        // The second page's read is cut off: as a restart in the middle of the commit.
        w.onScan = () => {
            reads += 1;

            if (reads === 2) {
                stop.abort(new Error("restart"));

                throw new Error("restart");
            }
        };

        await assert.rejects(pass(w, cut, desk, T0, stop.signal), /restart/);
        w.onScan = undefined;
        assert.equal(
            session(cut, 1).cursor,
            w.entries[ENTRY_PAGE - 1]?.id,
            "page 1 landed, page 2 did not",
        );
        assert.equal(cut.doc.sources.usage, undefined, "an abort records no failure");
        await settle(w, cut, desk);
        await settle(w, clean, desk);
        assert.deepEqual(cut.doc.sessions, clean.doc.sessions);
    });

    test("a page that throws marks its session, keeps its data, and is tried again later", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        conversation(w, 2);
        add(w, 1);
        add(w, 2);

        const desk = deskOf([thread("T1", { session: 1 }), thread("T2", { session: 2 })]);

        await settle(w, s, desk);

        const before = copy(session(s, 1));

        add(w, 1);
        w.failing.add(1);
        await pass(w, s, desk, T0 + PASS_MS);
        await pass(w, s, desk, T0 + 2 * PASS_MS);
        assert.equal(session(s, 1).error, "the storage read failed");
        assert.equal(session(s, 1).errorAt, T0 + 2 * PASS_MS);
        assert.deepEqual(session(s, 1).days, before.days, "its data stays");
        assert.equal(session(s, 2).error, undefined, "the other session is not touched");
        assert.equal(s.doc.sources.usage?.ok, true);
        assert.equal(s.doc.sources.usage?.complete, false);

        // Within the retry time it is not read again.
        const scans = w.scans.length;

        await pass(w, s, desk, T0 + 3 * PASS_MS);
        assert.equal(w.scans.length, scans);
        w.failing.clear();
        await settle(w, s, desk, T0 + 2 * PASS_MS + USAGE_ERROR_RETRY_MS);
        assert.equal(session(s, 1).error, undefined);
        assert.equal(totals(s, 1).totalTokens, 30);
    });

    test("a usage step whose document read fails records the failure and keeps every fact", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([thread("T1", { session: 1 })]);

        await settle(w, s, desk);

        const sessions = copy(s.doc.sessions);
        const deps = fakeDeps(w, s);

        deps.readUsage = async () => {
            throw new Error("the document cannot be read");
        };

        await usagePass(deps, {
            desk,
            facts: threadFacts(desk),
            boundary: BOUNDARY,
            now: T0 + HOUR,
            slot: 0,
        });
        assert.deepEqual(s.doc.sessions, sessions);
        assert.equal(s.doc.sources.usage?.ok, false);
        assert.equal(s.doc.sources.usage?.error, "the document cannot be read");
        assert.equal(s.doc.sources.usage?.lastGoodAt, T0);
    });

    test("a collector that no longer owns collection changes nothing", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);
        s.owned = false;
        await pass(w, s, deskOf([thread("T1", { session: 1 })]));
        assert.deepEqual(s.doc, { sessions: {}, sources: {} });
        assert.equal(w.scans.length, 0);
    });
});

// ─── Coverage and the ledger ─────────────────────────────────────────────────

describe("coverage and the ledger", () => {
    test("a compaction's usage is a settled residual, never dated", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1, { input: 10, output: 5, totalTokens: 15, cost: 0.25 });
        // A summary's usage: in the ledger, with no entry.
        addToLedger(w, 1, "anthropic/claude", {
            input: 900,
            output: 100,
            totalTokens: 1000,
            cost: { total: 0.5 },
        });
        await settle(w, s, deskOf([thread("T1", { session: 1 })]));

        const one = session(s, 1);

        assert.deepEqual(one.residual, {
            state: "settled",
            counters: {
                input: 900,
                output: 100,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 1000,
                cost: 0.5,
            },
        });
        assert.equal(Object.values(one.days ?? {}).length, 1);
        assert.equal(ownTotals(one).totalTokens, 15);
    });

    test("entries larger than the ledger are a mismatch", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1, { ledger: false });
        await settle(w, s, deskOf([thread("T1", { session: 1 })]));
        assert.equal(session(s, 1).residual?.state, "mismatch");
    });

    test("a ledger that changes between checks makes the session pending, then it is read again", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([thread("T1", { session: 1 })]);

        await settle(w, s, desk);
        assert.equal(session(s, 1).residual?.state, "settled");
        add(w, 1);
        await pass(w, s, desk, T0 + PASS_MS);
        assert.equal(session(s, 1).dirty, true);
        assert.equal(session(s, 1).residual?.state, "pending");
        assert.equal(s.doc.sources.usage?.complete, false);
        await pass(w, s, desk, T0 + 2 * PASS_MS);
        assert.equal(session(s, 1).dirty, undefined);
        assert.equal(session(s, 1).residual?.state, "settled");
        assert.equal(totals(s, 1).totalTokens, 30);
    });

    test("a ledger that cannot be read makes a visible gap, and new usage is still collected", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([thread("T1", { session: 1 })]);

        await settle(w, s, desk);

        const ledger = copy(session(s, 1).ledger);

        // The ledger read fails from now on; new usage comes.
        w.ledgerFails.add(1);
        add(w, 1);
        await pass(w, s, desk, T0 + PASS_MS);
        assert.deepEqual(session(s, 1).residual, {
            state: "unavailable",
            why: "the ledger could not be read",
        });
        assert.equal(session(s, 1).dirty, true);
        assert.deepEqual(session(s, 1).ledger, ledger, "the stored ledger stays");
        assert.equal(s.doc.sources.usage?.complete, false);

        // The next pass reads the entries again, without a ledger.
        await pass(w, s, desk, T0 + 2 * PASS_MS);
        assert.equal(totals(s, 1).totalTokens, 30);
        assert.equal(session(s, 1).dirty, undefined);
        assert.equal(session(s, 1).residual?.state, "unavailable");
        assert.equal(s.doc.sources.usage?.ledgerUnavailable, 1);
        assert.equal(s.doc.sources.usage?.complete, false);

        // Later checks that fail do not make it dirty again: the entry refresh reads it.
        add(w, 1);
        await pass(w, s, desk, T0 + 3 * PASS_MS);
        assert.equal(session(s, 1).dirty, undefined);
        assert.equal(totals(s, 1).totalTokens, 30);
        await pass(w, s, desk, T0 + 2 * PASS_MS + ENTRY_REFRESH_MS);
        assert.equal(totals(s, 1).totalTokens, 45, "the refresh collects it");

        // The ledger can be read again: the session settles, and the source is complete.
        w.ledgerFails.clear();
        await settle(w, s, desk, T0 + 3 * PASS_MS + ENTRY_REFRESH_MS);
        assert.equal(session(s, 1).residual?.state, "settled");
        assert.equal(s.doc.sources.usage?.ledgerUnavailable, 0);
        assert.equal(s.doc.sources.usage?.complete, true);
    });

    test("a caught-up session is read again after ENTRY_REFRESH_MS, whatever its ledger says", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([thread("T1", { session: 1 })]);

        await settle(w, s, desk);
        // Usage the ledger does not show: no check finds it, only the refresh.
        add(w, 1, { ledger: false });
        await pass(w, s, desk, T0 + ENTRY_REFRESH_MS - PASS_MS);
        assert.equal(totals(s, 1).totalTokens, 15);
        await pass(w, s, desk, T0 + ENTRY_REFRESH_MS);
        assert.equal(totals(s, 1).totalTokens, 30);
        assert.equal(session(s, 1).scannedAt, T0 + ENTRY_REFRESH_MS);
    });

    test("pending sessions whose ledgers keep failing do not starve the others", async () => {
        const w = world();
        const s = store();
        const threads: Thread[] = [];

        for (let id = 1; id <= 80; id++) {
            conversation(w, id);
            add(w, id);
            threads.push(thread(`T${String(id)}`, { session: id }));
        }

        const desk = deskOf(threads);

        await settle(w, s, desk, T0, 40);

        // 60 sessions are pending, and their ledger reads fail; 20 are settled.
        for (let id = 1; id <= 60; id++) {
            session(s, id).residual = { state: "pending" };
            w.ledgerFails.add(id);
        }

        const checked = new Set<number>();

        for (let slot = 0; slot < 4; slot++) {
            const plan = planChecks(s.doc, new Set(), slot);

            assert.equal(plan.length <= MAX_LEDGER_CHECKS, true);
            assert.equal(new Set(plan).size, plan.length);
            assert.equal(
                plan.filter((id) => id > 60).length >= 20,
                true,
                "the settled group gets its share",
            );

            for (const id of plan) {
                checked.add(id);
            }
        }

        assert.equal(checked.size, 80, "every session is checked within a few passes");

        // The same in passes: the failing reads make them unavailable, and the settled ones are still checked.
        const reads: number[] = [];
        const deps = fakeDeps(w, s);
        const read = deps.readLedger;

        deps.readLedger = async (id) => {
            reads.push(id);

            return read(id);
        };

        for (let index = 0; index < 3; index++) {
            const now = T0 + (index + 1) * PASS_MS;

            reads.length = 0;
            await usagePass(deps, {
                desk,
                facts: threadFacts(desk),
                boundary: BOUNDARY,
                now,
                slot: index,
            });
            // At most: 1 read before each page's session, then the sessions that caught up, then the 50 checks.
            assert.equal(reads.length <= MAX_LEDGER_CHECKS + 2 * MAX_SESSION_PAGES, true);
            assert.equal(
                reads.some((id) => id > 60),
                true,
            );
        }
    });

    test("a generation between the ledger read and the check: pending, then exact totals", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1, { totalTokens: 15, cost: 0.5 });

        const desk = deskOf([thread("T1", { session: 1 })]);
        const deps = fakeDeps(w, s);
        const read = deps.readLedger;
        let generated = false;

        // The first ledger read is the one before the scan: a generation commits right after it.
        deps.readLedger = async (id) => {
            const ledger = await read(id);

            if (!generated) {
                generated = true;
                add(w, 1, { totalTokens: 20, cost: 0.25 });
            }

            return ledger;
        };

        const input = (now: number) => ({
            desk,
            facts: threadFacts(desk),
            boundary: BOUNDARY,
            now,
            slot: 0,
        });

        await usagePass(deps, input(T0));
        assert.equal(totals(s, 1).totalTokens, 35, "the scan read the new request");
        assert.equal(session(s, 1).dirty, true);
        assert.deepEqual(session(s, 1).residual, { state: "pending" });
        assert.equal(session(s, 1).ledger?.totalTokens, 15, "the ledger read before the scan");
        assert.equal(s.doc.sources.usage?.complete, false);

        await usagePass(deps, input(T0 + PASS_MS));
        assert.deepEqual(totals(s, 1), {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 35,
            cost: 0.75,
        });
        assert.deepEqual(session(s, 1).residual, {
            state: "settled",
            counters: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        });
        assert.equal(s.doc.sources.usage?.complete, true);
    });

    test("a gone conversation keeps its data and is a coverage gap", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        conversation(w, 2);
        add(w, 1);
        add(w, 2);

        const desk = deskOf([thread("T1", { session: 1 }), thread("T2", { session: 2 })]);

        await settle(w, s, desk);

        const days = copy(session(s, 1).days);

        w.conversations.delete(1);
        // Its ledger is gone as well: a later check reads none, and the session is read again.
        w.ledgers.delete(1);
        await pass(w, s, desk, T0 + PASS_MS);
        await pass(w, s, desk, T0 + 2 * PASS_MS);
        assert.equal(session(s, 1).missingAt, T0 + 2 * PASS_MS);
        assert.deepEqual(session(s, 1).days, days);
        assert.equal(
            s.doc.sources.usage?.complete,
            true,
            "a missing session does not hold the source",
        );
    });

    test("a session no link names any more keeps its data and its repo, and is not read again", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);
        await settle(w, s, deskOf([thread("T1", { session: 1, repo: "a/b" })]));

        const before = copy(session(s, 1));
        const scans = w.scans.length;

        add(w, 1);
        await pass(w, s, deskOf([]), T0 + PASS_MS);
        await pass(w, s, deskOf([]), T0 + 2 * PASS_MS);
        assert.equal(session(s, 1).unlinkedAt, T0 + PASS_MS);
        assert.deepEqual(session(s, 1).assign, { repo: "a/b", via: 1 });
        assert.deepEqual(session(s, 1).days, before.days);
        assert.equal(w.scans.length, scans);
    });

    test("ledger checks: every session that caught up, then 50 round-robin", () => {
        const sessions: Record<string, SessionUsage> = {};

        for (let id = 1; id <= 120; id++) {
            sessions[String(id)] = {
                id,
                caughtUp: true,
                scannedAt: T0,
                residual: { state: id === 120 ? "pending" : "settled" },
            };
        }

        const doc: UsageState = { sessions, sources: {} };
        const first = planChecks(doc, new Set([5]), 0);
        const second = planChecks(doc, new Set(), 1);

        assert.equal(first[0], 5);
        assert.equal(first[1], 120, "a pending check goes first");
        assert.equal(first.length, 1 + MAX_LEDGER_CHECKS);
        assert.equal(second.length, MAX_LEDGER_CHECKS);
        assert.notDeepEqual(first.slice(2), second.slice(1));
    });

    test("no write when nothing changed; a heartbeat once an hour", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([thread("T1", { session: 1 })]);

        await settle(w, s, desk);

        const writes = s.writes;
        const commits = s.commits;

        await pass(w, s, desk, T0 + PASS_MS);
        await pass(w, s, desk, T0 + 2 * PASS_MS);
        assert.equal(s.commits, commits, "no commit");
        assert.equal(s.writes, writes);
        await pass(w, s, desk, T0 + USAGE_HEARTBEAT_MS);
        assert.equal(s.writes, writes + 1, "the heartbeat");
        assert.equal(s.doc.sources.usage?.checkedAt, T0 + USAGE_HEARTBEAT_MS);
        assert.equal(s.doc.sources.usage?.at, T0);
        // A day on, child discovery runs again: it finds nothing new.
        await pass(w, s, desk, T0 + CHILD_REFRESH_MS);
        assert.equal(session(s, 1).children?.at, T0 + CHILD_REFRESH_MS);
    });

    test("ledger sums: an absent ledger is empty; a bad one is unknown", () => {
        assert.deepEqual(ledgerOf(undefined), {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
        });
        assert.equal(
            ledgerOf({ models: { "a/b": { input: Number.NaN } as never }, tools: {} }),
            undefined,
        );
    });
});

// ─── In the collector's pass ─────────────────────────────────────────────────

describe("the usage step in a collector pass", () => {
    /** A collector pass with a fake GitHub that has nothing to read. */
    async function collect(
        dashboard: DashboardState,
        desk: DeskState,
        w: World,
        s: Store,
        usage = true,
    ) {
        return collectPass({
            readDesk: async () => copy(desk),
            readDashboard: async () => copy(dashboard),
            now: () => T0,
            graphql: async () => ({
                stdout: JSON.stringify({ data: { rateLimit: { remaining: 5000 } } }),
            }),
            commit: async (apply) => apply(dashboard),
            ...(usage ? { usage: fakeDeps(w, s) } : {}),
        });
    }

    test("no usage step before the boundary; after it, the dashboard and the desk are as without it", async () => {
        const w = world();
        const s = store();

        conversation(w, 1);
        add(w, 1);

        const desk = deskOf([
            thread("T1", { session: 1, prs: { "frostyard/test#1": { via: "seen" } } }),
        ]);
        const deskBefore = copy(desk);
        const withUsage: DashboardState = { threads: {}, prs: {}, issues: {}, sources: {} };
        const without: DashboardState = { threads: {}, prs: {}, issues: {}, sources: {} };

        await collect(withUsage, desk, w, s);
        assert.equal(s.commits, 0, "no boundary yet: no usage step");
        assert.equal(withUsage.boundary, BOUNDARY);
        await collect(without, desk, w, s, false);
        await collect(withUsage, desk, w, s);
        await collect(without, desk, w, s, false);
        assert.equal(totals(s, 1).totalTokens, 15);
        assert.equal(s.doc.sources.usage?.boundary, BOUNDARY);
        assert.deepEqual(withUsage, without);
        assert.deepEqual(desk, deskBefore);
    });

    test("a failing usage step never fails the GitHub part", async () => {
        const w = world();
        const s = store();
        const desk = deskOf([
            thread("T1", { session: 1, prs: { "frostyard/test#7": { via: "seen" } } }),
        ]);
        const dashboard: DashboardState = {
            threads: {},
            prs: {},
            issues: {},
            sources: {},
            initializedAt: T0,
            boundary: BOUNDARY,
        };
        const deps = fakeDeps(w, s);
        const queries: string[] = [];

        deps.readUsage = async () => {
            throw new Error("no usage document");
        };

        await collectPass({
            readDesk: async () => copy(desk),
            readDashboard: async () => copy(dashboard),
            now: () => T0,
            graphql: async (query) => {
                queries.push(query);

                return {
                    stdout: JSON.stringify({
                        data: {
                            rateLimit: { remaining: 4000, resetAt: "2026-10-30T01:00:00Z" },
                            p0: {
                                isArchived: false,
                                pullRequest: {
                                    state: "MERGED",
                                    createdAt: "2026-10-01T10:00:00Z",
                                    mergedAt: "2026-10-02T10:00:00Z",
                                    closedAt: "2026-10-02T10:00:00Z",
                                },
                            },
                        },
                    }),
                };
            },
            commit: async (apply) => apply(dashboard),
            usage: deps,
        });
        assert.equal(queries.length, 1, "the GraphQL call ran");
        assert.match(queries[0] ?? "", /pullRequest\(number: 7\)/);
        assert.equal(s.doc.sources.usage?.ok, false);
        assert.equal(s.doc.sources.usage?.error, "no usage document");
        assert.equal(dashboard.sources.threads?.ok, true);
        assert.equal(dashboard.sources.github?.ok, true);

        const fact = dashboard.prs["frostyard/test#7"];

        assert.equal(fact?.state, "MERGED");
        assert.equal(fact?.createdAt, Date.UTC(2026, 9, 1, 10));
        assert.equal(fact?.mergedAt, Date.UTC(2026, 9, 2, 10));
        assert.equal(fact?.closedAt, Date.UTC(2026, 9, 2, 10));
        assert.equal(fact?.readAt, T0);
    });

    test("an abort during the usage step still throws, and the GitHub part does not run", async () => {
        const w = world();
        const s = store();
        const desk = deskOf([
            thread("T1", { session: 1, prs: { "frostyard/test#7": { via: "seen" } } }),
        ]);
        const dashboard: DashboardState = {
            threads: {},
            prs: {},
            issues: {},
            sources: {},
            initializedAt: T0,
            boundary: BOUNDARY,
        };
        const before = copy(dashboard);
        const deps = fakeDeps(w, s);
        const stop = new AbortController();
        let calls = 0;

        deps.readUsage = async () => {
            stop.abort(new Error("stop"));

            throw new Error("stop");
        };

        await assert.rejects(
            collectPass({
                readDesk: async () => copy(desk),
                readDashboard: async () => copy(dashboard),
                now: () => T0,
                graphql: async () => {
                    calls += 1;

                    return { stdout: "{}" };
                },
                commit: async (apply) => apply(dashboard),
                usage: deps,
                signal: stop.signal,
            }),
            /stop/,
        );
        assert.equal(calls, 0);
        assert.deepEqual(dashboard, before);
        assert.equal(s.doc.sources.usage, undefined, "an abort records no failure");
    });
});

// ─── In Pocket ───────────────────────────────────────────────────────────────

const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

/** Pi, scripted: it starts a subagent when asked, and the subagent answers. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return reply("started");
    }

    if (text.includes("start a helper")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "helper",
                    message: "say hi please",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("say hi please")) {
        return reply("hi from helper");
    }

    if (text.startsWith("[subagent helper answered")) {
        return reply("noted");
    }

    return reply(`echo: ${text.slice(0, 40)}`);
});
let app: App;

/** Usage deps over the app's harness: no collector, so no owner check. */
const harnessDeps = (): UsageDeps => ({
    readUsage: () => app.harness.snapshot(DeskUsage, context),
    readLedger: (id) => app.harness.snapshot(UsageDoc, id as ConversationId, context),
    commit: async (change) => {
        await app.harness.commit(async (tx) => {
            await change(tx, (await tx.doc(DeskUsage)) as UsageState);
        }, context);

        return true;
    },
});

async function harnessPass(desk: DeskState) {
    return usagePass(harnessDeps(), {
        desk,
        facts: threadFacts(desk),
        boundary: BOUNDARY,
        now: Date.now(),
        slot: 0,
    });
}

describe("usage in Pocket", () => {
    const dataDir = join(root, "usage-data");

    before(async () => {
        app = await openApp(model, dataDir);
    });

    after(async () => {
        await app?.close();
        cleanUp();
    });

    test("generated entries, a fork and a subagent add up to their ledgers; a restart changes nothing", async () => {
        const parent = await newSession(app);

        await say(app, parent, "hello");
        await say(app, parent, "again");

        // A fork from the first reply: Pocket's own fork.
        const view = await (await app.harness.conversation(parent, context))!.entries(
            { order: "ascending" },
            100,
            undefined,
            context,
        );
        const reply = view.items.find((entry) => entry.kind === "pi.assistant");

        assert(reply !== undefined);

        const { id: fork } = await app.commands.fork(parent, owner(app), { entryId: reply.id });

        await say(app, fork, "in the fork");

        // A subagent, as Pocket's own `subagent` tool makes it: a conversation owned by a task of the parent.
        await say(app, parent, "start a helper");

        const child = await app.harness.commit(
            async (tx) =>
                (await tx.scanConversations({ ownerConversationId: parent }, 10)).items[0]?.id,
            context,
        );

        assert(child !== undefined, "the subagent's conversation");
        await until(async () => {
            const entries = await (await app.harness.conversation(child, context))!.entries(
                { order: "ascending" },
                100,
                undefined,
                context,
            );

            return entries.items.some((entry) => entry.kind === "pi.assistant");
        }, "the subagent's answer");
        await until(
            async () => (await modelTexts(app, parent)).some((text) => text.includes("noted")),
            "the report",
        );
        await (await app.harness.conversation(parent, context))!.waitForIdle(context);
        await (await app.harness.conversation(child, context))!.waitForIdle(context);

        const desk = deskOf([thread("T1", { session: parent }), thread("T2", { session: fork })]);

        for (let index = 0; index < 6; index++) {
            await harnessPass(desk);
        }

        const doc = (await app.harness.snapshot(DeskUsage, context)) as UsageState;
        const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

        assert.equal(doc.sessions[String(child)]?.parent, parent);
        assert.deepEqual(doc.sessions[String(child)]?.assign, {
            repo: "frostyard/test",
            via: parent,
        });

        for (const id of [parent, fork, child]) {
            const each = doc.sessions[String(id)];
            const ledger = ledgerOf(await app.harness.snapshot(UsageDoc, id, context));

            assert(each !== undefined && ledger !== undefined);
            assert.equal(ledger.totalTokens > 0, true, `session ${String(id)} has usage`);
            assert.deepEqual(
                ownTotals(each),
                ledger,
                `session ${String(id)} adds up to its ledger`,
            );
            assert.deepEqual(each.residual, { state: "settled", counters: zero });
        }

        assert.equal(doc.sessions[String(fork)]?.forkAt, reply.id);
        assert.equal(doc.sources.usage?.complete, true);

        // A repeated pass, and a restart: the totals stay.
        await harnessPass(desk);
        await app.close();
        app = await openApp(model, dataDir);
        await harnessPass(desk);

        const again = (await app.harness.snapshot(DeskUsage, context)) as UsageState;

        for (const id of [parent, fork, child]) {
            assert.deepEqual(
                ownTotals(again.sessions[String(id)] as SessionUsage),
                ownTotals(doc.sessions[String(id)] as SessionUsage),
            );
            assert.deepEqual(again.sessions[String(id)]?.days, doc.sessions[String(id)]?.days);
        }
    });
});
