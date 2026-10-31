// The dashboard's numbers: the pure reducers of `_desk-metrics.ts` on fixed facts, with exact results, and the
// owner-only `GET dashboard` route in Pocket's test harness with a fake `gh`. Nothing reads Brian's data, and nothing
// goes to GitHub.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createHandler } from "./_pocket/src/server/http.ts";
import {
    CHECK_HEARTBEAT_MS,
    DeskDashboard,
    PASS_MS,
    type DashboardState,
    type IssueFact,
    type PrFact,
    type ThreadFact,
} from "./_desk-dashboard.ts";
import { DeskUsage, type Counters, type SessionUsage, type UsageState } from "./_desk-usage.ts";
import {
    median,
    nearestRank,
    parseQuery,
    reduce,
    snapshot,
    sourceView,
    STALE_MS,
    type Facts,
    type Metrics,
    type MetricsQuery,
    type Snapshot,
    type Window,
} from "./_desk-metrics.ts";
import { DeskThreads } from "./desk.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 2026-10-30T00:00:00Z: "today" of the fixtures. */
const T0 = Date.UTC(2026, 9, 30);
/** The snapshot time: noon of today. */
const NOW = T0 + 12 * HOUR;
/** The recovery boundary: 2026-08-01T06:00Z. */
const BOUNDARY = Date.UTC(2026, 7, 1, 6);
/** Midnight UTC of 2026-10-d. */
const oct = (day: number, hour = 0): number => Date.UTC(2026, 9, day, hour);

const thread = (id: string, overrides: Partial<ThreadFact> = {}): ThreadFact => ({
    id,
    origin: "delegate",
    role: "delivery",
    state: "open",
    prs: [],
    issues: [],
    ...overrides,
});

/** A closed delivery thread. */
const closed = (
    id: string,
    repo: string | undefined,
    at: number | undefined,
    why: "done" | "dropped" | "failed",
    outcome?: string,
    startedAt?: number,
): ThreadFact =>
    thread(id, {
        ...(repo === undefined ? {} : { repo }),
        state: "closed",
        ...(startedAt === undefined ? {} : { startedAt }),
        closed: {
            ...(at === undefined ? {} : { at }),
            why,
            ...(outcome === undefined
                ? {}
                : { outcome: outcome as NonNullable<ThreadFact["closed"]>["outcome"] }),
        },
    });

const pr = (ref: string, overrides: Partial<PrFact> = {}): PrFact => {
    const [repo = "", number = "0"] = ref.split("#");

    return { ref, repo, number: Number(number), threads: ["T1"], via: ["seen"], ...overrides };
};

const issue = (ref: string, overrides: Partial<IssueFact> = {}): IssueFact => {
    const [repo = "", number = "0"] = ref.split("#");

    return { ref, repo, number: Number(number), threads: ["T1"], plans: [], ...overrides };
};

const resolved = (createdAt: number | undefined, mergedAt: number, pr = "x/y#1") => ({
    state: "CLOSED" as const,
    ...(createdAt === undefined ? {} : { createdAt }),
    resolution: { pr, mergedAt, evidence: "closed-event" as const, at: mergedAt },
});

const counters = (overrides: Partial<Counters> = {}): Counters => ({
    entries: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...overrides,
});

const session = (id: number, overrides: Partial<SessionUsage> = {}): SessionUsage => ({
    id,
    ...overrides,
});

const byKey = <T extends { id?: string; ref?: string }>(list: T[]): Record<string, T> =>
    Object.fromEntries(list.map((each) => [(each.id ?? each.ref ?? "").toLowerCase(), each]));

const fresh = (): DashboardState => ({ threads: {}, prs: {}, issues: {}, sources: {} });

/** Fresh sources: every one read at NOW. */
const okSources = (): DashboardState["sources"] => ({
    threads: { at: NOW, ok: true, lastGoodAt: NOW, checkedAt: NOW },
    github: { at: NOW, ok: true, lastGoodAt: NOW, pending: 0, complete: true },
});

const JUL1 = Date.UTC(2026, 6, 1);

/** The main fixture: 3 projects in 2 owners, and unattributed work. */
function mainDashboard(): DashboardState {
    return {
        initializedAt: BOUNDARY + 90 * DAY,
        boundary: BOUNDARY,
        threads: byKey([
            // a/one: 2 successes (24h, 2h), 1 failure.
            closed("T1", "a/one", oct(2, 10), "done", "completed", oct(1, 10)),
            closed("T2", "a/one", oct(3), "done", "verified", oct(2, 22)),
            closed("T3", "a/one", oct(4), "failed"),
            // a/two: 1 success (10h), 3 abandoned.
            closed("T4", "a/two", oct(5), "done", "completed", oct(5) - 10 * HOUR),
            closed("T5", "a/two", oct(6), "done", "abandoned"),
            closed("T6", "a/two", oct(6), "done", "abandoned"),
            closed("T7", "a/two", oct(6), "done", "abandoned"),
            // b/three: 1 success (100h), dropped, frozen, unknown; and the workload.
            closed("T8", "b/three", oct(7), "done", "completed", oct(7) - 100 * HOUR),
            closed("T9", "b/three", oct(7), "dropped", "completed"),
            closed("T10", "b/three", oct(7), "done", "frozen"),
            closed("T11", "b/three", oct(7), "done"),
            thread("T12", { repo: "b/three", state: "open" }),
            thread("T13", { repo: "b/three", state: "parked" }),
            thread("T14", { repo: "b/three", state: "starting" }),
            thread("T15", { repo: "b/three", state: "open", goneAt: oct(20) }),
            // Unattributed: 1 success (1h), a coordinator, 2 excluded, 1 undated, 1 before the range.
            closed("T16", undefined, oct(8), "done", "completed", oct(8) - HOUR),
            { ...closed("T17", undefined, oct(8), "done", "completed"), role: "coordinator" },
            thread("T18", { role: "excluded", excluded: "ask-only", origin: "ask" }),
            thread("T19", { role: "excluded", excluded: "no-work", origin: "found" }),
            closed("T20", undefined, undefined, "done", "completed"),
            closed("T21", undefined, Date.UTC(2026, 8, 20), "done", "completed"),
        ]),
        prs: byKey([
            pr("a/one#1", {
                state: "MERGED",
                createdAt: oct(2),
                mergedAt: oct(3),
                closedAt: oct(3),
                readAt: oct(29),
            }),
            pr("a/one#2", {
                state: "CLOSED",
                createdAt: Date.UTC(2026, 8, 1),
                closedAt: oct(10),
                readAt: oct(29),
            }),
            pr("a/one#8", { state: "OPEN", createdAt: oct(2), readAt: oct(2), untracked: true }),
            pr("a/two#3", { state: "OPEN", createdAt: oct(15), readAt: oct(29) }),
            pr("a/two#4", { state: "OPEN", createdAt: oct(2), excluded: "window" }),
            pr("b/three#5", { excluded: "missing", github: "missing", error: "NOT_FOUND" }),
            pr("b/three#6", { error: "FORBIDDEN", errorAt: oct(29) }),
            // Merged in the range; its createdAt is a gap; readAt is in the range but is not a lifecycle time.
            pr("b/three#7", {
                state: "MERGED",
                mergedAt: oct(20),
                closedAt: oct(20),
                readAt: oct(25),
                gaps: ["createdAt"],
            }),
        ]),
        issues: byKey([
            // Resolved by a PR in another repository: it counts for the issue's repository.
            issue("a/one#10", resolved(oct(1), oct(2), "b/three#99")),
            // Created before the boundary, merged in the range.
            issue("a/one#11", resolved(JUL1, oct(5))),
            issue("a/two#12", resolved(oct(10), oct(10))),
            // A negative duration with a merge in the range.
            issue("a/two#13", resolved(oct(12), oct(11))),
            issue("a/two#14", { ...resolved(oct(1), oct(3)), unresolved: "open", state: "OPEN" }),
            issue("a/two#15", { state: "OPEN", createdAt: oct(1) }),
            issue("b/three#16", { state: "CLOSED", createdAt: oct(1), unresolved: "not-planned" }),
            issue("b/three#17", { state: "CLOSED", createdAt: oct(1), unresolved: "ambiguous" }),
            issue("b/three#18", { state: "CLOSED", createdAt: oct(1), closedAt: oct(2) }),
            issue("b/three#19", { ...resolved(oct(1), oct(2)), untracked: true }),
            issue("b/three#20", resolved(oct(1), oct(4))),
            issue("b/three#21", resolved(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20))),
        ]),
        sources: okSources(),
    };
}

