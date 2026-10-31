/**
 * The dashboard's usage source: model usage by UTC day, model, and repository, read from the sessions the desk links,
 * and kept in `x.desk.usage`. The dashboard's collector runs 1 usage step in each pass (`usagePass`): it reads at most
 * `MAX_SESSION_PAGES` pages of entries or child conversations, each page in its own commit, and then checks the
 * sessions against their `pi.usage` ledgers in 1 more commit. A long history fills in over many passes (the backfill),
 * and a pass that a restart cuts off loses nothing and adds nothing twice: each page commit moves the session's cursor
 * and adds the page's usage together, and it acts only when the stored cursor is still the one the page started from.
 *
 * Attribution comes only from explicit Desk links: `thread.session`, and `plan.consults[].session` (the plan thread's
 * planning overhead). A child conversation (a subagent) has the attribution of its nearest linked ancestor. Supervisor
 * and Clerk sessions are shared: they are never read and never charged. Nothing comes from paths, PR mentions or text.
 *
 * Pocket does not load this file as a module: the `_` prefix keeps it out. `_desk-dashboard.ts` imports it, and gives
 * it what it needs at run time, so this file never imports `_desk-dashboard.ts` or `desk.ts` at run time.
 *
 * All times are epoch milliseconds (UTC). An absent value is unknown: no field stores 0 for unknown.
 */
import {
    AssistantEntry,
    defineDoc,
    type ConversationId,
    type ConversationRecord,
    type Cursor,
    type EntryId,
    type EntryRecord,
    type Tx,
    type UsageState as LedgerState,
} from "@earendil-works/pi-durable";
import type { DeskState } from "./desk.ts";
import type { ThreadFact } from "./_desk-dashboard.ts";

// ─── Limits ──────────────────────────────────────────────────────────────────

/** The most entries in 1 page: 1 page is 1 commit. */
export const ENTRY_PAGE = 200;
/** The most child conversations in 1 discovery page. */
export const CHILD_PAGE = 100;
/** The most pages in 1 pass, for all sessions together: each entry page and each child-discovery page counts. */
export const MAX_SESSION_PAGES = 10;
/** The most ledger checks in 1 pass, round-robin, beside the sessions that caught up in the pass. */
export const MAX_LEDGER_CHECKS = 50;
/** A session whose page failed is read again after this long. */
export const USAGE_ERROR_RETRY_MS = 15 * 60_000;
/** A session's child conversations are looked for again after this long, also when the session did not change. */
export const CHILD_REFRESH_MS = 24 * 3600_000;
/**
 * A caught-up session's entries are read again after this long, whatever its ledger says: new usage is collected also
 * while its ledger cannot be read.
 */
export const ENTRY_REFRESH_MS = 6 * 3600_000;
/** A pass with no change writes `checkedAt` only when the stored value is older than this. */
export const USAGE_HEARTBEAT_MS = 3600_000;
/** A residual cost above `-COST_EPSILON` counts as 0 or more: the 2 sums add the same costs in another order. */
export const COST_EPSILON = 1e-6;

const DAY_MS = 24 * 3600_000;
/** Why a residual is unavailable. */
const LEDGER_UNREAD = "the ledger could not be read";
/** The kind of `AssistantEntry` (`pi.assistant`): generation writes every assistant entry with it. */
const ASSISTANT = AssistantEntry.kind;

// ─── Stored state ────────────────────────────────────────────────────────────

/**
 * Usage counters of a set of assistant entries. Stored data: never rename a field or change what it means.
 * `entries - costEntries` entries have an unknown cost. A sum field that no entry reported is absent (not 0).
 */
export type Counters = {
    /** The entries counted here. */
    entries: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** The sum of each entry's own `totalTokens`: never a sum of the other fields, never with reasoning or 1h added. */
    totalTokens: number;
    /** Reasoning tokens: a subset of `output`. Only from the entries that reported a valid value. */
    reasoning?: number;
    /** The entries that reported a valid reasoning count. */
    reasoningEntries?: number;
    /** Cache writes with 1 hour retention: a subset of `cacheWrite`. Only from the entries that reported it. */
    cacheWrite1h?: number;
    cacheWrite1hEntries?: number;
    /** The sum of `cost.total` of the entries with a valid cost, in dollars. */
    cost?: number;
    /** The entries with a valid `cost.total` (0 included). */
    costEntries?: number;
    /** The entries whose valid `cost.total` is exactly 0. */
    zeroCostEntries?: number;
};

/** The usage counters a residual and a ledger compare. Stored data: never rename a field or change what it means. */
export type Totals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    /** The sum of `cost.total`, in dollars. */
    cost: number;
};

/**
 * The repository a session's usage goes to: exactly 1 repository from its explicit links, or none and why: `no-repo`
 * (no link names a valid repository) or `conflict` (2 or more do: `repos`). `via` is the session whose explicit links
 * decided: the session itself, or, for a child, its nearest linked ancestor. Stored data: never rename a field.
 */
export type UsageAssign =
    { repo: string; via: number } | { none: "no-repo" | "conflict"; repos?: string[]; via: number };

/** The ledger check of a session. Stored data: never rename a field or change what it means. */
export type Residual = {
    /**
     * pending: not checked since the session caught up; settled: the ledger minus the session's own entries is 0 or
     * more in every counter (`counters`: compaction summaries, which have no entry and no date); mismatch: it is not
     * (`why`); unavailable: the ledger could not be read.
     */
    state: "pending" | "settled" | "mismatch" | "unavailable";
    why?: string;
    /** The ledger minus the entries' all-time sum. It never goes into a date. */
    counters?: Totals;
};

