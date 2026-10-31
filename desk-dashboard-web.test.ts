// The numbers the Dashboard shows for the preview's fixture (`desk-dashboard-fixture.ts`): `snapshot()` on the same
// facts, and the page's own helpers on its answer. The browser check of `preview-desk.ts` reads the same values on the
// screen. Nothing reads Brian's data.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { snapshot, type Snapshot } from "./_desk-metrics.ts";
import { DAY, dashboardFixture, HOUR, REPOS, type Variant } from "./desk-dashboard-fixture.ts";
import {
    dashboardStates,
    formatCount,
    formatDuration,
    formatMoney,
    formatPerWeek,
    formatRate,
    rangeLine,
    tableRows,
} from "./desk-web/dashboard.js";

/** Noon UTC of 2026-10-30: "today" of the test. The preview uses the real clock; only velocity moves with it. */
const NOW = Date.UTC(2026, 9, 30, 12);

const take = (
    query: Record<string, string> = {},
    variant: Variant = "main",
    now = NOW,
): Snapshot => {
    const fixture = dashboardFixture(now, variant);
    const answer = snapshot({ dashboard: fixture.dashboard, usage: fixture.usage, now, query });

    if ("error" in answer) {
        assert.fail(answer.error);
    }

    return answer;
};

const codes = (answer: Snapshot | null, options = {}): string[] =>
    dashboardStates(answer, options).map((state: { code: string }) => state.code);