function mainUsage(): UsageState {
    return {
        sessions: {
            "1": session(1, {
                assign: { repo: "a/one", via: 1 },
                days: {
                    "2026-10-01": {
                        "p/x": counters({
                            entries: 2,
                            input: 100,
                            output: 50,
                            cacheRead: 10,
                            cacheWrite: 5,
                            totalTokens: 165,
                            reasoning: 20,
                            reasoningEntries: 2,
                            cacheWrite1h: 3,
                            cacheWrite1hEntries: 1,
                            cost: 0.5,
                            costEntries: 2,
                        }),
                    },
                    "2026-09-30": {
                        "p/x": counters({ entries: 1, input: 1000, totalTokens: 1000 }),
                    },
                },
                before: counters({
                    entries: 9,
                    input: 9999,
                    totalTokens: 9999,
                    cost: 9,
                    costEntries: 9,
                }),
                undated: counters({
                    entries: 1,
                    input: 7,
                    totalTokens: 7,
                    cost: 0.25,
                    costEntries: 1,
                }),
                residual: {
                    state: "settled",
                    counters: {
                        input: 3,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 3,
                        cost: 0.125,
                    },
                },
            }),
            // Missing: its data counts. No cost.
            "2": session(2, {
                assign: { repo: "a/two", via: 2 },
                missingAt: oct(20),
                days: {
                    "2026-10-10": {
                        "p/y": counters({ entries: 3, input: 10, output: 10, totalTokens: 20 }),
                    },
                },
            }),
            // An explicit zero cost.
            "3": session(3, {
                assign: { repo: "a/two", via: 3 },
                days: {
                    "2026-10-11": {
                        "p/y": counters({
                            entries: 1,
                            input: 1,
                            totalTokens: 1,
                            cost: 0,
                            costEntries: 1,
                            zeroCostEntries: 1,
                        }),
                    },
                },
            }),
            "4": session(4, {
                shared: true,
                days: { "2026-10-01": { "p/x": counters({ entries: 50, input: 5000 }) } },
            }),
            "5": session(5, {
                assign: { repo: "b/three", via: 5 },
                unlinkedAt: oct(20),
                days: { "2026-10-01": { "p/x": counters({ entries: 7, input: 700 }) } },
            }),
            "6": session(6, {
                assign: { none: "conflict", repos: ["a/one", "b/three"], via: 6 },
                days: {
                    "2026-10-02": {
                        "p/x": counters({
                            entries: 1,
                            input: 4,
                            totalTokens: 4,
                            cost: 0.25,
                            costEntries: 1,
                        }),
                    },
                },
            }),
            "7": session(7, {
                assign: { none: "no-repo", via: 7 },
                days: {
                    "2026-10-03": { "p/x": counters({ entries: 1, input: 6, totalTokens: 6 }) },
                },
            }),
            // A mismatch residual is not a settled one: not counted.
            "8": session(8, {
                assign: { repo: "b/three", via: 8 },
                residual: {
                    state: "mismatch",
                    why: "x",
                    counters: {
                        input: 99,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 99,
                        cost: 9,
                    },
                },
            }),
        },
        sources: {
            usage: {
                at: NOW,
                ok: true,
                lastGoodAt: NOW,
                checkedAt: NOW,
                pending: 0,
                complete: true,
            },
        },
    };
}

const OCTOBER: MetricsQuery = { from: "2026-10-01", to: "2026-10-30" };

function take(
    query: MetricsQuery = OCTOBER,
    dashboard: DashboardState | null = mainDashboard(),
    usage: UsageState | null = mainUsage(),
    now = NOW,
): Snapshot {
    const answer = snapshot({
        dashboard: dashboard ?? undefined,
        usage: usage ?? undefined,
        now,
        query,
    });

    if ("error" in answer) {
        assert.fail(answer.error);
    }

    return answer;
}

const refused = (
    query: MetricsQuery,
    dashboard: DashboardState | undefined = mainDashboard(),
    now = NOW,
): string => {
    const answer = snapshot({ dashboard, usage: undefined, now, query });

    assert("error" in answer, `refused: ${JSON.stringify(query)}`);

    return answer.error;
};

const project = (answer: Snapshot, repo: string): Metrics =>
    answer.rows.projects.find((row) => row.repo === repo)?.metrics ?? assert.fail(repo);
const ownerRow = (answer: Snapshot, name: string): Metrics =>
    answer.rows.owners.find((row) => row.owner === name)?.metrics ?? assert.fail(name);

/** The window of 1 range for the reducer. */
const windowOf = (from: string, to: string, end?: number): Window => {
    const start = Date.parse(`${from}T00:00:00Z`);

    return { from, to, start, end: end ?? Date.parse(`${to}T00:00:00Z`) + DAY };
};

const factsOf = (overrides: Partial<Facts> = {}): Facts => ({
    threads: [],
    prs: [],
    issues: [],
    sessions: [],
    ...overrides,
});

// ─── The main fixture ────────────────────────────────────────────────────────

