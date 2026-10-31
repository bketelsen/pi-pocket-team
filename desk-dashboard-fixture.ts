// A known set of dashboard facts, for the browser preview (`preview-desk.ts`) and for the test that checks the numbers
// the screen shows (`desk-dashboard-web.test.ts`). Every time is relative to `now`: events are whole hours on days
// before today (UTC), so the counts of a range do not change during a day. Nothing here reads Brian's data.
import type { DashboardState, IssueFact, PrFact, ThreadFact } from "./_desk-dashboard.ts";
import type { Counters, SessionUsage, UsageState } from "./_desk-usage.ts";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/** The repositories of the fixture: 3 owners, and 1 name of more than 60 characters. */
export const REPOS = {
    snosi: "frostyard/snosi",
    long: "frostyard/a-very-long-repository-name-that-checks-wrapping-on-phones",
    team: "bketelsen/pi-pocket-team",
    wiki: "bketelsen/homewiki",
    widgets: "acme-labs/widgets",
} as const;

/** The variants of the preview: each shows 1 state of the screen. */
export const VARIANTS = [
    "main",
    "empty",
    "not-started",
    "stale",
    "usage-unavailable",
    "partial-usage",
] as const;

export type Variant = (typeof VARIANTS)[number];

export type Fixture = { dashboard: DashboardState; usage: UsageState };

const thread = (id: string, overrides: Partial<ThreadFact>): ThreadFact => ({
    id,
    origin: "delegate",
    role: "delivery",
    state: "open",
    prs: [],
    issues: [],
    ...overrides,
});

const counters = (overrides: Partial<Counters>): Counters => ({
    entries: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...overrides,
});

/** Midnight UTC of the day of `now`. */
export const todayStart = (now: number): number => Math.floor(now / DAY) * DAY;

