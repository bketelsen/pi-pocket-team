/**
 * The dashboard's sources: facts about the desk's threads, the PRs they track, and the issues they work on, kept in
 * `x.desk.dashboard`. A collector task reads `x.desk.threads` (it never writes it), reads GitHub for the tracked refs
 * that are due, at most `MAX_REF_READS` in 1 query, and then writes what changed in 1 commit. It sleeps `PASS_MS`
 * between passes. Before the GitHub call, a pass runs the usage step of `_desk-usage.ts` (`x.desk.usage`): its own
 * small commits, which never write `x.desk.dashboard`.
 *
 * Pocket does not load this file as a module: the `_` prefix keeps it out. `desk.ts` imports it, and gives it what it
 * needs at run time (the threads' document token, the `gh` path), so this file never imports `desk.ts` at run time.
 *
 * All times are epoch milliseconds (UTC). An absent value is unknown: no field stores 0 for unknown. A failed read
 * keeps every fact it had, and never counts as an empty answer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    defineDoc,
    defineTask,
    UsageDoc,
    type ConversationId,
    type SessionDocToken,
    type TaskId,
    type Tx,
} from "@earendil-works/pi-durable";
import type { CloseOutcome, DeskState, PrLink, Thread } from "./desk.ts";
import type * as UsageModule from "./_desk-usage.ts";

/**
 * The usage helper, loaded fresh with each load of this module, as `desk.ts` loads this one: Pocket does not reload a
 * `_` helper by itself. In tests this module has no query, so a test's static import of `./_desk-usage.ts` gets the
 * same instance.
 */
const usage = (await import(
    new URL(`./_desk-usage.ts${new URL(import.meta.url).search}`, import.meta.url).href
)) as typeof UsageModule;

// ─── Limits ──────────────────────────────────────────────────────────────────

/** How long the collector sleeps between passes. A new collector waits this long before its first pass. */
export const PASS_MS = 5 * 60_000;
/** The most ref reads in 1 pass: PR reads, issue reads and closing-reference page reads share it. */
export const MAX_REF_READS = 20;
/** An open PR or issue is read again after this long. */
export const OPEN_REFRESH_MS = 30 * 60_000;
/** A closed-unmerged PR or a closed issue is read again after this long. A merged PR is not read again. */
export const CLOSED_REFRESH_MS = 24 * 3600_000;
/** A ref whose read failed is read again after this long. */
export const ERROR_RETRY_MS = 15 * 60_000;
/** After a rate limit with no reset time, no GitHub read for this long. */
export const RATE_BACKOFF_MS = 15 * 60_000;
/** The most pages of closing references read for 1 issue, 25 refs each. */
export const MAX_CLOSING_PAGES = 4;
/** The recovery boundary: this many days before the first pass. */
export const BOUNDARY_DAYS = 90;
/** Under this many GitHub points left, the collector waits until the rate limit resets. */
export const RATE_FLOOR = 100;
/** A pass with no change writes `checkedAt` only when the stored value is older than this. */
export const CHECK_HEARTBEAT_MS = 3600_000;
/** The collector's task name. */
export const COLLECTOR_TASK = "x.desk.dashboard-collector";

const DAY_MS = 24 * 3600_000;
const CLOSING_PAGE = 25;

// ─── Stored state ────────────────────────────────────────────────────────────

/** Why a source failed. */
export type FailureKind = "auth" | "rate" | "network" | "partial" | "other";

/** The state of 1 source. Stored data: never rename a field or change what it means. */
export type SourceStatus = {
    /** The last pass that changed this status or the facts of this source. A pass with no change does not move it. */
    at: number;
    /** Whether that pass read the source. */
    ok: boolean;
    /** Why it failed: 1 line. */
    error?: string;
    kind?: FailureKind;
    /** The last pass that read the source with no failure and wrote this status. */
    lastGoodAt?: number;
    /**
     * The last pass that read the source with no failure, to within `CHECK_HEARTBEAT_MS`: a pass with no change writes
     * it only when the stored value is older than that. A later reader tells a fresh source from a stale one by it.
     * Absent on a status from before the field.
     */
    checkedAt?: number;
    /** The refs whose part of the answer had an error: the rest of the answer counts. */
    partial?: string[];
};

/** The state of the GitHub source. Stored data: never rename a field or change what it means. */
export type GitHubSource = {
    /** The last pass that read GitHub. Absent: no pass read GitHub yet. */
    at?: number;
    /** Whether that read worked: false also when no requested ref read worked (kind "partial"). */
    ok?: boolean;
    /** Why it failed, or, with `ok` true, an error of the answer that belongs to no ref: 1 line. */
    error?: string;
    kind?: FailureKind;
    /** The last read with no failure. */
    lastGoodAt?: number;
    /**
     * The refs with a problem in the whole stored state, sorted and unique: each ref with a stored `error`, each ref of
     * the last answer whose part had an error (also a deeper error beside good data), and each earlier entry until a
     * clean read of it (an ok result with no error in its part). A failure of the whole read reads nothing cleanly, so
     * the earlier entries stay. Each of the 3 takes only a tracked ref, and a PR only when it is not excluded: a
     * missing or archived PR, or one linked only by the window rule, is never a coverage gap. Absent: none.
     */
    partial?: string[];
    /** No GitHub read before this time: a rate limit. */
    backoffUntil?: number;
    /** The due ref reads left after the last pass. */
    pending?: number;
    /**
     * The whole stored state is complete: every tracked PR is excluded, or has a good read, no gaps and no error; every
     * tracked issue has a good read, no gaps, no error, and is not `incomplete`; and `partial` is empty.
     */
    complete?: boolean;
    /** GitHub's points left after the last read. */
    rateRemaining?: number;
};

/** A thread's place in the counts. */
export type ThreadRole = "delivery" | "coordinator" | "excluded";

/** 1 desk thread, as the dashboard counts it. Stored data: never rename a field or change what it means. */
export type ThreadFact = {
    id: string;
    origin: Thread["origin"];
    /** delivery: it counts; coordinator: a plan thread whose task threads count; excluded: it does not count. */
    role: ThreadRole;
    /** Why an excluded thread does not count. */
    excluded?: "ask-only" | "no-work";
    /** `thread.repo`, only when it is exactly "owner/name". */
    repo?: string;
    state: Thread["state"];
    startedAt?: number;
    /** The latest closure, only while the thread is closed. `outcome` is absent on old records: unknown. */
    closed?: { at?: number; why: "done" | "dropped" | "failed"; outcome?: CloseOutcome };
    session?: number;
    supervisor?: number;
    /** On a task thread: its plan thread and task id. */
    plan?: string;
    task?: string;
    /** The lowercased refs of its attributable PRs (not `via: "window"`), sorted. */
    prs: string[];
    /** The lowercased refs of its issues, sorted. */
    issues: string[];
    /** The fields left out because their value was not valid. */
    invalid?: string[];
    /** When a pass found the thread gone from `x.desk.threads`. The fact stays. */
    goneAt?: number;
};

/** A desk link state. */
export type DeskPrState = NonNullable<PrLink["state"]>;

/** 1 tracked PR's lifecycle. Stored data: never rename a field or change what it means. */
export type PrFact = {
    /** "owner/name#n", in the case the first thread used. */
    ref: string;
    repo: string;
    number: number;
    /** The threads that link it, sorted. */
    threads: string[];
    /** How the threads link it, sorted, unique. */
    via: string[];
    /** The newest desk link state. */
    deskState?: DeskPrState;
    /** Why it is out of the outcome counts: only `via: "window"` links, missing, or archived. It is still counted. */
    excluded?: "window" | "missing" | "frozen";
    /** What GitHub itself said: NOT_FOUND (missing), or an archived repository (frozen). */
    github?: "missing" | "frozen";
    state?: "OPEN" | "MERGED" | "CLOSED";
    /** GitHub's `createdAt`, `mergedAt` and `closedAt`: never the fetch time. */
    createdAt?: number;
    mergedAt?: number;
    closedAt?: number;
    /** The fetch time of the last good read. */
    readAt?: number;
    /** Why the last read of this ref failed: "NOT_FOUND", "FORBIDDEN", or 1 line. */
    error?: string;
    errorAt?: number;
    /** When a pass saw the PR open again after it was closed. */
    reopenedAt?: number;
    /**
     * The lifecycle times its state needs that the stored facts lack: OPEN needs `createdAt`; MERGED needs `createdAt`,
     * `mergedAt` and `closedAt`; CLOSED needs `createdAt` and `closedAt`. A PR with gaps is read again after
     * `CLOSED_REFRESH_MS`, also when it is merged, and the source is not complete. Absent: no gap.
     */
    gaps?: string[];
    /** No thread links it any more: it is not read again. */
    untracked?: true;
};

