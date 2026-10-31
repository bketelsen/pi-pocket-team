/**
 * The dashboard's numbers: pure reducers over the stored facts of `x.desk.dashboard` and `x.desk.usage`. No I/O, no
 * Durable write, no GitHub call, no transcript read: `desk.ts` reads the 2 documents with `request.snapshot` and gives
 * them to `snapshot`, which validates the query and returns the whole answer for 1 instant (`asOf`).
 *
 * 1 reducer (`reduce`) makes every metric set: the scope total, each project row, each owner row, and the unattributed
 * row. Each set comes from the raw facts of its records, never from other rows: an owner's rate, median or P90 is not
 * a sum or an average of its projects' values. The facts are grouped by repository once, so the work is linear in the
 * number of facts.
 *
 * All times are epoch milliseconds (UTC). A range is inclusive at its start and exclusive at its end. Unknown is null,
 * never 0: a usage scope whose counted sessions all have no complete read (`UsageMetrics.state` "unknown") has null
 * range sums, and an explicit recorded 0 stays 0.
 *
 * Pocket does not load this file as a module: the `_` prefix keeps it out. `desk.ts` imports it.
 */
import type * as DashboardModule from "./_desk-dashboard.ts";
import type {
    DashboardState,
    FailureKind,
    GitHubSource,
    IssueFact,
    PrFact,
    ThreadFact,
} from "./_desk-dashboard.ts";
import type { Counters, SessionUsage, Totals, UsageState } from "./_desk-usage.ts";

/**
 * The dashboard helper, loaded fresh with each load of this module, with the same query as `desk.ts` gives it: the
 * same URL is the same instance. In tests this module has no query, so a static import gets the same instance.
 */
const dashboard = (await import(
    new URL(`./_desk-dashboard.ts${new URL(import.meta.url).search}`, import.meta.url).href
)) as typeof DashboardModule;

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

/** The most days in 1 range. */
export const MAX_RANGE_DAYS = 366;
/** The days of the default range, today included. */
export const DEFAULT_RANGE_DAYS = 30;
/** A source whose last good read is older than this is stale. */
export const STALE_MS = dashboard.CHECK_HEARTBEAT_MS + 3 * dashboard.PASS_MS;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// ─── The answer ──────────────────────────────────────────────────────────────

/** The query as the route gives it: absent or empty means "not given". */
export type MetricsQuery = {
    from?: string | null;
    to?: string | null;
    owner?: string | null;
    repo?: string | null;
};

export type Range = {
    /** Inclusive UTC dates. */
    from: string;
    to: string;
    /** Midnight UTC of `from`: the first day of the labels and of `daily`. */
    dayStart: number;
    /**
     * The effective start: midnight UTC of `from`, or the recovery boundary when it is later. Every event selection
     * and the elapsed time of velocity use it. Usage goes by day: it holds only times at or after the boundary.
     */
    start: number;
    /** The next midnight after `to`, or `asOf` when that is earlier. Exclusive. */
    end: number;
    days: number;
    /** `to` is today: the range ends at `asOf`. */
    partialToday: boolean;
    /** The default `from` was before the recovery boundary's day, and moved to it. */
    clamped: boolean;
};

export type Scope =
    | { kind: "all" }
    | { kind: "owner"; owner: string }
    | { kind: "repo"; owner: string; repo: string };

export type Completion = {
    /** success / denominator, or null with `flag` when the denominator is 0. */
    rate: number | null;
    flag?: "No eligible closures";
    success: number;
    completed: number;
    verified: number;
    abandoned: number;
    failed: number;
    denominator: number;
    excluded: { dropped: number; frozen: number; unknown: number };
    /** Closed delivery threads with no valid close time: in no range. */
    undated: number;
};

export type Velocity = {
    /** Successes per 7 days of the real elapsed interval; null when the interval is empty. */
    perWeek: number | null;
    successes: number;
};

export type CycleTime = {
    medianMs: number | null;
    samples: number;
    /** Successes with no valid start time, or a close before the start. */
    excludedTimestamps: number;
};

export type Workload = {
    label: "now";
    total: number;
    starting: number;
    open: number;
    parked: number;
};

export type PrMetrics = {
    /** Event counts in the range, each by its own lifecycle time: they overlap. */
    created: number;
    merged: number;
    closedUnmerged: number;
    /** Open now. */
    openNow: number;
    /** Tracked PRs that are not excluded. */
    tracked: number;
    excluded: { window: number; missing: number; frozen: number };
    coverage: { unread: number; errored: number; gaps: number };
};

export type UsageSum = {
    entries: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** The recorded totals only. */
    totalTokens: number;
    /** Reported model cost in USD; null when no entry reported a cost. */
    cost: number | null;
    costEntries: number;
    zeroCostEntries: number;
    unknownCostEntries: number;
};

/** The range sum fields of `UsageMetrics`: null when the scope's usage is unknown. */
type UsageRangeSum = { [K in keyof UsageSum]: UsageSum[K] | null };

/** What the counted sessions of a scope know of their usage. */
export type UsageKnowledge = "complete" | "partial" | "unknown" | "none";