/** 1 session's usage. Stored data: never rename a field or change what it means. */
export type SessionUsage = {
    /** The conversation id. */
    id: number;
    /**
     * The explicit Desk links now, sorted: a thread id ("T12") for `thread.session`, "T560:k1" for a plan consult's
     * session. Absent: no explicit link (a child, or a session no link names now).
     */
    links?: string[];
    /** The owner conversation, when a pass found this session as a child of another session. It never changes. */
    parent?: number;
    /** The linked session whose child discovery found the chain this session is in. */
    root?: number;
    /** Where its usage goes. An unlinked session keeps its last one. */
    assign?: UsageAssign;
    /** A supervisor or Clerk session: never read, never charged, and its children are not followed. */
    shared?: true;
    /** When a pass found no link to it any more. Its data stays; it is not read again until a link comes back. */
    unlinkedAt?: number;
    /** When a pass found its conversation gone. Its data stays: a coverage gap, not 0. */
    missingAt?: number;
    /** A fork: the parent entry through which it inherits history. Its own entries come after it. */
    forkAt?: number;
    /** The last entry id read, of any kind. Absent: no entry read yet. */
    cursor?: number;
    /** The last page commit. Absent: never read. */
    scannedAt?: number;
    /** The last page read had no next page. */
    caughtUp?: boolean;
    /** Its ledger changed since `ledger`: the next pass reads it again. */
    dirty?: true;
    /** By UTC day "YYYY-MM-DD", then by "provider/model": only request times at or after the boundary. */
    days?: Record<string, Record<string, Counters>>;
    /** Request times before the boundary: for the ledger check only. */
    before?: Counters;
    /** Valid usage with no valid request time, or one more than 1 day after the pass. */
    undated?: Counters;
    /**
     * The entries not counted: `inherited` (another conversation's), `imported` (an assistant entry with no task: a
     * copy, not a request), `malformed` (bad identity or counters). `reasoning` and `cacheWrite1h`: the entries whose
     * subset was not valid (more than its total): the rest of the entry counts.
     */
    skipped?: {
        inherited?: number;
        imported?: number;
        malformed?: number;
        reasoning?: number;
        cacheWrite1h?: number;
    };
    /**
     * Child discovery: whether the last discovery read every page, the next page's cursor, when it completed, and
     * `cursor` of the session at that time (a later entry makes it due again).
     */
    children?: { complete: boolean; cursor?: Cursor; at?: number; entry?: number };
    /** The `pi.usage` model sum, read before the pass that caught up. */
    ledger?: Totals;
    residual?: Residual;
    /** Why its last page failed: 1 line. */
    error?: string;
    errorAt?: number;
};

/** The usage source's state. Stored data: never rename a field or change what it means. */
export type UsageSource = {
    /** The last pass that changed this status or the usage facts. */
    at: number;
    ok: boolean;
    error?: string;
    lastGoodAt?: number;
    /** The last pass with no failure, to within `USAGE_HEARTBEAT_MS`. */
    checkedAt?: number;
    /** The linked sessions with work left. */
    pending?: number;
    /**
     * The linked sessions that caught up but whose ledger could not be read (`residual.state` "unavailable"): a
     * coverage gap. Absent on a status from before the field.
     */
    ledgerUnavailable?: number;
    /**
     * Every linked session that is not shared or missing has caught up, has a complete child discovery, and has a
     * ledger that could be read.
     */
    complete?: boolean;
    /** A copy of the dashboard's boundary. */
    boundary?: number;
};

/** The usage document. Stored data: never rename a field or change what it means. */
export type UsageState = {
    /** By conversation id. */
    sessions: Record<string, SessionUsage>;
    sources: { usage?: UsageSource };
};

const emptyUsage = (): UsageState => ({ sessions: {}, sources: {} });

/** The usage facts, app-wide as `x.desk.dashboard` is. */
export const DeskUsage = defineDoc<UsageState>({
    kind: "x.desk.usage",
    version: 1,
    scope: "session",
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => emptyUsage(),
});

// ─── Small rules ─────────────────────────────────────────────────────────────

/** A deep compare of JSON values. An absent key and an undefined value are the same. */
function same(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }

    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }

        return a.every((value, index) => same(value, b[index]));
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    const others = Object.keys(right).filter((key) => right[key] !== undefined);

    return keys.length === others.length && keys.every((key) => same(left[key], right[key]));
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Set 1 field only when its value changes; undefined deletes it. */
function put<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: T[K] | undefined,
): void {
    if (value === undefined) {
        if (target[key] !== undefined) {
            delete target[key];
        }

        return;
    }

    if (!same(target[key], value)) {
        target[key] = copy(value);
    }
}

/** 1 line of an error, at most 200 characters. */
function line(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);

    return (
        text
            .split("\n")
            .map((each) => each.trim())
            .find((each) => each !== "") ?? "the read failed"
    ).slice(0, 200);
}

/** A conversation id: a positive safe integer. */
const validId = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A counter: a finite number, 0 or more. */
const counter = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

/** A provider or model name: 1 to 200 characters, no control character. */
const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The UTC day of a time: "YYYY-MM-DD". */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Numeric order of conversation ids. */
const byNumber = (a: SessionUsage, b: SessionUsage): number => a.id - b.id;

/** A session counts and is read: not shared, still linked, not gone. */
export const active = (session: Readonly<SessionUsage>): boolean =>
    session.shared !== true && session.unlinkedAt === undefined && session.missingAt === undefined;