describe("the main fixture", () => {
    test("all tracked work: exact numbers", () => {
        const answer = take();
        const t = answer.totals;

        assert.equal(answer.asOf, NOW);
        assert.deepEqual(answer.range, {
            from: "2026-10-01",
            to: "2026-10-30",
            start: oct(1),
            end: NOW,
            days: 30,
            partialToday: true,
            clamped: false,
        });
        assert.deepEqual(answer.scope, { kind: "all" });
        assert.deepEqual(t.completion, {
            rate: 5 / 9,
            success: 5,
            completed: 4,
            verified: 1,
            abandoned: 3,
            failed: 1,
            denominator: 9,
            excluded: { dropped: 1, frozen: 1, unknown: 1 },
            undated: 1,
        });
        assert.deepEqual(t.velocity, { perWeek: 5 / ((NOW - oct(1)) / (7 * DAY)), successes: 5 });
        assert.deepEqual(t.cycleTime, { medianMs: 10 * HOUR, samples: 5, excludedTimestamps: 0 });
        assert.deepEqual(t.workload, { label: "now", total: 3, starting: 1, open: 1, parked: 1 });
        assert.deepEqual(t.population, {
            delivery: 18,
            coordinators: 1,
            excluded: { askOnly: 1, noWork: 1 },
            gone: 1,
        });
        assert.deepEqual(t.prs, {
            created: 2,
            merged: 2,
            closedUnmerged: 1,
            openNow: 1,
            tracked: 5,
            excluded: { window: 1, missing: 1, frozen: 0 },
            coverage: { unread: 1, errored: 1, gaps: 1 },
        });
        assert.deepEqual(t.usage, {
            entries: 8,
            input: 121,
            output: 60,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 196,
            cost: 0.75,
            costEntries: 4,
            zeroCostEntries: 1,
            unknownCostEntries: 4,
            sessions: 6,
            excluded: { shared: 1, unlinked: 1 },
            missing: 1,
            unattributed: { noRepo: 1, conflict: 1, unassigned: 0 },
            undated: {
                counters: {
                    entries: 1,
                    input: 7,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 7,
                    cost: 0.25,
                    costEntries: 1,
                    zeroCostEntries: 0,
                    unknownCostEntries: 0,
                },
                residual: {
                    sessions: 1,
                    counters: {
                        input: 3,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 3,
                        cost: 0.125,
                    },
                },
            },
        });

        const long = oct(5) - JUL1;

        assert.deepEqual(t.timeToSolve, {
            medianMs: 48 * HOUR,
            p90Ms: long,
            count: 4,
            nowUnresolved: 2,
            dated: { invalid: 1 },
            undated: { "not-planned": 1, ambiguous: 1, "no-resolution": 1 },
        });
        assert.equal(answer.daily.length, 30);
        assert.deepEqual(
            answer.daily.filter((day) => day.successes > 0),
            [
                { day: "2026-10-02", successes: 1 },
                { day: "2026-10-03", successes: 1 },
                { day: "2026-10-05", successes: 1 },
                { day: "2026-10-07", successes: 1 },
                { day: "2026-10-08", successes: 1 },
            ],
        );
        assert.deepEqual(answer.daily[0], { day: "2026-10-01", successes: 0 });
        assert.deepEqual(answer.daily[29], { day: "2026-10-30", successes: 0 });
        assert.deepEqual(
            answer.rows.projects.map((row) => [row.repo, row.owner]),
            [
                ["a/one", "a"],
                ["a/two", "a"],
                ["b/three", "b"],
            ],
        );
        assert.deepEqual(
            answer.rows.owners.map((row) => row.owner),
            ["a", "b"],
        );
    });

    test("the unattributed row holds only the records with no repository", () => {
        const row = take().rows.unattributed ?? assert.fail("the row");

        assert.equal(row.completion.success, 1);
        assert.equal(row.completion.rate, 1);
        assert.equal(row.completion.undated, 1);
        assert.deepEqual(row.cycleTime, { medianMs: HOUR, samples: 1, excludedTimestamps: 0 });
        assert.deepEqual(row.population, {
            delivery: 3,
            coordinators: 1,
            excluded: { askOnly: 1, noWork: 1 },
            gone: 0,
        });
        assert.equal(row.usage.entries, 2);
        assert.equal(row.usage.input, 10);
        assert.equal(row.usage.cost, 0.25);
        assert.deepEqual(row.usage.excluded, { shared: 1, unlinked: 0 });
        assert.deepEqual(row.usage.unattributed, { noRepo: 1, conflict: 1, unassigned: 0 });
        assert.equal(row.prs.tracked, 0);
        assert.equal(row.timeToSolve.count, 0);
        assert.equal(row.timeToSolve.flag, "No eligible resolved issues");
    });

    test("an owner: totals from its raw facts, not from sums or averages of its rows", () => {
        const answer = take({ ...OCTOBER, owner: "A" });
        const one = project(answer, "a/one");
        const two = project(answer, "a/two");
        const long = oct(5) - JUL1;

        assert.deepEqual(answer.scope, { kind: "owner", owner: "A" });
        assert.deepEqual(
            answer.rows.projects.map((row) => row.repo),
            ["a/one", "a/two"],
        );
        assert.equal(answer.rows.unattributed, null);
        assert.deepEqual(answer.totals, ownerRow(answer, "a"));
        assert.deepEqual(ownerRow(answer, "a"), ownerRow(take(), "a"));

        // Rates: 2/3 and 1/4 average to 11/24; the owner's rate is 3/7.
        assert.equal(one.completion.rate, 2 / 3);
        assert.equal(two.completion.rate, 1 / 4);
        assert.equal(answer.totals.completion.rate, 3 / 7);
        assert.notEqual(answer.totals.completion.rate, (2 / 3 + 1 / 4) / 2);
        // Medians: 13h and 10h average to 11.5h; the owner's median of [2h, 10h, 24h] is 10h.
        assert.equal(one.cycleTime.medianMs, 13 * HOUR);
        assert.equal(two.cycleTime.medianMs, 10 * HOUR);
        assert.equal(answer.totals.cycleTime.medianMs, 10 * HOUR);
        // Time to solve: a/one has [24h, long], a/two [0]: the owner has [0, 24h, long].
        assert.equal(one.timeToSolve.medianMs, (24 * HOUR + long) / 2);
        assert.equal(two.timeToSolve.medianMs, 0);
        assert.equal(two.timeToSolve.dated.invalid, 1);
        assert.equal(two.timeToSolve.nowUnresolved, 2);
        assert.equal(answer.totals.timeToSolve.medianMs, 24 * HOUR);
        assert.equal(answer.totals.timeToSolve.p90Ms, long);
        assert.equal(answer.totals.timeToSolve.count, 3);
        // Usage: a/two has a known zero cost and 3 entries of unknown cost.
        assert.equal(two.usage.cost, 0);
        assert.equal(two.usage.unknownCostEntries, 3);
        assert.equal(two.usage.missing, 1);
        assert.equal(answer.totals.usage.cost, 0.5);
        assert.equal(answer.totals.workload.total, 0);
        // The all-work median of time to solve is 48h; the mean of the project medians is not.
        const all = take().totals.timeToSolve.medianMs;
        const projects = take().rows.projects.map((row) => row.metrics.timeToSolve.medianMs ?? 0);

        assert.notEqual(all, projects.reduce((a, b) => a + b, 0) / projects.length);
    });

    test("a repository: only its records, any case of the name", () => {
        const answer = take({ ...OCTOBER, repo: "B/Three" });

        assert.deepEqual(answer.scope, { kind: "repo", owner: "B", repo: "B/Three" });
        assert.deepEqual(
            answer.rows.projects.map((row) => row.repo),
            ["b/three"],
        );
        assert.deepEqual(
            answer.rows.owners.map((row) => row.owner),
            ["b"],
        );
        assert.equal(answer.rows.unattributed, null);
        assert.deepEqual(answer.totals.completion, {
            rate: 1,
            success: 1,
            completed: 1,
            verified: 0,
            abandoned: 0,
            failed: 0,
            denominator: 1,
            excluded: { dropped: 1, frozen: 1, unknown: 1 },
            undated: 0,
        });
        assert.deepEqual(answer.totals.workload, {
            label: "now",
            total: 3,
            starting: 1,
            open: 1,
            parked: 1,
        });
        assert.equal(answer.totals.population.gone, 1);
        assert.equal(answer.totals.prs.merged, 1);
        assert.equal(answer.totals.prs.created, 0);
        assert.equal(answer.totals.prs.openNow, 0);
        assert.deepEqual(answer.totals.prs.coverage, { unread: 1, errored: 1, gaps: 1 });
        assert.equal(answer.totals.usage.cost, null, "no entry reported a cost");
        assert.equal(answer.totals.usage.entries, 0);
        assert.deepEqual(answer.totals.usage.excluded, { shared: 0, unlinked: 1 });
        assert.equal(answer.totals.usage.undated.residual.sessions, 0, "a mismatch is not settled");
        assert.deepEqual(answer.totals.timeToSolve, {
            medianMs: 72 * HOUR,
            p90Ms: 72 * HOUR,
            count: 1,
            nowUnresolved: 0,
            dated: { invalid: 0 },
            undated: { "not-planned": 1, ambiguous: 1, "no-resolution": 1 },
        });
        assert.equal(answer.coverage.population, answer.totals.population);
    });

    test("a repository with no records is an empty scope", () => {
        const answer = take({ ...OCTOBER, repo: "c/none" });

        assert.deepEqual(answer.rows.projects, []);
        assert.deepEqual(answer.rows.owners, []);
        assert.equal(answer.totals.completion.rate, null);
        assert.equal(answer.totals.usage.cost, null);
    });
});