/** Why an issue has no time-to-solve sample. */
export type Unresolved =
    | "open"
    | "not-planned"
    | "no-resolving-pr"
    | "ambiguous"
    | "incomplete"
    | "missing"
    | "inaccessible"
    | "invalid";

/** 1 tracked issue, for time to solve. Stored data: never rename a field or change what it means. */
export type IssueFact = {
    ref: string;
    repo: string;
    number: number;
    threads: string[];
    /** The plans that name it as their issue. */
    plans: string[];
    state?: "OPEN" | "CLOSED";
    stateReason?: string;
    createdAt?: number;
    closedAt?: number;
    readAt?: number;
    /**
     * The times its state needs that the stored facts lack: OPEN needs `createdAt`; CLOSED needs `createdAt` and
     * `closedAt`. The source is not complete while an issue has gaps. Absent: no gap.
     */
    gaps?: string[];
    /**
     * The PR that resolved it (lowercased ref, maybe in another repository), its merge time, and the evidence. Only the
     * latest close by a merged PR (`closed-event`) gives it now. `closing-reference` is from an older rule (1 merged
     * closing reference before the close): it is no sample now. Each pass marks such a fact `unresolved: "ambiguous"`
     * and keeps the resolution, so the fact is read again at once and judged by the current rule.
     */
    resolution?: {
        pr: string;
        mergedAt: number;
        evidence: "closed-event" | "closing-reference";
        /** When a pass found this resolution. */
        at: number;
    };
    /**
     * Why there is no sample. It wins over an older `resolution` that a missing or inaccessible read kept, and over a
     * stored `closing-reference` resolution (marked "ambiguous" until a good read judges it again).
     */
    unresolved?: Unresolved;
    /**
     * The merged closing references read so far (lowercased refs with their merge time), whether every page is read,
     * the cursor of the next page, and the pages read. A cursor stays only for a closed issue with no visible latest
     * close and no merged reference read yet: the references only tell `ambiguous` from `no-resolving-pr`.
     */
    closing?: {
        merged: { ref: string; mergedAt?: number }[];
        complete: boolean;
        cursor?: string;
        pages: number;
    };
    error?: string;
    errorAt?: number;
    untracked?: true;
};

/** The dashboard's document. Stored data: never rename a field or change what it means. */
export type DashboardState = {
    /** When the first pass ran. */
    initializedAt?: number;
    /** The recovery boundary, fixed at the first pass: `initializedAt` - 90 days. It never moves. */
    boundary?: number;
    /** The collector task that owns collection: another collector that finds a different id ends. */
    collector?: string;
    /** By thread id. */
    threads: Record<string, ThreadFact>;
    /** By lowercased "owner/name#n". */
    prs: Record<string, PrFact>;
    /** By lowercased "owner/name#n". */
    issues: Record<string, IssueFact>;
    sources: { threads?: SourceStatus; github?: GitHubSource };
};

const empty = (): DashboardState => ({ threads: {}, prs: {}, issues: {}, sources: {} });

/** The dashboard's facts, app-wide as `x.desk.threads` is. */
export const DeskDashboard = defineDoc<DashboardState>({
    kind: "x.desk.dashboard",
    version: 1,
    scope: "session",
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => empty(),
});

// ─── Small rules ─────────────────────────────────────────────────────────────

const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF = /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9][0-9]*)$/;
/** A GitHub page cursor that may go into a query. */
const CURSOR = /^[A-Za-z0-9+/=_:-]{1,200}$/;
/** An ISO 8601 time with a zone, as GitHub gives it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A repository name that may go into a query: exactly "owner/name". The same rule as `isRepoName` in desk.ts. */
export function isRepoName(name: unknown): name is string {
    if (typeof name !== "string") {
        return false;
    }

    const parts = name.split("/");

    return parts.length === 2 && OWNER_NAME.test(parts[0] ?? "") && OWNER_NAME.test(parts[1] ?? "");
}

/** A ref "owner/name#n" as its parts, or undefined when it is not valid. */
export function splitRef(ref: unknown): { repo: string; number: number } | undefined {
    if (typeof ref !== "string") {
        return undefined;
    }

    const match = REF.exec(ref);
    const number = Number(match?.[2]);

    if (match === null || !Number.isSafeInteger(number)) {
        return undefined;
    }

    return { repo: match[1] ?? "", number };
}

/** A stored time: a finite number above 0. */
export const validTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;

/** GitHub's ISO time as epoch milliseconds, or undefined. */
export function parseTime(value: unknown): number | undefined {
    if (typeof value !== "string" || !ISO_TIME.test(value)) {
        return undefined;
    }

    const at = Date.parse(value);

    return validTime(at) ? at : undefined;
}

/** Thread ids in a stable order: T2 before T10. */
const byId = (a: string, b: string): number =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "variant" });

/** A deep compare of JSON values. An absent key and an undefined value are the same. */
export function same(a: unknown, b: unknown): boolean {
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

/** Set 1 field only when its value changes; undefined deletes it. True when it wrote. */
function put<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: T[K] | undefined,
): boolean {
    if (value === undefined) {
        if (target[key] === undefined) {
            return false;
        }

        delete target[key];

        return true;
    }

    if (same(target[key], value)) {
        return false;
    }

    target[key] = copy(value);

    return true;
}

// ─── Threads ─────────────────────────────────────────────────────────────────

/** The fact of 1 thread. `coordinators` holds the plan threads that have at least 1 task thread. */
function threadFact(id: string, thread: Thread, coordinators: ReadonlySet<string>): ThreadFact {
    const invalid: string[] = [];
    const prs = new Set<string>();

    for (const [ref, link] of Object.entries(thread.prs ?? {})) {
        if (link?.via !== "window" && splitRef(ref) !== undefined) {
            prs.add(ref.toLowerCase());
        }
    }

    const issues = new Set<string>();

    for (const ref of thread.issues ?? []) {
        if (splitRef(ref) !== undefined) {
            issues.add(ref.toLowerCase());
        }
    }

    const fact: ThreadFact = {
        id,
        origin: thread.origin,
        role: "delivery",
        state: thread.state,
        prs: [...prs].sort(),
        issues: [...issues].sort(),
    };
    const task = thread.planTask;

    if (task !== undefined && typeof task.plan === "string" && typeof task.task === "string") {
        fact.plan = task.plan;
        fact.task = task.task;
    } else if (thread.origin === "plan" && coordinators.has(id)) {
        fact.role = "coordinator";
    } else if (thread.origin !== "delegate") {
        // A found, seeded, or asked thread, or a plan thread with no task thread: it counts when it has work.
        if (thread.session === undefined && prs.size === 0) {
            fact.role = "excluded";
            fact.excluded = thread.origin === "ask" ? "ask-only" : "no-work";
        }
    }

    if (thread.repo !== undefined) {
        if (isRepoName(thread.repo)) {
            fact.repo = thread.repo;
        } else {
            invalid.push("repo");
        }
    }

    if (validTime(thread.startedAt)) {
        fact.startedAt = thread.startedAt;
    } else {
        invalid.push("startedAt");
    }

    if (thread.state === "closed" && thread.closed !== undefined) {
        const closed: NonNullable<ThreadFact["closed"]> = { why: thread.closed.why };

        if (validTime(thread.closed.at)) {
            closed.at = thread.closed.at;
        } else {
            invalid.push("closed.at");
        }

        if (thread.closed.outcome !== undefined) {
            closed.outcome = thread.closed.outcome;
        }

        fact.closed = closed;
    }

    if (typeof thread.session === "number" && Number.isFinite(thread.session)) {
        fact.session = thread.session;
    }

    if (typeof thread.supervisor === "number" && Number.isFinite(thread.supervisor)) {
        fact.supervisor = thread.supervisor;
    }

    if (invalid.length > 0) {
        fact.invalid = invalid;
    }

    return fact;
}

/** The facts of every thread in `x.desk.threads`, open and closed. */
export function threadFacts(desk: Readonly<DeskState> | undefined): Record<string, ThreadFact> {
    const facts: Record<string, ThreadFact> = {};
    const threads = Object.entries(desk?.threads ?? {}).sort(([a], [b]) => byId(a, b));
    const coordinators = new Set<string>();

    for (const [, thread] of threads) {
        if (typeof thread?.planTask?.plan === "string") {
            coordinators.add(thread.planTask.plan);
        }
    }

    for (const [id, thread] of threads) {
        if (thread !== undefined && thread !== null) {
            facts[id] = threadFact(id, thread, coordinators);
        }
    }

    return facts;
}