// ─── Links ───────────────────────────────────────────────────────────────────

/** 1 explicit link of a session: its id ("T12" or "T560:k1") and its valid repository, when it has one. */
export type UsageLink = { id: string; repo?: string };

/** The explicit links by session id, and the shared (supervisor and Clerk) sessions. */
export type UsageLinks = { sessions: Record<string, UsageLink[]>; shared: number[] };

/**
 * The explicit links of every session: `thread.session` of every thread, open and closed, with the thread's valid
 * repository (from its fact), and each plan consult's session, with the plan thread's repository. The shared sessions:
 * every `thread.supervisor`, every Clerk session, and every supervisor that has a Clerk or a sweeper.
 */
export function usageLinks(
    desk: Readonly<DeskState> | undefined,
    facts: Readonly<Record<string, ThreadFact>>,
): UsageLinks {
    const sessions: Record<string, UsageLink[]> = {};
    const shared = new Set<number>();

    const add = (session: unknown, link: UsageLink): void => {
        if (!validId(session)) {
            return;
        }

        const list = (sessions[String(session)] ??= []);

        if (!list.some((each) => each.id === link.id)) {
            list.push(link);
        }
    };

    const linkOf = (id: string, thread: string): UsageLink => {
        const repo = facts[thread]?.repo;

        return repo === undefined ? { id } : { id, repo };
    };

    for (const [id, thread] of Object.entries(desk?.threads ?? {})) {
        if (thread === undefined || thread === null) {
            continue;
        }

        add(thread.session, linkOf(id, id));

        if (validId(thread.supervisor)) {
            shared.add(thread.supervisor);
        }
    }

    for (const [key, plan] of Object.entries(desk?.plans ?? {})) {
        const thread = typeof plan?.thread === "string" ? plan.thread : key;

        for (const consult of Array.isArray(plan?.consults) ? plan.consults : []) {
            if (typeof consult?.id === "string") {
                add(consult.session, linkOf(`${thread}:${consult.id}`, thread));
            }
        }
    }

    for (const [supervisor, clerk] of Object.entries(desk?.clerks ?? {})) {
        const id = Number(supervisor);

        if (validId(id)) {
            shared.add(id);
        }

        if (validId(clerk?.session)) {
            shared.add(clerk.session);
        }
    }

    for (const supervisor of Object.keys(desk?.sweepers ?? {})) {
        const id = Number(supervisor);

        if (validId(id)) {
            shared.add(id);
        }
    }

    for (const list of Object.values(sessions)) {
        list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    return { sessions, shared: [...shared].sort((a, b) => a - b) };
}

/** The repository of a set of explicit links. */
export function assignOf(links: readonly UsageLink[], via: number): UsageAssign {
    const repos = [
        ...new Set(links.flatMap((link) => (link.repo === undefined ? [] : [link.repo]))),
    ];

    if (repos.length === 1) {
        return { repo: repos[0] ?? "", via };
    }

    if (repos.length > 1) {
        return { none: "conflict", repos: repos.sort(), via };
    }

    return { none: "no-repo", via };
}

/**
 * Bring the sessions in line with the links: a new linked session gets a record, a session marks whether it is shared,
 * and each session gets its assignment: its own explicit links, else its nearest linked ancestor's, else it is unlinked
 * (it keeps its data and its last assignment). The walk up stops at a session seen before, so a cycle cannot loop.
 */
export function relink(draft: UsageState, links: UsageLinks, now: number): void {
    draft.sessions ??= {};

    const shared = new Set(links.shared);

    for (const id of Object.keys(links.sessions)) {
        if (draft.sessions[id] === undefined && validId(Number(id))) {
            draft.sessions[id] = { id: Number(id) };
        }
    }

    for (const session of Object.values(draft.sessions)) {
        const own = links.sessions[String(session.id)];

        put(session, "shared", shared.has(session.id) ? true : undefined);
        put(session, "links", own === undefined ? undefined : own.map((link) => link.id));
    }

    for (const session of Object.values(draft.sessions)) {
        if (session.shared === true) {
            continue;
        }

        let decided: UsageAssign | undefined;
        const seen = new Set<number>();
        let at: SessionUsage | undefined = session;

        while (at !== undefined && !seen.has(at.id)) {
            seen.add(at.id);

            // A shared ancestor stops the walk: its children are not followed.
            if (at.shared === true) {
                break;
            }

            const own = links.sessions[String(at.id)];

            if (own !== undefined) {
                decided = assignOf(own, at.id);
                break;
            }

            at = at.parent === undefined ? undefined : draft.sessions[String(at.parent)];
        }

        if (decided === undefined) {
            if (session.unlinkedAt === undefined) {
                session.unlinkedAt = now;
            }
        } else {
            put(session, "assign", decided);
            put(session, "unlinkedAt", undefined);
        }
    }
}

// ─── Entries ─────────────────────────────────────────────────────────────────

/** The usage of 1 valid assistant entry. */
export type Reading = {
    /** "provider/model". */
    key: string;
    /** The request time, when it is a valid time. */
    at?: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
    cacheWrite1h?: number;
    cost?: number;
    /** The subsets left out because they were not valid. */
    dropped: ("reasoning" | "cacheWrite1h")[];
};

/**
 * The usage of an assistant entry's message, or undefined when it is malformed: no assistant message, a provider or
 * model that is not a valid name, or a required counter that is not a finite number of 0 or more. A subset larger than
 * its total is left out (`dropped`); a missing or bad cost leaves the cost unknown.
 */
export function entryUsage(entry: Readonly<EntryRecord>): Reading | undefined {
    const message = record(entry.model?.[0]);
    const usage = record(message?.usage);
    const provider = message?.provider;
    const model = message?.model;

    if (
        message?.role !== "assistant" ||
        usage === undefined ||
        typeof provider !== "string" ||
        typeof model !== "string" ||
        !NAME.test(provider) ||
        !NAME.test(model)
    ) {
        return undefined;
    }

    const key = `${provider}/${model}`;
    const { input, output, cacheRead, cacheWrite, totalTokens } = usage;

    if (
        BAD_KEYS.has(key) ||
        !counter(input) ||
        !counter(output) ||
        !counter(cacheRead) ||
        !counter(cacheWrite) ||
        !counter(totalTokens)
    ) {
        return undefined;
    }

    const reading: Reading = {
        key,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        dropped: [],
    };
    const at = message.timestamp;

    if (typeof at === "number" && Number.isFinite(at) && at > 0) {
        reading.at = at;
    }

    if (usage.reasoning !== undefined) {
        if (counter(usage.reasoning) && usage.reasoning <= output) {
            reading.reasoning = usage.reasoning;
        } else {
            reading.dropped.push("reasoning");
        }
    }

    if (usage.cacheWrite1h !== undefined) {
        if (counter(usage.cacheWrite1h) && usage.cacheWrite1h <= cacheWrite) {
            reading.cacheWrite1h = usage.cacheWrite1h;
        } else {
            reading.dropped.push("cacheWrite1h");
        }
    }

    const cost = record(usage.cost)?.total;

    if (counter(cost)) {
        reading.cost = cost;
    }

    return reading;
}

const emptyCounters = (): Counters => ({
    entries: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
});

/** Add 1 entry's usage to counters. */
export function addReading(target: Counters, reading: Reading): void {
    target.entries += 1;
    target.input += reading.input;
    target.output += reading.output;
    target.cacheRead += reading.cacheRead;
    target.cacheWrite += reading.cacheWrite;
    target.totalTokens += reading.totalTokens;

    if (reading.reasoning !== undefined) {
        target.reasoning = (target.reasoning ?? 0) + reading.reasoning;
        target.reasoningEntries = (target.reasoningEntries ?? 0) + 1;
    }

    if (reading.cacheWrite1h !== undefined) {
        target.cacheWrite1h = (target.cacheWrite1h ?? 0) + reading.cacheWrite1h;
        target.cacheWrite1hEntries = (target.cacheWrite1hEntries ?? 0) + 1;
    }

    if (reading.cost !== undefined) {
        target.cost = (target.cost ?? 0) + reading.cost;
        target.costEntries = (target.costEntries ?? 0) + 1;

        if (reading.cost === 0) {
            target.zeroCostEntries = (target.zeroCostEntries ?? 0) + 1;
        }
    }
}

/** 1 page of a session's entries, as 1 commit read it. */
export type EntryPage = {
    /** The stored cursor the page started from. */
    from?: number;
    /** The conversation's record; absent: the conversation is gone. */
    conversation?: ConversationRecord;
    entries: readonly EntryRecord[];
    /** The scan has a next page. */
    more: boolean;
};

/** What a page needs beside its entries. */
export type PageContext = {
    boundary: number;
    now: number;
    /** The ledger read before the session's first page of the pass; undefined when it could not be read. */
    ledger?: Totals;
};

function skip(session: SessionUsage, why: keyof NonNullable<SessionUsage["skipped"]>): void {
    if (session.skipped === undefined) {
        session.skipped = {};
    }

    session.skipped[why] = (session.skipped[why] ?? 0) + 1;
}

/** Where 1 entry's usage goes: a day and model, `before`, or `undated`. */
function bucketOf(session: SessionUsage, reading: Reading, context: PageContext): Counters {
    const at = reading.at;

    // Each level is read back from its parent after it is set: in a commit, the parent is a draft, and only a change
    // made through the draft is stored (`x ??= {}` would give back the plain object, not the draft).
    if (at === undefined || at > context.now + DAY_MS) {
        if (session.undated === undefined) {
            session.undated = emptyCounters();
        }

        return session.undated;
    }

    if (at < context.boundary) {
        if (session.before === undefined) {
            session.before = emptyCounters();
        }

        return session.before;
    }

    const key = dayOf(at);

    if (session.days === undefined) {
        session.days = {};
    }

    const days = session.days;

    if (days[key] === undefined) {
        days[key] = {};
    }

    const day = days[key];

    if (day[reading.key] === undefined) {
        day[reading.key] = emptyCounters();
    }

    return day[reading.key];
}

/**
 * Apply 1 page of entries to a session: count each own assistant entry that a task wrote, skip and count the rest, and
 * move the cursor past every entry read, in the same change. It acts only when the stored cursor is still `page.from`,
 * so the same page applied twice counts once. True when it acted.
 */
export function applyEntryPage(
    draft: UsageState,
    id: number,
    page: EntryPage,
    context: PageContext,
): boolean {
    const session = draft.sessions?.[String(id)];

    if (session === undefined || session.cursor !== page.from) {
        return false;
    }

    put(session, "error", undefined);
    put(session, "errorAt", undefined);

    if (page.conversation === undefined) {
        if (session.missingAt === undefined) {
            session.missingAt = context.now;
        }

        return true;
    }

    put(session, "forkAt", page.conversation.parent?.at);

    let cursor = session.cursor;
    let counted = false;

    for (const entry of page.entries) {
        if (cursor !== undefined && entry.id <= cursor) {
            continue;
        }

        cursor = entry.id;

        if (entry.conversationId !== id) {
            skip(session, "inherited");
            continue;
        }

        if (entry.kind !== ASSISTANT) {
            continue;
        }

        if (entry.byTaskId === undefined) {
            skip(session, "imported");
            continue;
        }

        counted = true;

        const reading = entryUsage(entry);

        if (reading === undefined) {
            skip(session, "malformed");
            continue;
        }

        for (const dropped of reading.dropped) {
            skip(session, dropped);
        }

        addReading(bucketOf(session, reading, context), reading);
    }

    put(session, "cursor", cursor);
    put(session, "scannedAt", context.now);
    put(session, "caughtUp", !page.more);

    if (page.more) {
        return true;
    }

    put(session, "dirty", undefined);

    if (context.ledger === undefined) {
        // The stored ledger stays: a later check that can read the ledger compares with it, and a changed one makes
        // the session dirty.
        put(session, "residual", { state: "unavailable", why: LEDGER_UNREAD });
    } else if (
        counted ||
        session.residual === undefined ||
        session.residual.state === "unavailable" ||
        !same(session.ledger, context.ledger)
    ) {
        put(session, "ledger", context.ledger);
        put(session, "residual", { state: "pending" });
    }

    return true;
}

// ─── Children ────────────────────────────────────────────────────────────────

/** 1 page of a session's child conversations, as 1 commit read it. */
export type ChildPage = {
    /** The stored discovery cursor the page started from. */
    from?: Cursor;
    conversation?: ConversationRecord;
    children: readonly ConversationRecord[];
    /** The next page's cursor. */
    next?: Cursor;
};

/** Whether `id` is `ancestor` or has it among its parents. The walk stops at a session seen before. */
function descends(draft: Readonly<UsageState>, id: number, ancestor: number): boolean {
    const seen = new Set<number>();
    let at: SessionUsage | undefined = draft.sessions?.[String(id)];

    if (id === ancestor) {
        return true;
    }

    while (at?.parent !== undefined && !seen.has(at.id)) {
        seen.add(at.id);

        if (at.parent === ancestor) {
            return true;
        }

        at = draft.sessions?.[String(at.parent)];
    }

    return false;
}

/**
 * Apply 1 page of child conversations: each child not in the tree yet gets a record with this session as its parent
 * (a session already in the tree keeps its first parent), and the links are applied again. It acts only when the
 * stored discovery cursor is still `page.from`. True when it acted.
 */
export function applyChildPage(
    draft: UsageState,
    id: number,
    page: ChildPage,
    links: UsageLinks,
    now: number,
): boolean {
    const session = draft.sessions?.[String(id)];

    if (session === undefined || !same(session.children?.cursor, page.from)) {
        return false;
    }

    put(session, "error", undefined);
    put(session, "errorAt", undefined);

    if (page.conversation === undefined) {
        if (session.missingAt === undefined) {
            session.missingAt = now;
        }

        return true;
    }

    for (const child of page.children) {
        const key = String(child.id);

        if (child.id === id || !validId(child.id)) {
            continue;
        }

        const found = draft.sessions[key];

        if (found === undefined) {
            draft.sessions[key] = { id: child.id, parent: id, root: session.root ?? id };
        } else if (found.parent === undefined && !descends(draft, id, child.id)) {
            // A session that has its own link and is also a child: the edge is kept, so it inherits when its own
            // link goes. An existing parent stays, and no edge makes a cycle.
            found.parent = id;
            found.root = session.root ?? id;
        }
    }

    if (page.next === undefined) {
        const children: NonNullable<SessionUsage["children"]> = { complete: true, at: now };

        if (session.cursor !== undefined) {
            children.entry = session.cursor;
        }

        put(session, "children", children);
    } else {
        const children: NonNullable<SessionUsage["children"]> = {
            ...copy(session.children ?? { complete: false }),
            complete: false,
            cursor: page.next,
        };

        put(session, "children", children);
    }

    relink(draft, links, now);

    return true;
}

// ─── Ledger checks ───────────────────────────────────────────────────────────

/** The model sum of a `pi.usage` value; absent: the conversation has no ledger yet, an empty one. */
export function ledgerOf(state: Readonly<LedgerState> | undefined): Totals | undefined {
    const sum: Totals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
    };

    for (const raw of Object.values(state?.models ?? {})) {
        const usage = record(raw);
        const cost = record(usage?.cost)?.total;
        const values = [
            usage?.input,
            usage?.output,
            usage?.cacheRead,
            usage?.cacheWrite,
            usage?.totalTokens,
            cost,
        ];

        if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
            return undefined;
        }

        const [input, output, cacheRead, cacheWrite, totalTokens, total] = values as number[];

        sum.input += input ?? 0;
        sum.output += output ?? 0;
        sum.cacheRead += cacheRead ?? 0;
        sum.cacheWrite += cacheWrite ?? 0;
        sum.totalTokens += totalTokens ?? 0;
        sum.cost += total ?? 0;
    }

    return sum;
}