export type UsageMetrics = UsageRangeSum & {
    /**
     * What the range sums know. Each counted session is complete (read, caught up, not dirty: no ledger change since
     * the last read, no malformed entry, not missing, no error, no residual mismatch or unavailable ledger), partial
     * (not complete, but with at least 1 valid entry), or unknown (not complete, and no valid entry). "none": no counted
     * session (the sums are 0). "unknown": every counted session is unknown: each range sum field is null, not 0. "partial": at least 1 counted session is partial or
     * unknown, and at least 1 is not unknown: the sums are the known subtotal. "complete": every counted session is
     * complete. A scope's state comes from its own raw sessions, never from the states of its rows.
     */
    state: UsageKnowledge;
    /** The counted sessions by their own usage knowledge. */
    sessionStates: { complete: number; partial: number; unknown: number };
    /** The sessions that count. */
    sessions: number;
    /** Sessions that do not count. */
    excluded: { shared: number; unlinked: number };
    /** Counted sessions whose conversation is gone: their collected data counts. */
    missing: number;
    /** Counted sessions with no repository. */
    unattributed: { noRepo: number; conflict: number; unassigned: number };
    /** The summed `skipped` counts of the counted sessions: entries not counted, or subsets not valid. */
    skipped: UsageSkipped;
    /** The counted sessions by their residual state: `absent` has no ledger check yet. */
    residuals: ResidualCounts;
    /**
     * Outside the range totals: usage with no date, and the sum of the settled compaction residuals with their session
     * count. `residual` is null when no counted session has a settled residual: unknown, not 0.
     */
    undated: {
        counters: UsageSum;
        residual: { sessions: number; counters: Totals } | null;
    };
};

export type UsageSkipped = {
    inherited: number;
    imported: number;
    malformed: number;
    reasoning: number;
    cacheWrite1h: number;
};

export type ResidualCounts = {
    settled: number;
    pending: number;
    mismatch: number;
    unavailable: number;
    absent: number;
};

/** A usage scope with a coverage gap: malformed entries, a residual mismatch, or a ledger that could not be read. */
export const usageGaps = (usage: Readonly<UsageMetrics>): boolean =>
    usage.skipped.malformed > 0 || usage.residuals.mismatch > 0 || usage.residuals.unavailable > 0;

export type UndatedReason =
    | "not-planned"
    | "no-resolving-pr"
    | "ambiguous"
    | "incomplete"
    | "missing"
    | "inaccessible"
    | "invalid"
    | "no-resolution"
    | "unread";

export type TimeToSolve = {
    medianMs: number | null;
    p90Ms: number | null;
    count: number;
    flag?: "No eligible resolved issues";
    /** Issues open now, or reopened: not samples. */
    nowUnresolved: number;
    /** Merges in the range with no valid duration. */
    dated: { invalid: number };
    /** Issues whose relation to the range is unknown, by reason. */
    undated: Partial<Record<UndatedReason, number>>;
};

export type Population = {
    delivery: number;
    coordinators: number;
    excluded: { askOnly: number; noWork: number };
    /** Threads gone from `x.desk.threads`: their facts still count. */
    gone: number;
};

export type Metrics = {
    completion: Completion;
    velocity: Velocity;
    cycleTime: CycleTime;
    workload: Workload;
    prs: PrMetrics;
    usage: UsageMetrics;
    timeToSolve: TimeToSolve;
    population: Population;
};

export type SourceView = {
    status: "ok" | "stale" | "failed" | "partial" | "never";
    at: number | null;
    ok: boolean | null;
    kind: FailureKind | null;
    error: string | null;
    lastGoodAt: number | null;
    checkedAt: number | null;
};

export type Limitation = { code: string; text: string };

export type Coverage = {
    status: "not started" | "started";
    boundary: number | null;
    boundaryDay: string | null;
    initializedAt: number | null;
    sources: {
        threads: SourceView;
        github: SourceView & { backoffUntil: number | null };
        usage: SourceView;
    };
    progress: {
        /** `overdue`: tracked refs whose next read is due by more than `STALE_MS`, from the stored facts. */
        github: { pending: number | null; complete: boolean | null; overdue: number };
        usage: {
            pending: number | null;
            complete: boolean | null;
            ledgerUnavailable: number | null;
        };
    };
    population: Population;
    limitations: Limitation[];
};

export type ProjectRow = { repo: string; owner: string; metrics: Metrics };
export type OwnerRow = { owner: string; metrics: Metrics };

export type Snapshot = {
    asOf: number;
    range: Range;
    scope: Scope;
    totals: Metrics;
    daily: { day: string; successes: number }[];
    rows: { projects: ProjectRow[]; owners: OwnerRow[]; unattributed: Metrics | null };
    coverage: Coverage;
    /**
     * Every owner and every repository with an attributed record, lowercased and sorted, whatever the scope: the
     * page's scope choices do not shrink when a scope is picked.
     */
    choices: { owners: string[]; repos: string[] };
};

export type SnapshotInput = {
    dashboard: Readonly<DashboardState> | undefined;
    usage: Readonly<UsageState> | undefined;
    now: number;
    query: MetricsQuery;
};

// ─── Small rules ─────────────────────────────────────────────────────────────

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A valid "YYYY-MM-DD" as midnight UTC, or undefined. */
export function parseDay(value: string): number | undefined {
    const match = DATE.exec(value);

    if (match === null) {
        return undefined;
    }

    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const at = Date.UTC(year, month - 1, day);
    const back = new Date(at);

    return back.getUTCFullYear() === year &&
        back.getUTCMonth() === month - 1 &&
        back.getUTCDate() === day
        ? at
        : undefined;
}