describe("the preview fixture: what the screen shows", () => {
    test("the default range, all tracked work: the cards", () => {
        const answer = take();
        const t = answer.totals;

        assert.equal(
            rangeLine(answer),
            "Showing 2026-10-01 to 2026-10-30 UTC (30 days), today up to 2026-10-30 12:00 UTC · all tracked work",
        );
        // Thread completion rate: 8 of 10.
        assert.deepEqual(t.completion, {
            rate: 0.8,
            success: 8,
            completed: 7,
            verified: 1,
            abandoned: 1,
            failed: 1,
            denominator: 10,
            excluded: { dropped: 1, frozen: 1, unknown: 1 },
            undated: 1,
        });
        assert.equal(formatRate(t.completion.rate), "80%");
        // Velocity: 8 successes in 29.5 days.
        assert.equal(t.velocity.successes, 8);
        assert.equal(t.velocity.perWeek, 8 / (29.5 / 7));
        assert.equal(formatPerWeek(t.velocity.perWeek), "1.9");
        // Thread cycle time: [2, 6, 6, 12, 24, 48] hours; T11 and T22 have no valid start.
        assert.deepEqual(t.cycleTime, { medianMs: 9 * HOUR, samples: 6, excludedTimestamps: 2 });
        assert.equal(formatDuration(t.cycleTime.medianMs), "9 h");
        // Time to solve: [24h, 57h, 201h, 1921h].
        assert.deepEqual(t.timeToSolve, {
            medianMs: 129 * HOUR,
            p90Ms: 1921 * HOUR,
            count: 4,
            nowUnresolved: 1,
            dated: { invalid: 1 },
            undated: { "not-planned": 1, ambiguous: 1 },
        });
        assert.equal(formatDuration(t.timeToSolve.medianMs), "5.4 d");
        assert.equal(formatDuration(t.timeToSolve.p90Ms), "80 d");
        assert.deepEqual(t.workload, { label: "now", total: 5, starting: 1, open: 3, parked: 1 });
        assert.deepEqual(t.prs, {
            created: 5,
            merged: 4,
            closedUnmerged: 1,
            openNow: 2,
            tracked: 8,
            excluded: { window: 1, missing: 1, frozen: 0 },
            coverage: { unread: 1, errored: 0, gaps: 1 },
        });
        // Dated tokens and cost: the supervisor's session is shared, and not counted.
        assert.deepEqual(
            [
                t.usage.input,
                t.usage.output,
                t.usage.cacheRead,
                t.usage.cacheWrite,
                t.usage.totalTokens,
            ],
            [2300, 520, 6200, 300, 9320],
        );
        assert.equal(formatCount(t.usage.totalTokens), "9,320");
        assert.equal(t.usage.cost, 0.9);
        assert.equal(formatMoney(t.usage.cost), "$0.90");
        assert.deepEqual(
            [
                t.usage.entries,
                t.usage.costEntries,
                t.usage.zeroCostEntries,
                t.usage.unknownCostEntries,
            ],
            [11, 8, 2, 3],
        );
        assert.deepEqual([t.usage.sessions, t.usage.missing, t.usage.excluded.shared], [6, 1, 1]);
        assert.deepEqual(t.usage.unattributed, { noRepo: 1, conflict: 1, unassigned: 0 });
        // Apart from the range total: the undated entry and the settled residual.
        assert.equal(t.usage.undated.counters.totalTokens, 12);
        assert.equal(formatMoney(t.usage.undated.counters.cost), "$0.0010");
        assert.deepEqual(t.usage.undated.residual, {
            sessions: 1,
            counters: {
                input: 50,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 55,
                cost: 0.02,
            },
        });
        assert.deepEqual(t.population, {
            delivery: 20,
            coordinators: 1,
            excluded: { askOnly: 1, noWork: 0 },
            gone: 0,
        });
    });

    test("the trend, the choices, and the coverage", () => {
        const answer = take();
        const busy = answer.daily.filter((day) => day.successes > 0);

        assert.equal(answer.daily.length, 30);
        assert.equal(
            answer.daily.reduce((sum, day) => sum + day.successes, 0),
            8,
        );
        assert.deepEqual(
            busy.map((day) => day.day),
            [
                "2026-10-05",
                "2026-10-15",
                "2026-10-18",
                "2026-10-21",
                "2026-10-25",
                "2026-10-27",
                "2026-10-28",
                "2026-10-29",
            ],
        );
        assert.deepEqual(answer.choices, {
            owners: ["acme-labs", "bketelsen", "frostyard"],
            repos: [REPOS.widgets, REPOS.wiki, REPOS.team, REPOS.long, REPOS.snosi].map((repo) =>
                repo.toLowerCase(),
            ),
        });
        assert(REPOS.long.length > 60);
        assert.equal(answer.coverage.status, "started");
        assert.equal(answer.coverage.boundaryDay, "2026-07-30");
        assert.deepEqual(
            Object.values(answer.coverage.sources).map((source) => source.status),
            ["ok", "partial", "ok"],
        );
        assert.deepEqual(codes(answer), ["partial"]);
        assert(answer.coverage.limitations.some((each) => each.code === "zero-cost-reported"));
    });

    test("the project table: owner subtotals from the route, then their projects, then unattributed", () => {
        const answer = take();
        const rows = tableRows(answer, { key: "name", dir: "asc" });

        assert.deepEqual(
            rows.map((row: { kind: string; name: string }) => `${row.kind}:${row.name}`),
            [
                "owner:acme-labs",
                `project:${REPOS.widgets}`,
                "owner:bketelsen",
                `project:${REPOS.wiki}`,
                `project:${REPOS.team}`,
                "owner:frostyard",
                `project:${REPOS.long}`,
                `project:${REPOS.snosi}`,
                "unattributed:Unattributed",
            ],
        );

        const by = (name: string) =>
            rows.find((row: { name: string }) => row.name === name).metrics as Snapshot["totals"];
        const frostyard = by("frostyard");

        // 3/5 and 1/1 make 4/6, not the mean of 60% and 100%.
        assert.equal(by(REPOS.snosi).completion.rate, 0.6);
        assert.equal(by(REPOS.long).completion.rate, 1);
        assert.equal(formatRate(frostyard.completion.rate), "66.7%");
        assert.equal(frostyard.completion.denominator, 6);
        assert.equal(frostyard.cycleTime.medianMs, 24 * HOUR);
        assert.equal(frostyard.usage.cost, 0.75);
        assert.equal(by(REPOS.team).usage.cost, null, "no entry reported a cost: unknown");
        assert.equal(by(REPOS.long).usage.cost, 0, "a reported zero stays 0");
        assert.equal(by(REPOS.wiki).completion.denominator, 0);
        assert.equal(by("Unattributed").completion.success, 1);
        assert.equal(by("Unattributed").usage.cost, 0.05);
        assert.equal(by("Unattributed").usage.totalTokens, 120);

        // Sorted by cost, descending: unknown last.
        const byCost = tableRows(answer, { key: "cost", dir: "desc" }).map(
            (row: { name: string }) => row.name,
        );

        assert.deepEqual(byCost, [
            "frostyard",
            REPOS.snosi.toLowerCase(),
            REPOS.long.toLowerCase(),
            "acme-labs",
            REPOS.widgets.toLowerCase(),
            "bketelsen",
            REPOS.wiki.toLowerCase(),
            REPOS.team.toLowerCase(),
            "Unattributed",
        ]);
    });

    test("the presets and the scopes", () => {
        const week = take({ from: "2026-10-24" }).totals;

        assert.deepEqual(
            [
                week.completion.success,
                week.completion.denominator,
                week.completion.excluded.dropped,
            ],
            [4, 5, 1],
        );
        assert.deepEqual([week.prs.created, week.prs.merged, week.prs.closedUnmerged], [4, 3, 1]);

        const quarter = take({ from: "2026-08-02" }).totals;

        assert.deepEqual(
            [
                quarter.completion.success,
                quarter.completion.verified,
                quarter.completion.denominator,
            ],
            [9, 2, 11],
        );
        assert.equal(quarter.usage.totalTokens, 9430);

        const owner = take({ owner: "frostyard" });

        assert.equal(owner.rows.unattributed, null);
        assert.equal(owner.totals.completion.success, 4);
        assert.deepEqual(owner.choices, take().choices, "the choices stay");

        const repo = take({ repo: REPOS.long });

        assert.deepEqual(
            repo.rows.projects.map((row) => row.repo),
            [REPOS.long.toLowerCase()],
        );
        assert.equal(repo.totals.timeToSolve.count, 1);
        assert.equal(formatDuration(repo.totals.timeToSolve.medianMs), "80 d");
    });

    test("a bad custom range is refused with its reason", () => {
        const fixture = dashboardFixture(NOW);

        const refuse = (query: Record<string, string>) => {
            const answer = snapshot({ ...fixture, now: NOW, query });

            assert("error" in answer);

            return answer.error;
        };

        assert.match(refuse({ from: "2026-10-20", to: "2026-10-10" }), /from must not be after to/);
        assert.match(refuse({ from: "2026-07-29", to: "2026-10-10" }), /recovery boundary's day/);
        assert.match(refuse({ from: "2026-10-01", to: "2026-10-31" }), /after today/);
    });

    test("each preview variant shows its state", () => {
        assert.deepEqual(codes(take({}, "not-started")), ["not-started"]);
        assert.equal(take({}, "not-started").coverage.status, "not started");
        assert.deepEqual(codes(take({}, "empty")), ["no-work"]);
        assert.deepEqual(codes(take({}, "stale")), [
            "stale-source",
            "stale-source",
            "stale-source",
            "partial",
        ]);
        assert.deepEqual(codes(take({}, "usage-unavailable")), [
            "failed-source",
            "usage-unavailable",
            "partial",
        ]);
        assert.deepEqual(codes(take({}, "partial-usage")), ["partial"]);
        assert.match(
            dashboardStates(take({}, "partial-usage"))[0].text,
            /usage: 3 sessions pending, 1 ledger unreadable/,
        );
        assert.deepEqual(codes(take(), { error: "HTTP 500" }), ["refresh-failed", "partial"]);
        assert.deepEqual(codes(null, { error: "HTTP 500" }), ["refresh-failed"]);
        assert.deepEqual(codes(take({ owner: "nobody" })), ["partial", "no-work"]);
        assert.deepEqual(codes(take({ repo: REPOS.wiki })), ["partial", "no-closures"]);
    });

    test("the fixture's times stay in their days: the counts do not move during a day", () => {
        const early = take({}, "main", Date.UTC(2026, 9, 30, 0, 1)).totals;
        const late = take({}, "main", Date.UTC(2026, 9, 30, 23, 59)).totals;

        assert.deepEqual(early.completion, late.completion);
        assert.deepEqual(early.timeToSolve, late.timeToSolve);
        assert.deepEqual(early.prs, late.prs);
        assert.equal(early.usage.totalTokens, late.usage.totalTokens);
        assert.notEqual(
            early.velocity.perWeek,
            late.velocity.perWeek,
            "velocity uses the elapsed time",
        );
        assert.equal(DAY, 24 * HOUR);
    });
});