// ─── Threads ─────────────────────────────────────────────────────────────────

describe("thread closures", () => {
    const window = windowOf("2026-10-01", "2026-10-29");

    test("every why and outcome case, in the rule's order", () => {
        const at = oct(10);
        const metrics = reduce(
            factsOf({
                threads: [
                    closed("C1", "a/b", at, "done", "completed"),
                    closed("C2", "a/b", at, "done", "verified"),
                    closed("C3", "a/b", at, "done", "abandoned"),
                    closed("C4", "a/b", at, "done", "frozen"),
                    closed("C5", "a/b", at, "done"),
                    closed("C6", "a/b", at, "done", "other"),
                    closed("C7", "a/b", at, "dropped", "completed"),
                    closed("C8", "a/b", at, "dropped", "abandoned"),
                    closed("C9", "a/b", at, "failed", "completed"),
                    closed("C10", "a/b", at, "failed"),
                    closed("C11", "a/b", at, "failed", "frozen"),
                ],
            }),
            window,
        );

        assert.deepEqual(metrics.completion, {
            rate: 2 / 6,
            success: 2,
            completed: 1,
            verified: 1,
            abandoned: 1,
            failed: 3,
            denominator: 6,
            excluded: { dropped: 2, frozen: 1, unknown: 2 },
            undated: 0,
        });
    });

    test("a reopened thread leaves the cohort; a reclosed one counts once at its latest close", () => {
        const metrics = reduce(
            factsOf({
                threads: [
                    // Reopened: open, with no closure.
                    thread("R1", { repo: "a/b", state: "open", startedAt: oct(1) }),
                    // A closure on an open thread does not count.
                    {
                        ...thread("R2", { repo: "a/b", state: "open" }),
                        closed: { at: oct(5), why: "done", outcome: "completed" },
                    },
                    // Reclosed: its latest close only.
                    closed("R3", "a/b", oct(20), "done", "completed", oct(19)),
                ],
            }),
            window,
        );

        assert.equal(metrics.completion.success, 1);
        assert.equal(metrics.completion.denominator, 1);
        assert.equal(metrics.workload.open, 2);
        assert.deepEqual(metrics.cycleTime, { medianMs: DAY, samples: 1, excludedTimestamps: 0 });
    });

    test("cycle time excludes a missing start and a close before the start", () => {
        const metrics = reduce(
            factsOf({
                threads: [
                    closed("S1", "a/b", oct(10), "done", "completed"),
                    closed("S2", "a/b", oct(10), "done", "completed", oct(11)),
                    closed("S3", "a/b", oct(10), "done", "completed", oct(10)),
                    // Abandoned: no cycle time sample, no exclusion.
                    closed("S4", "a/b", oct(10), "done", "abandoned"),
                ],
            }),
            window,
        );

        assert.deepEqual(metrics.cycleTime, { medianMs: 0, samples: 1, excludedTimestamps: 2 });
    });

    test("the range is inclusive at its start and exclusive at its end", () => {
        const metrics = reduce(
            factsOf({
                threads: [
                    closed("B1", "a/b", window.start, "done", "completed"),
                    closed("B2", "a/b", window.end, "done", "completed"),
                    closed("B3", "a/b", window.start - 1, "done", "completed"),
                    closed("B4", "a/b", window.end - 1, "done", "completed"),
                ],
            }),
            window,
        );

        assert.equal(metrics.completion.success, 2);
    });
});

// ─── Ranges ──────────────────────────────────────────────────────────────────