/** A GitHub owner name: the part before "/" of a repository name. */
export const isOwnerName = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 100 && OWNER_NAME.test(value);

/** A finite number, or 0: a stored counter never poisons a sum. */
const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

const roundCost = (value: number): number => Math.round(value * 1e9) / 1e9;

/** The middle value, or the mean of the middle pair; null with no value. Sorts `values`. */
export function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }

    values.sort((a, b) => a - b);

    const middle = Math.floor(values.length / 2);

    return values.length % 2 === 1
        ? (values[middle] ?? 0)
        : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

/** The nearest-rank percentile: sorted, rank ceil(p × n), from 1; null with no value. Sorts `values`. */
export function nearestRank(values: number[], p: number): number | null {
    if (values.length === 0) {
        return null;
    }

    values.sort((a, b) => a - b);

    const rank = Math.max(1, Math.ceil(p * values.length));

    return values[rank - 1] ?? null;
}

const given = (value: string | null | undefined): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;

// ─── The query ───────────────────────────────────────────────────────────────

/** The range and scope of a query, or why it is refused (a 400). */
export function parseQuery(
    query: MetricsQuery,
    now: number,
    boundary: number | undefined,
): { range: Range; scope: Scope } | { error: string } {
    const today = dayOf(now);
    const todayAt = parseDay(today) ?? 0;
    const boundaryDay = boundary === undefined ? undefined : dayOf(boundary);
    const boundaryAt = boundaryDay === undefined ? undefined : parseDay(boundaryDay);
    const fromText = given(query.from);
    const toText = given(query.to);
    let toAt = todayAt;

    if (toText !== undefined) {
        const at = parseDay(toText);

        if (at === undefined) {
            return {
                error: DATE.test(toText)
                    ? `to is not a real date: ${toText}.`
                    : "to must be a date YYYY-MM-DD.",
            };
        }

        toAt = at;
    }

    let fromAt: number;
    let clamped = false;

    if (fromText !== undefined) {
        const at = parseDay(fromText);

        if (at === undefined) {
            return {
                error: DATE.test(fromText)
                    ? `from is not a real date: ${fromText}.`
                    : "from must be a date YYYY-MM-DD.",
            };
        }

        fromAt = at;
    } else {
        fromAt = toAt - (DEFAULT_RANGE_DAYS - 1) * DAY_MS;
    }

    if (toAt > todayAt) {
        return { error: `to must not be after today (UTC): ${today}.` };
    }

    if (boundaryAt !== undefined && fromAt < boundaryAt) {
        if (fromText !== undefined) {
            return {
                error: `from must not be before the recovery boundary's day (UTC): ${boundaryDay ?? ""}.`,
            };
        }

        if (toAt < boundaryAt) {
            return {
                error: `to must not be before the recovery boundary's day (UTC): ${boundaryDay ?? ""}.`,
            };
        }

        fromAt = boundaryAt;
        clamped = true;
    }

    if (fromAt > toAt) {
        return { error: "from must not be after to." };
    }

    const days = Math.round((toAt - fromAt) / DAY_MS) + 1;

    if (days > MAX_RANGE_DAYS) {
        return {
            error: `The range is ${String(days)} days: the most is ${String(MAX_RANGE_DAYS)}.`,
        };
    }

    const scope = parseScope(given(query.owner), given(query.repo));

    if ("error" in scope) {
        return scope;
    }

    return {
        range: {
            from: dayOf(fromAt),
            to: dayOf(toAt),
            dayStart: fromAt,
            start: boundary === undefined ? fromAt : Math.max(fromAt, boundary),
            end: Math.min(toAt + DAY_MS, now),
            days,
            partialToday: toAt === todayAt,
            clamped,
        },
        scope,
    };
}

function parseScope(
    owner: string | undefined,
    repo: string | undefined,
): Scope | { error: string } {
    if (owner !== undefined && !isOwnerName(owner)) {
        return { error: "owner must be a GitHub owner name: letters, digits, '_', '.' and '-'." };
    }

    if (repo !== undefined) {
        if (!dashboard.isRepoName(repo)) {
            return { error: "repo must be a repository name: owner/name." };
        }

        const repoOwner = repo.split("/")[0] ?? "";

        if (owner !== undefined && owner.toLowerCase() !== repoOwner.toLowerCase()) {
            return { error: `repo ${repo} is not in owner ${owner}.` };
        }

        return { kind: "repo", owner: repoOwner, repo };
    }

    return owner === undefined ? { kind: "all" } : { kind: "owner", owner };
}

// ─── The reducer ─────────────────────────────────────────────────────────────

/** The records of 1 metric set. */
export type Facts = {
    threads: ThreadFact[];
    prs: PrFact[];
    issues: IssueFact[];
    sessions: SessionUsage[];
};

const noFacts = (): Facts => ({ threads: [], prs: [], issues: [], sessions: [] });

/** The range parts the reducer needs. */
export type Window = Pick<Range, "from" | "to" | "start" | "end">;

const inRange = (at: unknown, window: Window): at is number =>
    dashboard.validTime(at) && at >= window.start && at < window.end;

