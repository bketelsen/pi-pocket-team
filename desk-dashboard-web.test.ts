// The numbers the Dashboard shows for the preview's fixture (`desk-dashboard-fixture.ts`): `snapshot()` on the same
// facts, and the page's own helpers on its answer. The browser check of `preview-desk.ts` reads the same values on the
// screen. Nothing reads Brian's data.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { records, snapshot, type Records, type Snapshot } from "./_desk-metrics.ts";
import { DAY, dashboardFixture, HOUR, REPOS, type Variant } from "./desk-dashboard-fixture.ts";
import {
    cellText,
    dashboardStates,
    formatCount,
    formatDuration,
    formatMoney,
    formatPerWeek,
    formatRate,
    rangeLine,
    residualKnowledge,
    prEventsText,
    prUrl,
    recordsPath,
    tableRows,
    threadKindText,
    usageAvailable,
    usageKnowledge,
    usageReadLines,
    usageText,
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
        assert.deepEqual([t.usage.sessions, t.usage.missing, t.usage.excluded.shared], [7, 1, 1]);
        // 1 gone conversation (partial) and 1 session never caught up (unknown): the total is partial, and says so.
        assert.equal(t.usage.state, "partial");
        assert.deepEqual(t.usage.sessionStates, { complete: 5, partial: 1, unknown: 1 });
        assert.equal(usageKnowledge(t.usage, answer.coverage), "partial");
        assert.deepEqual(usageReadLines(t.usage, answer.coverage), {
            read: "partial",
            sessions: "5 complete, 1 partial, 1 unknown",
        });
        assert.equal(
            cellText("tokens", { metrics: t, coverage: answer.coverage }),
            "9,320 (partial)",
        );
        assert.equal(
            cellText("cost", { metrics: t, coverage: answer.coverage }),
            "$0.90 (partial)",
        );
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
            gone: 1,
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
        assert.deepEqual(codes(answer), ["usage-unknown", "partial"]);
        assert(answer.coverage.limitations.some((each) => each.code === "zero-cost-reported"));

        const notice = dashboardStates(answer).find(
            (state: { code: string }) => state.code === "usage-unknown",
        );

        assert.equal(notice.tone, "warn");
        assert.equal(
            notice.text,
            answer.coverage.limitations.find((each) => each.code === "usage-unknown")?.text,
        );
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

        // Each row's usage from its own sessions: complete, an explicit $0.00, partial, unknown, and none.
        const usage = (name: string) => {
            const row = rows.find((each: { name: string }) => each.name === name);

            return [
                row.metrics.usage.state,
                usageKnowledge(row.metrics.usage, row.coverage),
                cellText("tokens", row),
                cellText("cost", row),
            ];
        };

        assert.deepEqual(usage(REPOS.snosi.toLowerCase()), ["complete", "known", "6,500", "$0.75"]);
        assert.deepEqual(usage(REPOS.long.toLowerCase()), ["complete", "known", "500", "$0.00"]);
        assert.deepEqual(usage(REPOS.team.toLowerCase()), ["complete", "known", "1,950", null]);
        assert.deepEqual(usage(REPOS.widgets.toLowerCase()), [
            "partial",
            "partial",
            "250 (partial)",
            "$0.10 (partial)",
        ]);
        assert.deepEqual(usage("acme-labs"), [
            "partial",
            "partial",
            "250 (partial)",
            "$0.10 (partial)",
        ]);
        assert.deepEqual(usage(REPOS.wiki.toLowerCase()), ["unknown", "unknown", null, null]);
        assert.deepEqual(usage("bketelsen"), ["partial", "partial", "1,950 (partial)", null]);
        assert.deepEqual(usage("frostyard"), ["complete", "known", "7,000", "$0.75"]);
        assert.deepEqual(usage("Unattributed"), ["complete", "known", "120", "$0.05"]);

        // Sorted by tokens, ascending: the partial rows by their number, the unknown homewiki row last.
        assert.deepEqual(
            tableRows(answer, { key: "tokens", dir: "asc" }).map(
                (row: { name: string }) => row.name,
            ),
            [
                "acme-labs",
                REPOS.widgets.toLowerCase(),
                "bketelsen",
                REPOS.team.toLowerCase(),
                REPOS.wiki.toLowerCase(),
                "frostyard",
                REPOS.long.toLowerCase(),
                REPOS.snosi.toLowerCase(),
                "Unattributed",
            ],
        );

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
            "usage-unknown",
            "partial",
        ]);
        assert.deepEqual(codes(take({}, "usage-unavailable")), [
            "failed-source",
            "usage-unavailable",
            "usage-unknown",
            "partial",
        ]);
        assert.deepEqual(codes(take({}, "partial-usage")), ["usage-unknown", "partial"]);
        assert.deepEqual(codes(take({}, "residual-only")), ["usage-unknown", "partial"]);
        assert.match(
            dashboardStates(take({}, "partial-usage"))[1].text,
            /usage: 3 sessions pending, 1 ledger unreadable/,
        );
        assert.deepEqual(codes(take(), { error: "HTTP 500" }), [
            "refresh-failed",
            "usage-unknown",
            "partial",
        ]);
        assert.deepEqual(codes(null, { error: "HTTP 500" }), ["refresh-failed"]);
        assert.deepEqual(codes(take({ owner: "nobody" })), ["partial", "no-work"]);
        assert.deepEqual(codes(take({ repo: REPOS.wiki })), [
            "usage-unknown",
            "partial",
            "no-closures",
        ]);
        // A scope whose sessions all have a complete read has no usage notice.
        assert.deepEqual(codes(take({ repo: REPOS.snosi })), ["partial"]);
    });

    test("the drill-down: each row's path gives the threads and PRs that the row counts", () => {
        const answer = take();
        const rows = tableRows(answer, { key: "name", dir: "asc" });

        const drill = (name: string): Records => {
            const row = rows.find((each: { name: string }) => each.name === name);
            const path = recordsPath(row, answer.range);
            const [route, search] = path.split("?");

            assert.equal(route, "dashboard/records");

            const fixture = dashboardFixture(NOW);
            const result = records({
                ...fixture,
                now: NOW,
                query: Object.fromEntries(new URLSearchParams(search)),
            });

            if ("error" in result) {
                assert.fail(result.error);
            }

            return result;
        };

        const snosi = drill(REPOS.snosi.toLowerCase());

        assert.deepEqual(snosi.scope, { kind: "repo", owner: "frostyard", repo: REPOS.snosi });
        assert.deepEqual(
            snosi.threads.map((thread) => [thread.id, thread.kind, thread.gone]),
            [
                ["T1", "success", false],
                ["T2", "success", false],
                ["T3", "abandoned", false],
                ["T4", "failed", false],
                ["T5", "dropped", false],
                ["T15", "now", false],
                ["T22", "success", true],
            ],
        );
        assert.deepEqual(
            snosi.threads.map((thread) => threadKindText(thread)),
            [
                "closed: success",
                "closed: success",
                "closed: abandoned",
                "closed: failed",
                "closed: dropped (excluded)",
                "open now",
                "closed: success",
            ],
        );
        // The unread #13 has no event in the range: it is not in the list.
        assert.deepEqual(
            snosi.prs.map((pr) => [pr.ref, pr.events, prUrl(pr)]),
            [
                [
                    `${REPOS.snosi}#10`,
                    ["created", "merged"],
                    `https://github.com/${REPOS.snosi}/pull/10`,
                ],
                [
                    `${REPOS.snosi}#11`,
                    ["created", "closed-unmerged"],
                    `https://github.com/${REPOS.snosi}/pull/11`,
                ],
                [
                    `${REPOS.snosi}#12`,
                    ["created", "open-now"],
                    `https://github.com/${REPOS.snosi}/pull/12`,
                ],
            ],
        );
        assert.equal(
            prEventsText(snosi.prs[1]),
            "closed · created in range, closed unmerged in range",
        );
        assert.deepEqual(snosi.truncated, { threads: 0, prs: 0 });

        // The owner subtotal: T10 is outside 30 days, T12 has no close time, T19 is a coordinator.
        const owner = drill("bketelsen");

        assert.deepEqual(owner.scope, { kind: "owner", owner: "bketelsen" });
        assert.deepEqual(
            owner.threads.map((thread) => `${thread.id}:${thread.kind}`),
            ["T9:success", "T11:success", "T16:now"],
        );
        assert.deepEqual(
            owner.prs.map((pr) => `${pr.ref}:${pr.events.join("+")}`),
            [
                `${REPOS.team}#93:created+merged`,
                `${REPOS.team}#94:open-now`,
                `${REPOS.team}#95:created+merged`,
            ],
        );

        // The unattributed row: its threads only (T20 is ask-only), and no PR.
        const unattributed = drill("Unattributed");

        assert.deepEqual(unattributed.scope, { kind: "unattributed" });
        assert.deepEqual(
            unattributed.threads.map((thread) => [thread.id, thread.kind, thread.repo]),
            [
                ["T18", "success", null],
                ["T21", "now", null],
            ],
        );
        assert.deepEqual(unattributed.prs, []);

        // The scope total has no drill-down; all tracked work holds every row's records.
        assert.equal(recordsPath({ kind: "total", name: "Scope total" }, answer.range), null);

        const all = records({ ...dashboardFixture(NOW), now: NOW, query: {} });

        assert(!("error" in all));
        assert.deepEqual(
            all.threads.map((thread) => thread.id),
            [
                "T1",
                "T2",
                "T3",
                "T4",
                "T5",
                "T6",
                "T7",
                "T8",
                "T9",
                "T11",
                "T13",
                "T14",
                "T15",
                "T16",
                "T17",
                "T18",
                "T21",
                "T22",
            ],
        );
        assert.deepEqual(
            all.threads.filter((thread) => thread.kind === "now").length,
            answer.totals.workload.total,
            "the open-now threads are the workload",
        );
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

    test("the long variant: a valid 366-day range, with a bar for each day", () => {
        const answer = take({ from: "2025-10-30" }, "long");

        assert.equal(answer.range.days, 366);
        assert.equal(answer.daily.length, 366);
        assert.equal(answer.coverage.boundaryDay, "2025-10-05");
        // The 8 of the main fixture, T10, and 1 every 5 days from 35 to 365 days ago.
        assert.equal(answer.totals.completion.success, 8 + 1 + 67);
        assert.equal(
            answer.daily.reduce((sum, day) => sum + day.successes, 0),
            76,
        );
        assert.equal(
            take({}, "long").totals.completion.success,
            8,
            "the default range is unchanged",
        );
    });

    test("usage availability on the fixture: a failed read after a good one keeps the facts; no good read is unknown", () => {
        const failed = take({}, "usage-unavailable");

        assert.equal(usageAvailable(failed.coverage), true);
        // Each row keeps its own knowledge: only the homewiki row (no complete read) is unknown.
        assert.deepEqual(
            tableRows(failed, { key: "name", dir: "asc" })
                .filter(
                    (row: { metrics: Snapshot["totals"]; coverage: Snapshot["coverage"] }) =>
                        usageKnowledge(row.metrics.usage, row.coverage) === "unknown",
                )
                .map((row: { name: string }) => row.name),
            [REPOS.wiki.toLowerCase()],
        );

        const fixture = dashboardFixture(NOW, "usage-unavailable");

        delete fixture.usage.sources.usage!.lastGoodAt;

        const first = snapshot({ ...fixture, now: NOW, query: {} });

        assert(!("error" in first));
        assert.equal(first.coverage.sources.usage.status, "failed");
        assert.equal(usageAvailable(first.coverage), false);
        // No good read: every row is unknown, the complete ones too.
        assert.deepEqual(
            [
                ...tableRows(first, { key: "name", dir: "asc" }),
                { metrics: first.totals, coverage: first.coverage },
            ].map((row) => [cellText("tokens", row), cellText("cost", row)]),
            Array.from({ length: 10 }, () => [null, null]),
        );

        const never = take({}, "not-started");

        assert.equal(never.coverage.sources.usage.status, "never");
        assert.equal(usageAvailable(never.coverage), false);
    });
    test("residual-only: the dated usage is unknown, and the settled residual shows by its own knowledge", () => {
        const answer = take({}, "residual-only");
        const usage = answer.totals.usage;

        const residualOf = (scope: Snapshot["totals"]["usage"], coverage: Snapshot["coverage"]) => {
            const knowledge = residualKnowledge(scope, coverage);
            const counters = scope.undated.residual?.counters;

            return [
                usageText(counters ? formatCount(counters.totalTokens) : null, knowledge),
                usageText(counters ? formatMoney(counters.cost) : null, knowledge),
            ];
        };

        // Every counted session is unknown: the dated sums are null, and the cards show "—".
        assert.equal(usage.state, "unknown");
        assert.equal(usage.totalTokens, null);
        assert.equal(usage.cost, null);
        assert.deepEqual(usage.sessionStates, { complete: 0, partial: 0, unknown: 7 });
        assert.equal(usageKnowledge(usage, answer.coverage), "unknown");
        // The reducer keeps the settled residual of session 103: the card shows it, not "—".
        assert.deepEqual(usage.undated.residual, {
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
        assert.equal(residualKnowledge(usage, answer.coverage), "known");
        assert.deepEqual(residualOf(usage, answer.coverage), ["55", "$0.02"]);

        // The pi-pocket-team row holds session 103; a row with no settled residual stays unknown.
        const team = take({ repo: REPOS.team }, "residual-only");
        const snosi = take({ repo: REPOS.snosi }, "residual-only");

        assert.equal(usageKnowledge(team.totals.usage, team.coverage), "unknown");
        assert.deepEqual(residualOf(team.totals.usage, team.coverage), ["55", "$0.02"]);
        assert.deepEqual(residualOf(snosi.totals.usage, snosi.coverage), [null, null]);

        // A ledger that could not be read marks the residual partial; no good read makes it unknown.
        const partial = take({}, "partial-usage");

        assert.equal(partial.totals.usage.residuals.unavailable, 1);
        assert.deepEqual(residualOf(partial.totals.usage, partial.coverage), [
            "55 (partial)",
            "$0.02 (partial)",
        ]);

        const fixture = dashboardFixture(NOW, "residual-only");

        fixture.usage.sources.usage = { at: NOW, ok: false, error: "refused", complete: false };

        const failed = snapshot({ ...fixture, now: NOW, query: {} });

        assert(!("error" in failed));
        assert.equal(usageAvailable(failed.coverage), false);
        assert.deepEqual(residualOf(failed.totals.usage, failed.coverage), [null, null]);
    });
});