/** A session's own all-time sum: `before`, every day, and `undated`. */
export function ownTotals(session: Readonly<SessionUsage>): Totals {
    const sum: Totals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
    };
    const parts: Counters[] = [];

    if (session.before !== undefined) {
        parts.push(session.before);
    }

    for (const day of Object.keys(session.days ?? {}).sort()) {
        const models = session.days?.[day] ?? {};

        for (const key of Object.keys(models).sort()) {
            const counters = models[key];

            if (counters !== undefined) {
                parts.push(counters);
            }
        }
    }

    if (session.undated !== undefined) {
        parts.push(session.undated);
    }

    for (const part of parts) {
        sum.input += part.input;
        sum.output += part.output;
        sum.cacheRead += part.cacheRead;
        sum.cacheWrite += part.cacheWrite;
        sum.totalTokens += part.totalTokens;
        sum.cost += part.cost ?? 0;
    }

    return sum;
}

/** Round a cost difference to a billionth of a dollar: the 2 sums add the same costs in another order. */
const roundCost = (value: number): number => Math.round(value * 1e9) / 1e9;

/** The residual of a caught-up session whose ledger is the stored one. */
export function residualOf(session: Readonly<SessionUsage>, ledger: Totals): Residual {
    const malformed = session.skipped?.malformed ?? 0;

    if (malformed > 0) {
        return {
            state: "mismatch",
            why: `${String(malformed)} malformed entr${malformed === 1 ? "y" : "ies"}`,
        };
    }

    const own = ownTotals(session);
    const counters: Totals = {
        input: ledger.input - own.input,
        output: ledger.output - own.output,
        cacheRead: ledger.cacheRead - own.cacheRead,
        cacheWrite: ledger.cacheWrite - own.cacheWrite,
        totalTokens: ledger.totalTokens - own.totalTokens,
        cost: roundCost(ledger.cost - own.cost),
    };
    const tokens = [
        counters.input,
        counters.output,
        counters.cacheRead,
        counters.cacheWrite,
        counters.totalTokens,
    ];

    if (tokens.some((value) => value < 0) || counters.cost < -COST_EPSILON) {
        return { state: "mismatch", why: "the entries add up to more than the ledger", counters };
    }

    if (counters.cost < 0) {
        counters.cost = 0;
    }

    return { state: "settled", counters };
}