const emptySum = (): UsageSum => ({
    entries: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
    costEntries: 0,
    zeroCostEntries: 0,
    unknownCostEntries: 0,
});

/** Add 1 counters record to a sum. Cost adds only from records that report cost entries. */
function addCounters(sum: UsageSum, counters: Readonly<Counters> | undefined): void {
    if (counters === undefined) {
        return;
    }

    sum.entries += num(counters.entries);
    sum.input += num(counters.input);
    sum.output += num(counters.output);
    sum.cacheRead += num(counters.cacheRead);
    sum.cacheWrite += num(counters.cacheWrite);
    sum.totalTokens += num(counters.totalTokens);

    const costEntries = num(counters.costEntries);

    if (costEntries > 0) {
        sum.cost = roundCost((sum.cost ?? 0) + num(counters.cost));
        sum.costEntries += costEntries;
    }

    sum.zeroCostEntries += num(counters.zeroCostEntries);
    sum.unknownCostEntries = Math.max(0, sum.entries - sum.costEntries);
}

const zeroTotals = (): Totals => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
});

/** The daily successes of a set, by UTC day "YYYY-MM-DD". */
export type Daily = Map<string, number>;

/** Every metric of 1 set of facts. `daily`, when given, gets the successes by day. */
export function reduce(facts: Readonly<Facts>, window: Window, daily?: Daily): Metrics {
    const completion: Completion = {
        rate: null,
        success: 0,
        completed: 0,
        verified: 0,
        abandoned: 0,
        failed: 0,
        denominator: 0,
        excluded: { dropped: 0, frozen: 0, unknown: 0 },
        undated: 0,
    };
    const workload: Workload = { label: "now", total: 0, starting: 0, open: 0, parked: 0 };
    const population: Population = {
        delivery: 0,
        coordinators: 0,
        excluded: { askOnly: 0, noWork: 0 },
        gone: 0,
    };
    const cycles: number[] = [];
    let excludedTimestamps = 0;

    for (const fact of facts.threads) {
        if (fact.goneAt !== undefined) {
            population.gone += 1;
        }

        if (fact.role === "coordinator") {
            population.coordinators += 1;

            continue;
        }

        if (fact.role !== "delivery") {
            if (fact.excluded === "ask-only") {
                population.excluded.askOnly += 1;
            } else {
                population.excluded.noWork += 1;
            }

            continue;
        }

        population.delivery += 1;

        if (
            fact.goneAt === undefined &&
            (fact.state === "starting" || fact.state === "open" || fact.state === "parked")
        ) {
            workload.total += 1;
            workload[fact.state] += 1;
        }

        const closed = fact.closed;

        if (fact.state !== "closed" || closed === undefined) {
            continue;
        }

        if (!dashboard.validTime(closed.at)) {
            completion.undated += 1;

            continue;
        }

        if (!inRange(closed.at, window)) {
            continue;
        }

        if (closed.why === "dropped") {
            completion.excluded.dropped += 1;
        } else if (closed.why === "failed") {
            completion.failed += 1;
        } else if (
            closed.why === "done" &&
            (closed.outcome === "completed" || closed.outcome === "verified")
        ) {
            completion.success += 1;
            completion[closed.outcome] += 1;

            const day = dayOf(closed.at);

            daily?.set(day, (daily.get(day) ?? 0) + 1);

            const started = fact.startedAt;
            const duration = dashboard.validTime(started) ? closed.at - started : -1;

            if (duration >= 0) {
                cycles.push(duration);
            } else {
                excludedTimestamps += 1;
            }
        } else if (closed.outcome === "abandoned") {
            completion.abandoned += 1;
        } else if (closed.outcome === "frozen") {
            completion.excluded.frozen += 1;
        } else {
            completion.excluded.unknown += 1;
        }
    }

    completion.denominator = completion.success + completion.abandoned + completion.failed;

    if (completion.denominator === 0) {
        completion.flag = "No eligible closures";
    } else {
        completion.rate = completion.success / completion.denominator;
    }

    const elapsed = window.end - window.start;
    const velocity: Velocity = {
        perWeek: elapsed > 0 ? completion.success / (elapsed / WEEK_MS) : null,
        successes: completion.success,
    };
    const cycleTime: CycleTime = {
        medianMs: median(cycles),
        samples: cycles.length,
        excludedTimestamps,
    };

    return {
        completion,
        velocity,
        cycleTime,
        workload,
        prs: reducePrs(facts.prs, window),
        usage: reduceUsage(facts.sessions, window),
        timeToSolve: reduceIssues(facts.issues, window),
        population,
    };
}

function reducePrs(prs: readonly PrFact[], window: Window): PrMetrics {
    const metrics: PrMetrics = {
        created: 0,
        merged: 0,
        closedUnmerged: 0,
        openNow: 0,
        tracked: 0,
        excluded: { window: 0, missing: 0, frozen: 0 },
        coverage: { unread: 0, errored: 0, gaps: 0 },
    };

    for (const fact of prs) {
        if (fact.untracked === true) {
            continue;
        }

        if (fact.excluded !== undefined) {
            metrics.excluded[fact.excluded] += 1;

            continue;
        }

        metrics.tracked += 1;

        if (inRange(fact.createdAt, window)) {
            metrics.created += 1;
        }

        if (inRange(fact.mergedAt, window)) {
            metrics.merged += 1;
        }

        if (fact.state === "CLOSED" && inRange(fact.closedAt, window)) {
            metrics.closedUnmerged += 1;
        }

        if (fact.state === "OPEN") {
            metrics.openNow += 1;
        }

        if (fact.readAt === undefined) {
            metrics.coverage.unread += 1;
        }

        if (fact.error !== undefined) {
            metrics.coverage.errored += 1;
        }

        if ((fact.gaps?.length ?? 0) > 0) {
            metrics.coverage.gaps += 1;
        }
    }

    return metrics;
}