/** The UTC day "YYYY-MM-DD" of a time. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The fixture's facts at `now`, for 1 variant. */
export function dashboardFixture(now: number, variant: Variant = "main"): Fixture {
    const t0 = todayStart(now);
    /** `days` before today, at `hour` UTC. */
    const at = (days: number, hour = 0): number => t0 - days * DAY + hour * HOUR;
    const fresh = now - 5 * 60_000;
    const initializedAt = at(2, 3);
    const boundary = initializedAt - 90 * DAY;

    if (variant === "not-started") {
        return {
            dashboard: { threads: {}, prs: {}, issues: {}, sources: {} },
            usage: { sessions: {}, sources: {} },
        };
    }

    const sources: DashboardState["sources"] = {
        threads: { at: fresh, ok: true, lastGoodAt: fresh, checkedAt: fresh },
        github: {
            at: fresh,
            ok: true,
            lastGoodAt: fresh,
            pending: 1,
            complete: false,
            rateRemaining: 4800,
        },
    };
    const usageSource: UsageState["sources"] = {
        usage: {
            at: fresh,
            ok: true,
            lastGoodAt: fresh,
            checkedAt: fresh,
            pending: 0,
            ledgerUnavailable: 0,
            complete: true,
            boundary,
        },
    };

    if (variant === "empty") {
        // Nothing tracked: nothing pending either.
        sources.github = { ...sources.github, pending: 0, complete: true };

        return {
            dashboard: { initializedAt, boundary, threads: {}, prs: {}, issues: {}, sources },
            usage: { sessions: {}, sources: usageSource },
        };
    }

    const closed = (
        id: string,
        repo: string | undefined,
        closedAt: number | undefined,
        why: "done" | "dropped" | "failed",
        outcome?: "completed" | "verified" | "abandoned" | "frozen",
        startedAt?: number,
    ): ThreadFact =>
        thread(id, {
            ...(repo === undefined ? {} : { repo }),
            state: "closed",
            ...(startedAt === undefined ? {} : { startedAt }),
            closed: {
                ...(closedAt === undefined ? {} : { at: closedAt }),
                why,
                ...(outcome === undefined ? {} : { outcome }),
            },
        });
    const threads: ThreadFact[] = [
        closed("T1", REPOS.snosi, at(2, 10), "done", "completed", at(3, 10)),
        closed("T2", REPOS.snosi, at(5, 12), "done", "verified", at(5, 6)),
        closed("T3", REPOS.snosi, at(6, 9), "done", "abandoned", at(7, 9)),
        closed("T4", REPOS.snosi, at(10, 9), "failed", undefined, at(11, 9)),
        closed("T5", REPOS.snosi, at(4, 9), "dropped", undefined, at(5, 9)),
        closed("T6", REPOS.long, at(12, 15), "done", "completed", at(14, 15)),
        closed("T7", REPOS.long, at(3, 8), "done", "frozen", at(4, 8)),
        // An old record: no outcome, so it is unknown.
        closed("T8", REPOS.long, at(20, 8), "done", undefined, at(21, 8)),
        closed("T9", REPOS.team, at(1, 20), "done", "completed", at(1, 8)),
        // Only in a 90-day range.
        closed("T10", REPOS.team, at(40, 10), "done", "verified", at(41, 10)),
        // No start time: a success with no cycle time.
        closed("T11", REPOS.team, at(9, 10), "done", "completed"),
        // No close time: undated.
        closed("T12", REPOS.wiki, undefined, "done", "completed", at(30, 0)),
        closed("T13", REPOS.widgets, at(25, 10), "done", "completed", at(25, 4)),
        thread("T14", { repo: REPOS.widgets, state: "open", startedAt: at(3) }),
        thread("T15", { repo: REPOS.snosi, state: "open", startedAt: at(1) }),
        thread("T16", { repo: REPOS.team, state: "parked", startedAt: at(8) }),
        thread("T17", { repo: REPOS.long, state: "starting", startedAt: at(0) }),
        // No repository: unattributed.
        closed("T18", undefined, at(3, 14), "done", "completed", at(3, 12)),
        thread("T19", { origin: "plan", role: "coordinator", repo: REPOS.team, state: "open" }),
        thread("T20", { origin: "ask", role: "excluded", excluded: "ask-only", state: "open" }),
        thread("T21", { state: "open", startedAt: at(2) }),
        // A start after the close: no cycle time.
        closed("T22", REPOS.snosi, at(15, 10), "done", "completed", at(15, 11)),
    ];

    const pr = (ref: string, overrides: Partial<PrFact>): PrFact => {
        const [repo = "", number = "0"] = ref.split("#");

        return {
            ref,
            repo,
            number: Number(number),
            threads: ["T1"],
            via: ["seen"],
            readAt: fresh,
            ...overrides,
        };
    };

    const prs: PrFact[] = [
        pr(`${REPOS.snosi}#10`, {
            state: "MERGED",
            createdAt: at(4, 9),
            mergedAt: at(2, 9),
            closedAt: at(2, 9),
        }),
        pr(`${REPOS.snosi}#11`, { state: "CLOSED", createdAt: at(8, 9), closedAt: at(6, 9) }),
        pr(`${REPOS.snosi}#12`, { state: "OPEN", createdAt: at(1, 9) }),
        pr(`${REPOS.long}#3`, {
            state: "MERGED",
            createdAt: at(40, 1),
            mergedAt: at(20, 1),
            closedAt: at(20, 1),
        }),
        pr(`${REPOS.team}#93`, {
            state: "MERGED",
            createdAt: at(2, 1),
            mergedAt: at(1, 18),
            closedAt: at(1, 18),
        }),
        pr(`${REPOS.team}#94`, { state: "OPEN", createdAt: at(45) }),
        // GitHub did not give its close time: a coverage gap, not a fetch time.
        pr(`${REPOS.team}#95`, {
            state: "MERGED",
            createdAt: at(3),
            mergedAt: at(2),
            gaps: ["closedAt"],
        }),
        pr(`${REPOS.wiki}#5`, { via: ["window"], excluded: "window", state: "OPEN" }),
        pr(`${REPOS.widgets}#7`, { excluded: "missing", github: "missing", error: "NOT_FOUND" }),
    ];

    // Not read yet: a ref the next pass reads.
    const unread = pr(`${REPOS.snosi}#13`, {});

    delete unread.readAt;
    prs.push(unread);

    const issue = (ref: string, overrides: Partial<IssueFact>): IssueFact => {
        const [repo = "", number = "0"] = ref.split("#");

        return {
            ref,
            repo,
            number: Number(number),
            threads: ["T1"],
            plans: [],
            readAt: fresh,
            ...overrides,
        };
    };

    const resolved = (createdAt: number, pr: string, mergedAt: number): Partial<IssueFact> => ({
        state: "CLOSED",
        stateReason: "COMPLETED",
        createdAt,
        closedAt: mergedAt,
        resolution: { pr: pr.toLowerCase(), mergedAt, evidence: "closed-event", at: fresh },
    });
    const issues: IssueFact[] = [
        issue(`${REPOS.snosi}#100`, resolved(at(10), `${REPOS.snosi}#10`, at(2, 9))),
        // Resolved by a PR in another repository: it counts for the issue's repository.
        issue(`${REPOS.snosi}#101`, resolved(at(3, 9), `${REPOS.team}#93`, at(1, 18))),
        // Created before the recovery boundary: its merge is in the range.
        issue(`${REPOS.long}#1`, resolved(at(100), `${REPOS.long}#3`, at(20, 1))),
        // A merge before the creation: not a valid duration.
        issue(`${REPOS.team}#50`, resolved(at(2, 6), `${REPOS.team}#95`, at(2))),
        issue(`${REPOS.team}#51`, { state: "OPEN", createdAt: at(6), unresolved: "open" }),
        issue(`${REPOS.team}#52`, resolved(at(5), `${REPOS.team}#93`, at(4))),
        issue(`${REPOS.widgets}#2`, {
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
            createdAt: at(30),
            closedAt: at(12),
            unresolved: "not-planned",
        }),
        issue(`${REPOS.wiki}#3`, {
            state: "CLOSED",
            createdAt: at(30),
            closedAt: at(11),
            unresolved: "ambiguous",
        }),
    ];
    const session = (id: number, overrides: Partial<SessionUsage>): SessionUsage => ({
        id,
        scannedAt: fresh,
        caughtUp: true,
        ...overrides,
    });
    const day = (days: number): string => dayOf(at(days));
    const sessions: SessionUsage[] = [
        session(101, {
            links: ["T1"],
            assign: { repo: REPOS.snosi, via: 101 },
            days: {
                [day(2)]: {
                    "anthropic/claude-opus": counters({
                        entries: 4,
                        input: 1000,
                        output: 200,
                        cacheRead: 5000,
                        cacheWrite: 300,
                        totalTokens: 6500,
                        cost: 0.75,
                        costEntries: 4,
                    }),
                },
                [day(40)]: {
                    "anthropic/claude-opus": counters({
                        entries: 1,
                        input: 100,
                        output: 10,
                        totalTokens: 110,
                        cost: 0.01,
                        costEntries: 1,
                    }),
                },
            },
        }),
        // A subscription model: it reports a cost of exactly 0.
        session(102, {
            links: ["T6"],
            assign: { repo: REPOS.long, via: 102 },
            days: {
                [day(3)]: {
                    "github-copilot/claude-sonnet": counters({
                        entries: 2,
                        input: 400,
                        output: 100,
                        totalTokens: 500,
                        cost: 0,
                        costEntries: 2,
                        zeroCostEntries: 2,
                    }),
                },
            },
        }),
        // No cost reported: unknown, not 0. A settled compaction residual, outside the range totals.
        session(103, {
            links: ["T9"],
            assign: { repo: REPOS.team, via: 103 },
            days: {
                [day(1)]: {
                    "deepseek/deepseek-flash": counters({
                        entries: 3,
                        input: 600,
                        output: 150,
                        cacheRead: 1200,
                        totalTokens: 1950,
                    }),
                },
            },
            residual: {
                state: "settled",
                counters: {
                    input: 50,
                    output: 5,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 55,
                    cost: 0.02,
                },
            },
        }),
        // 2 explicit repositories: unattributed, a conflict.
        session(104, {
            links: ["T30", "T31"],
            assign: { none: "conflict", repos: [REPOS.snosi, REPOS.team], via: 104 },
            days: {
                [day(4)]: {
                    "openai/gpt": counters({
                        entries: 1,
                        input: 100,
                        output: 20,
                        totalTokens: 120,
                        cost: 0.05,
                        costEntries: 1,
                    }),
                },
            },
        }),
        // No repository, and usage with no date only.
        session(105, {
            links: ["T18"],
            assign: { none: "no-repo", via: 105 },
            undated: counters({
                entries: 1,
                input: 10,
                output: 2,
                totalTokens: 12,
                cost: 0.001,
                costEntries: 1,
            }),
        }),
        // A supervisor: shared, never charged.
        session(106, {
            shared: true,
            days: {
                [day(1)]: {
                    "anthropic/claude-opus": counters({
                        entries: 10,
                        input: 9999,
                        totalTokens: 9999,
                        cost: 9,
                        costEntries: 10,
                    }),
                },
            },
        }),
        // Its conversation is gone: its collected usage still counts.
        session(107, {
            links: ["T13"],
            assign: { repo: REPOS.widgets, via: 107 },
            missingAt: fresh,
            days: {
                [day(25)]: {
                    "anthropic/claude-opus": counters({
                        entries: 1,
                        input: 200,
                        output: 50,
                        totalTokens: 250,
                        cost: 0.1,
                        costEntries: 1,
                    }),
                },
            },
        }),
    ];
    const dashboard: DashboardState = {
        initializedAt,
        boundary,
        threads: Object.fromEntries(threads.map((each) => [each.id, each])),
        prs: Object.fromEntries(prs.map((each) => [each.ref.toLowerCase(), each])),
        issues: Object.fromEntries(issues.map((each) => [each.ref.toLowerCase(), each])),
        sources,
    };
    const usage: UsageState = {
        sessions: Object.fromEntries(sessions.map((each) => [String(each.id), each])),
        sources: usageSource,
    };

    if (variant === "stale") {
        // The last good reads are 3 hours old.
        const old = now - 3 * HOUR;

        dashboard.sources.threads = { at: old, ok: true, lastGoodAt: old, checkedAt: old };
        dashboard.sources.github = { ...dashboard.sources.github, at: old, lastGoodAt: old };

        if (usage.sources.usage !== undefined) {
            usage.sources.usage = {
                ...usage.sources.usage,
                at: old,
                lastGoodAt: old,
                checkedAt: old,
            };
        }
    }

    if (variant === "usage-unavailable") {
        usage.sources.usage = {
            at: fresh,
            ok: false,
            error: "the usage read failed: conversation scan refused",
            lastGoodAt: now - 2 * DAY,
            checkedAt: now - 2 * DAY,
            pending: 4,
            complete: false,
            boundary,
        };
    }

    if (variant === "partial-usage") {
        // The backfill still has sessions to read, and 1 ledger could not be read.
        usage.sources.usage = {
            ...usageSource.usage!,
            pending: 3,
            ledgerUnavailable: 1,
            complete: false,
        };

        const ledgerless = usage.sessions["102"];

        if (ledgerless !== undefined) {
            ledgerless.residual = { state: "unavailable", why: "the ledger could not be read" };
        }
    }

    return { dashboard, usage };
}