// ─── Tracked refs ────────────────────────────────────────────────────────────

/** 1 tracked PR, as the desk links it now. */
export type TrackedPr = {
    key: string;
    ref: string;
    repo: string;
    number: number;
    threads: string[];
    via: string[];
    deskState?: DeskPrState;
    /** When the desk read the link that gave `deskState`. */
    deskReadAt?: number;
};

/** 1 tracked issue, as the desk links it now. */
export type TrackedIssue = {
    key: string;
    ref: string;
    repo: string;
    number: number;
    threads: string[];
    plans: string[];
};

/** The PR and issue populations, by lowercased ref. */
export type Tracked = { prs: Record<string, TrackedPr>; issues: Record<string, TrackedIssue> };

const DESK_STATES = new Set<string>(["OPEN", "MERGED", "CLOSED", "FROZEN", "MISSING"]);

/**
 * The tracked PRs (every ref in any thread's `prs`, open and closed threads, never `otherPrs`) and the tracked issues
 * (every thread's `issues` and every plan's `issue`), each with the threads and plans that link it.
 */
export function trackedRefs(desk: Readonly<DeskState> | undefined): Tracked {
    const prs: Record<string, TrackedPr> = {};
    const issues: Record<string, TrackedIssue> = {};
    const threads = Object.entries(desk?.threads ?? {}).sort(([a], [b]) => byId(a, b));

    const issueOf = (ref: string): TrackedIssue | undefined => {
        const parts = splitRef(ref);

        if (parts === undefined) {
            return undefined;
        }

        const key = ref.toLowerCase();

        issues[key] ??= { key, ref, ...parts, threads: [], plans: [] };

        return issues[key];
    };

    for (const [id, thread] of threads) {
        for (const [ref, link] of Object.entries(thread?.prs ?? {})) {
            const parts = splitRef(ref);

            if (parts === undefined || link === undefined || link === null) {
                continue;
            }

            const key = ref.toLowerCase();
            const tracked = (prs[key] ??= { key, ref, ...parts, threads: [], via: [] });

            if (!tracked.threads.includes(id)) {
                tracked.threads.push(id);
            }

            if (typeof link.via === "string" && !tracked.via.includes(link.via)) {
                tracked.via.push(link.via);
            }

            if (link.state !== undefined && DESK_STATES.has(link.state)) {
                const readAt = validTime(link.readAt) ? link.readAt : undefined;

                // The newest read wins; a link with no read time gives a state only when no other does.
                if (
                    tracked.deskState === undefined ||
                    (readAt !== undefined && readAt > (tracked.deskReadAt ?? 0))
                ) {
                    tracked.deskState = link.state;

                    if (readAt === undefined) {
                        delete tracked.deskReadAt;
                    } else {
                        tracked.deskReadAt = readAt;
                    }
                }
            }
        }

        for (const ref of thread?.issues ?? []) {
            const issue = issueOf(ref);

            if (issue !== undefined && !issue.threads.includes(id)) {
                issue.threads.push(id);
            }
        }
    }

    for (const [id, plan] of Object.entries(desk?.plans ?? {}).sort(([a], [b]) => byId(a, b))) {
        const issue = plan?.issue === undefined ? undefined : issueOf(plan.issue);

        if (issue !== undefined && !issue.plans.includes(id)) {
            issue.plans.push(id);
        }
    }

    for (const pr of Object.values(prs)) {
        pr.threads.sort(byId);
        pr.via.sort();
    }

    for (const issue of Object.values(issues)) {
        issue.threads.sort(byId);
        issue.plans.sort(byId);
    }

    return { prs, issues };
}

/** Why a PR is out of the outcome counts, from its links and GitHub's own answer. */
function prExcluded(
    via: readonly string[],
    deskState: DeskPrState | undefined,
    github: PrFact["github"],
): PrFact["excluded"] {
    if (!via.some((each) => each !== "window")) {
        return "window";
    }

    if (deskState === "MISSING" || github === "missing") {
        return "missing";
    }

    if (deskState === "FROZEN" || github === "frozen") {
        return "frozen";
    }

    return undefined;
}

// ─── Read planning ───────────────────────────────────────────────────────────

/** 1 ref read: a PR, an issue, or the next page of an issue's closing references. */
export type Read = {
    kind: "pr" | "issue" | "closing";
    /** The lowercased ref. */
    key: string;
    owner: string;
    name: string;
    number: number;
    /** A closing read: the page cursor. */
    cursor?: string;
    /** The order class: 0 never read, 1 the desk saw a change, 2 an error to retry, 3 a closing page, 4 open, 5 closed. */
    why: number;
};

/** How long a ref waits after a failed read: a missing or forbidden ref waits as a closed one does. */
const retryMs = (error: string): number =>
    error === "NOT_FOUND" || error === "FORBIDDEN" ? CLOSED_REFRESH_MS : ERROR_RETRY_MS;

/** A ref's order class now, or undefined when it is not due. */
function prDue(
    fact: Readonly<PrFact> | undefined,
    tracked: TrackedPr,
    now: number,
): number | undefined {
    const github = fact?.github;

    if (
        prExcluded(tracked.via, tracked.deskState, undefined) !== undefined ||
        fact?.untracked === true
    ) {
        return undefined;
    }

    if (fact === undefined || (fact.readAt === undefined && fact.errorAt === undefined)) {
        return 0;
    }

    const desk = tracked.deskState;

    if (
        (desk === "OPEN" || desk === "MERGED" || desk === "CLOSED") &&
        fact.state !== undefined &&
        desk !== fact.state &&
        tracked.deskReadAt !== undefined &&
        tracked.deskReadAt > (fact.readAt ?? 0)
    ) {
        return 1;
    }

    if (fact.error !== undefined && fact.errorAt !== undefined) {
        return now - fact.errorAt >= retryMs(fact.error) ? 2 : undefined;
    }

    const age = now - (fact.readAt ?? 0);

    if (github === "frozen") {
        return age >= CLOSED_REFRESH_MS ? 5 : undefined;
    }

    if (fact.state === "OPEN") {
        return age >= OPEN_REFRESH_MS ? 4 : undefined;
    }

    if (fact.state === "CLOSED") {
        return age >= CLOSED_REFRESH_MS ? 5 : undefined;
    }

    // MERGED is final, unless the desk says OPEN (above), or a lifecycle time is missing: then once a day.
    if (fact.state === "MERGED") {
        return (fact.gaps?.length ?? 0) > 0 && age >= CLOSED_REFRESH_MS ? 5 : undefined;
    }

    // No state with a read: the read gave nothing; read again.
    return age >= ERROR_RETRY_MS ? 2 : undefined;
}

/** An issue's read kind and order class now, or undefined when it is not due. */
function issueDue(
    fact: Readonly<IssueFact> | undefined,
    now: number,
): { kind: "issue" | "closing"; why: number } | undefined {
    if (fact?.untracked === true) {
        return undefined;
    }

    if (fact === undefined || (fact.readAt === undefined && fact.errorAt === undefined)) {
        return { kind: "issue", why: 0 };
    }

    const cursor = fact.closing?.cursor;
    const kind = cursor === undefined ? "issue" : "closing";

    if (fact.error !== undefined && fact.errorAt !== undefined) {
        return now - fact.errorAt >= retryMs(fact.error) ? { kind, why: 2 } : undefined;
    }

    // A resolution from the older closing-reference rule is no evidence now: read the issue again at once, so the
    // current rule judges it.
    if (fact.resolution?.evidence === "closing-reference") {
        return { kind: "issue", why: 1 };
    }

    if (cursor !== undefined) {
        return { kind: "closing", why: 3 };
    }

    const age = now - (fact.readAt ?? 0);

    if (fact.state === "OPEN") {
        return age >= OPEN_REFRESH_MS ? { kind: "issue", why: 4 } : undefined;
    }

    if (fact.state === "CLOSED") {
        return age >= CLOSED_REFRESH_MS ? { kind: "issue", why: 5 } : undefined;
    }

    return age >= ERROR_RETRY_MS ? { kind: "issue", why: 2 } : undefined;
}