/** The entries of a counters record, 0 when it is absent. */
const entriesOf = (counters: Readonly<Counters> | undefined): number => num(counters?.entries);

/**
 * What 1 counted session knows of its usage. A gap: never read, not caught up, its ledger changed since the last read
 * (`dirty`: its stored entries lack the new usage), malformed entries, its conversation gone, a failed page, or a
 * residual mismatch or unavailable ledger. With a gap, a session with at least 1 valid entry (any day, undated, or
 * before the boundary) is partial, and one with none is unknown: its 0 is no recorded 0.
 */
function sessionKnowledge(session: Readonly<SessionUsage>): "complete" | "partial" | "unknown" {
    const residual = session.residual?.state;
    const gap =
        session.scannedAt === undefined ||
        session.caughtUp !== true ||
        session.dirty === true ||
        num(session.skipped?.malformed) > 0 ||
        session.missingAt !== undefined ||
        session.error !== undefined ||
        residual === "mismatch" ||
        residual === "unavailable";

    if (!gap) {
        return "complete";
    }

    let entries = entriesOf(session.undated) + entriesOf(session.before);

    for (const models of Object.values(session.days ?? {})) {
        for (const counters of Object.values(models ?? {})) {
            entries += entriesOf(counters);
        }
    }

    return entries > 0 ? "partial" : "unknown";
}

/** The state of a scope from the counts of its counted sessions. */
function usageKnowledge(states: Readonly<UsageMetrics["sessionStates"]>): UsageKnowledge {
    const { complete, partial, unknown } = states;

    if (complete + partial + unknown === 0) {
        return "none";
    }

    if (complete + partial === 0) {
        return "unknown";
    }

    return partial + unknown > 0 ? "partial" : "complete";
}

function reduceUsage(sessions: readonly SessionUsage[], window: Window): UsageMetrics {
    const sum = emptySum();
    const undated = emptySum();
    const residual = zeroTotals();
    const sessionStates = { complete: 0, partial: 0, unknown: 0 };
    const metrics = {
        sessions: 0,
        excluded: { shared: 0, unlinked: 0 },
        missing: 0,
        unattributed: { noRepo: 0, conflict: 0, unassigned: 0 },
        skipped: { inherited: 0, imported: 0, malformed: 0, reasoning: 0, cacheWrite1h: 0 },
        residuals: { settled: 0, pending: 0, mismatch: 0, unavailable: 0, absent: 0 },
    };
    let residuals = 0;

    for (const session of sessions) {
        if (session.shared === true) {
            metrics.excluded.shared += 1;

            continue;
        }

        if (session.unlinkedAt !== undefined) {
            metrics.excluded.unlinked += 1;

            continue;
        }

        metrics.sessions += 1;
        sessionStates[sessionKnowledge(session)] += 1;

        if (session.missingAt !== undefined) {
            metrics.missing += 1;
        }

        const assign = session.assign;

        if (assign === undefined) {
            metrics.unattributed.unassigned += 1;
        } else if ("none" in assign) {
            metrics.unattributed[assign.none === "conflict" ? "conflict" : "noRepo"] += 1;
        }

        for (const [day, models] of Object.entries(session.days ?? {})) {
            if (!DATE.test(day) || day < window.from || day > window.to) {
                continue;
            }

            for (const counters of Object.values(models ?? {})) {
                addCounters(sum, counters);
            }
        }

        addCounters(undated, session.undated);

        for (const key of Object.keys(metrics.skipped) as (keyof UsageSkipped)[]) {
            metrics.skipped[key] += num(session.skipped?.[key]);
        }

        const state = session.residual?.state;

        if (
            state === "settled" ||
            state === "pending" ||
            state === "mismatch" ||
            state === "unavailable"
        ) {
            metrics.residuals[state] += 1;
        } else {
            metrics.residuals.absent += 1;
        }

        if (state === "settled" && session.residual?.counters !== undefined) {
            const counters = session.residual.counters;

            residuals += 1;
            residual.input += num(counters.input);
            residual.output += num(counters.output);
            residual.cacheRead += num(counters.cacheRead);
            residual.cacheWrite += num(counters.cacheWrite);
            residual.totalTokens += num(counters.totalTokens);
            residual.cost = roundCost(residual.cost + num(counters.cost));
        }
    }

    const state = usageKnowledge(sessionStates);
    const range: UsageRangeSum =
        state === "unknown"
            ? {
                  entries: null,
                  input: null,
                  output: null,
                  cacheRead: null,
                  cacheWrite: null,
                  totalTokens: null,
                  cost: null,
                  costEntries: null,
                  zeroCostEntries: null,
                  unknownCostEntries: null,
              }
            : sum;

    return {
        ...range,
        state,
        sessionStates,
        ...metrics,
        undated: {
            counters: undated,
            residual: residuals === 0 ? null : { sessions: residuals, counters: residual },
        },
    };
}