/**
 * Apply the ledger checks: a ledger that is not the stored one makes the session dirty (it is read again); the same
 * ledger settles the residual. A ledger that could not be read (undefined) makes the residual unavailable, and keeps
 * the stored ledger and every count; the first such check also makes the session dirty, and later ones leave the
 * reads to `ENTRY_REFRESH_MS`, so sessions whose ledgers keep failing do not take every page of each pass.
 */
export function applyChecks(
    draft: UsageState,
    ledgers: ReadonlyMap<number, Totals | undefined>,
): void {
    for (const [id, ledger] of ledgers) {
        const session = draft.sessions?.[String(id)];

        if (session === undefined || !active(session) || session.caughtUp !== true) {
            continue;
        }

        if (ledger === undefined) {
            if (session.residual?.state !== "unavailable") {
                put(session, "dirty", true);
            }

            put(session, "residual", { state: "unavailable", why: LEDGER_UNREAD });
            continue;
        }

        if (session.ledger === undefined || !same(session.ledger, ledger)) {
            put(session, "dirty", true);
            put(session, "residual", { state: "pending" });
            continue;
        }

        put(session, "residual", residualOf(session, ledger));
    }
}

// ─── Planning ────────────────────────────────────────────────────────────────

/** 1 page of work: read entries (`scan`) or child conversations (`children`). */
export type Work = { kind: "scan" | "children"; id: number; why: number };