/** Every due read, in order, with no budget and no backoff. */
function dueReads(dashboard: Readonly<DashboardState>, tracked: Tracked, now: number): Read[] {
    const due: { read: Read; readAt: number }[] = [];

    const split = (repo: string) => {
        const [owner = "", name = ""] = repo.split("/");

        return { owner, name };
    };

    for (const pr of Object.values(tracked.prs)) {
        const fact = dashboard.prs?.[pr.key];
        const why = prDue(fact, pr, now);

        if (why !== undefined) {
            due.push({
                read: { kind: "pr", key: pr.key, ...split(pr.repo), number: pr.number, why },
                readAt: fact?.readAt ?? 0,
            });
        }
    }

    for (const issue of Object.values(tracked.issues)) {
        const fact = dashboard.issues?.[issue.key];
        const plan = issueDue(fact, now);

        if (plan === undefined) {
            continue;
        }

        const read: Read = {
            kind: plan.kind,
            key: issue.key,
            ...split(issue.repo),
            number: issue.number,
            why: plan.why,
        };

        if (plan.kind === "closing" && fact?.closing?.cursor !== undefined) {
            read.cursor = fact.closing.cursor;
        }

        due.push({ read, readAt: fact?.readAt ?? 0 });
    }

    due.sort(
        (a, b) =>
            a.read.why - b.read.why ||
            a.readAt - b.readAt ||
            (a.read.key < b.read.key ? -1 : a.read.key > b.read.key ? 1 : 0) ||
            a.read.kind.localeCompare(b.read.kind),
    );

    return due.map((each) => each.read);
}

/**
 * The due ref reads, at most `budget`, in order: never read; the desk saw a change (a reopen or a close); an error past
 * its retry time; an issue's next closing page; open past `OPEN_REFRESH_MS`; closed past `CLOSED_REFRESH_MS`. Ties:
 * the oldest read first, then the ref. Nothing during a rate-limit backoff.
 */
export function planReads(
    dashboard: Readonly<DashboardState> | undefined,
    tracked: Tracked,
    now: number,
    budget = MAX_REF_READS,
): Read[] {
    const state = dashboard ?? empty();
    const backoff = state.sources?.github?.backoffUntil;

    if (backoff !== undefined && backoff > now) {
        return [];
    }

    return dueReads(state, tracked, now).slice(0, Math.max(0, budget));
}

// ─── The query ───────────────────────────────────────────────────────────────

const PR_FIELDS = "isArchived pullRequest(number: %n) { state createdAt mergedAt closedAt }";
const CLOSING_FIELDS =
    "pageInfo { hasNextPage endCursor } nodes { number merged mergedAt repository { nameWithOwner } }";
const ISSUE_FIELDS =
    "isArchived issue(number: %n) { state stateReason createdAt closedAt " +
    "timelineItems(itemTypes: [CLOSED_EVENT, REOPENED_EVENT], last: 1) { nodes { __typename " +
    "... on ClosedEvent { createdAt closer { __typename " +
    "... on PullRequest { number merged mergedAt repository { nameWithOwner } } } } } } " +
    `closedByPullRequestsReferences(first: ${String(CLOSING_PAGE)}, includeClosedPrs: true) { ${CLOSING_FIELDS} } }`;

/** Whether a read may go into a query: every part is checked again here. */
function safeRead(read: Read): boolean {
    return (
        OWNER_NAME.test(read.owner) &&
        OWNER_NAME.test(read.name) &&
        Number.isSafeInteger(read.number) &&
        read.number > 0 &&
        (read.kind !== "closing" || (read.cursor !== undefined && CURSOR.test(read.cursor)))
    );
}

/** The alias of the read at `index`: `p0`, `i1`, `c2`. */
const aliasOf = (read: Read, index: number): string =>
    `${read.kind === "pr" ? "p" : read.kind === "issue" ? "i" : "c"}${String(index)}`;

/**
 * 1 GraphQL query for the reads, each under its alias, and the rate limit. A read that is not valid is left out. Every
 * value goes in through `JSON.stringify` or as a checked number: no raw input reaches the query.
 */
export function buildQuery(reads: readonly Read[]): string {
    const parts: string[] = [];

    reads.forEach((read, index) => {
        if (!safeRead(read)) {
            return;
        }

        const repository = `repository(owner: ${JSON.stringify(read.owner)}, name: ${JSON.stringify(read.name)})`;
        const number = String(read.number);
        const alias = aliasOf(read, index);

        if (read.kind === "pr") {
            parts.push(`${alias}: ${repository} { ${PR_FIELDS.replace("%n", number)} }`);
        } else if (read.kind === "issue") {
            parts.push(`${alias}: ${repository} { ${ISSUE_FIELDS.replace("%n", number)} }`);
        } else {
            parts.push(
                `${alias}: ${repository} { issue(number: ${number}) { closedByPullRequestsReferences(first: ${String(CLOSING_PAGE)}, includeClosedPrs: true, after: ${JSON.stringify(read.cursor)}) { ${CLOSING_FIELDS} } } }`,
            );
        }
    });

    return `query { rateLimit { remaining resetAt } ${parts.join(" ")} }`;
}

// ─── The answer ──────────────────────────────────────────────────────────────

/** 1 page of closing references. */
export type ClosingPage = {
    merged: { ref: string; mergedAt?: number }[];
    hasNext: boolean;
    cursor?: string;
};

/** The closer of an issue's latest close, when its latest event is a close. */
export type Closer =
    | { type: "none" }
    | { type: "PullRequest"; ref?: string; merged: boolean; mergedAt?: number }
    | { type: "other"; name: string };

/** The result of 1 read. */
export type ReadResult =
    | {
          kind: "pr";
          key: string;
          ok: true;
          archived: boolean;
          state?: "OPEN" | "MERGED" | "CLOSED";
          createdAt?: number;
          mergedAt?: number;
          closedAt?: number;
      }
    | {
          kind: "issue";
          key: string;
          ok: true;
          archived: boolean;
          state?: "OPEN" | "CLOSED";
          stateReason?: string;
          createdAt?: number;
          closedAt?: number;
          /** Absent: the latest event is not a close (a reopen, or no event). */
          closer?: Closer;
          closing: ClosingPage;
      }
    | { kind: "closing"; key: string; ok: true; cursor: string; closing: ClosingPage }
    | { kind: Read["kind"]; key: string; ok: false; error: string; cursor?: string };

/** What 1 GitHub answer said. */
export type Answer = {
    results: ReadResult[];
    rate?: { remaining: number; resetAt?: number };
    /** The refs whose part of the answer had an error, and every ref whose read failed. */
    partial: string[];
    /** GitHub said RATE_LIMITED. */
    rateLimited: boolean;
    /** The errors with no alias path (they belong to no read), 1 line each. */
    errors: string[];
};

const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

/** A PR node of a closing list or a closer as a lowercased ref, or undefined. */
function prRefOf(node: Record<string, unknown> | undefined): string | undefined {
    const repo = record(node?.repository)?.nameWithOwner;
    const number = node?.number;

    if (!isRepoName(repo) || typeof number !== "number" || !Number.isSafeInteger(number)) {
        return undefined;
    }

    const ref = `${repo}#${String(number)}`;

    return splitRef(ref) === undefined ? undefined : ref.toLowerCase();
}

/** Whether a closing-reference list is there: its `nodes` array and its `pageInfo`. */
const closingList = (value: unknown): boolean =>
    Array.isArray(record(value)?.nodes) && record(record(value)?.pageInfo) !== undefined;

function closingPage(value: unknown): ClosingPage {
    const list = record(value);
    const info = record(list?.pageInfo);
    const merged: { ref: string; mergedAt?: number }[] = [];

    for (const raw of Array.isArray(list?.nodes) ? list.nodes : []) {
        const node = record(raw);
        const ref = prRefOf(node);

        if (ref === undefined || node?.merged !== true || merged.some((m) => m.ref === ref)) {
            continue;
        }

        const mergedAt = parseTime(node.mergedAt);

        merged.push(mergedAt === undefined ? { ref } : { ref, mergedAt });
    }

    const hasNext = info?.hasNextPage === true;
    const cursor = info?.endCursor;
    const page: ClosingPage = { merged, hasNext };

    if (hasNext && typeof cursor === "string" && CURSOR.test(cursor)) {
        page.cursor = cursor;
    }

    return page;
}

function closerOf(timeline: unknown): Closer | undefined {
    const nodes = record(timeline)?.nodes;
    const last = Array.isArray(nodes) ? record(nodes[nodes.length - 1]) : undefined;

    if (last?.__typename !== "ClosedEvent") {
        return undefined;
    }

    const closer = record(last.closer);

    if (closer === undefined) {
        return { type: "none" };
    }

    if (closer.__typename === "PullRequest") {
        const result: Closer = { type: "PullRequest", merged: closer.merged === true };
        const ref = prRefOf(closer);
        const mergedAt = parseTime(closer.mergedAt);

        if (ref !== undefined) {
            result.ref = ref;
        }

        if (mergedAt !== undefined) {
            result.mergedAt = mergedAt;
        }

        return result;
    }

    return { type: "other", name: typeof closer.__typename === "string" ? closer.__typename : "?" };
}