function reduceIssues(issues: readonly IssueFact[], window: Window): TimeToSolve {
    const samples: number[] = [];
    const metrics: TimeToSolve = {
        medianMs: null,
        p90Ms: null,
        count: 0,
        nowUnresolved: 0,
        dated: { invalid: 0 },
        undated: {},
    };

    const undated = (reason: UndatedReason): void => {
        metrics.undated[reason] = (metrics.undated[reason] ?? 0) + 1;
    };

    for (const fact of issues) {
        if (fact.untracked === true) {
            continue;
        }

        // A ref gone or out of reach keeps its reason, even when an older read stored it as open.
        if (fact.unresolved === "missing" || fact.unresolved === "inaccessible") {
            undated(fact.unresolved);

            continue;
        }

        if (fact.unresolved === "open" || fact.state === "OPEN") {
            metrics.nowUnresolved += 1;

            continue;
        }

        if (fact.unresolved !== undefined) {
            undated(fact.unresolved);

            continue;
        }

        const resolution = fact.resolution;

        if (resolution === undefined) {
            undated(fact.state === "CLOSED" ? "no-resolution" : "unread");

            continue;
        }

        if (!dashboard.validTime(resolution.mergedAt)) {
            undated("invalid");

            continue;
        }

        if (!inRange(resolution.mergedAt, window)) {
            continue;
        }

        const duration = dashboard.validTime(fact.createdAt)
            ? resolution.mergedAt - fact.createdAt
            : -1;

        if (duration >= 0) {
            samples.push(duration);
        } else {
            metrics.dated.invalid += 1;
        }
    }

    metrics.count = samples.length;
    metrics.medianMs = median(samples);
    metrics.p90Ms = nearestRank(samples, 0.9);

    if (samples.length === 0) {
        metrics.flag = "No eligible resolved issues";
    }

    return metrics;
}

// ─── Attribution ─────────────────────────────────────────────────────────────

/** The lowercased repository of a record, or undefined: unattributed. */
const repoKey = (repo: unknown): string | undefined =>
    dashboard.isRepoName(repo) ? repo.toLowerCase() : undefined;

const sessionRepo = (session: Readonly<SessionUsage>): string | undefined => {
    const assign = session.assign;

    return assign !== undefined && "repo" in assign ? repoKey(assign.repo) : undefined;
};

/** Every record by its lowercased repository (once each), and the unattributed ones. */
export function groupFacts(
    dashboardState: Readonly<DashboardState> | undefined,
    usageState: Readonly<UsageState> | undefined,
): { byRepo: Map<string, Facts>; unattributed: Facts } {
    const byRepo = new Map<string, Facts>();
    const unattributed = noFacts();

    const groupOf = (repo: string | undefined): Facts => {
        if (repo === undefined) {
            return unattributed;
        }

        let facts = byRepo.get(repo);

        if (facts === undefined) {
            facts = noFacts();
            byRepo.set(repo, facts);
        }

        return facts;
    };

    for (const fact of Object.values(dashboardState?.threads ?? {})) {
        groupOf(repoKey(fact.repo)).threads.push(fact);
    }

    for (const fact of Object.values(dashboardState?.prs ?? {})) {
        if (fact.untracked !== true) {
            groupOf(repoKey(fact.repo)).prs.push(fact);
        }
    }

    for (const fact of Object.values(dashboardState?.issues ?? {})) {
        if (fact.untracked !== true) {
            groupOf(repoKey(fact.repo)).issues.push(fact);
        }
    }

    for (const session of Object.values(usageState?.sessions ?? {})) {
        groupOf(sessionRepo(session)).sessions.push(session);
    }

    return { byRepo, unattributed };
}

/** Add the records of `facts` to `target`, 1 by 1: a spread of a long list can overflow the call stack. */
function concat(target: Facts, facts: Readonly<Facts>): void {
    for (const each of facts.threads) {
        target.threads.push(each);
    }

    for (const each of facts.prs) {
        target.prs.push(each);
    }

    for (const each of facts.issues) {
        target.issues.push(each);
    }

    for (const each of facts.sessions) {
        target.sessions.push(each);
    }
}

// ─── Coverage ────────────────────────────────────────────────────────────────

type AnySource = {
    at?: number;
    ok?: boolean;
    error?: string;
    kind?: FailureKind;
    lastGoodAt?: number;
    checkedAt?: number;
    partial?: string[];
    complete?: boolean;
};

/**
 * A source's view and its status: never, failed, stale, partial, or ok, in that order. Stale: the last good read is
 * older than `STALE_MS`. GitHub has its own rule: `githubView`.
 */
export function sourceView(source: Readonly<AnySource> | undefined, now: number): SourceView {
    const view = baseView(source);
    const checked = source?.checkedAt ?? source?.lastGoodAt;

    if (view.status !== "ok") {
        return view;
    }

    if (checked === undefined || now - checked > STALE_MS) {
        view.status = "stale";
    } else if (partialSource(source)) {
        view.status = "partial";
    }

    return view;
}