/** Whether a session's child discovery is due: never done, not complete, the session changed, or a day old. */
function childrenDue(session: Readonly<SessionUsage>, now: number): boolean {
    const children = session.children;

    return (
        children === undefined ||
        !children.complete ||
        (session.cursor ?? 0) > (children.entry ?? 0) ||
        now - (children.at ?? 0) >= CHILD_REFRESH_MS
    );
}

/**
 * Every due page of work, in order: a new link (never read), an unfinished scan, a dirty session, child discovery, a
 * scan older than `ENTRY_REFRESH_MS`, an error past its retry time. Ties: the lower id first. A session whose page failed waits `USAGE_ERROR_RETRY_MS`.
 */
export function dueWork(state: Readonly<UsageState> | undefined, now: number): Work[] {
    const work: Work[] = [];

    for (const session of Object.values(state?.sessions ?? {}).sort(byNumber)) {
        if (!active(session)) {
            continue;
        }

        const failed = session.error !== undefined && session.errorAt !== undefined;

        if (failed && now - (session.errorAt ?? 0) < USAGE_ERROR_RETRY_MS) {
            continue;
        }

        if (session.scannedAt === undefined) {
            work.push({ kind: "scan", id: session.id, why: 0 });
        } else if (session.caughtUp !== true) {
            work.push({ kind: "scan", id: session.id, why: 1 });
        } else if (session.dirty === true) {
            work.push({ kind: "scan", id: session.id, why: 2 });
        } else if (childrenDue(session, now)) {
            work.push({ kind: "children", id: session.id, why: 3 });
        } else if (now - session.scannedAt >= ENTRY_REFRESH_MS) {
            work.push({ kind: "scan", id: session.id, why: 4 });
        } else if (failed) {
            work.push({ kind: "scan", id: session.id, why: 5 });
        }
    }

    return work.sort((a, b) => a.why - b.why || a.id - b.id);
}

/** Whether a session has work left: it has not caught up, is dirty, failed, or its discovery is not done. */
function hasWork(session: Readonly<SessionUsage>): boolean {
    const children = session.children;

    return (
        session.scannedAt === undefined ||
        session.caughtUp !== true ||
        session.dirty === true ||
        session.error !== undefined ||
        children === undefined ||
        !children.complete ||
        (session.cursor ?? 0) > (children.entry ?? 0)
    );
}