describe("ranges", () => {
    test("partial today: the range ends now, and velocity uses the elapsed half day", () => {
        const dashboard = fresh();

        dashboard.boundary = BOUNDARY;
        dashboard.threads.T1 = closed("T1", "a/b", T0 + HOUR, "done", "completed");
        // After now: not in the range.
        dashboard.threads.T2 = closed("T2", "a/b", NOW + HOUR, "done", "completed");

        const answer = take({ from: "2026-10-30", to: "2026-10-30" }, dashboard);

        assert.equal(answer.range.end, NOW);
        assert.equal(answer.range.partialToday, true);
        assert.equal(answer.range.days, 1);
        assert.equal(answer.totals.completion.success, 1);
        assert.equal(answer.totals.velocity.perWeek, 14);
        assert.deepEqual(answer.daily, [{ day: "2026-10-30", successes: 1 }]);
    });

    test("a range that ends before today ends at the next midnight", () => {
        const dashboard = fresh();

        dashboard.boundary = BOUNDARY;
        dashboard.threads.T1 = closed("T1", "a/b", oct(29), "done", "completed");
        dashboard.threads.T2 = closed("T2", "a/b", oct(30), "done", "completed");

        const answer = take({ from: "2026-10-29", to: "2026-10-29" }, dashboard);

        assert.equal(answer.range.start, oct(29));
        assert.equal(answer.range.end, oct(30));
        assert.equal(answer.range.partialToday, false);
        assert.equal(answer.totals.completion.success, 1);
        assert.equal(answer.totals.velocity.perWeek, 7);
    });

    test("an empty interval (today at midnight) has no velocity", () => {
        const answer = take({ from: "2026-10-30", to: "2026-10-30" }, fresh(), null, T0);

        assert.equal(answer.range.end, T0);
        assert.deepEqual(answer.totals.velocity, { perWeek: null, successes: 0 });
    });

    test("the default range: the last 30 days, and no boundary means not started", () => {
        const answer = take({}, fresh(), null);

        assert.equal(answer.range.from, "2026-10-01");
        assert.equal(answer.range.to, "2026-10-30");
        assert.equal(answer.range.days, 30);
        assert.equal(answer.range.clamped, false);
        assert.equal(answer.coverage.status, "not started");
        assert.equal(answer.coverage.boundary, null);
        assert(answer.coverage.limitations.some((each) => each.code === "not-started"));
        // With no boundary, an old explicit from is accepted.
        assert.equal(take({ from: "2026-01-01" }, fresh()).range.days, 303);
    });

    test("the default range clamps to the boundary's day, and says so", () => {
        const dashboard = fresh();

        dashboard.boundary = Date.UTC(2026, 9, 20, 10);

        const answer = take({}, dashboard);

        assert.equal(answer.range.from, "2026-10-20");
        assert.equal(answer.range.clamped, true);
        assert.equal(answer.range.days, 11);
        assert.equal(answer.coverage.boundaryDay, "2026-10-20");

        const codes = answer.coverage.limitations.map((each) => each.code);

        assert(codes.includes("range-clamped"));
        assert(codes.includes("partial-first-day"));
        // An explicit from on the boundary's day: not clamped, the first day is partial.
        const explicit = take({ from: "2026-10-20" }, dashboard);

        assert.equal(explicit.range.clamped, false);
        assert(explicit.coverage.limitations.some((each) => each.code === "partial-first-day"));
        assert(
            !take({ from: "2026-10-21" }, dashboard).coverage.limitations.some(
                (each) => each.code === "partial-first-day",
            ),
        );
    });

    test("each refusal", () => {
        assert.equal(refused({ from: "2026-10-1" }), "from must be a date YYYY-MM-DD.");
        assert.equal(refused({ to: "yesterday" }), "to must be a date YYYY-MM-DD.");
        assert.equal(
            refused({ from: "2026-02-30", to: "2026-03-01" }),
            "from is not a real date: 2026-02-30.",
        );
        assert.equal(refused({ to: "2026-13-01" }), "to is not a real date: 2026-13-01.");
        assert.equal(
            refused({ from: "2026-10-10", to: "2026-10-09" }),
            "from must not be after to.",
        );
        assert.equal(
            refused({ to: "2026-10-31" }),
            "to must not be after today (UTC): 2026-10-30.",
        );
        assert.equal(
            refused({ from: "2025-10-28", to: "2026-10-29" }, fresh()),
            "The range is 367 days: the most is 366.",
        );
        assert.equal(take({ from: "2025-10-29", to: "2026-10-29" }, fresh()).range.days, 366);
        assert.equal(
            refused({ from: "2026-07-31" }),
            "from must not be before the recovery boundary's day (UTC): 2026-08-01.",
        );
        assert.equal(take({ from: "2026-08-01" }).range.from, "2026-08-01");
        assert.equal(
            refused({ to: "2026-07-31" }),
            "to must not be before the recovery boundary's day (UTC): 2026-08-01.",
        );
        assert.match(refused({ owner: "-bad" }), /^owner must be a GitHub owner name/);
        assert.match(refused({ owner: "a/b" }), /^owner must be a GitHub owner name/);
        assert.equal(refused({ repo: "nope" }), "repo must be a repository name: owner/name.");
        assert.equal(refused({ repo: "a/b/c" }), "repo must be a repository name: owner/name.");
        assert.equal(refused({ repo: "a/one", owner: "b" }), "repo a/one is not in owner b.");
        assert.deepEqual(take({ repo: "a/one", owner: "A" }).scope, {
            kind: "repo",
            owner: "a",
            repo: "a/one",
        });
        // Empty parameters are not given.
        assert.deepEqual(parseQuery({ from: "", to: "", owner: "", repo: "" }, NOW, undefined), {
            range: {
                from: "2026-10-01",
                to: "2026-10-30",
                start: oct(1),
                end: NOW,
                days: 30,
                partialToday: true,
                clamped: false,
            },
            scope: { kind: "all" },
        });
    });
});

// ─── Zero, unknown, empty ────────────────────────────────────────────────────

describe("zero, unknown, and empty", () => {
    test("no facts at all: zero counts, null rates and medians, never-read sources", () => {
        const answer = take(OCTOBER, null, null);
        const t = answer.totals;

        assert.equal(t.completion.rate, null);
        assert.equal(t.completion.flag, "No eligible closures");
        assert.equal(t.completion.denominator, 0);
        assert.equal(t.velocity.perWeek, 0);
        assert.equal(t.cycleTime.medianMs, null);
        assert.equal(t.cycleTime.samples, 0);
        assert.equal(t.usage.cost, null);
        assert.equal(t.usage.entries, 0);
        assert.equal(t.usage.undated.counters.cost, null);
        assert.equal(t.timeToSolve.medianMs, null);
        assert.equal(t.timeToSolve.p90Ms, null);
        assert.equal(t.timeToSolve.flag, "No eligible resolved issues");
        assert.deepEqual(answer.rows.projects, []);
        assert.deepEqual(answer.rows.owners, []);
        assert.deepEqual(answer.rows.unattributed, t);
        assert.equal(answer.coverage.status, "not started");
        assert.equal(answer.coverage.sources.threads.status, "never");
        assert.equal(answer.coverage.sources.github.status, "never");
        assert.equal(answer.coverage.sources.usage.status, "never");
        assert.deepEqual(answer.coverage.progress, {
            github: { pending: null, complete: null },
            usage: { pending: null, complete: null, ledgerUnavailable: null },
        });
        assert(answer.daily.every((day) => day.successes === 0));
    });

    test("a true zero rate is 0, not null; a recorded zero cost is 0, not null", () => {
        const window = windowOf("2026-10-01", "2026-10-29");
        const metrics = reduce(
            factsOf({
                threads: [closed("Z1", "a/b", oct(10), "done", "abandoned")],
                sessions: [
                    session(1, {
                        assign: { repo: "a/b", via: 1 },
                        days: {
                            "2026-10-10": {
                                "p/m": counters({
                                    entries: 1,
                                    costEntries: 1,
                                    cost: 0,
                                    zeroCostEntries: 1,
                                }),
                            },
                        },
                    }),
                ],
            }),
            window,
        );

        assert.equal(metrics.completion.rate, 0);
        assert.equal(metrics.completion.flag, undefined);
        assert.equal(metrics.usage.cost, 0);
        assert.equal(metrics.usage.zeroCostEntries, 1);
        assert.equal(metrics.velocity.successes, 0);
    });
});

// ─── PRs ─────────────────────────────────────────────────────────────────────