/** The fields of a source's view; status never, failed, or ok. */
function baseView(source: Readonly<AnySource> | undefined): SourceView {
    return {
        status: source?.at === undefined ? "never" : source.ok !== true ? "failed" : "ok",
        at: source?.at ?? null,
        ok: source?.ok ?? null,
        kind: source?.kind ?? null,
        error: source?.error ?? null,
        lastGoodAt: source?.lastGoodAt ?? null,
        checkedAt: source?.checkedAt ?? null,
    };
}

const partialSource = (source: Readonly<AnySource> | undefined): boolean =>
    (source?.partial?.length ?? 0) > 0 || source?.complete === false || source?.kind === "partial";

/**
 * When the collector's rules make a tracked ref due again, from the stored facts only (the same rules as `prDue` and
 * `issueDue` in `_desk-dashboard.ts`), or undefined when it is not due again (a merged PR with no gap). A ref never
 * read and with no error is due from the last GitHub read, or from the first pass.
 */
function nextReadAt(
    fact: Readonly<PrFact> | Readonly<IssueFact>,
    lastCollection: number | undefined,
): number | undefined {
    if (fact.readAt === undefined && fact.errorAt === undefined) {
        return lastCollection;
    }

    if (fact.error !== undefined && fact.errorAt !== undefined) {
        // A missing or forbidden ref waits as a closed one does.
        return (
            fact.errorAt +
            (fact.error === "NOT_FOUND" || fact.error === "FORBIDDEN"
                ? dashboard.CLOSED_REFRESH_MS
                : dashboard.ERROR_RETRY_MS)
        );
    }

    const readAt = fact.readAt ?? fact.errorAt ?? 0;

    if ("closing" in fact && fact.closing?.cursor !== undefined) {
        return readAt;
    }

    if ("github" in fact && fact.github === "frozen") {
        return readAt + dashboard.CLOSED_REFRESH_MS;
    }

    if (fact.state === "OPEN") {
        return readAt + dashboard.OPEN_REFRESH_MS;
    }

    if (fact.state === "CLOSED") {
        return readAt + dashboard.CLOSED_REFRESH_MS;
    }

    if (fact.state === "MERGED") {
        return (fact.gaps?.length ?? 0) > 0 ? readAt + dashboard.CLOSED_REFRESH_MS : undefined;
    }

    return readAt + dashboard.ERROR_RETRY_MS;
}

/** The tracked refs (not excluded, not untracked) whose next read is due by more than `STALE_MS`. */
export function overdueRefs(state: Readonly<DashboardState> | undefined, now: number): number {
    const lastCollection = state?.sources.github?.at ?? state?.initializedAt;
    let overdue = 0;

    const count = (fact: Readonly<PrFact> | Readonly<IssueFact>): void => {
        const due = nextReadAt(fact, lastCollection);

        if (due !== undefined && now - due > STALE_MS) {
            overdue += 1;
        }
    };

    for (const fact of Object.values(state?.prs ?? {})) {
        if (fact.untracked !== true && fact.excluded === undefined) {
            count(fact);
        }
    }

    for (const fact of Object.values(state?.issues ?? {})) {
        if (fact.untracked !== true) {
            count(fact);
        }
    }

    return overdue;
}

/**
 * The GitHub source's view. GitHub writes no heartbeat when no read is due, so its age alone does not make it stale.
 * Stale: the threads source is stale or never read (1 pass reads both), or a tracked ref is overdue. During a valid
 * backoff, overdue refs do not count, and the status is at least partial.
 */
export function githubView(
    source: Readonly<GitHubSource> | undefined,
    threads: Readonly<SourceView>,
    overdue: number,
    now: number,
): SourceView {
    const view = baseView(source);

    if (view.status !== "ok") {
        return view;
    }

    const backoff = source?.backoffUntil !== undefined && source.backoffUntil > now;

    if (threads.status === "stale" || threads.status === "never") {
        view.status = "stale";
    } else if (!backoff && overdue > 0) {
        view.status = "stale";
    } else if (backoff || partialSource(source)) {
        view.status = "partial";
    }

    return view;
}

const LIMITS = {
    "latest-known-outcomes":
        "Thread outcomes are the latest known: a reopened thread leaves its range until it closes again.",
    "tracked-work-only":
        "Only Desk-tracked work counts: this is not all GitHub activity of an owner or repository.",
    "dated-model-usage-only":
        "Tokens and cost are the dated assistant-model usage of Desk-linked sessions only, not all machine spend.",
    "undated-residual":
        "Compaction and other undated usage cannot go into a day: it is shown apart, outside the range totals.",
    "cost-not-invoice":
        "Reported model cost is an estimate from recorded usage, not an invoice or a subscription charge.",
    "usage-gaps":
        "Some counted sessions have malformed entries, a ledger mismatch, or a ledger that could not be read: their usage is incomplete.",
    "usage-unknown":
        "Some counted sessions have no complete usage read (not read yet, changed since the last read, gone, failed, or only malformed entries): their usage is unknown or partial, not 0.",
    "zero-cost-reported":
        "Some entries report a cost of exactly 0: subscription or provider pricing can report 0.",
    "partial-first-day":
        "The first day of the range holds the recovery boundary: only part of that day is covered.",
    "range-clamped":
        "The default range started before the recovery boundary: it starts at the boundary's day.",
    "not-started": "Collection has not started: there is no recovery boundary yet.",
    "incomplete-sources":
        "At least 1 source is stale, failed, partial, or never read: the values are the last good facts.",
} as const;