/** `list` turned by `slot` steps of `take`, so that successive slots go round the whole list. */
function rotate<T>(list: readonly T[], slot: number, take: number): T[] {
    if (list.length === 0 || take <= 0) {
        return [];
    }

    const offset = (((Math.floor(slot) * take) % list.length) + list.length) % list.length;

    return [...list.slice(offset), ...list.slice(0, offset)].slice(0, take);
}

/**
 * The sessions to check against their ledgers: every session that caught up in this pass, then at most
 * `MAX_LEDGER_CHECKS` more, from 2 groups that each get half of it: the caught-up sessions with no settled check
 * (pending, unavailable, or never checked), and the rest. A half that 1 group does not use goes to the other. Each
 * group turns by `slot`, so every session is checked within a few passes.
 */
export function planChecks(
    state: Readonly<UsageState> | undefined,
    caught: ReadonlySet<number>,
    slot: number,
): number[] {
    const sessions = Object.values(state?.sessions ?? {})
        .filter(
            (session) => active(session) && session.caughtUp === true && !caught.has(session.id),
        )
        .sort(byNumber);
    const open = sessions.filter(
        (session) => session.residual === undefined || session.residual.state !== "settled",
    );
    const rest = sessions.filter((session) => session.residual?.state === "settled");
    const half = Math.ceil(MAX_LEDGER_CHECKS / 2);
    const openTake = Math.min(open.length, Math.max(half, MAX_LEDGER_CHECKS - rest.length));
    const restTake = Math.min(rest.length, MAX_LEDGER_CHECKS - openTake);

    return [
        ...[...caught].sort((a, b) => a - b),
        ...rotate(open, slot, openTake).map((session) => session.id),
        ...rotate(rest, slot, restTake).map((session) => session.id),
    ];
}

// ─── Source status ───────────────────────────────────────────────────────────

/** The usage source's status after a pass: `changed` says whether the pass changed any session. */
export function applyUsageSource(
    draft: UsageState,
    input: { now: number; boundary: number; changed: boolean },
): void {
    draft.sources ??= {};

    const { now, boundary } = input;
    const linked = Object.values(draft.sessions ?? {}).filter(active);
    const pending = linked.filter(hasWork).length;
    const ledgerUnavailable = linked.filter(
        (session) => session.caughtUp === true && session.residual?.state === "unavailable",
    ).length;
    const complete = pending === 0 && ledgerUnavailable === 0;
    const old = draft.sources.usage;

    if (
        input.changed ||
        old === undefined ||
        !old.ok ||
        old.error !== undefined ||
        old.pending !== pending ||
        old.ledgerUnavailable !== ledgerUnavailable ||
        old.complete !== complete ||
        old.boundary !== boundary
    ) {
        draft.sources.usage = {
            at: now,
            ok: true,
            lastGoodAt: now,
            checkedAt: now,
            pending,
            ledgerUnavailable,
            complete,
            boundary,
        };
    } else if (old.checkedAt === undefined || now - old.checkedAt >= USAGE_HEARTBEAT_MS) {
        old.checkedAt = now;
    }
}

/** A usage step that failed: the source says why, and every usage fact stays. */
export function applyUsageFailure(draft: UsageState, error: string, now: number): void {
    draft.sources ??= {};

    const old = draft.sources.usage;
    const status: UsageSource = {
        ...copy(old ?? { at: now, ok: false }),
        at: now,
        ok: false,
        error,
    };

    if (old?.ok === false && old.error === error) {
        return;
    }

    draft.sources.usage = status;
}

/** Record a failed page on its session: its data stays, and it waits `USAGE_ERROR_RETRY_MS`. */
export function applySessionError(draft: UsageState, id: number, error: string, now: number): void {
    const session = draft.sessions?.[String(id)];

    if (session !== undefined) {
        put(session, "error", error);
        put(session, "errorAt", now);
    }
}

// ─── The pass ────────────────────────────────────────────────────────────────

/** The table reads a usage commit makes. */
export type UsageTx = Pick<Tx, "conversation" | "scanEntries" | "scanConversations">;

/** What a usage step needs: injected, so a test can give fakes. */
export type UsageDeps = {
    /** `x.desk.usage`, outside a commit. */
    readUsage: () => Promise<Readonly<UsageState> | undefined>;
    /** A conversation's `pi.usage`, outside a commit; undefined when it has none. It throws when it cannot read. */
    readLedger: (id: number) => Promise<Readonly<LedgerState> | undefined>;
    /**
     * 1 commit: `change` makes its table reads first, then changes the draft of `x.desk.usage`. False when the
     * collector no longer owns collection: then the commit changed nothing.
     */
    commit: (change: (tx: UsageTx, draft: UsageState) => Promise<void>) => Promise<boolean>;
    signal?: AbortSignal;
};

/** What 1 usage step reads. */
export type UsageInput = {
    desk: Readonly<DeskState>;
    facts: Readonly<Record<string, ThreadFact>>;
    /** The dashboard's recovery boundary. */
    boundary: number;
    now: number;
    /** The round-robin slot of the ledger checks: the pass number, such as `floor(now / PASS_MS)`. */
    slot: number;
};

/** What 1 usage step did. */
export type UsageResult = { pages: number; checks: number };

const aborted = (deps: UsageDeps): boolean => deps.signal?.aborted === true;

/** The ledger sum of a conversation, or undefined when it could not be read. */
async function readTotals(deps: UsageDeps, id: number): Promise<Totals | undefined> {
    try {
        return ledgerOf(await deps.readLedger(id));
    } catch (error) {
        if (aborted(deps)) {
            throw error;
        }

        return undefined;
    }
}