/** 1 line of an error, at most 200 characters. */
const line = (text: string): string =>
    (
        text
            .split("\n")
            .map((each) => each.trim())
            .find((each) => each !== "") ?? ""
    ).slice(0, 200);

/**
 * Each read's result from 1 GraphQL answer. An error is matched to its read by its alias path: NOT_FOUND and FORBIDDEN
 * on the alias or its PR or issue node fail that read only; an error deeper in the path keeps the node's data. A read
 * with no data and no error failed with "no answer". The rest of the answer counts (a partial answer).
 */
export function parseAnswer(json: unknown, reads: readonly Read[]): Answer {
    const answer = record(json);
    const data = record(answer?.data) ?? {};
    const errors = Array.isArray(answer?.errors) ? answer.errors : [];
    const results: ReadResult[] = [];
    const partial: string[] = [];
    let rateLimited = false;

    const aliases = new Set(reads.map((read, index) => aliasOf(read, index)));
    const unscoped: string[] = [];

    for (const raw of errors) {
        const error = record(raw);

        if (error?.type === "RATE_LIMITED") {
            rateLimited = true;
        }

        const path = error?.path;

        if (!Array.isArray(path) || typeof path[0] !== "string" || !aliases.has(path[0])) {
            const text = typeof error?.message === "string" ? line(error.message) : "";

            unscoped.push(text === "" ? "GitHub gave an error" : text);
        }
    }

    reads.forEach((read, index) => {
        const alias = aliasOf(read, index);
        const own = errors
            .map((raw) => record(raw))
            .filter((error) => Array.isArray(error?.path) && error.path[0] === alias);
        const repo = record(data[alias]);
        const node = read.kind === "pr" ? record(repo?.pullRequest) : record(repo?.issue);

        const fail = (error: string): void => {
            const result: ReadResult = { kind: read.kind, key: read.key, ok: false, error };

            if (read.cursor !== undefined) {
                result.cursor = read.cursor;
            }

            results.push(result);

            if (!partial.includes(read.key)) {
                partial.push(read.key);
            }
        };

        // A relationship read with an error under its alias, or with a list that is not there, is unavailable: never
        // an empty one. The stored relationship facts stay, and the read waits `ERROR_RETRY_MS`.
        const unavailable = (): void =>
            fail(own.some((error) => error?.type === "RATE_LIMITED") ? "RATE_LIMITED" : "partial");

        if (own.length > 0 && !partial.includes(read.key)) {
            partial.push(read.key);
        }

        if (node === undefined) {
            const types = own.map((error) => error?.type);

            if (types.includes("NOT_FOUND")) {
                fail("NOT_FOUND");
            } else if (types.includes("FORBIDDEN")) {
                fail("FORBIDDEN");
            } else if (types.includes("RATE_LIMITED")) {
                fail("RATE_LIMITED");
            } else {
                const message = own
                    .map((error) => error?.message)
                    .find((m) => typeof m === "string");

                fail(typeof message === "string" ? line(message) || "no answer" : "no answer");
            }

            return;
        }

        if (read.kind === "pr") {
            const state = node.state;
            const result: ReadResult = {
                kind: "pr",
                key: read.key,
                ok: true,
                archived: repo?.isArchived === true,
            };

            if (state === "OPEN" || state === "MERGED" || state === "CLOSED") {
                result.state = state;
            }

            const createdAt = parseTime(node.createdAt);
            const mergedAt = parseTime(node.mergedAt);
            const closedAt = parseTime(node.closedAt);

            if (createdAt !== undefined) {
                result.createdAt = createdAt;
            }

            if (mergedAt !== undefined) {
                result.mergedAt = mergedAt;
            }

            if (closedAt !== undefined) {
                result.closedAt = closedAt;
            }

            results.push(result);

            return;
        }

        if (read.kind === "closing") {
            if (own.length > 0 || !closingList(node.closedByPullRequestsReferences)) {
                unavailable();

                return;
            }

            results.push({
                kind: "closing",
                key: read.key,
                ok: true,
                cursor: read.cursor ?? "",
                closing: closingPage(node.closedByPullRequestsReferences),
            });

            return;
        }

        if (
            own.length > 0 ||
            !closingList(node.closedByPullRequestsReferences) ||
            !Array.isArray(record(node.timelineItems)?.nodes)
        ) {
            unavailable();

            return;
        }

        const result: ReadResult = {
            kind: "issue",
            key: read.key,
            ok: true,
            archived: repo?.isArchived === true,
            closing: closingPage(node.closedByPullRequestsReferences),
        };

        if (node.state === "OPEN" || node.state === "CLOSED") {
            result.state = node.state;
        }

        if (typeof node.stateReason === "string" && /^[A-Z_]{1,40}$/.test(node.stateReason)) {
            result.stateReason = node.stateReason;
        }

        const createdAt = parseTime(node.createdAt);
        const closedAt = parseTime(node.closedAt);
        const closer = closerOf(node.timelineItems);

        if (createdAt !== undefined) {
            result.createdAt = createdAt;
        }

        if (closedAt !== undefined) {
            result.closedAt = closedAt;
        }

        if (closer !== undefined) {
            result.closer = closer;
        }

        results.push(result);
    });

    const rate = record(data.rateLimit);
    const parsed: Answer = { results, partial, rateLimited, errors: unscoped };

    if (typeof rate?.remaining === "number" && Number.isFinite(rate.remaining)) {
        const resetAt = parseTime(rate.resetAt);

        parsed.rate =
            resetAt === undefined
                ? { remaining: rate.remaining }
                : { remaining: rate.remaining, resetAt };
    }

    return parsed;
}

/** The text a `gh` failure printed: its stderr and its message. */
function failureText(error: unknown): string {
    const failure = record(error);
    const stderr = failure?.stderr;
    const err =
        typeof stderr === "string"
            ? stderr
            : Buffer.isBuffer(stderr)
              ? stderr.toString("utf8")
              : "";
    const message = typeof failure?.message === "string" ? failure.message : String(error);

    return `${err}\n${message}`;
}

/**
 * Why a `gh` call failed: "rate" (a rate limit, a secondary rate limit, HTTP 429), "auth" (HTTP 401, bad credentials,
 * no login), "network" (no connection, a timeout, a gateway error), or "other".
 */
export function classifyFailure(error: unknown): Exclude<FailureKind, "partial"> {
    const text = failureText(error);

    if (/rate limit|HTTP 429|RATE_LIMITED|abuse detection/i.test(text)) {
        return "rate";
    }

    if (
        /HTTP 401|Bad credentials|gh auth login|not logged in|authentication required/i.test(text)
    ) {
        return "auth";
    }

    if (
        record(error)?.killed === true ||
        /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|i\/o timeout|connection reset|network|timed? ?out|HTTP 50[0234]|unexpected EOF/i.test(
            text,
        )
    ) {
        return "network";
    }

    return "other";
}