const limitation = (code: keyof typeof LIMITS): Limitation => ({ code, text: LIMITS[code] });

// ─── The snapshot ────────────────────────────────────────────────────────────

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The whole answer of `GET dashboard`, or why the query is refused (a 400). */
export function snapshot(input: SnapshotInput): Snapshot | { error: string } {
    const { now } = input;
    const state = input.dashboard;
    const boundary = dashboard.validTime(state?.boundary) ? state.boundary : undefined;
    const parsed = parseQuery(input.query, now, boundary);

    if ("error" in parsed) {
        return parsed;
    }

    const { range, scope } = parsed;
    const window: Window = range;
    const { byRepo, unattributed } = groupFacts(state, input.usage);
    const inScope = (repo: string): boolean =>
        scope.kind === "all" ||
        (scope.kind === "owner"
            ? repo.split("/")[0] === scope.owner.toLowerCase()
            : repo === scope.repo.toLowerCase());
    const repos = [...byRepo.keys()].filter(inScope).sort(byName);
    const owners = new Map<string, Facts>();
    const projects: ProjectRow[] = [];

    for (const repo of repos) {
        const facts = byRepo.get(repo) ?? noFacts();
        const owner = repo.split("/")[0] ?? "";
        let ownerFacts = owners.get(owner);

        if (ownerFacts === undefined) {
            ownerFacts = noFacts();
            owners.set(owner, ownerFacts);
        }

        concat(ownerFacts, facts);
        projects.push({ repo, owner, metrics: reduce(facts, window) });
    }

    const ownerRows: OwnerRow[] = [...owners.keys()].sort(byName).map((owner) => ({
        owner,
        metrics: reduce(owners.get(owner) ?? noFacts(), window),
    }));
    const all = noFacts();

    for (const facts of owners.values()) {
        concat(all, facts);
    }

    if (scope.kind === "all") {
        concat(all, unattributed);
    }

    const counts: Daily = new Map();
    const totals = reduce(all, window, counts);
    const daily: Snapshot["daily"] = [];

    for (let day = range.dayStart; day < range.dayStart + range.days * DAY_MS; day += DAY_MS) {
        const key = dayOf(day);

        daily.push({ day: key, successes: counts.get(key) ?? 0 });
    }

    return {
        asOf: now,
        range,
        scope,
        totals,
        daily,
        rows: {
            projects,
            owners: ownerRows,
            unattributed: scope.kind === "all" ? reduce(unattributed, window) : null,
        },
        coverage: coverageOf(state, input.usage, now, range, totals),
        choices: {
            owners: [...new Set([...byRepo.keys()].map((repo) => repo.split("/")[0] ?? ""))].sort(
                byName,
            ),
            repos: [...byRepo.keys()].sort(byName),
        },
    };
}

function coverageOf(
    state: Readonly<DashboardState> | undefined,
    usageState: Readonly<UsageState> | undefined,
    now: number,
    range: Range,
    totals: Metrics,
): Coverage {
    const boundary = dashboard.validTime(state?.boundary) ? state.boundary : undefined;
    const github = state?.sources.github;
    const usageSource = usageState?.sources.usage;
    const threads = sourceView(state?.sources.threads, now);
    const overdue = overdueRefs(state, now);
    const usage = sourceView(usageSource, now);
    const gaps = usageGaps(totals.usage);

    // Malformed entries, a residual mismatch, or a ledger that could not be read: the usage is partial.
    if (gaps && usage.status === "ok") {
        usage.status = "partial";
    }

    const sources: Coverage["sources"] = {
        threads,
        github: {
            ...githubView(github, threads, overdue, now),
            backoffUntil: github?.backoffUntil ?? null,
        },
        usage,
    };
    const limitations: Limitation[] = [
        limitation("latest-known-outcomes"),
        limitation("tracked-work-only"),
        limitation("dated-model-usage-only"),
        limitation("undated-residual"),
        limitation("cost-not-invoice"),
    ];

    if (gaps) {
        limitations.push(limitation("usage-gaps"));
    }

    if (totals.usage.state === "unknown" || totals.usage.state === "partial") {
        limitations.push(limitation("usage-unknown"));
    }

    if ((totals.usage.zeroCostEntries ?? 0) > 0) {
        limitations.push(limitation("zero-cost-reported"));
    }

    if (boundary === undefined) {
        limitations.push(limitation("not-started"));
    } else if (dayOf(boundary) === range.from) {
        limitations.push(limitation("partial-first-day"));
    }

    if (range.clamped) {
        limitations.push(limitation("range-clamped"));
    }

    if (Object.values(sources).some((source) => source.status !== "ok")) {
        limitations.push(limitation("incomplete-sources"));
    }

    return {
        status: boundary === undefined ? "not started" : "started",
        boundary: boundary ?? null,
        boundaryDay: boundary === undefined ? null : dayOf(boundary),
        initializedAt: state?.initializedAt ?? null,
        sources,
        progress: {
            github: {
                pending: github?.pending ?? null,
                complete: github?.complete ?? null,
                overdue,
            },
            usage: {
                pending: usageSource?.pending ?? null,
                complete: usageSource?.complete ?? null,
                ledgerUnavailable: usageSource?.ledgerUnavailable ?? null,
            },
        },
        population: totals.population,
        limitations,
    };
}