describe("PR counts", () => {
    const window = windowOf("2026-10-01", "2026-10-29");

    test("event counts overlap; excluded and untracked PRs are out; readAt is no lifecycle time", () => {
        const metrics = reduce(
            factsOf({
                prs: [
                    // Created, merged, and closed in the range: created and merged.
                    pr("a/b#1", {
                        state: "MERGED",
                        createdAt: oct(2),
                        mergedAt: oct(4),
                        closedAt: oct(4),
                        readAt: oct(5),
                    }),
                    // Created and closed unmerged in the range.
                    pr("a/b#2", {
                        state: "CLOSED",
                        createdAt: oct(3),
                        closedAt: oct(6),
                        readAt: oct(7),
                    }),
                    // Created before, open now.
                    pr("a/b#3", { state: "OPEN", createdAt: Date.UTC(2026, 8, 1), readAt: oct(7) }),
                    // Times at the bounds: created at the start counts, merged at the end does not.
                    pr("a/b#4", {
                        state: "MERGED",
                        createdAt: window.start,
                        mergedAt: window.end,
                        closedAt: window.end,
                        readAt: oct(7),
                    }),
                    // Lifecycle gaps: only readAt is in the range.
                    pr("a/b#5", {
                        state: "MERGED",
                        readAt: oct(10),
                        gaps: ["createdAt", "mergedAt", "closedAt"],
                    }),
                    pr("a/b#6", { state: "OPEN", createdAt: oct(2), excluded: "window" }),
                    pr("a/b#7", { excluded: "missing" }),
                    pr("a/b#8", {
                        state: "CLOSED",
                        createdAt: oct(2),
                        closedAt: oct(3),
                        excluded: "frozen",
                    }),
                    pr("a/b#9", {
                        state: "OPEN",
                        createdAt: oct(2),
                        readAt: oct(2),
                        untracked: true,
                    }),
                    pr("a/b#10", { error: "network", errorAt: oct(9) }),
                ],
            }),
            window,
        );

        assert.deepEqual(metrics.prs, {
            created: 3,
            merged: 1,
            closedUnmerged: 1,
            openNow: 1,
            tracked: 6,
            excluded: { window: 1, missing: 1, frozen: 1 },
            coverage: { unread: 1, errored: 1, gaps: 1 },
        });
    });

    test("an issue's resolving PR that is not a tracked PR does not count", () => {
        const dashboard = fresh();

        dashboard.issues["a/b#1"] = issue("a/b#1", resolved(oct(1), oct(2), "a/b#50"));

        const answer = take(OCTOBER, dashboard);

        assert.equal(answer.totals.prs.merged, 0);
        assert.equal(answer.totals.prs.tracked, 0);
        assert.equal(answer.totals.timeToSolve.count, 1);
    });
});

// ─── Usage ───────────────────────────────────────────────────────────────────

describe("usage", () => {
    test("days filter by the range; partial cost; recorded totals only; before is ignored", () => {
        const window = windowOf("2026-10-02", "2026-10-03");
        const metrics = reduce(
            factsOf({
                sessions: [
                    session(1, {
                        assign: { repo: "a/b", via: 1 },
                        days: {
                            "2026-10-01": { m: counters({ entries: 100, input: 100 }) },
                            "2026-10-02": {
                                m: counters({
                                    entries: 2,
                                    input: 10,
                                    output: 20,
                                    cacheRead: 30,
                                    cacheWrite: 40,
                                    totalTokens: 100,
                                    reasoning: 15,
                                    reasoningEntries: 1,
                                    cacheWrite1h: 40,
                                    cacheWrite1hEntries: 2,
                                    cost: 0.5,
                                    costEntries: 1,
                                }),
                                n: counters({ entries: 1, input: 1, totalTokens: 1 }),
                            },
                            "2026-10-03": { m: counters({ entries: 1, input: 2, totalTokens: 2 }) },
                            "2026-10-04": { m: counters({ entries: 100, input: 100 }) },
                            "not-a-day": { m: counters({ entries: 100, input: 100 }) },
                        },
                        before: counters({ entries: 5, input: 5, cost: 5, costEntries: 5 }),
                    }),
                ],
            }),
            window,
        );

        assert.equal(metrics.usage.entries, 4);
        assert.equal(metrics.usage.input, 13);
        assert.equal(metrics.usage.output, 20);
        assert.equal(metrics.usage.cacheRead, 30);
        assert.equal(metrics.usage.cacheWrite, 40);
        assert.equal(metrics.usage.totalTokens, 103, "reasoning and 1h cache writes are not added");
        assert.equal(metrics.usage.cost, 0.5);
        assert.equal(metrics.usage.costEntries, 1);
        assert.equal(metrics.usage.unknownCostEntries, 3);
        assert.equal(metrics.usage.zeroCostEntries, 0);
        assert.equal(metrics.usage.undated.counters.entries, 0);
    });

    test("unassigned sessions are unattributed, with their own count", () => {
        const answer = take(OCTOBER, fresh(), {
            sessions: {
                "9": session(9, {
                    days: {
                        "2026-10-05": { m: counters({ entries: 1, input: 3, totalTokens: 3 }) },
                    },
                }),
            },
            sources: {},
        });

        assert.deepEqual(answer.totals.usage.unattributed, {
            noRepo: 0,
            conflict: 0,
            unassigned: 1,
        });
        assert.equal(answer.rows.unattributed?.usage.input, 3);
        assert.deepEqual(answer.rows.projects, []);
    });
});

// ─── Time to solve ───────────────────────────────────────────────────────────