/** 1 page of entries: the conversation, then the entries after the cursor and the fork point. */
async function scanPage(deps: UsageDeps, id: number, context: PageContext): Promise<boolean> {
    return deps.commit(async (tx, draft) => {
        const from = draft.sessions?.[String(id)]?.cursor;
        const conversation = await tx.conversation(id as ConversationId);

        if (conversation === undefined) {
            applyEntryPage(draft, id, { from, entries: [], more: false }, context);

            return;
        }

        const start = Math.max(from ?? 0, conversation.parent?.at ?? 0) + 1;
        const page = await tx.scanEntries(
            {
                conversationId: id as ConversationId,
                minEntryId: start as EntryId,
                order: "ascending",
            },
            ENTRY_PAGE,
        );

        applyEntryPage(
            draft,
            id,
            { from, conversation, entries: page.items, more: page.next !== undefined },
            context,
        );
    });
}

/** 1 page of child conversations. */
async function childPage(
    deps: UsageDeps,
    id: number,
    links: UsageLinks,
    now: number,
): Promise<boolean> {
    return deps.commit(async (tx, draft) => {
        const from = draft.sessions?.[String(id)]?.children?.cursor;
        const conversation = await tx.conversation(id as ConversationId);

        if (conversation === undefined) {
            applyChildPage(draft, id, { from, children: [] }, links, now);

            return;
        }

        const page = await tx.scanConversations(
            { ownerConversationId: id as ConversationId, order: "ascending" },
            CHILD_PAGE,
            from,
        );
        const next: ChildPage = {
            from,
            conversation,
            children: page.items,
        };

        if (page.next !== undefined) {
            next.next = page.next;
        }

        applyChildPage(draft, id, next, links, now);
    });
}

async function runUsage(deps: UsageDeps, input: UsageInput): Promise<UsageResult> {
    const { now, boundary } = input;
    const links = usageLinks(input.desk, input.facts);
    const start = copy((await deps.readUsage()) ?? emptyUsage());
    let view = start;

    const refresh = async (): Promise<void> => {
        view = copy((await deps.readUsage()) ?? emptyUsage());
    };

    // The links first: new sessions, shared sessions, assignments. Only when they change.
    const trial = copy(view);

    relink(trial, links, now);

    if (!same(trial.sessions, view.sessions)) {
        if (!(await deps.commit(async (_tx, draft) => relink(draft, links, now)))) {
            return { pages: 0, checks: 0 };
        }

        await refresh();
    }

    const ledgers = new Map<number, Totals | undefined>();
    const caught = new Set<number>();
    let pages = 0;

    while (pages < MAX_SESSION_PAGES) {
        if (aborted(deps)) {
            throw deps.signal?.reason ?? new Error("aborted");
        }

        const work = dueWork(view, now)[0];

        if (work === undefined) {
            break;
        }

        pages += 1;

        let owned: boolean;

        try {
            if (work.kind === "scan") {
                if (!ledgers.has(work.id)) {
                    ledgers.set(work.id, await readTotals(deps, work.id));
                }

                const context: PageContext = { boundary, now };
                const ledger = ledgers.get(work.id);

                if (ledger !== undefined) {
                    context.ledger = ledger;
                }

                owned = await scanPage(deps, work.id, context);
            } else {
                owned = await childPage(deps, work.id, links, now);
            }
        } catch (error) {
            if (aborted(deps)) {
                throw error;
            }

            // The page's commit failed: nothing of it was stored. The session says why, and waits.
            const text = `${work.kind === "children" ? "children: " : ""}${line(error)}`;

            owned = await deps.commit(async (_tx, draft) => {
                applySessionError(draft, work.id, text, now);
            });
        }

        if (!owned) {
            return { pages, checks: 0 };
        }

        await refresh();

        const session = view.sessions[String(work.id)];

        if (work.kind === "scan" && session?.caughtUp === true && session.error === undefined) {
            caught.add(work.id);
        }
    }

    // The ledger checks, read before the commit, and the source's status, in 1 commit, only when something changes.
    const checks = planChecks(view, caught, input.slot);
    const fresh = new Map<number, Totals | undefined>();

    for (const id of checks) {
        if (aborted(deps)) {
            throw deps.signal?.reason ?? new Error("aborted");
        }

        fresh.set(id, await readTotals(deps, id));
    }

    const final = copy(view);

    applyChecks(final, fresh);

    const changed = !same(start.sessions, final.sessions);

    applyUsageSource(final, { now, boundary, changed });

    if (!same(final, view)) {
        await deps.commit(async (_tx, draft) => {
            applyChecks(draft, fresh);
            applyUsageSource(draft, { now, boundary, changed });
        });
    }

    return { pages, checks: checks.length };
}

/**
 * 1 usage step: the links, at most `MAX_SESSION_PAGES` pages (each its own commit), then the ledger checks and the
 * source's status in 1 commit. A failure is recorded on the source and keeps every fact; an abort throws.
 */
export async function usagePass(deps: UsageDeps, input: UsageInput): Promise<UsageResult> {
    try {
        return await runUsage(deps, input);
    } catch (error) {
        if (aborted(deps)) {
            throw error;
        }

        const text = line(error);

        try {
            await deps.commit(async (_tx, draft) => applyUsageFailure(draft, text, input.now));
        } catch (again) {
            if (aborted(deps)) {
                throw again;
            }
        }

        return { pages: 0, checks: 0 };
    }
}