/** 1 line for a failed `gh` call, with no token in it. */
export function failureLine(error: unknown): string {
    if (record(error)?.killed === true) {
        return "the read took longer than 60 seconds";
    }

    const text = line(failureText(error)).replace(
        /\b(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g,
        "[token]",
    );

    return text === "" ? "the read failed" : text;
}

/** The JSON a failed `gh` call still printed, when it holds data: a partial answer. */
export function partialJson(error: unknown): unknown {
    const stdout = record(error)?.stdout;
    const raw =
        typeof stdout === "string"
            ? stdout
            : Buffer.isBuffer(stdout)
              ? stdout.toString("utf8")
              : "";

    try {
        const answer = raw.trim() === "" ? undefined : (JSON.parse(raw) as unknown);

        return record(record(answer)?.data) === undefined ? undefined : answer;
    } catch {
        return undefined;
    }
}

// ─── Applying a pass ─────────────────────────────────────────────────────────

/** A failure of the whole GitHub read: no data came back. */
export type PassFailure = {
    error: string;
    kind: Exclude<FailureKind, "partial">;
    resetAt?: number;
};

/** What 1 pass read. */
export type PassInput = {
    /** The thread facts; absent when `x.desk.threads` could not be read: the thread facts stay as they are. */
    threads?: Record<string, ThreadFact>;
    /** The tracked refs; absent with `threads`: nothing becomes untracked. */
    tracked?: Tracked;
    /** The reads that went to GitHub; empty when none went. */
    reads: readonly Read[];
    answer?: Answer;
    failure?: PassFailure;
    now: number;
};

/** A PR open again after it was closed: no close time, and the time the pass saw it. */
function reopenPr(fact: PrFact, now: number): void {
    put(fact, "state", "OPEN");
    put(fact, "closedAt", undefined);
    put(fact, "reopenedAt", now);
}

/** The lifecycle times each state needs. */
const NEEDED: Record<string, readonly ("createdAt" | "mergedAt" | "closedAt")[]> = {
    OPEN: ["createdAt"],
    MERGED: ["createdAt", "mergedAt", "closedAt"],
    CLOSED: ["createdAt", "closedAt"],
};

/** The names of the times a fact's state needs and lacks, or undefined when none is missing. */
export function gapsOf(fact: {
    state?: string;
    createdAt?: number;
    mergedAt?: number;
    closedAt?: number;
}): string[] | undefined {
    const gaps = (NEEDED[fact.state ?? ""] ?? []).filter((name) => fact[name] === undefined);

    return gaps.length === 0 ? undefined : gaps;
}

function applyPrResult(
    fact: PrFact,
    result: Extract<ReadResult, { kind: "pr" }>,
    now: number,
): void {
    put(fact, "readAt", now);
    put(fact, "error", undefined);
    put(fact, "errorAt", undefined);
    put(fact, "github", result.archived ? "frozen" : undefined);

    if (result.state === undefined) {
        return;
    }

    if (result.state === "OPEN" && fact.state === "CLOSED") {
        reopenPr(fact, now);
    }

    put(fact, "state", result.state);

    if (result.createdAt !== undefined) {
        put(fact, "createdAt", result.createdAt);
    }

    put(
        fact,
        "mergedAt",
        result.state === "MERGED" ? (result.mergedAt ?? fact.mergedAt) : undefined,
    );
    put(fact, "closedAt", result.state === "OPEN" ? undefined : (result.closedAt ?? fact.closedAt));
    put(fact, "gaps", gapsOf(fact));
}

/** Set an issue's resolution, keeping the stored one (and its time) when it says the same. */
function resolve(
    fact: IssueFact,
    pr: string,
    mergedAt: number,
    evidence: "closed-event" | "closing-reference",
    now: number,
): void {
    const old = fact.resolution;

    if (
        old === undefined ||
        old.pr !== pr ||
        old.mergedAt !== mergedAt ||
        old.evidence !== evidence
    ) {
        fact.resolution = { pr, mergedAt, evidence, at: now };
    }

    put(fact, "unresolved", undefined);
}

function unresolved(fact: IssueFact, why: Unresolved): void {
    put(fact, "resolution", undefined);
    put(fact, "unresolved", why);
}

/**
 * An issue's resolution from its state and its latest close. Only the latest close by a merged PR gives a sample. A
 * manual close (`closer` type "none") or a close by something else (a Commit) has no resolving PR: earlier merged
 * closing references never give a sample. `closer` absent: no latest close is visible, so the closing references cannot
 * show the latest resolver; they only tell `ambiguous` (a merged reference) from `no-resolving-pr` (a complete list with
 * none) and `incomplete` (no merged reference read yet, and pages left).
 */
function judgeIssue(fact: IssueFact, closer: Closer | undefined, now: number): void {
    if (fact.state === "OPEN") {
        unresolved(fact, "open");

        return;
    }

    if (fact.state !== "CLOSED") {
        unresolved(fact, "invalid");

        return;
    }

    if (fact.stateReason === "NOT_PLANNED") {
        unresolved(fact, "not-planned");

        return;
    }

    if (closer?.type === "PullRequest") {
        if (!closer.merged || closer.ref === undefined) {
            unresolved(fact, "no-resolving-pr");
        } else if (closer.mergedAt === undefined || fact.createdAt === undefined) {
            unresolved(fact, "invalid");
        } else {
            resolve(fact, closer.ref, closer.mergedAt, "closed-event", now);
        }

        return;
    }

    if (closer?.type === "other" || closer?.type === "none") {
        unresolved(fact, "no-resolving-pr");

        return;
    }

    const closing = fact.closing;

    if ((closing?.merged.length ?? 0) > 0) {
        unresolved(fact, "ambiguous");
    } else if (closing === undefined || !closing.complete) {
        unresolved(fact, "incomplete");
    } else {
        unresolved(fact, "no-resolving-pr");
    }
}

/**
 * Whether the closing references must be read on: a close with no visible latest close event, and no merged reference
 * on the first page. A merged reference makes the issue `ambiguous` at once.
 */
const needsClosing = (result: Extract<ReadResult, { kind: "issue" }>): boolean =>
    result.state === "CLOSED" &&
    result.stateReason !== "NOT_PLANNED" &&
    result.closer === undefined &&
    result.closing.merged.length === 0;

function applyIssueResult(
    fact: IssueFact,
    result: Extract<ReadResult, { kind: "issue" }>,
    now: number,
): void {
    put(fact, "readAt", now);
    put(fact, "error", undefined);
    put(fact, "errorAt", undefined);
    put(fact, "state", result.state);
    put(fact, "stateReason", result.stateReason);

    if (result.createdAt !== undefined) {
        put(fact, "createdAt", result.createdAt);
    }

    put(fact, "closedAt", result.state === "CLOSED" ? result.closedAt : undefined);
    put(fact, "gaps", gapsOf(fact));

    // Each issue read starts the closing references again from page 1.
    const closing: NonNullable<IssueFact["closing"]> = {
        merged: result.closing.merged,
        complete: !result.closing.hasNext,
        pages: 1,
    };

    if (needsClosing(result) && result.closing.cursor !== undefined) {
        closing.cursor = result.closing.cursor;
    }

    put(fact, "closing", closing);
    judgeIssue(fact, result.closer, now);
}

function applyClosingResult(
    fact: IssueFact,
    result: Extract<ReadResult, { kind: "closing" }>,
    now: number,
): void {
    const stored = fact.closing;

    // A page for a cursor the issue no longer waits on: an older pass's, or a replay. It changes nothing.
    if (stored?.cursor === undefined || stored.cursor !== result.cursor) {
        return;
    }

    const merged = [...stored.merged];

    for (const pr of result.closing.merged) {
        if (!merged.some((each) => each.ref === pr.ref)) {
            merged.push(pr);
        }
    }

    const pages = stored.pages + 1;
    const closing: NonNullable<IssueFact["closing"]> = {
        merged,
        complete: !result.closing.hasNext,
        pages,
    };

    if (result.closing.cursor !== undefined && merged.length === 0 && pages < MAX_CLOSING_PAGES) {
        closing.cursor = result.closing.cursor;
    }

    put(fact, "error", undefined);
    put(fact, "errorAt", undefined);
    put(fact, "closing", closing);
    // A cursor is kept only for a close with no visible latest close event, and no merged reference read yet.
    judgeIssue(fact, undefined, now);
}

function applyFailedRead(
    draft: DashboardState,
    result: Extract<ReadResult, { ok: false }>,
    now: number,
): void {
    if (result.kind === "pr") {
        const fact = draft.prs[result.key];

        if (fact === undefined) {
            return;
        }

        put(fact, "error", result.error);
        put(fact, "errorAt", now);

        if (result.error === "NOT_FOUND") {
            put(fact, "github", "missing");
        }

        return;
    }

    const fact = draft.issues[result.key];

    // A closing page for a cursor the issue no longer waits on changes nothing.
    if (
        fact === undefined ||
        (result.kind === "closing" && fact.closing?.cursor !== result.cursor)
    ) {
        return;
    }

    put(fact, "error", result.error);
    put(fact, "errorAt", now);

    if (result.error === "NOT_FOUND" || result.error === "FORBIDDEN") {
        // The earlier facts stay; `unresolved` says why there is no sample now.
        put(fact, "unresolved", result.error === "NOT_FOUND" ? "missing" : "inaccessible");

        if (fact.closing?.cursor !== undefined) {
            const closing = { ...copy(fact.closing), complete: false };

            delete closing.cursor;
            put(fact, "closing", closing);
        }
    }
}

/**
 * Merge 1 pass into the dashboard's draft. It writes only the fields that change, so applying the same input twice
 * gives the same document as applying it once (a restart between the read and the commit). A failure of the whole read
 * keeps every fact.
 */
export function applyPass(draft: DashboardState, input: PassInput): void {
    const { now } = input;

    draft.threads ??= {};
    draft.prs ??= {};
    draft.issues ??= {};
    draft.sources ??= {};

    if (draft.initializedAt === undefined) {
        draft.initializedAt = now;
    }

    if (draft.boundary === undefined) {
        draft.boundary = draft.initializedAt - BOUNDARY_DAYS * DAY_MS;
    }

    if (input.threads !== undefined) {
        let changed = false;

        for (const [id, fact] of Object.entries(input.threads)) {
            if (!same(draft.threads[id], fact)) {
                draft.threads[id] = copy(fact);
                changed = true;
            }
        }

        for (const [id, stored] of Object.entries(draft.threads)) {
            if (input.threads[id] === undefined && stored.goneAt === undefined) {
                stored.goneAt = now;
                changed = true;
            }
        }

        const status = draft.sources.threads;

        if (changed || status === undefined || !status.ok) {
            draft.sources.threads = { at: now, ok: true, lastGoodAt: now, checkedAt: now };
        } else if (status.checkedAt === undefined || now - status.checkedAt >= CHECK_HEARTBEAT_MS) {
            // No change: only the heartbeat, at most once an hour.
            status.checkedAt = now;
        }
    }

    const tracked = input.tracked;

    if (tracked !== undefined) {
        for (const pr of Object.values(tracked.prs)) {
            draft.prs[pr.key] ??= {
                ref: pr.ref,
                repo: pr.repo,
                number: pr.number,
                threads: [],
                via: [],
            };

            const fact = draft.prs[pr.key] as PrFact;

            put(fact, "threads", pr.threads);
            put(fact, "via", pr.via);
            put(fact, "deskState", pr.deskState);
            put(fact, "untracked", undefined);

            // The desk read the PR open after this fact's last read: it reopened.
            if (
                pr.deskState === "OPEN" &&
                fact.state === "CLOSED" &&
                pr.deskReadAt !== undefined &&
                pr.deskReadAt > (fact.readAt ?? 0)
            ) {
                reopenPr(fact, now);
            }
        }

        for (const [key, fact] of Object.entries(draft.prs)) {
            if (tracked.prs[key] === undefined) {
                put(fact, "untracked", true);
            }
        }

        for (const issue of Object.values(tracked.issues)) {
            draft.issues[issue.key] ??= {
                ref: issue.ref,
                repo: issue.repo,
                number: issue.number,
                threads: [],
                plans: [],
            };

            const fact = draft.issues[issue.key] as IssueFact;

            put(fact, "threads", issue.threads);
            put(fact, "plans", issue.plans);
            put(fact, "untracked", undefined);
        }

        for (const [key, fact] of Object.entries(draft.issues)) {
            if (tracked.issues[key] === undefined) {
                put(fact, "untracked", true);
            }
        }
    }

    // A resolution from the older closing-reference rule is no sample: it is ambiguous until a good read judges it
    // again (also when a failed read, a backoff or the read budget delays that read). The resolution stays, so
    // `issueDue` plans the read at once. A good read in this pass judges it below.
    for (const fact of Object.values(draft.issues)) {
        if (fact.resolution?.evidence === "closing-reference" && fact.unresolved === undefined) {
            put(fact, "unresolved", "ambiguous");
        }
    }

    for (const result of input.answer?.results ?? []) {
        if (!result.ok) {
            applyFailedRead(draft, result, now);
        } else if (result.kind === "pr") {
            const fact = draft.prs[result.key];

            if (fact !== undefined) {
                applyPrResult(fact, result, now);
            }
        } else if (result.kind === "issue") {
            const fact = draft.issues[result.key];

            if (fact !== undefined) {
                applyIssueResult(fact, result, now);
            }
        } else {
            const fact = draft.issues[result.key];

            if (fact !== undefined) {
                applyClosingResult(fact, result, now);
            }
        }
    }

    for (const fact of Object.values(draft.prs)) {
        put(fact, "excluded", prExcluded(fact.via, fact.deskState, fact.github));
    }

    applyGitHubSource(draft, input);
}

/** The GitHub source's status after the pass, and the progress. */
function applyGitHubSource(draft: DashboardState, input: PassInput): void {
    const { now, answer, failure } = input;
    const source: GitHubSource = copy(draft.sources.github ?? {});

    if (input.reads.length > 0) {
        const rate = answer?.rate;

        if (failure !== undefined) {
            source.at = now;
            source.ok = false;
            source.error = failure.error;
            source.kind = failure.kind;

            if (failure.kind === "rate") {
                source.backoffUntil = failure.resetAt ?? now + RATE_BACKOFF_MS;
            }
        } else if (answer?.rateLimited === true) {
            source.at = now;
            source.ok = false;
            source.error = "GitHub's rate limit";
            source.kind = "rate";
            source.backoffUntil =
                rate?.resetAt !== undefined && rate.resetAt > now
                    ? rate.resetAt
                    : now + RATE_BACKOFF_MS;
        } else if (answer?.results.some((result) => result.ok) !== true) {
            // No requested read worked: no success, and `lastGoodAt` stays.
            const failed = answer?.results.find((result) => !result.ok);

            source.at = now;
            source.ok = false;
            source.kind = "partial";
            source.error =
                answer?.errors[0] ??
                (failed !== undefined && !failed.ok
                    ? `no read worked: ${failed.error}`
                    : "no read worked");
            delete source.backoffUntil;
        } else {
            source.at = now;
            source.ok = true;
            source.lastGoodAt = now;
            delete source.backoffUntil;

            // An error that belongs to no read: the answer is partial, and its line stays.
            if (answer.errors.length > 0) {
                source.error = answer.errors[0];
                source.kind = "partial";
            } else {
                delete source.error;
                delete source.kind;
            }
        }

        if (failure === undefined && source.backoffUntil === undefined) {
            if (rate !== undefined && rate.remaining < RATE_FLOOR) {
                source.backoffUntil =
                    rate.resetAt !== undefined && rate.resetAt > now
                        ? rate.resetAt
                        : now + RATE_BACKOFF_MS;
            }
        }

        if (failure === undefined && rate !== undefined) {
            source.rateRemaining = rate.remaining;
        }
    }

    const partial = partialRefs(draft, input);

    if (partial.length > 0) {
        source.partial = partial;
    } else {
        delete source.partial;
    }

    const tracked = input.tracked;

    if (tracked !== undefined) {
        source.pending = dueReads(draft, tracked, now).length;
        source.complete =
            partial.length === 0 &&
            Object.values(tracked.prs).every((pr) => {
                const fact = draft.prs[pr.key];

                return (
                    fact?.excluded !== undefined ||
                    (fact?.readAt !== undefined &&
                        fact.gaps === undefined &&
                        fact.error === undefined)
                );
            }) &&
            Object.values(tracked.issues).every((issue) => {
                const fact = draft.issues[issue.key];

                return (
                    fact?.readAt !== undefined &&
                    fact.gaps === undefined &&
                    fact.error === undefined &&
                    fact.unresolved !== "incomplete"
                );
            });
    }

    if (!same(draft.sources.github ?? {}, source)) {
        draft.sources.github = source;
    }
}

/**
 * The GitHub source's partial refs from the whole stored state: each ref with a stored error; each ref of this answer
 * whose part had an error (a deeper error can come beside an ok result, and stores no error); and each earlier entry,
 * unless this pass read it cleanly (an ok result, and not in this answer's partial list). A failure of the whole read
 * reads nothing cleanly. All 3 use 1 rule, after this pass applies: the ref is tracked, and a PR is not excluded (an
 * excluded PR is never a coverage gap). Sorted and unique.
 */
function partialRefs(draft: Readonly<DashboardState>, input: PassInput): string[] {
    const keys = new Set<string>();
    const answer = input.failure === undefined ? input.answer : undefined;
    const answered = new Set(answer?.partial ?? []);
    const clean = new Set(
        (answer?.results ?? [])
            .filter((result) => result.ok && !answered.has(result.key))
            .map((result) => result.key),
    );

    const trackedPr = (key: string): boolean => {
        const fact = draft.prs[key];

        return fact !== undefined && fact.untracked !== true && fact.excluded === undefined;
    };

    const trackedIssue = (key: string): boolean => {
        const fact = draft.issues[key];

        return fact !== undefined && fact.untracked !== true;
    };

    /** The 1 rule for every source of the list: tracked, and for a PR not excluded. */
    const counts = (key: string): boolean => trackedPr(key) || trackedIssue(key);

    for (const [key, fact] of Object.entries(draft.prs)) {
        if (trackedPr(key) && fact.error !== undefined) {
            keys.add(key);
        }
    }

    for (const [key, fact] of Object.entries(draft.issues)) {
        if (trackedIssue(key) && fact.error !== undefined) {
            keys.add(key);
        }
    }

    for (const key of answered) {
        if (counts(key)) {
            keys.add(key);
        }
    }

    for (const key of draft.sources.github?.partial ?? []) {
        if (counts(key) && !clean.has(key)) {
            keys.add(key);
        }
    }

    return [...keys].sort();
}

/** A pass that could not read its documents: the threads source failed, and every fact stays. */
export function applyReadFailure(draft: DashboardState, error: string, now: number): void {
    draft.sources ??= {};

    const old = draft.sources.threads;
    const status: SourceStatus = { at: now, ok: false, error };

    if (old?.lastGoodAt !== undefined) {
        status.lastGoodAt = old.lastGoodAt;
    }

    if (old?.checkedAt !== undefined) {
        status.checkedAt = old.checkedAt;
    }

    if (!same(old, status)) {
        draft.sources.threads = status;
    }
}

// ─── The pass ────────────────────────────────────────────────────────────────

/** What a pass needs from its task: injected, so a test can give fakes. */
export type PassDeps = {
    readDesk: () => Promise<Readonly<DeskState> | undefined>;
    readDashboard: () => Promise<Readonly<DashboardState> | undefined>;
    now: () => number;
    /** 1 `gh api graphql` call: its stdout, or a throw with `stdout`, `stderr`, `killed` as `execFile` gives them. */
    graphql: (query: string) => Promise<{ stdout: string }>;
    /** 1 commit that applies the pass to the draft. */
    commit: (apply: (draft: DashboardState) => void) => Promise<void>;
    /** The collector's task id: a pass of another collector reads nothing, and its commit ends it. */
    owner?: string;
    signal?: AbortSignal;
    /**
     * The usage step's reads and commits: absent, no usage step. It runs after the document reads and before the GitHub
     * call, once the boundary is fixed. Its failure never fails the GitHub part; an abort still throws.
     */
    usage?: UsageModule.UsageDeps;
};

/**
 * 1 collection pass: read `x.desk.threads` (a snapshot, outside the commit), run the usage step (when `deps.usage` is
 * given and the boundary is fixed), plan the due reads, make at most 1 GitHub call, then 1 commit. No call when nothing
 * is due or during a backoff. It gives back the number of reads that went.
 */
export async function collectPass(deps: PassDeps): Promise<number> {
    let dashboard: Readonly<DashboardState> | undefined;
    let desk: Readonly<DeskState> | undefined;

    try {
        dashboard = await deps.readDashboard();
        desk = await deps.readDesk();
    } catch (error) {
        if (deps.signal?.aborted === true) {
            throw error;
        }

        // A failed read fails no task: every fact stays, no GitHub call goes, and the next pass tries again.
        const now = deps.now();
        const text =
            line(error instanceof Error ? error.message : String(error)) || "the read failed";

        await deps.commit((draft) => applyReadFailure(draft, text, now));

        return 0;
    }

    if (deps.owner !== undefined && dashboard?.collector !== deps.owner) {
        await deps.commit(() => undefined);

        return 0;
    }

    const now = deps.now();
    const threads = desk === undefined ? undefined : threadFacts(desk);
    const tracked = desk === undefined ? undefined : trackedRefs(desk);
    const boundary = dashboard?.boundary;

    if (
        deps.usage !== undefined &&
        desk !== undefined &&
        threads !== undefined &&
        boundary !== undefined
    ) {
        try {
            await usage.usagePass(
                { ...deps.usage, signal: deps.usage.signal ?? deps.signal },
                { desk, facts: threads, boundary, now, slot: Math.floor(now / PASS_MS) },
            );
        } catch (error) {
            if (deps.signal?.aborted === true || deps.usage.signal?.aborted === true) {
                throw error;
            }

            // The usage step records its own failures: anything else it throws leaves the GitHub part to run.
        }
    }

    const reads = tracked === undefined ? [] : planReads(dashboard, tracked, now);
    let answer: Answer | undefined;
    let failure: PassFailure | undefined;

    if (reads.length > 0) {
        try {
            const { stdout } = await deps.graphql(buildQuery(reads));

            answer = parseAnswer(JSON.parse(stdout) as unknown, reads);
        } catch (error) {
            if (deps.signal?.aborted === true) {
                throw error;
            }

            const data = partialJson(error);

            if (data !== undefined) {
                answer = parseAnswer(data, reads);
            } else {
                const kind = classifyFailure(error);

                failure = { error: failureLine(error), kind };
            }
        }
    }

    await deps.commit((draft) =>
        applyPass(draft, { threads, tracked, reads, answer, failure, now }),
    );

    return reads.length;
}

// ─── The collector task ──────────────────────────────────────────────────────

type CollectorInput = { supervisor: number };
type CollectorState = { phase: "sleep" } | { phase: "pass" };

/**
 * The collector task: it waits `PASS_MS`, makes 1 pass, sleeps `PASS_MS`, and makes the next. The pass's commit ends
 * the task when `collector` names another task, so only 1 collector works. It never starts an agent and never sends a
 * message. The sleep is durable: a restart keeps it.
 */
export function defineCollector(options: {
    deskDoc: SessionDocToken<DeskState>;
    gh: () => string;
}) {
    const run = promisify(execFile);

    return defineTask<CollectorInput, CollectorState, null>({
        name: COLLECTOR_TASK,
        version: 1,
        initial: () => ({ phase: "sleep" }),
        phases: {
            // The first pass waits: a new collector does not read GitHub in the commit that starts it.
            sleep: async (_task, runtime, context) =>
                runtime.sleepUntil(runtime.now() + PASS_MS, { phase: "pass" }, context),
            pass: async (_task, runtime, context) => {
                const id = String(runtime.taskId);

                await collectPass({
                    readDesk: () => runtime.snapshot(options.deskDoc, context),
                    readDashboard: () => runtime.snapshot(DeskDashboard, context),
                    now: () => runtime.now(),
                    graphql: (query) =>
                        run(options.gh(), ["api", "graphql", "-f", `query=${query}`], {
                            timeout: 60_000,
                            maxBuffer: 8 * 1024 * 1024,
                            encoding: "utf8",
                            signal: runtime.signal,
                        }),
                    owner: id,
                    signal: runtime.signal,
                    usage: {
                        readUsage: () => runtime.snapshot(usage.DeskUsage, context),
                        readLedger: (conversation) =>
                            runtime.snapshot(UsageDoc, conversation as ConversationId, context),
                        // Each usage commit checks that this task still owns collection, else it changes nothing.
                        // It leaves the task's state as it is: the pass's last commit sets the sleep.
                        commit: async (change) => {
                            let owned = false;

                            await runtime.commit(async (tx) => {
                                if ((await tx.doc(DeskDashboard)).collector !== id) {
                                    return undefined;
                                }

                                owned = true;
                                await change(tx, await tx.doc(usage.DeskUsage));

                                return undefined;
                            }, context);

                            return owned;
                        },
                        signal: runtime.signal,
                    },
                    commit: (apply) =>
                        runtime.commit(async (tx) => {
                            const draft = await tx.doc(DeskDashboard);

                            if (draft.collector !== id) {
                                return {
                                    status: "terminal",
                                    outcome: { status: "completed", result: null },
                                };
                            }

                            apply(draft);

                            return {
                                status: "sleeping",
                                until: runtime.now() + PASS_MS,
                                checkpoint: { phase: "pass" },
                            };
                        }, context),
                });
            },
        },
        abort: async (_task, runtime, context) =>
            runtime.commit(async (tx) => {
                const draft = await tx.doc(DeskDashboard);

                if (draft.collector === String(runtime.taskId)) {
                    delete draft.collector;
                }

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context),
    });
}

/** The collector task's token. */
export type Collector = ReturnType<typeof defineCollector>;

/**
 * Whether the recorded collector task is live. Durable refuses a table read after the first table write of a commit,
 * so a commit calls this before it writes a table (a task, an entry), and gives the answer to `ensureCollector`.
 */
export async function collectorLive(tx: Tx): Promise<boolean> {
    const id = (await tx.doc(DeskDashboard)).collector;

    if (id === undefined || !/^[1-9][0-9]*$/.test(id)) {
        return false;
    }

    const status = (await tx.task(Number(id) as TaskId))?.state.status;

    return status !== undefined && status !== "terminal" && status !== "completing";
}

/**
 * Start the collector in the caller's commit, owned by `supervisor`'s conversation, unless a live one is recorded
 * (`live`, from `collectorLive` at the start of the same commit). `live` undefined (the read failed): it does nothing.
 * A restart finds it, and adds no other.
 */
export async function ensureCollector(
    tx: Tx,
    supervisor: number,
    collector: Collector,
    live: boolean | undefined,
): Promise<void> {
    // Unknown: no new task. A duplicate collector is worse than a late one; the next sweep asks again.
    if (live === undefined) {
        return;
    }

    const draft = await tx.doc(DeskDashboard);

    if (live && draft.collector !== undefined) {
        return;
    }

    const id = await tx.createTask(
        collector,
        { supervisor },
        {
            ownership: { kind: "conversation" },
            conversationId: supervisor as ConversationId,
            background: true,
            abandonOnRestart: false,
        },
    );

    draft.collector = String(id);
}