describe("time to solve", () => {
    const window = windowOf("2026-10-01", "2026-10-29");

    test("median and P90: odd, even, singleton, empty, and 10 values", () => {
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(nearestRank([3, 1, 2], 0.9), 3);
        assert.equal(median([4, 1, 3, 2]), 2.5);
        assert.equal(nearestRank([4, 1, 3, 2], 0.9), 4);
        assert.equal(median([5]), 5);
        assert.equal(nearestRank([5], 0.9), 5);
        assert.equal(median([]), null);
        assert.equal(nearestRank([], 0.9), null);
        assert.equal(nearestRank([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.9), 9);
        assert.equal(nearestRank([...Array(11).keys()], 0.9), 9);
    });

    test("each exclusion reason, zero and negative durations, the range bounds", () => {
        const issues: IssueFact[] = [
            issue("a/b#1", resolved(oct(2), oct(2))),
            issue("a/b#2", resolved(oct(3), oct(2))),
            issue("a/b#3", resolved(undefined, oct(2))),
            issue("a/b#4", resolved(oct(1), window.start)),
            issue("a/b#5", resolved(oct(1), window.end)),
            issue("a/b#6", { state: "OPEN", createdAt: oct(1) }),
            issue("a/b#7", { ...resolved(oct(1), oct(3)), state: "OPEN" }),
            issue("a/b#8", { ...resolved(oct(1), oct(3)), unresolved: "open" }),
            issue("a/b#9", { state: "CLOSED", unresolved: "not-planned" }),
            issue("a/b#10", { state: "CLOSED", unresolved: "no-resolving-pr" }),
            issue("a/b#11", { state: "CLOSED", unresolved: "ambiguous" }),
            issue("a/b#12", { state: "CLOSED", unresolved: "incomplete" }),
            issue("a/b#13", { ...resolved(oct(1), oct(3)), unresolved: "missing" }),
            issue("a/b#14", { ...resolved(oct(1), oct(3)), unresolved: "inaccessible" }),
            issue("a/b#15", { state: "CLOSED", unresolved: "invalid" }),
            issue("a/b#16", { state: "CLOSED", createdAt: oct(1), closedAt: oct(3) }),
            issue("a/b#17", {}),
            issue("a/b#18", { ...resolved(oct(1), oct(3)), untracked: true }),
        ];
        const metrics = reduce(factsOf({ issues }), window);

        // Samples: #1 and #4, both 0. Dated invalid: #2 (negative) and #3 (no creation time). #5 merged at the end.
        assert.deepEqual(metrics.timeToSolve, {
            medianMs: 0,
            p90Ms: 0,
            count: 2,
            nowUnresolved: 3,
            dated: { invalid: 2 },
            undated: {
                "not-planned": 1,
                "no-resolving-pr": 1,
                ambiguous: 1,
                incomplete: 1,
                missing: 1,
                inaccessible: 1,
                invalid: 1,
                "no-resolution": 1,
                unread: 1,
            },
        });
    });

    test("1 issue linked by 2 threads counts once; the stored resolution is the final resolver", () => {
        const dashboard = fresh();

        dashboard.boundary = BOUNDARY;
        dashboard.threads.T1 = thread("T1", { repo: "a/b", issues: ["a/b#1"] });
        dashboard.threads.T2 = thread("T2", { repo: "c/d", issues: ["a/b#1"] });
        // Resolved by c/d#9 (its final resolver), after an earlier related merge.
        dashboard.issues["a/b#1"] = {
            ...issue("a/b#1", resolved(oct(1), oct(4), "c/d#9")),
            threads: ["T1", "T2"],
            closing: {
                merged: [
                    { ref: "c/d#8", mergedAt: oct(2) },
                    { ref: "c/d#9", mergedAt: oct(4) },
                ],
                complete: true,
                pages: 1,
            },
        };

        const answer = take(OCTOBER, dashboard);

        assert.equal(answer.totals.timeToSolve.count, 1);
        assert.equal(answer.totals.timeToSolve.medianMs, 3 * DAY);
        assert.equal(project(answer, "a/b").timeToSolve.count, 1);
        assert.equal(project(answer, "c/d").timeToSolve.count, 0, "the issue's repository gets it");
    });

    test("owner and all-work percentiles come from the raw samples of every project", () => {
        const dashboard = fresh();

        const add = (ref: string, hours: number): void => {
            dashboard.issues[ref] = issue(ref, resolved(oct(10) - hours * HOUR, oct(10)));
        };

        // o/a: [1, 2, 3]; o/b: [10]; p/c: [100, 200].
        add("o/a#1", 1);
        add("o/a#2", 2);
        add("o/a#3", 3);
        add("o/b#1", 10);
        add("p/c#1", 100);
        add("p/c#2", 200);

        const answer = take(OCTOBER, dashboard);

        assert.equal(project(answer, "o/a").timeToSolve.medianMs, 2 * HOUR);
        assert.equal(project(answer, "o/b").timeToSolve.medianMs, 10 * HOUR);
        assert.equal(project(answer, "p/c").timeToSolve.medianMs, 150 * HOUR);
        // o: [1, 2, 3, 10]: median 2.5h, P90 rank 4: 10h.
        assert.equal(ownerRow(answer, "o").timeToSolve.medianMs, 2.5 * HOUR);
        assert.equal(ownerRow(answer, "o").timeToSolve.p90Ms, 10 * HOUR);
        // All: [1, 2, 3, 10, 100, 200]: median 6.5h, P90 rank 6: 200h.
        assert.equal(answer.totals.timeToSolve.medianMs, 6.5 * HOUR);
        assert.equal(answer.totals.timeToSolve.p90Ms, 200 * HOUR);
        assert.equal(answer.totals.timeToSolve.count, 6);
    });
});

// ─── Sources ─────────────────────────────────────────────────────────────────

describe("source states", () => {
    test("never, failed, stale, partial, ok", () => {
        const old = NOW - STALE_MS - 1;

        assert.equal(STALE_MS, CHECK_HEARTBEAT_MS + 3 * PASS_MS);
        assert.equal(sourceView(undefined, NOW).status, "never");
        assert.equal(sourceView({}, NOW).status, "never");
        assert.equal(sourceView({ at: NOW, ok: false, lastGoodAt: NOW }, NOW).status, "failed");
        assert.equal(sourceView({ at: old, ok: true, lastGoodAt: old }, NOW).status, "stale");
        assert.equal(
            sourceView({ at: old, ok: true, lastGoodAt: NOW - STALE_MS }, NOW).status,
            "ok",
        );
        assert.equal(
            sourceView({ at: old, ok: true, lastGoodAt: old, checkedAt: NOW }, NOW).status,
            "ok",
        );
        assert.equal(
            sourceView({ at: NOW, ok: true, lastGoodAt: NOW, partial: ["a/b#1"] }, NOW).status,
            "partial",
        );
        assert.equal(
            sourceView({ at: NOW, ok: true, lastGoodAt: NOW, complete: false }, NOW).status,
            "partial",
        );
        // GitHub writes no heartbeat when no read is due: its age makes it stale only with reads pending.
        assert.equal(
            sourceView({ at: old, ok: true, lastGoodAt: old, pending: 0 }, NOW, true).status,
            "ok",
        );
        assert.equal(
            sourceView({ at: old, ok: true, lastGoodAt: old, pending: 2 }, NOW, true).status,
            "stale",
        );
    });

    test("a failed source keeps its last good facts, and the answer says so", () => {
        const dashboard = mainDashboard();

        dashboard.sources.threads = {
            at: NOW,
            ok: false,
            error: "the read failed",
            kind: "other",
            lastGoodAt: NOW - DAY,
            checkedAt: NOW - DAY,
        };
        dashboard.sources.github = {
            at: NOW - DAY,
            ok: true,
            lastGoodAt: NOW - DAY,
            pending: 3,
            complete: false,
            backoffUntil: NOW + HOUR,
        };

        const usage = mainUsage();

        usage.sources.usage = {
            at: NOW,
            ok: true,
            lastGoodAt: NOW,
            checkedAt: NOW,
            pending: 2,
            complete: false,
            ledgerUnavailable: 1,
        };

        const answer = take(OCTOBER, dashboard, usage);
        const { sources, progress } = answer.coverage;

        assert.equal(answer.totals.completion.success, 5, "the values stay");
        assert.equal(sources.threads.status, "failed");
        assert.equal(sources.threads.error, "the read failed");
        assert.equal(sources.threads.kind, "other");
        assert.equal(sources.threads.lastGoodAt, NOW - DAY);
        assert.equal(sources.github.status, "stale");
        assert.equal(sources.github.backoffUntil, NOW + HOUR);
        assert.equal(sources.usage.status, "partial");
        assert.deepEqual(progress, {
            github: { pending: 3, complete: false },
            usage: { pending: 2, complete: false, ledgerUnavailable: 1 },
        });
        assert(answer.coverage.limitations.some((each) => each.code === "incomplete-sources"));
    });

    test("fresh sources: ok, and the standing limitations", () => {
        const answer = take();

        assert.equal(answer.coverage.status, "started");
        assert.equal(answer.coverage.boundary, BOUNDARY);
        assert.equal(answer.coverage.initializedAt, BOUNDARY + 90 * DAY);
        assert.equal(answer.coverage.sources.threads.status, "ok");
        assert.equal(answer.coverage.sources.github.status, "ok");
        assert.equal(answer.coverage.sources.usage.status, "ok");
        assert.deepEqual(
            answer.coverage.limitations.map((each) => each.code),
            [
                "latest-known-outcomes",
                "tracked-work-only",
                "dated-model-usage-only",
                "undated-residual",
                "cost-not-invoice",
                "zero-cost-reported",
            ],
        );
        assert(answer.coverage.limitations.every((each) => each.text.length > 0));
    });
});

// ─── The route in Pocket ─────────────────────────────────────────────────────

describe("GET dashboard in Pocket", () => {
    const dataDir = join(root, "metrics-data");
    const fakeGh = join(root, "metrics-gh");
    const ghCalls = join(root, "metrics-gh-calls");
    const configPath = join(root, "metrics-desk.json");
    let app: App;
    let server: Server | undefined;
    let base = "";
    let viewer = "";

    const get = async (path: string, token?: string | null) => {
        const response = await fetch(base + path, {
            headers: {
                ...(token === null
                    ? {}
                    : { authorization: `Bearer ${token ?? app.config.ownerToken}` }),
                "x-pocket": "1",
            },
        });

        return {
            status: response.status,
            data: (await response.json().catch(() => ({}))) as Snapshot & { error?: string },
        };
    };

    before(async () => {
        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });

        for (const file of [
            "desk.ts",
            "_desk-usage.ts",
            "_desk-dashboard.ts",
            "_desk-metrics.ts",
        ]) {
            cpSync(join(import.meta.dirname, file), join(dropIns, file));
        }

        cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), {
            recursive: true,
        });
        // A fake `gh` that logs every call: a GET must not call it.
        writeFileSync(
            fakeGh,
            `#!/bin/sh\necho call >> ${JSON.stringify(ghCalls)}\necho '{"data":{"viewer":{"login":"github-viewer"}}}'\n`,
            { mode: 0o755 },
        );
        writeFileSync(ghCalls, "");
        process.env.PI_POCKET_DESK_GH = fakeGh;
        process.env.PI_POCKET_DESK_CONFIG = configPath;
        writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));

        app = await openApp(scriptedModel(), dataDir);
        await app.setExtensionEnabled(owner(app), "desk.ts", true);
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/desk/`;
        viewer = app.config.addUser("Vic", "viewer").token;

        // Facts relative to the real clock: the route reads Date.now().
        const now = Date.now();

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(DeskDashboard);

            doc.initializedAt = now - HOUR;
            doc.boundary = now - 90 * DAY;
            doc.threads.T1 = closed(
                "T1",
                "a/one",
                now - 2 * HOUR,
                "done",
                "completed",
                now - 3 * HOUR,
            );
            doc.threads.T2 = closed(
                "T2",
                "a/one",
                now - 2 * HOUR,
                "done",
                "verified",
                now - 5 * HOUR,
            );
            doc.threads.T3 = closed("T3", "b/two", now - 2 * HOUR, "done", "abandoned");
            doc.prs["a/one#1"] = pr("a/one#1", {
                state: "MERGED",
                createdAt: now - 3 * HOUR,
                mergedAt: now - 2 * HOUR,
                closedAt: now - 2 * HOUR,
                readAt: now - HOUR,
            });
            doc.sources = {
                threads: { at: now, ok: true, lastGoodAt: now, checkedAt: now },
                github: { at: now, ok: true, lastGoodAt: now, pending: 0, complete: true },
            };

            const usage = await tx.doc(DeskUsage);
            const day = new Date(now).toISOString().slice(0, 10);

            usage.sessions["5"] = session(5, {
                assign: { repo: "a/one", via: 5 },
                days: {
                    [day]: {
                        "p/m": counters({
                            entries: 2,
                            input: 40,
                            totalTokens: 40,
                            cost: 0.5,
                            costEntries: 2,
                        }),
                    },
                },
            });
        }, context);
    });

    after(async () => {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        await app?.close();
        cleanUp();
    });

    test("the owner gets the numbers; the GET calls no gh, changes no document, and starts no task", async () => {
        const docs = async () => [
            await app.harness.snapshot(DeskDashboard, context),
            await app.harness.snapshot(DeskUsage, context),
            await app.harness.snapshot(DeskThreads, context),
        ];
        const tasks = async () =>
            (await app.harness.inspect(context)).tasks
                .map((task) => `${task.record.kind}:${task.record.id}`)
                .sort();
        const docsBefore = JSON.stringify(await docs());
        const tasksBefore = await tasks();
        const callsBefore = readFileSync(ghCalls, "utf8");
        const { status, data } = await get("dashboard");

        assert.equal(status, 200, JSON.stringify(data));
        assert.equal(data.totals.completion.success, 2);
        assert.equal(data.totals.completion.abandoned, 1);
        assert.equal(data.totals.completion.rate, 2 / 3);
        assert.equal(data.totals.cycleTime.medianMs, 2 * HOUR);
        assert.equal(data.totals.prs.merged, 1);
        assert.equal(data.totals.usage.input, 40);
        assert.equal(data.totals.usage.cost, 0.5);
        assert.equal(data.range.days, 30);
        assert.equal(data.coverage.status, "started");
        assert.equal(data.asOf, data.range.end);
        assert.deepEqual(
            data.rows.projects.map((row) => [row.repo, row.metrics.completion.success]),
            [
                ["a/one", 2],
                ["b/two", 0],
            ],
        );

        const scoped = await get("dashboard?owner=a&repo=a/one");

        assert.equal(scoped.status, 200);
        assert.equal(scoped.data.totals.completion.rate, 1);

        assert.equal(readFileSync(ghCalls, "utf8"), callsBefore, "no gh call");
        assert.equal(JSON.stringify(await docs()), docsBefore, "no document changed");
        assert.deepEqual(await tasks(), tasksBefore, "no task started");
    });

    test("no token, and a viewer, are refused", async () => {
        assert.equal((await get("dashboard", null)).status, 401);

        const asViewer = await get("dashboard", viewer);

        // Pocket answers 404 to a person who may not use an owner route: it does not say the route exists.
        assert.equal(asViewer.status, 404);
    });

    test("a bad range or scope is a 400 with its reason", async () => {
        const feb = await get("dashboard?from=2026-02-30");

        assert.equal(feb.status, 400);
        assert.match(JSON.stringify(feb.data), /from is not a real date: 2026-02-30/);
        assert.equal((await get("dashboard?from=2020-01-01")).status, 400);
        assert.equal((await get("dashboard?to=2999-01-01")).status, 400);
        assert.equal((await get("dashboard?repo=nope")).status, 400);
        assert.equal((await get("dashboard?owner=b&repo=a/one")).status, 400);
    });
});
