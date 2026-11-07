// Each check of the daily audit, on invented data: a fixture that makes the finding, and one at the threshold edge
// that does not.
import assert from "node:assert/strict";
import test from "node:test";
import { DAY, HOUR, MINUTE } from "./common.mjs";
import {
    CHECKS,
    checkA1,
    checkA2,
    checkA3,
    checkA4,
    errorLine,
    checkA5,
    checkB1,
    checkB2,
    checkC1,
    checkD1,
    checkD1b,
    checkD2,
    checkE1,
    checkE2,
    checkE3,
    checkF1,
    checkF2,
    checkF3,
    isCrossReviewSpawn,
    checkG1,
    checkH1,
    checkH2,
    checkH3,
    checkI1,
    checkI2,
    checkI3,
    checkJ1,
    checkQ1,
    checkP1,
    checkR1,
    checkR2,
    R2_BENCH_REPOS,
    R2_THRESHOLDS,
    Q1_ROUND_THRESHOLDS,
    Q1_STOP_THRESHOLDS,
    inDeepseekPeak,
    PLAN_TARGETED,
    makeFinding,
    runChecks,
} from "./checks.mjs";
import { NOW, ago, ctx, emptyData, event, pr, thread, threadMap } from "./fixtures/builders.mjs";

const ids = (result: { findings: { id: string }[] }) => result.findings.map((f) => f.id);

// ---------- A. Desk lifecycle ----------

test("A1: 2 reopens in 24 h make a finding; 1, or 2 more than 24 h apart, do not", () => {
    const t1 = thread("T1", { state: "closed" });
    const two = emptyData({
        threads: threadMap(t1),
        events: [
            event("T1", ago(5 * HOUR), "reopened:1", "reopened: its session is busy"),
            event("T1", ago(2 * HOUR), "reopened:2", "reopened: new work in its session"),
        ],
    });

    assert.deepEqual(ids(checkA1(two, ctx)), ["A1:T1"]);
    assert.equal(checkA1(two, ctx).findings[0]!.severity, "medium");
    assert.equal(checkA1(two, ctx).findings[0]!.cases, 2);

    const one = emptyData({
        threads: threadMap(t1),
        events: [event("T1", ago(2 * HOUR), "reopened:2", "reopened: x")],
    });

    assert.deepEqual(ids(checkA1(one, ctx)), []);

    const apart = emptyData({
        threads: threadMap(t1),
        events: [
            event("T1", ago(23 * HOUR), "reopened:1", "reopened: a"),
            event("T1", ago(23 * HOUR) + DAY, "reopened:2", "reopened: b"),
        ],
    });

    assert.deepEqual(ids(checkA1(apart, ctx)), []);
});

test("A1: 4 reopens in 24 h are high", () => {
    const events = [1, 2, 3, 4].map((n) =>
        event("T1", ago(n * HOUR), `reopened:${n}`, "reopened: its session is busy"),
    );
    const result = checkA1(emptyData({ threads: threadMap(thread("T1")), events }), ctx);

    assert.equal(result.findings[0]!.severity, "high");
});

test("A1: an empty reopen costs its span; a reopen with a PR event is not empty", () => {
    const t1 = thread("T1", { session: 101 });
    const costRows = [
        { c: 101, at: ago(5 * HOUR) + MINUTE, cost: 1.5 },
        { c: 101, at: ago(5 * HOUR) + 2 * MINUTE, cost: 0.5 },
        { c: 101, at: ago(HOUR), cost: 9 },
    ];
    const empty = emptyData({
        threads: threadMap(t1),
        costRows,
        events: [
            event("T1", ago(5 * HOUR), "reopened:1", "reopened: a"),
            event("T1", ago(5 * HOUR) + 3 * MINUTE, "busy:1", "the session is idle"),
            event("T1", ago(5 * HOUR) + 5 * MINUTE, "closed:1", "closed: all parts closed"),
            event("T1", ago(3 * HOUR), "reopened:2", "reopened: b"),
            event("T1", ago(3 * HOUR) + MINUTE, "x/y#3:state", "x/y#3: OPEN"),
            event("T1", ago(2 * HOUR), "closed:2", "closed: all parts closed"),
        ],
    });
    const result = checkA1(empty, ctx);

    assert.equal(result.metrics.empty, 1);
    assert.equal(result.metrics.emptyCost, 2);
    assert.equal(result.findings[0]!.waste, 2);
});

test("A1: each finding states the empty reopens of its own thread and their cost, not the totals", () => {
    const threads = [thread("T1", { session: 101 }), thread("T2", { session: 102 })];
    const reopenPair = (id: string, start: number, work: boolean) => [
        event(id, ago(start), `reopened:${start}`, "reopened: a"),
        ...(work ? [event(id, ago(start) + MINUTE, "x/y#1:state", "x/y#1: OPEN")] : []),
        event(id, ago(start) + 5 * MINUTE, `closed:${start}`, "closed: all parts closed"),
    ];
    const data = emptyData({
        threads: threadMap(...threads),
        costRows: [
            { c: 101, at: ago(9 * HOUR) + 2 * MINUTE, cost: 1.5 },
            { c: 101, at: ago(7 * HOUR) + 2 * MINUTE, cost: 2.25 },
            { c: 101, at: ago(5 * HOUR) + 2 * MINUTE, cost: 40 },
            { c: 102, at: ago(8 * HOUR) + 2 * MINUTE, cost: 7 },
            { c: 102, at: ago(6 * HOUR) + 2 * MINUTE, cost: 7 },
        ],
        events: [
            ...reopenPair("T1", 9 * HOUR, false),
            ...reopenPair("T1", 7 * HOUR, false),
            ...reopenPair("T1", 5 * HOUR, true),
            ...reopenPair("T2", 8 * HOUR, false),
            ...reopenPair("T2", 6 * HOUR, true),
        ],
    });
    const result = checkA1(data, ctx);
    const [t1, t2] = result.findings;

    // The totals: 3 empty reopens, $10.75 (T2's second reopen has work, so its $7 is not counted).
    assert.equal(result.metrics.empty, 3);
    assert.equal(result.metrics.emptyCost, 10.75);

    // T1: 2 of 3 reopens are empty, $3.75. The $40 turn of its reopen with work is not waste.
    assert.equal(t1!.id, "A1:T1");
    assert.equal(t1!.waste, 3.75);
    assert.match(t1!.text, /reopened 3 times/);
    assert.match(t1!.text, /2 of these reopens did no work, and cost \$3\.75/);
    assert.ok(t1!.evidence.includes("2 empty reopens of T1, $3.75"));

    // T2: 1 empty reopen, $7. Nothing of T1's numbers is in its facts.
    assert.equal(t2!.waste, 7);
    assert.match(t2!.text, /1 of these reopens did no work, and cost \$7\.00/);
    assert.ok(!t2!.text.includes("3.75") && !t2!.text.includes("10.75"));
});

test("A1: a thread with no empty reopen says nothing of waste", () => {
    const data = emptyData({
        threads: threadMap(thread("T1")),
        events: [
            event("T1", ago(5 * HOUR), "reopened:1", "reopened: a"),
            event("T1", ago(4 * HOUR), "reopened:2", "reopened: b"),
        ],
    });
    const found = checkA1(data, ctx).findings[0]!;

    assert.doesNotMatch(found.text, /did no work/);
    assert.equal(found.waste, undefined);
});

test("A1: what began the turn is classified from the session's user entries", () => {
    const t1 = thread("T1", { session: 101, run: { returnAddress: "session-aaa" } });
    const data = emptyData({
        threads: threadMap(t1),
        userEntries: {
            101: [
                {
                    id: 1,
                    at: ago(6 * HOUR),
                    text: "[via linked session session-aaa]\n<linked-session-message>\nNight muster gather: list",
                },
            ],
        },
        events: [event("T1", ago(5 * HOUR), "reopened:1", "reopened: x")],
    });

    assert.deepEqual(checkA1(data, ctx).metrics.triggers, { "supervisor: muster gather": 1 });
});

test("A2: 3 queue items for a thread make a finding; 2 do not; 6 are high", () => {
    const entry = (n: number, text: string) => ({
        id: n,
        at: ago(n * HOUR),
        text: `Desk queue: these threads wait on you: ${text}. Act on each now.`,
    });
    const make = (count: number) =>
        emptyData({
            threads: threadMap(thread("T1"), thread("T2")),
            userEntries: {
                10: Array.from({ length: count }, (_, i) =>
                    entry(i + 1, "T1: silent session; T2: new ask"),
                ),
            },
            costRows: [{ c: 10, at: ago(30 * MINUTE), cost: 3 }],
        });

    assert.deepEqual(ids(checkA2(make(2), ctx)), []);
    assert.deepEqual(ids(checkA2(make(3), ctx)), ["A2:T1", "A2:T2"]);
    assert.equal(checkA2(make(3), ctx).findings[0]!.severity, "medium");
    assert.equal(checkA2(make(6), ctx).findings[0]!.severity, "high");
});

test("A2: cost is the supervisor's spend until its next user entry; done work is counted", () => {
    const data = emptyData({
        threads: threadMap(thread("T1")),
        userEntries: {
            10: [
                {
                    id: 1,
                    at: ago(3 * HOUR),
                    text: "Desk queue: these threads wait on you: T1: silent session. Act.",
                },
                { id: 2, at: ago(2 * HOUR), text: "a person writes" },
            ],
        },
        costRows: [
            { c: 10, at: ago(3 * HOUR) + MINUTE, cost: 2 },
            { c: 10, at: ago(HOUR), cost: 50 },
        ],
        events: [event("T1", ago(150 * MINUTE), "closed:1", "closed: all parts closed")],
    });
    const result = checkA2(data, ctx);

    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.silentThenClosed, 1);
});

test("A2: each finding states the queue cost of its own thread", () => {
    const entry = (n: number, text: string) => ({
        id: n,
        at: ago(n * HOUR),
        text: `Desk queue: these threads wait on you: ${text}. Act on each now.`,
    });
    // 3 continues, each costing $6 for 2 items: T1 and T2 each carry $3 a continue, $9 in all. T3 is in 1 only.
    const data = emptyData({
        threads: threadMap(thread("T1"), thread("T2"), thread("T3")),
        userEntries: {
            10: [
                entry(5, "T1: silent session; T2: silent session"),
                entry(4, "T1: silent session; T2: silent session"),
                entry(3, "T1: silent session; T2: silent session"),
                entry(2, "T3: silent session"),
            ],
        },
        costRows: [5, 4, 3].map((n) => ({ c: 10, at: ago(n * HOUR) + MINUTE, cost: 6 })),
    });
    const result = checkA2(data, ctx);
    const [t1, t2] = result.findings;

    assert.deepEqual(ids(result), ["A2:T1", "A2:T2"]);
    assert.equal(t1!.waste, 9);
    assert.match(t1!.text, /share of the supervisor's spend on these continues was \$9\.00/);
    assert.ok(t1!.evidence.includes("queue share of T1: $9.00"));
    assert.equal(t2!.waste, 9);
    assert.equal(result.metrics.cost, 18);
});

test("A3: 3 close-out wake-ups on a thread make a finding; 2 do not", () => {
    const sent = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            event("T1", ago((i + 1) * HOUR), `closeout:${i}`, "close-out wake-up sent"),
        );

    assert.deepEqual(ids(checkA3(emptyData({ events: sent(2) }), ctx)), []);
    assert.deepEqual(ids(checkA3(emptyData({ events: sent(3) }), ctx)), ["A3:T1"]);
});

test("A4: the same tool error twice makes a finding, with thread ids masked; once does not", () => {
    const error = (id: number, text: string) => ({
        id,
        c: 7,
        tool: "desk",
        at: ago(id * HOUR),
        isError: true,
        text: `<harness>\n[error] ${text}\n</harness>`,
    });
    const two = emptyData({
        toolErrors: [
            error(1, "Cannot ask on T5: it is closed."),
            error(2, "Cannot ask on T9: it is closed."),
        ],
    });
    const one = emptyData({ toolErrors: [error(1, "Cannot ask on T5: it is closed.")] });

    assert.equal(checkA4(two, ctx).findings.length, 1);
    assert.equal(checkA4(two, ctx).findings[0]!.cases, 2);
    assert.match(checkA4(two, ctx).findings[0]!.text, /Cannot ask on T<n>/);
    assert.deepEqual(ids(checkA4(one, ctx)), []);
});

test("A4: refusals and other tools are not counted", () => {
    const refusal = (id: number) => ({
        id,
        c: 7,
        tool: "team_delegate",
        at: ago(id * HOUR),
        isError: true,
        text: "[error] The desk is full: 12 of 12 threads count.",
    });
    const bash = (id: number) => ({ ...refusal(id), tool: "bash", text: "[error] boom" });

    assert.deepEqual(ids(checkA4(emptyData({ toolErrors: [refusal(1), refusal(2)] }), ctx)), []);
    assert.deepEqual(ids(checkA4(emptyData({ toolErrors: [bash(1), bash(2)] }), ctx)), []);
});

test("A4: the same plan tool error twice makes a finding", () => {
    const error = (id: number) => ({
        id,
        c: 13,
        tool: "plan",
        at: ago(id * HOUR),
        isError: true,
        text: "<harness>\n[error] Plan T857 has no draft graph for rev 133209f: call plan tasks first.\n</harness>",
    });
    const result = checkA4(emptyData({ toolErrors: [error(1), error(2)] }), ctx);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.cases, 2);
    assert.match(result.findings[0]!.text, /^2× plan: Plan T<n> has no draft graph/);
    assert.deepEqual(ids(checkA4(emptyData({ toolErrors: [error(1)] }), ctx)), []);
});

test("A4: the same refusal with 2 revs is 1 finding with 2 cases", () => {
    const error = (id: number, rev: string) => ({
        id,
        c: 13,
        tool: "plan",
        at: ago(id * HOUR),
        isError: true,
        text: `<harness>\n[error] Plan T857 has no draft graph for rev ${rev}: call plan tasks first.\n</harness>`,
    });
    const result = checkA4(
        emptyData({ toolErrors: [error(1, "133209f"), error(2, "2a31779")] }),
        ctx,
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.cases, 2);
    assert.equal(result.findings[0]!.id, "A4:plan-plan-t-n-has-no-draft-graph-for-rev-rev-cal");
    assert.match(result.findings[0]!.text, /for rev <rev>: call plan tasks first/);
});

test("errorLine masks a whole word of 7 to 40 hex characters, and leaves other words as they are", () => {
    assert.equal(
        errorLine("rev 133209f and a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"),
        "rev <rev> and <rev>",
    );
    // 6 hex characters, 41, a hex run inside a word, a thread id and a plain word stay.
    assert.equal(errorLine("abc123 at T857, x133209fy"), "abc123 at T<n>, x133209fy");
    assert.equal(errorLine(`${"a".repeat(40)}1`), `${"a".repeat(40)}1`);
    // A word of a to f only has no digit: it is not a rev.
    assert.equal(errorLine("the page was defaced"), "the page was defaced");
    // The subjects of the A4 tests above do not change.
    assert.equal(
        errorLine("<harness>\n[error] Cannot ask on T5: it is closed.\n</harness>"),
        "Cannot ask on T<n>: it is closed.",
    );
});

test("A5: a thread closed failed is a finding; closed done is not", () => {
    const failed = thread("T1", {
        state: "closed",
        closed: { at: ago(HOUR), why: "failed", by: "desk" },
    });
    const done = thread("T2", {
        state: "closed",
        closed: { at: ago(HOUR), why: "done", by: "sweep" },
    });
    const old = thread("T3", {
        state: "closed",
        closed: { at: ago(30 * HOUR), why: "failed", by: "desk" },
    });

    assert.deepEqual(ids(checkA5(emptyData({ threads: threadMap(failed, done, old) }), ctx)), [
        "A5:failed:T1",
    ]);
});

test("A5: a found thread open 24 h or more is a finding; 23 h is not", () => {
    const found = (hours: number) =>
        emptyData({ threads: threadMap(thread("F1", { startedAt: NOW - hours * HOUR })) });

    assert.deepEqual(ids(checkA5(found(24), ctx)), ["A5:found:F1"]);
    assert.deepEqual(ids(checkA5(found(23), ctx)), []);
    assert.equal(checkA5(found(23), ctx).metrics.foundThreads[0].hours, 23);
});

test("A5: refusals of the desk are a finding, and the OKs used are counted", () => {
    const refusal = {
        id: 1,
        c: 7,
        tool: "team_delegate",
        at: ago(HOUR),
        isError: true,
        text: "The desk is full: 12 of 12 threads count.",
    };
    const data = emptyData({
        toolErrors: [refusal],
        grants: [
            {
                at: ago(2 * HOUR),
                by: "brian",
                via: "tap",
                key: "k",
                usedBy: "d1",
                expires: NOW + HOUR,
            },
            { at: ago(3 * HOUR), by: "brian", via: "tap", key: "k2", expires: NOW + HOUR },
        ],
    });
    const result = checkA5(data, ctx);

    assert.deepEqual(ids(result), ["A5:refusals"]);
    assert.equal(result.metrics.refusals, 1);
    assert.equal(result.metrics.okUsed, 1);
});

test("A5: a watch due more than 1 day ago with no result is a finding; exactly 1 day, or a result, is not", () => {
    const watch = (dueAt: number, result?: object) =>
        emptyData({
            threads: threadMap(
                thread("T1", {
                    watch: {
                        checkOn: "2026-10-20",
                        check: "x",
                        setAt: 1,
                        setBy: "brian",
                        key: "k",
                        dueAt,
                        result,
                    },
                }),
            ),
        });

    assert.deepEqual(ids(checkA5(watch(NOW - DAY - 1), ctx)), ["A5:watch:T1"]);
    assert.deepEqual(ids(checkA5(watch(NOW - DAY), ctx)), []);
    assert.deepEqual(
        ids(checkA5(watch(NOW - 3 * DAY, { at: 1, by: "x", pass: true, text: "", key: "r" }), ctx)),
        [],
    );
});

test("A5: asks open more than 24 h are a metric", () => {
    const data = emptyData({
        threads: threadMap(
            thread("T1", {
                asks: [
                    { id: "T1a", text: "q", at: NOW - 25 * HOUR },
                    { id: "T1b", text: "q", at: NOW - HOUR },
                ],
            }),
        ),
    });

    assert.equal(checkA5(data, ctx).metrics.asksOpenOver24h, 1);
});

// ---------- B. Repair wake-ups ----------

const repairThread = (oid: string) =>
    thread("T1", {
        run: {
            repairs: {
                [`repair:acme/widgets#7:${oid}:FAILURE`]: {
                    at: ago(HOUR),
                    to: "agent",
                    why: "change",
                    sent: true,
                },
            },
        },
    });

const runs = (...list: [string, string][]) =>
    list.map(([name, conclusion]) => ({ name, conclusion }));

test("B1: a repair where only a cancelled run failed is a finding", () => {
    const data = emptyData({
        threads: threadMap(repairThread("abc1234")),
        github: {
            botPrs: [],
            prs: {},
            autoDelete: {},
            checkRuns: {
                "acme/widgets@abc1234": runs(["Title", "success"], ["Title", "cancelled"]),
            },
        },
    });
    const result = checkB1(data, ctx);

    assert.deepEqual(ids(result), ["B1:acme/widgets#7"]);
    assert.equal(result.findings[0]!.severity, "high");
    assert.match(result.findings[0]!.text, /Title \(success, cancelled\)/);
    assert.equal(result.metrics.withoutRealFailure, 1);
});

test("B1: a name with only failures is a real fault; a name with a success is not", () => {
    const github = (checks: ReturnType<typeof runs>) => ({
        botPrs: [],
        prs: {},
        autoDelete: {},
        checkRuns: { "acme/widgets@abc1234": checks },
    });
    const real = emptyData({
        threads: threadMap(repairThread("abc1234")),
        github: github(runs(["Build", "failure"])),
    });
    const healed = emptyData({
        threads: threadMap(repairThread("abc1234")),
        github: github(runs(["Build", "failure"], ["Build", "success"])),
    });
    const timedOut = emptyData({
        threads: threadMap(repairThread("abc1234")),
        github: github(runs(["Build", "timed_out"])),
    });

    assert.deepEqual(ids(checkB1(real, ctx)), []);
    assert.deepEqual(ids(checkB1(timedOut, ctx)), []);
    assert.deepEqual(ids(checkB1(healed, ctx)), ["B1:acme/widgets#7"]);
});

test("B1: a failure before the wake-up is real, even when a rerun succeeded after it (updex#461)", () => {
    const wake = ago(HOUR);
    const timed = (name: string, conclusion: string, at: number) => ({
        name,
        conclusion,
        completed_at: new Date(at).toISOString(),
    });
    const data = (checks: unknown[]) =>
        emptyData({
            threads: threadMap(repairThread("abc1234")),
            github: {
                botPrs: [],
                prs: {},
                autoDelete: {},
                checkRuns: { "acme/widgets@abc1234": checks },
            },
        });

    // The rerun succeeded after the wake-up: it was not known then.
    assert.deepEqual(
        ids(
            checkB1(
                data([
                    timed("Unit Tests", "failure", wake - 60_000),
                    timed("Unit Tests", "success", wake + 3 * 60_000),
                ]),
                ctx,
            ),
        ),
        [],
    );
    // Both ended before the wake-up and the success was later: the failure healed.
    assert.deepEqual(
        ids(
            checkB1(
                data([
                    timed("Unit Tests", "failure", wake - 120_000),
                    timed("Unit Tests", "success", wake - 60_000),
                ]),
                ctx,
            ),
        ),
        ["B1:acme/widgets#7"],
    );
});

test("B1: runs with times are judged by what was known at the wake-up", () => {
    const wake = ago(HOUR);
    const done = (conclusion: string, at: number) => ({
        name: "Build",
        conclusion,
        completed_at: new Date(wake + at).toISOString(),
    });
    const cases: [string, unknown[], boolean][] = [
        [
            "an older success, then a newer failure: real failure",
            [done("success", -120_000), done("failure", -60_000)],
            false,
        ],
        [
            "a success and a cancelled run: no failure",
            [done("success", -120_000), done("cancelled", -60_000)],
            true,
        ],
        [
            "a failure and a rerun in progress: real failure",
            [done("failure", -60_000), { name: "Build", status: "in_progress", conclusion: null }],
            false,
        ],
    ];

    for (const [label, checks, finding] of cases) {
        const data = emptyData({
            threads: threadMap(repairThread("abc1234")),
            github: {
                botPrs: [],
                prs: {},
                autoDelete: {},
                checkRuns: { "acme/widgets@abc1234": checks },
            },
        });

        assert.deepEqual(ids(checkB1(data, ctx)), finding ? ["B1:acme/widgets#7"] : [], label);
    }
});

test("B1: a repair with no check data from GitHub is left out; a CONFLICTING one is not read", () => {
    const missing = emptyData({ threads: threadMap(repairThread("abc1234")) });
    const conflict = emptyData({
        threads: threadMap(
            thread("T1", {
                run: {
                    repairs: {
                        "repair:acme/widgets#7:abc1234:CONFLICTING": {
                            at: ago(HOUR),
                            to: "agent",
                            why: "change",
                            sent: true,
                        },
                    },
                },
            }),
        ),
    });

    assert.deepEqual(ids(checkB1(missing, ctx)), []);
    assert.deepEqual(ids(checkB1(conflict, ctx)), []);
});

test("B2: an agent report after a repair that says it does not fail is a finding", () => {
    const wake = event(
        "T1",
        ago(3 * HOUR),
        "repair:k",
        "acme/widgets#7 is failing: repair wake-up to the agent",
    );
    const data = (text: string, at = ago(2 * HOUR)) =>
        emptyData({
            threads: threadMap(thread("T1", { session: 101 })),
            events: [wake],
            reports: { 101: [{ key: "r1", at, from: "team_message", text }] },
        });

    assert.deepEqual(ids(checkB2(data("The PR does not fail. Only cancelled runs."), ctx)), [
        "B2:T1",
    ]);
    assert.deepEqual(ids(checkB2(data("The check is not failing now."), ctx)), ["B2:T1"]);
    assert.deepEqual(ids(checkB2(data("Fixed the lint error."), ctx)), []);
    assert.deepEqual(ids(checkB2(data("It does not fail", ago(4 * HOUR)), ctx)), []);
});

// ---------- C. Attribution ----------

test("C1: a window attach that was detached is a finding; one that stayed is not", () => {
    const moved = emptyData({
        events: [
            event("T1", ago(5 * HOUR), "pr:1", "acme/widgets#8 attached (window)"),
            event("T1", ago(2 * HOUR), "detached:1", "detached acme/widgets#8"),
            event("T2", ago(2 * HOUR) + 1, "attached:1", "acme/widgets#8 attached"),
        ],
    });
    const stayed = emptyData({
        events: [event("T1", ago(5 * HOUR), "pr:1", "acme/widgets#8 attached (window)")],
    });
    const result = checkC1(moved, ctx);

    assert.deepEqual(ids(result), ["C1:acme/widgets#8"]);
    assert.match(result.findings[0]!.text, /attached to T2/);
    assert.deepEqual(ids(checkC1(stayed, ctx)), []);
    assert.equal(checkC1(stayed, ctx).metrics.windowAttaches, 1);
});

// ---------- D. The desk against GitHub ----------

const askThread = (answerAt: number, extra: object[] = []) =>
    thread("T1", {
        asks: [
            {
                id: "T1a",
                text: "Merge widgets#7?",
                at: answerAt - HOUR,
                answer: { at: answerAt, by: "brian", words: "merged" },
            },
            ...extra,
        ],
    });

const withPr = (state: object) => ({
    botPrs: [],
    prs: { "acme/widgets#7": pr(state) },
    checkRuns: {},
    autoDelete: {},
});

test("D1: merged 15 min after the answer is a finding; 14 min is not; never merged is", () => {
    const answerAt = ago(5 * HOUR);
    const at = (min: number) =>
        emptyData({
            threads: threadMap(askThread(answerAt)),
            github: withPr({
                state: "MERGED",
                mergedAt: new Date(answerAt + min * MINUTE).toISOString(),
            }),
        });

    assert.deepEqual(ids(checkD1(at(15), ctx)), ["D1:acme/widgets#7"]);
    assert.deepEqual(ids(checkD1(at(14), ctx)), []);
    assert.deepEqual(ids(checkD1(at(-1), ctx)), []);

    const open = emptyData({
        threads: threadMap(askThread(answerAt)),
        github: withPr({ state: "OPEN" }),
    });

    assert.deepEqual(ids(checkD1(open, ctx)), ["D1:acme/widgets#7"]);
    assert.equal(checkD1(at(-1), ctx).metrics.lagSeconds.mergedBeforeAnswer, 1);
});

test("D1b: a new ask within 10 min while GitHub had not merged is a finding; 11 min is not", () => {
    const answerAt = ago(5 * HOUR);
    const data = (afterMin: number) =>
        emptyData({
            threads: threadMap(
                askThread(answerAt, [
                    { id: "T1b", text: "Is widgets#7 merged?", at: answerAt + afterMin * MINUTE },
                ]),
            ),
            github: withPr({
                state: "MERGED",
                mergedAt: new Date(answerAt + 20 * MINUTE).toISOString(),
            }),
        });

    assert.deepEqual(ids(checkD1b(data(9), ctx)), ["D1b:acme/widgets#7"]);
    assert.deepEqual(ids(checkD1b(data(11), ctx)), []);

    const early = emptyData({
        threads: threadMap(
            askThread(answerAt, [
                { id: "T1b", text: "Is widgets#7 merged?", at: answerAt + 5 * MINUTE },
            ]),
        ),
        github: withPr({ state: "MERGED", mergedAt: new Date(answerAt - MINUTE).toISOString() }),
    });

    assert.deepEqual(ids(checkD1b(early, ctx)), []);
});

test("D2: the desk says OPEN, GitHub merged before the last sweep: a finding; a late change is not", () => {
    const desk = (sweptAt: number) =>
        thread("T1", {
            prs: { "acme/widgets#7": { via: "attached", state: "OPEN" } },
            run: { sweptAt },
        });
    const github = (mergedAt: number) =>
        withPr({ state: "MERGED", mergedAt: new Date(mergedAt).toISOString() });

    assert.deepEqual(
        ids(
            checkD2(
                emptyData({
                    threads: threadMap(desk(ago(10 * MINUTE))),
                    github: github(ago(HOUR)),
                }),
                ctx,
            ),
        ),
        ["D2:acme/widgets#7"],
    );
    // GitHub changed after the sweep: the next sweep will see it.
    assert.deepEqual(
        ids(
            checkD2(
                emptyData({
                    threads: threadMap(desk(ago(HOUR))),
                    github: github(ago(10 * MINUTE)),
                }),
                ctx,
            ),
        ),
        [],
    );
    // The last sweep is more than 1 h old: the sweep did not run, which is not this check.
    assert.deepEqual(
        ids(
            checkD2(
                emptyData({
                    threads: threadMap(desk(ago(2 * HOUR))),
                    github: github(ago(3 * HOUR)),
                }),
                ctx,
            ),
        ),
        [],
    );
});

// ---------- E. Reports and messaging ----------

const report = (key: string, at: number, text: string, from = "team_message") => ({
    key,
    at,
    from,
    text,
});
const sentence =
    "The migration is done and the tests pass on widgets #7 with the new index in place";

test("E1: the same text twice within 30 min is a sure duplicate", () => {
    const data = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        reports: {
            101: [report("a", ago(HOUR), sentence), report("b", ago(HOUR) + 5 * MINUTE, sentence)],
        },
    });
    const result = checkE1(data, ctx);

    assert.deepEqual(ids(result), ["E1:T1"]);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.metrics.duplicates, 1);
});

test("E1: 80% the same words but other PR refs is a candidate for the LLM", () => {
    const data = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        reports: {
            101: [
                report(
                    "a",
                    ago(HOUR),
                    "Opened widgets #20 with the new index and all tests pass here now",
                ),
                report(
                    "b",
                    ago(HOUR) + MINUTE,
                    "Opened widgets #22 with the new index and all tests pass here now",
                ),
            ],
        },
    });
    const result = checkE1(data, ctx);

    assert.deepEqual(ids(result), ["E1?:T1"]);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].check, "E1?");
});

test("E1: under 50% the same words, or 30 min apart, is nothing", () => {
    const low = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        reports: {
            101: [
                report("a", ago(HOUR), sentence),
                report("b", ago(HOUR) + MINUTE, "Different words entirely here"),
            ],
        },
    });
    const apart = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        reports: {
            101: [report("a", ago(HOUR), sentence), report("b", ago(HOUR) + 30 * MINUTE, sentence)],
        },
    });

    assert.deepEqual(ids(checkE1(low, ctx)), []);
    assert.deepEqual(ids(checkE1(apart, ctx)), []);
});

test("E2: a message with no address is a finding per thread; one block is not, two are low", () => {
    const error = (id: number, text: string, tool = "team_message") => ({
        id,
        c: 101,
        tool,
        at: ago(id * HOUR),
        isError: true,
        text: `<harness>\n[error] ${text}\n</harness>`,
    });
    const address = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        toolErrors: [error(1, "No linked session has that address here.")],
    });
    const oneBlock = emptyData({
        toolErrors: [error(1, "Tool call blocked: use team_message", "team")],
    });
    const twoBlocks = emptyData({
        toolErrors: [
            error(1, "Tool call blocked: use team_message", "team"),
            error(2, "Tool call blocked: use team_message", "team"),
        ],
    });

    assert.deepEqual(ids(checkE2(address, ctx)), ["E2:T1"]);
    assert.equal(checkE2(address, ctx).findings[0]!.severity, "medium");
    assert.deepEqual(ids(checkE2(oneBlock, ctx)), []);
    assert.deepEqual(ids(checkE2(twoBlocks, ctx)), ["E2:blocked"]);
    assert.equal(checkE2(twoBlocks, ctx).findings[0]!.severity, "low");
});

test("E3: 3 night shift reports with a team_message within 30 min are a finding, with pairs; 2 are not", () => {
    const make = (count: number) => {
        const threads = Array.from({ length: count }, (_, i) =>
            thread(`T${i + 1}`, { session: 101 + i }),
        );
        const reports = Object.fromEntries(
            threads.map((t, i) => [
                t.session!,
                [
                    report(`n${i}`, ago(3 * HOUR), "night shift summary", "night-shift"),
                    report(`m${i}`, ago(3 * HOUR) + 29 * MINUTE, "the same result by message"),
                ],
            ]),
        );

        return emptyData({ threads: threadMap(...threads), reports });
    };

    assert.deepEqual(ids(checkE3(make(3), ctx)), ["E3"]);
    assert.equal(checkE3(make(3), ctx).pairs.length, 3);
    assert.deepEqual(ids(checkE3(make(2), ctx)), []);
    assert.equal(checkE3(make(2), ctx).pairs.length, 0);
    assert.equal(checkE3(make(2), ctx).metrics.shiftPlusMessage, 2);
});

test("E3: a team_message 31 min away is not a twin", () => {
    const threads = [1, 2, 3].map((n) => thread(`T${n}`, { session: 100 + n }));
    const reports = Object.fromEntries(
        threads.map((t) => [
            t.session!,
            [
                report("n", ago(3 * HOUR), "x", "night-shift"),
                report("m", ago(3 * HOUR) + 31 * MINUTE, "y"),
            ],
        ]),
    );

    assert.deepEqual(ids(checkE3(emptyData({ threads: threadMap(...threads), reports }), ctx)), []);
});

/** 3 threads, each with a night shift report and a team_message 29 min later. */
const e3Pairs = (userEntries: (i: number) => object[] = () => []) => {
    const threads = [1, 2, 3].map((n) => thread(`T${n}`, { session: 100 + n }));
    const reports = Object.fromEntries(
        threads.map((t, i) => [
            t.session!,
            [
                report(`n${i}`, ago(3 * HOUR), "night shift summary", "night-shift"),
                report(`m${i}`, ago(3 * HOUR) + 29 * MINUTE, "the same result by message"),
            ],
        ]),
    );
    const entries = Object.fromEntries(threads.map((t, i) => [t.session!, userEntries(i)]));

    return emptyData({ threads: threadMap(...threads), reports, userEntries: entries });
};

test("E3: a team_message that answers a new request after the shift report is not a twin", () => {
    const data = e3Pairs((i) => [
        {
            id: `u${i}`,
            at: ago(3 * HOUR) + 5 * MINUTE,
            text: `[via linked session session-x] All PRs on T${i + 1} are merged. Do the after-merge steps, then report.`,
        },
    ]);
    const result = checkE3(data, ctx);

    assert.deepEqual(ids(result), []);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.metrics.answeredAfterShift, 3);
    assert.equal(result.metrics.shiftPlusMessage, 0);
    assert.equal(result.metrics.shiftReports, 3);
});

test("E3: the shift's own entries between the report and the message do not make it an answer", () => {
    const data = e3Pairs((i) => [
        { id: `u${i}a`, at: ago(3 * HOUR) + 5 * MINUTE, text: "[night-shift] Round 2 of 4." },
        {
            id: `u${i}b`,
            at: ago(3 * HOUR) + 15 * MINUTE,
            text: "[subagent x answered, no reply needed] ok",
        },
    ]);
    const result = checkE3(data, ctx);

    assert.deepEqual(ids(result), ["E3"]);
    assert.equal(result.pairs.length, 3);
    assert.equal(result.metrics.answeredAfterShift, 0);
});

test("E3: a person's message between the shift report and the team_message makes it an answer", () => {
    const data = e3Pairs((i) => [
        { id: `u${i}`, at: ago(3 * HOUR) + 5 * MINUTE, text: "Also check the changelog." },
    ]);

    assert.deepEqual(ids(checkE3(data, ctx)), []);
    assert.equal(checkE3(data, ctx).metrics.answeredAfterShift, 3);
});

test("E3: 1 answering message with 2 shift reports near it counts 1 time", () => {
    const data = emptyData({
        threads: threadMap(thread("T1", { session: 101 })),
        reports: {
            101: [
                report("n1", ago(3 * HOUR), "night shift summary", "night-shift"),
                report("n2", ago(3 * HOUR) + 10 * MINUTE, "second shift summary", "night-shift"),
                report("m1", ago(3 * HOUR) + 20 * MINUTE, "the answer to the new request"),
            ],
        },
        userEntries: {
            101: [
                {
                    id: "u1",
                    at: ago(3 * HOUR) + 15 * MINUTE,
                    text: "[via linked session session-x] Do the after-merge steps, then report.",
                },
            ],
        },
    });
    const result = checkE3(data, ctx);

    assert.deepEqual(ids(result), []);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.metrics.answeredAfterShift, 1);
    assert.equal(result.metrics.shiftPlusMessage, 0);
    assert.equal(result.metrics.shiftReports, 2);
});

// ---------- F. Night and day shifts ----------

const goal = (over: object = {}) => ({
    id: "g1",
    status: "ended",
    reason: "done",
    setAt: ago(5 * HOUR),
    endedAt: ago(HOUR),
    maxRounds: 10,
    round: 2,
    rounds: [],
    ...over,
});

test("F1: failed, max-rounds and blocked endings are findings; done is not", () => {
    const data = (reason: string) =>
        emptyData({ goals: [{ session: 5, goal: goal({ reason, why: "because" }) }] });

    assert.deepEqual(ids(checkF1(data("failed"), ctx)), ["F1:g1"]);
    assert.deepEqual(ids(checkF1(data("max-rounds"), ctx)), ["F1:g1"]);
    assert.equal(checkF1(data("blocked"), ctx).findings[0]!.severity, "low");
    assert.deepEqual(ids(checkF1(data("done"), ctx)), []);
    assert.deepEqual(checkF1(data("done"), ctx).metrics.endings, { "ended: done": 1 });
});

test("F1: a goal that ended before the window is not counted", () => {
    const old = emptyData({
        goals: [
            {
                session: 5,
                goal: goal({ reason: "failed", setAt: ago(40 * HOUR), endedAt: ago(30 * HOUR) }),
            },
        ],
    });

    assert.deepEqual(ids(checkF1(old, ctx)), []);
});

const quickGoal = (id: string, gapMs: number) =>
    goal({
        id,
        rounds: [
            { n: 1, verdict: "continue", reason: "", at: ago(5 * HOUR) },
            { n: 2, verdict: "continue", reason: "", at: ago(5 * HOUR) + gapMs },
            { n: 3, verdict: "continue", reason: "", at: ago(5 * HOUR) + 2 * gapMs },
        ],
    });

test("F2: 2 shifts with 2 rounds each under 60 s are a finding; 1 shift, or 60 s rounds, are not", () => {
    const two = emptyData({
        goals: [
            { session: 5, goal: quickGoal("a", 30_000) },
            { session: 6, goal: quickGoal("b", 59_999) },
        ],
    });
    const one = emptyData({ goals: [{ session: 5, goal: quickGoal("a", 30_000) }] });
    const edge = emptyData({
        goals: [
            { session: 5, goal: quickGoal("a", 60_000) },
            { session: 6, goal: quickGoal("b", 60_000) },
        ],
    });

    assert.deepEqual(ids(checkF2(two, ctx)), ["F2"]);
    assert.equal(checkF2(two, ctx).findings[0]!.cases, 2);
    assert.deepEqual(ids(checkF2(one, ctx)), []);
    assert.deepEqual(ids(checkF2(edge, ctx)), []);
});

test("F3: a subagent on another model than the worker is a finding; the same model, or no worker, is not", () => {
    const spawn = (model: string | null) => ({ id: 9, c: 5, at: ago(3 * HOUR), model });
    const data = (worker: string | undefined, model: string | null) =>
        emptyData({ goals: [{ session: 5, goal: goal({ worker }) }], spawns: [spawn(model)] });

    assert.deepEqual(
        ids(checkF3(data("github-copilot/claude-sonnet-5.5", "deepseek/deepseek-flash"), ctx)),
        ["F3:model:g1"],
    );
    assert.deepEqual(ids(checkF3(data("github-copilot/claude-sonnet-5.5", null), ctx)), [
        "F3:model:g1",
    ]);
    assert.match(
        checkF3(data("github-copilot/claude-sonnet-5.5", null), ctx).findings[0]!.text,
        /no model given/,
    );
    assert.deepEqual(
        ids(
            checkF3(
                data("github-copilot/claude-sonnet-5.5", "github-copilot/claude-sonnet-5.5"),
                ctx,
            ),
        ),
        [],
    );
    assert.deepEqual(ids(checkF3(data(undefined, "anything"), ctx)), []);
});

test("F3: a cross-review reviewer is left out; other spawns on another model stay findings", () => {
    const worker = "deepseek/deepseek-flash";
    const data = (extra: Record<string, unknown>) =>
        emptyData({
            goals: [{ session: 5, goal: goal({ worker }) }],
            spawns: [
                {
                    id: 9,
                    c: 5,
                    at: ago(3 * HOUR),
                    model: "openai/gpt-6.1-sol",
                    brief: "",
                    ...extra,
                },
            ],
        });
    const reviewer = {
        name: "xreview-43",
        tools: ["bash", "read"],
        brief: "You are a read-only cross-reviewer.",
    };
    const left = checkF3(data(reviewer), ctx);

    assert.deepEqual(ids(left), []);
    assert.equal(left.metrics.reviewerSpawns, 1);
    assert.equal(isCrossReviewSpawn(reviewer), true);
    // "review" only past the 300 characters of the brief: the loader's flag has it.
    assert.equal(
        isCrossReviewSpawn({ name: "audit", tools: ["read", "bash"], brief: "x", review: true }),
        true,
    );
    assert.equal(isCrossReviewSpawn({ name: "audit", tools: ["read", "bash"], brief: "x" }), false);
    assert.deepEqual(
        ids(checkF3(data({ name: "fix462", tools: null, brief: "You fix review findings" }), ctx)),
        ["F3:model:g1"],
    );
    assert.deepEqual(
        ids(checkF3(data({ ...reviewer, name: "xreview", tools: ["read", "bash", "edit"] }), ctx)),
        ["F3:model:g1"],
    );
    assert.equal(checkF3(data({ name: "fix462", tools: null }), ctx).metrics.reviewerSpawns, 0);
});

test("F3: today's cross-review spawns are reviewers, not wrong models", () => {
    const worker = "deepseek/deepseek-flash";
    const spawn = (over: object) => ({
        id: 1,
        c: 5,
        at: ago(3 * HOUR),
        model: "openai/gpt-6.1-sol",
        ...over,
    });
    const reviewers = [
        spawn({
            id: 1,
            name: "xr-core-164",
            tools: ["read", "bash"],
            brief: "You are a cross-family reviewer. Review 1 PR. The review is read-only.",
        }),
        spawn({
            id: 2,
            name: "xreview",
            tools: ["read", "bash"],
            brief: "You do a read-only cross-review of 1 pull request, in batches.",
        }),
    ];
    const data = (spawns: object[]) =>
        emptyData({ goals: [{ session: 5, goal: goal({ worker }) }], spawns });
    const only = checkF3(data(reviewers), ctx);

    assert.deepEqual(ids(only), []);
    assert.equal(only.metrics.reviewerSpawns, 2);
    assert.equal(only.metrics.wrongModelSpawns, 0);

    const coder = spawn({
        id: 3,
        name: "fix-162",
        tools: null,
        brief: "Fix the 2 findings in core#162.",
    });
    const mixed = checkF3(data([...reviewers, coder]), ctx);

    assert.deepEqual(ids(mixed), ["F3:model:g1"]);
    assert.equal(mixed.metrics.wrongModelSpawns, 1);
    assert.equal(mixed.metrics.reviewerSpawns, 2);
});

test("F3: a spawn in another session, or before the shift, is not counted", () => {
    const base = { goals: [{ session: 5, goal: goal({ worker: "a/b" }) }] };

    assert.deepEqual(
        ids(
            checkF3(
                emptyData({ ...base, spawns: [{ id: 1, c: 6, at: ago(3 * HOUR), model: "x/y" }] }),
                ctx,
            ),
        ),
        [],
    );
    assert.deepEqual(
        ids(
            checkF3(
                emptyData({ ...base, spawns: [{ id: 1, c: 5, at: ago(9 * HOUR), model: "x/y" }] }),
                ctx,
            ),
        ),
        [],
    );
});

test("F3: a DeepSeek worker with a round that started in peak hours is a finding; off peak is not", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 23, h, m);
    const data = (startHour: number) =>
        emptyData({
            goals: [
                {
                    session: 5,
                    goal: goal({
                        worker: "deepseek/deepseek-flash",
                        setAt: at(startHour),
                        endedAt: at(12),
                        rounds: [{ n: 1, verdict: "done", reason: "", at: at(12) }],
                    }),
                },
            ],
        });

    assert.deepEqual(ids(checkF3(data(2), ctx)), ["F3:peak:g1"]);
    assert.deepEqual(ids(checkF3(data(1), ctx)), ["F3:peak:g1"]);
    assert.deepEqual(ids(checkF3(data(4), ctx)), []);
    assert.deepEqual(ids(checkF3(data(10), ctx)), []);
    assert.deepEqual(ids(checkF3(data(8), ctx)), ["F3:peak:g1"]);
    assert.equal(inDeepseekPeak(at(5, 59)), false);
    assert.equal(inDeepseekPeak(at(6)), true);
    assert.equal(inDeepseekPeak(at(9, 59)), true);
});

test("F3: a round after the first starts when the one before it ended", () => {
    const at = (h: number) => Date.UTC(2026, 9, 23, h);
    const data = emptyData({
        goals: [
            {
                session: 5,
                goal: goal({
                    worker: "deepseek/deepseek-flash",
                    setAt: at(4),
                    endedAt: at(8),
                    start: at(4),
                    rounds: [
                        { n: 1, verdict: "continue", reason: "", at: at(7) },
                        { n: 2, verdict: "done", reason: "", at: at(8) },
                    ],
                }),
            },
        ],
    });

    // Round 1 starts at 04:00 (off peak); round 2 starts at 07:00 (peak).
    assert.deepEqual(checkF3(data, ctx).findings[0]!.evidence, [
        "round 2 started 2026-10-23T07:00Z",
    ]);
});

// ---------- G. Schedules ----------

const task = (over: object = {}) => ({
    taskId: 1,
    conversation: 5,
    scheduleId: "abc",
    startedAt: ago(10 * HOUR),
    endedAt: ago(HOUR),
    status: "completed",
    every: false,
    firstNext: ago(HOUR) - 30 * MINUTE,
    ...over,
});

test("G1: a failed run is a finding; completed and aborted are only counted", () => {
    const data = emptyData({
        schedules: [
            task({ status: "failed" }),
            task({ taskId: 2 }),
            task({ taskId: 3, status: "aborted" }),
        ],
    });
    const result = checkG1(data, ctx);

    assert.deepEqual(ids(result), ["G1:failed"]);
    assert.deepEqual(result.metrics.outcomes, { failed: 1, completed: 1, aborted: 1 });
});

test("G1: a one-shot that ran more than 1 h after its due time is late; exactly 1 h is not", () => {
    const late = emptyData({ schedules: [task({ firstNext: ago(HOUR) - HOUR - 1 })] });
    const edge = emptyData({ schedules: [task({ firstNext: ago(HOUR) - HOUR })] });
    const recurring = emptyData({ schedules: [task({ firstNext: ago(8 * HOUR), every: true })] });

    assert.deepEqual(ids(checkG1(late, ctx)), ["G1:late"]);
    assert.deepEqual(ids(checkG1(edge, ctx)), []);
    assert.deepEqual(ids(checkG1(recurring, ctx)), []);
});

test("G1: a running schedule that is more than 1 h overdue is late", () => {
    const running = (next: number) =>
        emptyData({ schedules: [task({ status: "running", endedAt: undefined, next })] });

    assert.deepEqual(ids(checkG1(running(NOW - HOUR - 1), ctx)), ["G1:late"]);
    assert.deepEqual(ids(checkG1(running(NOW - HOUR), ctx)), []);
});

// ---------- H. GitHub ----------

const github = (prs: Record<string, object>, autoDelete: Record<string, boolean | null> = {}) => ({
    botPrs: Object.keys(prs),
    prs,
    checkRuns: {},
    autoDelete,
});
const merged = (minutesAgo: number, headRef: object | null = { name: "b" }) =>
    pr({ state: "MERGED", mergedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(), headRef });

test("H1: a merged bot PR with its branch 1 h after the merge is a finding; before 1 h, or a deleted branch, is not", () => {
    const left = emptyData({
        github: github({ "acme/widgets#1": merged(61) }, { "acme/widgets": false }),
    });

    assert.deepEqual(ids(checkH1(left, ctx)), ["H1"]);
    assert.equal(checkH1(left, ctx).findings[0]!.severity, "low");
    assert.deepEqual(checkH1(left, ctx).metrics.autoDeleteOff, ["acme/widgets"]);
    assert.deepEqual(
        ids(checkH1(emptyData({ github: github({ "acme/widgets#1": merged(60) }) }), ctx)),
        [],
    );
    assert.deepEqual(
        ids(checkH1(emptyData({ github: github({ "acme/widgets#1": merged(120, null) }) }), ctx)),
        [],
    );
});

test("H1: 5 branches are medium; 4 are low", () => {
    const many = (count: number) =>
        emptyData({
            github: github(
                Object.fromEntries(
                    Array.from({ length: count }, (_, i) => [`acme/widgets#${i + 1}`, merged(120)]),
                ),
            ),
        });

    assert.equal(checkH1(many(5), ctx).findings[0]!.severity, "medium");
    assert.equal(checkH1(many(4), ctx).findings[0]!.severity, "low");
});

test("H2: a bot PR on no desk thread is a finding; one on a thread is not", () => {
    const data = (attached: boolean) =>
        emptyData({
            threads: threadMap(
                thread("T1", { prs: attached ? { "acme/widgets#1": { via: "seen" } } : {} }),
            ),
            github: github({ "acme/widgets#1": pr() }),
        });

    assert.deepEqual(ids(checkH2(data(false))), ["H2"]);
    assert.deepEqual(ids(checkH2(data(true))), []);
});

const rollupPr = (state: string) =>
    pr({
        commits: { totalCount: 1, nodes: [{ commit: { oid: "a", statusCheckRollup: { state } } }] },
    });
const batch = (red: number, total: number) =>
    emptyData({
        github: github(
            Object.fromEntries(
                Array.from({ length: total }, (_, i) => [
                    `acme/widgets#${i + 1}`,
                    rollupPr(i < red ? "FAILURE" : "SUCCESS"),
                ]),
            ),
        ),
    });

test("H3: more than 20% of bot PRs with a failing commit is a finding; exactly 20% is not", () => {
    assert.deepEqual(ids(checkH3(batch(2, 9), ctx)), ["H3:ci"]);
    assert.deepEqual(ids(checkH3(batch(2, 10), ctx)), []);
    assert.deepEqual(ids(checkH3(batch(1, 5), ctx)), []);
    assert.equal(checkH3(batch(2, 9), ctx).metrics.withAFailingCommit, 2);
});

test("H3: an error rollup counts; fewer than 5 PRs are too few to judge", () => {
    const err = emptyData({
        github: github(
            Object.fromEntries(
                [1, 2, 3, 4, 5].map((n) => [
                    `acme/widgets#${n}`,
                    rollupPr(n < 3 ? "ERROR" : "SUCCESS"),
                ]),
            ),
        ),
    });

    assert.deepEqual(ids(checkH3(err, ctx)), ["H3:ci"]);
    assert.deepEqual(ids(checkH3(batch(2, 4), ctx)), []);
});

test("H3: failing bot PRs split into red then fixed, red at merge, and other", () => {
    const data = emptyData({
        github: github({
            "acme/widgets#1": pr({
                state: "MERGED",
                headRefOid: "success",
                commits: {
                    totalCount: 2,
                    nodes: [
                        { commit: { oid: "failure", statusCheckRollup: { state: "FAILURE" } } },
                        { commit: { oid: "success", statusCheckRollup: { state: "SUCCESS" } } },
                    ],
                },
            }),
            "acme/widgets#2": pr({
                state: "MERGED",
                headRefOid: "red-head",
                commits: {
                    totalCount: 1,
                    nodes: [
                        { commit: { oid: "red-head", statusCheckRollup: { state: "FAILURE" } } },
                    ],
                },
            }),
            "acme/widgets#3": rollupPr("ERROR"),
            "acme/widgets#4": pr({
                state: "MERGED",
                headRefOid: "green",
                commits: {
                    totalCount: 1,
                    nodes: [{ commit: { oid: "green", statusCheckRollup: { state: "SUCCESS" } } }],
                },
            }),
        }),
    });

    const metrics = checkH3(data, ctx).metrics;

    assert.equal(metrics.redThenFixed, 1);
    assert.equal(metrics.redAtMerge, 1);
    assert.equal(metrics.redOther, 1);
    assert.equal(metrics.withAFailingCommit, 3);
    assert.deepEqual(metrics.redAtMergePrs, ["acme/widgets#2"]);
});

test("H3: a headRefOid that matches no commit is head unknown and counts as other", () => {
    const data = emptyData({
        github: github({
            "acme/widgets#1": pr({
                state: "MERGED",
                headRefOid: "missing",
                commits: {
                    totalCount: 1,
                    nodes: [{ commit: { oid: "red", statusCheckRollup: { state: "FAILURE" } } }],
                },
            }),
        }),
    });

    const metrics = checkH3(data, ctx).metrics;

    assert.equal(metrics.redThenFixed, 0);
    assert.equal(metrics.redAtMerge, 0);
    assert.equal(metrics.redOther, 1);
    assert.equal(metrics.withAFailingCommit, 1);
    assert.deepEqual(metrics.redAtMergePrs, []);
});

test("H3: an open bot PR with no update for 48 h is idle; 47 h is not", () => {
    const idle = (hours: number) =>
        emptyData({
            github: github({
                "acme/widgets#1": pr({ updatedAt: new Date(NOW - hours * HOUR).toISOString() }),
            }),
        });

    assert.deepEqual(ids(checkH3(idle(48), ctx)), ["H3:idle"]);
    assert.deepEqual(ids(checkH3(idle(47), ctx)), []);
    assert.deepEqual(
        ids(checkH3(emptyData({ github: github({ "acme/widgets#1": merged(60 * 100) }) }), ctx)),
        [],
    );
});

// ---------- I. Odrade's notes ----------

test("I1: the text says how many of all the reports are missing, with the audit's own folders left out", () => {
    const reports = [
        ...Array.from({ length: 42 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}-x`),
        "2026-10-23-daily-audit",
        "2026-10-24-daily-audit",
    ];
    const data = emptyData({
        odrade: {
            readme: reports
                .slice(0, 36)
                .map((name) => `reports/${name}`)
                .join("\n"),
            reports,
            dirty: [],
            lastCommitAt: NOW,
        },
    });
    const result = checkI1(data);

    assert.equal(result.findings[0]!.text, "6 of 42 reports are not in Odrade's README index");
    assert.equal(result.findings[0]!.cases, 6);
    assert.deepEqual(result.metrics, { reports: 42, notInIndex: 6 });
});

test("I1: a report folder that the index does not link is a finding; the audit's own folder is not", () => {
    const data = emptyData({
        odrade: {
            readme: "- [a](reports/2026-10-22-a/README.md)",
            reports: ["2026-10-22-a", "2026-10-22-b", "2026-10-23-daily-audit"],
            dirty: [],
            lastCommitAt: NOW,
        },
    });
    const result = checkI1(data);

    assert.deepEqual(ids(result), ["I1"]);
    assert.deepEqual(result.findings[0]!.evidence, ["reports/2026-10-22-b"]);
    assert.equal(result.metrics.reports, 2);
    // The text holds the total: all report entries, without the audit's own folder.
    assert.equal(result.findings[0]!.text, "1 of 2 reports is not in Odrade's README index");

    const clean = emptyData({
        odrade: {
            readme: "reports/2026-10-22-a",
            reports: ["2026-10-22-a", "2026-10-24-daily-audit"],
            dirty: [],
            lastCommitAt: NOW,
        },
    });

    assert.deepEqual(ids(checkI1(clean)), []);
});

test("I2: uncommitted files and a last commit older than 13 h is a finding; exactly 13 h is not", () => {
    const data = (age: number, dirty: string[]) =>
        emptyData({ odrade: { readme: "", reports: [], dirty, lastCommitAt: NOW - age } });

    assert.deepEqual(ids(checkI2(data(13 * HOUR + 1, [" M plans/x.md"]), ctx)), ["I2"]);
    assert.deepEqual(ids(checkI2(data(13 * HOUR, [" M plans/x.md"]), ctx)), []);
    assert.deepEqual(ids(checkI2(data(20 * HOUR, []), ctx)), []);
});

test("I2: the audit's own folder is not an uncommitted file", () => {
    const own = emptyData({
        odrade: {
            readme: "",
            reports: [],
            dirty: ["?? reports/2026-10-23-daily-audit/"],
            lastCommitAt: NOW - 20 * HOUR,
        },
    });

    assert.deepEqual(ids(checkI2(own, ctx)), []);
    assert.equal(checkI2(own, ctx).metrics.uncommitted, 0);
});

// ---------- I. The agents' homes ----------

/** 1 home as `readHomes` builds it. */
const home = (id: string, dirty: string[], age: number | null = 30 * HOUR) => ({
    id,
    folder: `/home/b/agents/${id}`,
    dirty,
    lastCommitAt: age === null ? null : NOW - age,
});

test("I3: 1 low finding for each home dirty for more than 24 h; a recent commit, or a clean home, is none", () => {
    const data = emptyData({
        homes: [
            home("irulan", [" M notes/x.md", "?? plans/y.md"], 30 * HOUR),
            home("moneo", [" M notes/x.md"], 25 * HOUR),
            home("teg", [" M notes/x.md"], 24 * HOUR),
            home("lucilla", [], 3 * DAY),
            home("duncan", ["?? notes/new.md"], HOUR),
        ],
    });
    const result = checkI3(data, ctx);

    assert.deepEqual(ids(result), ["I3:irulan", "I3:moneo"]);
    assert.deepEqual(
        result.findings.map((finding) => finding.severity),
        ["low", "low"],
    );
    assert.equal(
        result.findings[0]!.text,
        "2 uncommitted files in irulan's home, and the last commit is 30 h old",
    );
    assert.equal(result.findings[0]!.cases, 2);
    assert.deepEqual(result.findings[0]!.evidence, [" M notes/x.md", "?? plans/y.md"]);
    // The metrics count every home, and the homes that are dirty.
    assert.deepEqual(result.metrics, { homes: 5, dirty: 4 });
});

test("I3: a home with no commit at all is a finding when it is dirty, and no homes give no finding", () => {
    const none = checkI3(emptyData({ homes: [home("irulan", [" M notes/x.md"], null)] }), ctx);

    assert.deepEqual(ids(none), ["I3:irulan"]);
    assert.match(none.findings[0]!.text, /the last commit is unknown/);
    assert.deepEqual(ids(checkI3(emptyData(), ctx)), []);
    assert.deepEqual(checkI3(emptyData(), ctx).metrics, { homes: 0, dirty: 0 });
});

// ---------- J. Spend ----------

/** Cost rows of 1 session: `daily` dollars on each of the 7 days before the window, and `today` in it. */
const spend = (daily: number[], today: number, agent = "odrade") =>
    emptyData({
        agentOf: { 10: agent },
        threads: threadMap(thread("T1", { session: 10 })),
        costRows: [
            { c: 10, at: ago(HOUR), cost: today },
            ...daily.map((cost, i) => ({ c: 10, at: ctx.since - i * DAY - HOUR, cost })),
        ],
    });

test("J1: a day 50% above the 7-day median is a finding; exactly 50% is not", () => {
    const base = [100, 100, 100, 100, 100, 100, 100];

    assert.deepEqual(ids(checkJ1(spend(base, 151), ctx)), ["J1:spike"]);
    assert.deepEqual(ids(checkJ1(spend(base, 150), ctx)), []);
    assert.equal(checkJ1(spend(base, 150), ctx).metrics.median7, 100);
});

test("money in the texts has 2 decimals", () => {
    assert.match(
        checkJ1(spend([100, 100, 100], 400), ctx).findings[0]!.text,
        /Spend of \$400\.00 a day is 400% of the 7-day median \(\$100\.00\)/,
    );
});

test("J1: spend is split per agent and per thread", () => {
    const result = checkJ1(spend([100, 100, 100], 120), ctx);

    assert.deepEqual(result.metrics.perAgent, { odrade: 120 });
    assert.deepEqual(result.metrics.topThreads, { T1: 120 });
    assert.equal(result.metrics.total, 120);
});

test("J1: with fewer than 3 days of earlier spend there is no baseline and no spike", () => {
    const result = checkJ1(spend([10, 10], 1000), ctx);

    assert.equal(result.metrics.median7, null);
    assert.deepEqual(ids(result), []);
});

test("J1: waste above $5 (empty reopens and queue continues) is a finding; $5 is not", () => {
    const reopen = (cost: number) =>
        emptyData({
            threads: threadMap(thread("T1", { session: 101 })),
            costRows: [{ c: 101, at: ago(5 * HOUR) + MINUTE, cost }],
            events: [
                event("T1", ago(5 * HOUR), "reopened:1", "reopened: x"),
                event("T1", ago(5 * HOUR) + 5 * MINUTE, "closed:1", "closed: all parts closed"),
            ],
        });

    assert.deepEqual(ids(checkJ1(reopen(5.01), ctx)), ["J1:waste"]);
    assert.deepEqual(ids(checkJ1(reopen(5), ctx)), []);
});

// ---------- R. Model routing (shadow) ----------

/** A thread that carries the model router's shadow record. */
const zeroNamed = { count: 0, open: 0, success: 0, notSuccess: 0, suggestionRan: 0 };

const routed = (id: string, route = {}, over = {}) =>
    thread(id, {
        route: {
            mode: "shadow",
            status: "shadow",
            kind: "implement",
            kindConfidence: 0.82,
            complexity: 1.8,
            capability: 1.9,
            deepReasoning: 0.4,
            demand: 1.9,
            tier: "high",
            model: "github-copilot/claude-sonnet-5.5",
            thinking: "medium",
            reason: "shadow: recorded only",
            at: NOW - 2 * DAY,
            line: "Route: implement (kind 0.82), complexity 1.8/3, demand 1.9",
            ...route,
        },
        ...over,
    });

/** A closed thread, as the desk stores it. */
const closed = (why: string, outcome?: string) => ({
    state: "closed",
    closed: { at: NOW - HOUR, why, by: "sweep", ...(outcome === undefined ? {} : { outcome }) },
});

/** A `subagent` spawn call of a session, as the audit's source gives it. */
const spawn = (over = {}) => ({
    id: "entry-1",
    c: 101,
    at: NOW - HOUR,
    model: "deepseek/deepseek-flash",
    name: "Worker",
    tools: ["read", "bash", "edit"],
    review: false,
    brief: "Fix the failing test",
    ...over,
});

test("R1: threads group by kind, tier, model, status and the model used, and the sort is by count", () => {
    const data = emptyData({
        threads: threadMap(
            routed("T1", {}, closed("done", "completed")),
            routed("T2", {}, closed("done", "verified")),
            routed("T3", { kind: "plan", model: "github-copilot/claude-opus-5.5" }),
        ),
    });
    const result = checkR1(data, ctx);

    assert.deepEqual(result.findings, [], "no finding: it is a table");
    assert.equal(result.metrics.routes, 3);
    assert.deepEqual(
        result.metrics.cells.map((cell) => [cell.kind, cell.tier, cell.model, cell.count]),
        [
            ["implement", "high", "github-copilot/claude-sonnet-5.5", 2],
            ["plan", "high", "github-copilot/claude-opus-5.5", 1],
        ],
        "the bigger cell first",
    );

    const implement = result.metrics.cells[0]!;

    assert.equal(implement.open, 0);
    assert.equal(implement.success, 2, "done + completed, and done + verified");
    assert.equal(implement.notSuccess, 0);
    assert.equal(result.metrics.cells[1]!.open, 1, "a thread that is not closed is open");

    const mark = (outcome: string) =>
        checkR1(
            emptyData({
                threads: threadMap(
                    routed("T1", {}, closed("done", outcome)),
                    routed("T2", {}, closed("dropped")),
                    routed("T3", {}, closed("failed")),
                    routed("T4", {}, closed("done", "verified")),
                ),
            }),
            ctx,
        ).metrics.cells[0]!;

    assert.equal(mark("completed").success, 2);
    assert.equal(mark("completed").notSuccess, 2, "dropped and failed");
    assert.equal(mark("abandoned").success, 1, "T4's verified watch is the only success");
    assert.equal(mark("abandoned").notSuccess, 3, "done + abandoned, dropped, and failed");

    // `done` with no outcome counts as a success too.
    const plain = checkR1(emptyData({ threads: threadMap(routed("T1", {}, closed("done"))) }), ctx)
        .metrics.cells[0]!;

    assert.equal(plain.success, 1);
    assert.equal(plain.notSuccess, 0);
});

test("R1: a success rate needs 10 threads in the cell", () => {
    const cell = (count: number, wins: number) =>
        checkR1(
            emptyData({
                threads: threadMap(
                    ...Array.from({ length: count }, (_, index) =>
                        routed(
                            `T${index + 1}`,
                            {},
                            closed(
                                index < wins ? "done" : "dropped",
                                index < wins ? "completed" : undefined,
                            ),
                        ),
                    ),
                ),
            }),
            ctx,
        ).metrics.cells[0]!;

    assert.equal(cell(9, 9).successRate, null, "9 threads give no rate");
    assert.equal(cell(9, 9).success, 9);

    const ten = cell(10, 7);

    assert.equal(ten.count, 10);
    assert.equal(ten.success, 7);
    assert.equal(ten.successRate, 0.7);
});

test("R1: a route with a brief hash counts only on a night shift; an older route counts as before", () => {
    const hash = "a".repeat(64);
    const data = emptyData({
        threads: threadMap(
            // A night shift's new route: its session has a goal.
            routed("T1", { briefHash: hash }),
            // A delegation that is no night shift: a new route, and no goal.
            routed("T2", { briefHash: hash, kind: "plan" }),
            // An older route (no hash): always a night shift's, counted with or without its goal.
            routed("T3", { kind: "debug" }),
        ),
        goals: [{ session: 101, goal: { status: "ended", reason: "done", round: 1 } }],
    });
    const result = checkR1(data, ctx);

    assert.equal(result.metrics.routes, 2);
    assert.deepEqual(result.metrics.cells.map((cell) => cell.kind).sort(), ["debug", "implement"]);
});

test("R1: the model used is the goal's worker, else the most common spawn model", () => {
    const data = emptyData({
        threads: threadMap(
            routed("T1"),
            routed("T2", { kind: "debug" }),
            routed("T3", { kind: "plan" }),
        ),
        goals: [
            {
                session: 101,
                goal: { status: "ended", reason: "done", worker: "acme/named", round: 1 },
            },
        ],
        routeSpawns: [
            spawn({ c: 102, model: "acme/ran" }),
            spawn({ c: 102, model: "acme/ran" }),
            spawn({ c: 102, model: "acme/other" }),
            // A cross-review reviewer runs on another model family by design: it is not the worker.
            spawn({
                c: 102,
                model: "acme/reviewer",
                tools: ["read", "bash"],
                name: "cross-review",
            }),
        ],
    });
    const used = (kind: string) =>
        checkR1(data, ctx).metrics.cells.find((cell) => cell.kind === kind)!.used;

    assert.equal(used("implement"), "acme/named", "the goal's worker wins");
    assert.equal(used("debug"), "acme/ran", "else the most common spawn model");
    assert.equal(used("plan"), "-", "with nothing to go on");
});

test("R1: the rounds, the cost and the reopenings of a cell", () => {
    const data = emptyData({
        threads: threadMap(
            routed("T1", {}, closed("done", "completed")),
            routed("T2", {}, closed("done", "verified")),
        ),
        goals: [
            { session: 101, goal: { status: "ended", reason: "done", round: 3 } },
            { session: 102, goal: { status: "ended", reason: "blocked", round: 5 } },
        ],
        routeCosts: [
            { c: 101, at: NOW - 3 * HOUR, cost: 1 },
            { c: 101, at: NOW - 2 * HOUR, cost: 1 },
            { c: 102, at: NOW - 2 * HOUR, cost: 4 },
        ],
        events: [
            event("T1", ago(4 * HOUR), "reopened:1", "reopened: its session is busy"),
            event("T1", ago(3 * HOUR), "reopened:2", "reopened: new work in its session"),
            event("T1", ago(2 * HOUR), "bound", "session 101 bound"),
        ],
    });
    const cell = checkR1(data, ctx).metrics.cells[0]!;

    assert.equal(cell.medianRounds, 4, "3 and 5");
    assert.equal(cell.medianCost, 3, "2 and 4");
    assert.equal(cell.reopenings, 2, "the `bound` event is not a reopening");
    assert.deepEqual(cell.goals, { "ended: done": 1, "ended: blocked": 1 });
});

test("R1: a thread with no route is not counted", () => {
    const data = emptyData({
        threads: threadMap(routed("T1"), thread("T2"), thread("T3", { route: undefined })),
    });
    const result = checkR1(data, ctx);

    assert.equal(result.metrics.routes, 1);
    assert.equal(result.metrics.cells.length, 1);
    assert.equal(result.metrics.cells[0]!.count, 1);

    assert.deepEqual(checkR1(emptyData(), ctx).metrics, {
        routes: 0,
        cells: [],
        named: { routes: 0, same: zeroNamed, differs: zeroNamed },
    });
});

test("R1: a cell holds the named worker, `-` when none was named", () => {
    const result = checkR1(
        emptyData({
            threads: threadMap(
                routed("T1"),
                routed("T2", { worker: "acme/named" }),
                routed("T3", { worker: "acme/named" }),
                routed("T4", { worker: "acme/another" }),
            ),
        }),
        ctx,
    );

    assert.deepEqual(
        result.metrics.cells.map((cell) => [cell.named, cell.count]),
        [
            ["acme/named", 2],
            ["-", 1],
            ["acme/another", 1],
        ],
        "the named worker splits a cell, and sorts after the status",
    );
    assert.equal(result.metrics.named.routes, 3, "3 shadow routes with a worker");
});

test("R1: named compares the suggestion with the named worker, and counts how the threads ended", () => {
    const sonnet = "github-copilot/claude-sonnet-5.5";
    const data = emptyData({
        threads: threadMap(
            // The suggestion is the named worker: 1 success that ran it, 1 open that ran another model.
            routed("T1", { worker: sonnet }, closed("done", "completed")),
            routed("T2", { worker: sonnet }),
            // The suggestion differs: 1 success, 1 not success, and 1 open.
            routed("T3", { worker: "acme/named" }, closed("done", "verified")),
            routed("T4", { worker: "acme/named" }, closed("dropped")),
            routed("T5", { worker: "acme/named" }),
            // Not counted: no worker, a failed route, an explicit route.
            routed("T6"),
            routed("T7", { worker: "acme/named", status: "failed", model: undefined }),
            routed("T8", { worker: "acme/named", status: "explicit", model: undefined }),
        ),
        goals: [
            // T1 ran the suggestion; T3 ran the named worker.
            { session: 101, goal: { status: "ended", reason: "done", worker: sonnet } },
            { session: 103, goal: { status: "ended", reason: "done", worker: "acme/named" } },
        ],
        routeSpawns: [
            // T2 ran the suggestion too, found from its spawns.
            spawn({ c: 102, model: sonnet }),
        ],
    });
    const { named, routes } = checkR1(data, ctx).metrics;

    assert.equal(routes, 8);
    assert.deepEqual(named, {
        routes: 5,
        same: { count: 2, open: 1, success: 1, notSuccess: 0, suggestionRan: 2 },
        differs: { count: 3, open: 1, success: 1, notSuccess: 1, suggestionRan: 0 },
    });
});

// ---------- Findings and the run ----------

test("makeFinding: the id is stable, a secret in the text is dropped, a secret in evidence is dropped", () => {
    const finding = makeFinding({
        check: "A1",
        subject: "T36",
        severity: "high",
        text: "x",
        evidence: ["ok line", "token=abc", "ghp_xxxxxxxx"],
    });

    assert.equal(finding.id, "A1:T36");
    assert.deepEqual(finding.evidence, ["ok line"]);
    assert.equal(makeFinding({ check: "E3", severity: "low", text: "x" }).id, "E3");
    assert.match(
        makeFinding({ check: "A4", severity: "low", text: "the password=hunter2 failed" }).text,
        /dropped/,
    );
});

test("runChecks: every check has an entry, and a missing source skips its checks only", () => {
    const data = emptyData({ sourceErrors: { github: "disabled by --no-github" } });
    const result = runChecks(data, ctx);

    assert.equal(CHECKS.length, 29);
    // P1 reads the desk's plan threads and their planning sessions.
    assert.deepEqual(
        CHECKS.find(([id]) => id === "P1"),
        ["P1", checkP1, ["desk", "planSessions"]],
    );
    // R1 reads the router's records on the desk threads, and the goals beside them.
    assert.deepEqual(
        CHECKS.find(([id]) => id === "R1"),
        ["R1", checkR1, ["desk", "goals", "routes"]],
    );
    // I3 sits beside I2 and reads the homes source.
    assert.deepEqual(
        CHECKS.find(([id]) => id === "I3"),
        ["I3", checkI3, ["homes"]],
    );
    assert.deepEqual(Object.keys(result.skipped).sort(), [
        "B1",
        "D1",
        "D1b",
        "D2",
        "H1",
        "H2",
        "H3",
    ]);
    assert.match(result.skipped.B1!, /source unavailable: github: disabled/);
    assert.ok(result.metrics.A1);
    assert.ok(result.metrics.J1);
    assert.deepEqual(result.metrics.R1, {
        routes: 0,
        cells: [],
        named: { routes: 0, same: zeroNamed, differs: zeroNamed },
    });
});

test("runChecks: a check that throws is skipped and the run goes on", () => {
    const data = emptyData({ odrade: undefined });
    const result = runChecks(data, ctx);

    assert.match(result.skipped.I1!, /^check failed:/);
    assert.match(result.skipped.I2!, /^check failed:/);
    assert.ok(result.metrics.A1);
});

test("runChecks: a failed entries source skips E3, so it cannot make false twins", () => {
    const data = emptyData({ sourceErrors: { entries: "no such table" } });
    const result = runChecks(data, ctx);

    assert.match(result.skipped.E3!, /source unavailable: entries: no such table/);
    assert.equal(result.metrics.E3, undefined);
});

test("runChecks: a database that cannot be read skips the checks that need it", () => {
    const data = emptyData({
        sourceErrors: { desk: "no such table", entries: "no such table", costs: "no such table" },
    });
    const result = runChecks(data, ctx);

    assert.match(result.skipped.A4!, /source unavailable: entries: no such table/);
    assert.ok(!("I1" in result.skipped));
});

// ---------- Q. Quality metrics ----------

const Q1_DATE = "2026-10-23";

/** The date `n` days before the run's date. */
const daysBefore = (n: number) =>
    new Date(Date.parse(`${Q1_DATE}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

type Q1Pr = {
    ref: string;
    state: "merged" | "closed";
    at: string;
    agent: string;
    author: string;
    title: string;
    reverts?: string[];
    revertsTitle?: string;
};

/** 1 PR of a Q1 day record. */
const q1Pr = (n: number, over: Partial<Q1Pr> = {}): Q1Pr => ({
    ref: `acme/widgets#${n}`,
    state: "merged",
    at: new Date(NOW - 2 * DAY + n * HOUR).toISOString(),
    agent: "irulan",
    author: "frostyard-machines",
    title: `Change ${n}`,
    ...over,
});

const q1Record = (prs: Q1Pr[], complete = true) => ({
    from: "2026-10-01T00:00:00.000Z",
    until: "2026-10-02T00:00:00.000Z",
    complete,
    ...(complete ? {} : { reason: "a search returned no data" }),
    calls: 1,
    // An incomplete record may hold PRs: they are never summed.
    prs,
});

/**
 * Earlier days as `loadEarlier` gives them: day `i` (1 to `count`) is `i` days before the run, oldest first. `prsOf`
 * gives a day's PRs.
 */
const earlierDays = (count: number, prsOf: (i: number) => Q1Pr[] = () => []) =>
    Array.from({ length: count }, (_, index) => count - index).map((i) => ({
        date: daysBefore(i),
        json: { findings: [], metrics: { Q1: { day: q1Record(prsOf(i)) } } },
    }));

/** Today's source: complete, with no PR. */
const todayEmpty = { from: "x", until: "y", complete: true, calls: 1, nodes: [] };

/** Spread PRs over the earlier days: PR `k` goes to day `k`. */
const spread = (prs: Q1Pr[]) => (i: number) => prs.filter((_, k) => k + 1 === i);

/** Case (b): 6 merged originals, 3 merged reverts (body, title, both), 1 closed unmerged. */
const caseB = () => [
    ...[1, 2, 3, 4, 5, 6].map((n) => q1Pr(n)),
    q1Pr(7, { title: "Undo the first change", reverts: ["acme/widgets#1"] }),
    q1Pr(8, { title: 'Revert "Change 2"', revertsTitle: "Change 2" }),
    q1Pr(9, {
        title: 'Revert "Change 3"',
        revertsTitle: "Change 3",
        reverts: ["acme/widgets#3"],
    }),
    q1Pr(10, { state: "closed" }),
];

const q1Ctx = (earlier: object[]) => ({ ...ctx, date: Q1_DATE, earlier });

test("Q1 (a): 10 decided, 1 reverted, 1 closed unmerged over 26 days: acceptance 0.8, no finding", () => {
    const prs = [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => q1Pr(n)),
        q1Pr(9, { title: "Undo change 3", reverts: ["acme/widgets#3"] }),
    ];
    // The closed PR is today's, from the search, on a desk thread of irulan's.
    const data = emptyData({
        threads: threadMap(thread("T5", { prs: { "acme/widgets#10": { via: "seen" } } })),
        decided: {
            ...todayEmpty,
            nodes: [
                {
                    number: 10,
                    url: "https://github.com/acme/widgets/pull/10",
                    title: "Change 10",
                    body: "Some body",
                    mergedAt: null,
                    closedAt: new Date(NOW - HOUR).toISOString(),
                    author: { login: "frostyard-machines" },
                    repository: { nameWithOwner: "acme/widgets" },
                },
            ],
        },
    });
    const result = checkQ1(data, q1Ctx(earlierDays(25, spread(prs))));

    assert.deepEqual(result.findings, []);
    assert.equal(result.metrics.window.covered, 26);
    assert.deepEqual(result.metrics.window, {
        from: "2026-09-24",
        to: Q1_DATE,
        days: 30,
        covered: 26,
    });
    assert.deepEqual(result.metrics.thresholds, { minDecided: 8, minCovered: 25, below: 0.75 });
    const row = { merged: 9, closedUnmerged: 1, reverted: 1, decided: 10, acceptance: 0.8 };

    assert.deepEqual(result.metrics.totals, row);
    assert.deepEqual(result.metrics.repos, { "acme/widgets": row });
    assert.deepEqual(result.metrics.agents, { irulan: row });
    assert.equal(result.metrics.day.prs.length, 1);
    assert.equal(result.metrics.day.prs[0].agent, "irulan");
});

test("Q1 (b): 6 originals, 3 reverts by body, title and both, 1 closed over 26 days: 0.6, a finding for the repo and the agent", () => {
    // 10 closed PRs of another repository with no desk thread: `unattributed` makes no finding, its repository does.
    const other = Array.from({ length: 10 }, (_, i) =>
        q1Pr(i + 1, { ref: `acme/other#${i + 1}`, state: "closed", agent: "unattributed" }),
    );
    const prs = [...caseB(), ...other];
    const data = emptyData({ decided: todayEmpty });
    const result = checkQ1(data, q1Ctx(earlierDays(25, spread(prs))));

    assert.deepEqual(ids(result).sort(), [
        "Q1:agent:irulan",
        "Q1:repo:acme/other",
        "Q1:repo:acme/widgets",
    ]);

    const repo = result.findings.find((f) => f.id === "Q1:repo:acme/widgets")!;
    const agent = result.findings.find((f) => f.id === "Q1:agent:irulan")!;

    assert.equal(repo.severity, "medium");
    assert.equal(
        repo.text,
        "Decided acceptance of acme/widgets is 0.6 over 30 days: merged 9, closed unmerged 1, reverted 3 (26 of 30 days covered)",
    );
    assert.equal(repo.cases, 4);
    assert.deepEqual(
        repo.evidence.map((line) => line.split(" ")[0]),
        [1, 10, 2, 3].map((n) => `https://github.com/acme/widgets/pull/${n}`),
    );
    // The newest case: the closed PR #10.
    assert.equal(
        repo.lastSeen,
        new Date(NOW - 2 * DAY + 10 * HOUR).toISOString().slice(0, 16) + "Z",
    );
    assert.equal(agent.severity, "medium");
    assert.equal(agent.cases, 4);
    assert.match(agent.text, /^Decided acceptance of agent irulan is 0\.6 over 30 days/);
    assert.deepEqual(result.metrics.repos["acme/widgets"], {
        merged: 9,
        closedUnmerged: 1,
        reverted: 3,
        decided: 10,
        acceptance: 0.6,
    });
    assert.deepEqual(result.metrics.agents.unattributed, {
        merged: 0,
        closedUnmerged: 10,
        reverted: 0,
        decided: 10,
        acceptance: 0,
    });
    assert.deepEqual(result.metrics.totals, {
        merged: 9,
        closedUnmerged: 11,
        reverted: 3,
        decided: 20,
        acceptance: 0.3,
    });
});

test("Q1 (c): case (b) with 24 covered days makes no finding", () => {
    const result = checkQ1(
        emptyData({ decided: todayEmpty }),
        q1Ctx(earlierDays(23, spread(caseB()))),
    );

    assert.equal(result.metrics.window.covered, 24);
    assert.equal(result.metrics.totals.acceptance, 0.6);
    assert.deepEqual(result.findings, []);
});

test("Q1 (d): 7 decided PRs below 0.75 over 30 days make no finding", () => {
    const prs = [
        ...[1, 2, 3, 4].map((n) => q1Pr(n)),
        ...[5, 6, 7].map((n) => q1Pr(n, { state: "closed" })),
    ];
    const result = checkQ1(emptyData({ decided: todayEmpty }), q1Ctx(earlierDays(29, spread(prs))));

    assert.equal(result.metrics.window.covered, 30);
    assert.equal(result.metrics.totals.decided, 7);
    assert.equal(result.metrics.totals.acceptance, 0.57);
    assert.deepEqual(result.findings, []);
});

test("Q1 (e): days older than 29 days and incomplete days are not summed or covered; a ref in 2 days counts once", () => {
    const earlier = [
        // 30 days before: outside the window.
        {
            date: daysBefore(30),
            json: { findings: [], metrics: { Q1: { day: q1Record([q1Pr(1)]) } } },
        },
        // 29 days before: the first day of the window.
        {
            date: daysBefore(29),
            json: { findings: [], metrics: { Q1: { day: q1Record([q1Pr(2)]) } } },
        },
        // Incomplete: not summed, not covered.
        {
            date: daysBefore(10),
            json: { findings: [], metrics: { Q1: { day: q1Record([q1Pr(3)], false) } } },
        },
        // A day with no Q1 record at all (the run before Q1 existed).
        { date: daysBefore(8), json: { findings: [] } },
        // #4 is in 2 days: closed, then merged; the newest record wins.
        {
            date: daysBefore(6),
            json: {
                findings: [],
                metrics: { Q1: { day: q1Record([q1Pr(4, { state: "closed" })]) } },
            },
        },
        {
            date: daysBefore(5),
            json: { findings: [], metrics: { Q1: { day: q1Record([q1Pr(4)]) } } },
        },
    ];
    const result = checkQ1(emptyData({ decided: todayEmpty }), q1Ctx(earlier));

    // Today, 29 days before, 6 and 5 days before.
    assert.equal(result.metrics.window.covered, 4);
    assert.deepEqual(result.metrics.totals, {
        merged: 2,
        closedUnmerged: 0,
        reverted: 0,
        decided: 2,
        acceptance: 1,
    });
});

test("Q1 (f): a source error gives an incomplete day with no PRs, and the earlier days still sum", () => {
    const data = emptyData({ sourceErrors: { decided: "disabled by --no-github" } });
    const result = checkQ1(
        data,
        q1Ctx(earlierDays(3, () => [q1Pr(1), q1Pr(2, { state: "closed" })])),
    );

    assert.deepEqual(result.metrics.day, {
        from: null,
        until: null,
        complete: false,
        reason: "disabled by --no-github",
        calls: 0,
        prs: [],
    });
    assert.equal(result.metrics.window.covered, 3);
    assert.deepEqual(result.metrics.totals, {
        merged: 1,
        closedUnmerged: 1,
        reverted: 0,
        decided: 2,
        acceptance: 0.5,
    });

    // An incomplete source keeps no PRs either, and does not count today.
    const partial = checkQ1(
        emptyData({
            decided: {
                ...todayEmpty,
                complete: false,
                reason: "more than 1000 results",
                nodes: [{}],
            },
        }),
        q1Ctx([]),
    );

    assert.equal(partial.metrics.day.complete, false);
    assert.equal(partial.metrics.day.reason, "more than 1000 results");
    assert.deepEqual(partial.metrics.day.prs, []);
    assert.equal(partial.metrics.window.covered, 0);
    assert.equal(partial.metrics.totals.acceptance, null);
});

test("Q1: the day record keeps no body, reads the revert fields of merged PRs only, and attributes by desk thread", () => {
    const node = (number: number, over: object = {}) => ({
        number,
        url: `https://github.com/acme/widgets/pull/${number}`,
        title: `Change ${number}`,
        body: "",
        mergedAt: "2026-10-23T12:00:00Z",
        closedAt: "2026-10-23T12:00:00Z",
        author: { login: "brian" },
        repository: { nameWithOwner: "acme/widgets" },
        ...over,
    });
    const data = emptyData({
        threads: threadMap(
            thread("T10", { agents: ["teg"], prs: { "acme/widgets#1": {} } }),
            thread("T2", { agents: [], prs: { "acme/widgets#1": {} } }),
            thread("T3", { agents: ["lucilla"], prs: { "acme/widgets#1": {} } }),
        ),
        decided: {
            ...todayEmpty,
            nodes: [
                node(1, { body: "Reverts acme/widgets#7\n\nReverts acme/gadgets#2 and a secret" }),
                node(2, { title: 'Revert "Revert "Change 7""' }),
                node(3, {
                    mergedAt: null,
                    title: 'Revert "Change 8"',
                    body: "Reverts acme/widgets#8",
                }),
                // The same ref twice in one search (the 1-hour overlap): 1 PR.
                node(3, {
                    mergedAt: null,
                    title: 'Revert "Change 8"',
                    body: "Reverts acme/widgets#8",
                }),
            ],
        },
    });
    const day = checkQ1(data, q1Ctx([])).metrics.day;

    assert.equal(day.complete, true);
    assert.deepEqual(day.prs, [
        {
            ref: "acme/widgets#1",
            state: "merged",
            at: "2026-10-23T12:00:00Z",
            // T2 has no agent; T3 comes before T10.
            agent: "lucilla",
            author: "brian",
            title: "Change 1",
            reverts: ["acme/widgets#7", "acme/gadgets#2"],
        },
        {
            ref: "acme/widgets#2",
            state: "merged",
            at: "2026-10-23T12:00:00Z",
            agent: "unattributed",
            author: "brian",
            title: 'Revert "Revert "Change 7""',
            revertsTitle: 'Revert "Change 7"',
        },
        {
            ref: "acme/widgets#3",
            state: "closed",
            at: "2026-10-23T12:00:00Z",
            agent: "unattributed",
            author: "brian",
            title: 'Revert "Change 8"',
        },
    ]);
    assert.ok(!JSON.stringify(day).includes("secret"));
});

test("Q1: runChecks runs it after the other checks but R2, with the date and the earlier days of its ctx", () => {
    // R2 reads Q1's result, so it comes after Q1.
    assert.deepEqual(CHECKS.at(-2), ["Q1", checkQ1, ["desk"]]);
    assert.deepEqual(CHECKS.at(-1), ["R2", checkR2, ["desk", "routes"]]);

    const result = runChecks(
        emptyData({ decided: todayEmpty }),
        q1Ctx(earlierDays(2, () => [q1Pr(1)])),
    );

    assert.equal(result.metrics.Q1.window.covered, 3);
    assert.equal(result.metrics.Q1.totals.merged, 1);
    assert.equal(result.skipped.Q1, undefined);
});

// ---------- Q1: review rounds, 3-failure stops and CI reruns ----------

let reviewCallId = 0;

type ReviewCall = {
    id: number;
    c: number;
    at: number;
    action: string;
    name: string;
    model?: string | null;
    tools?: string[] | null;
    review?: boolean;
    brief?: string;
};

/** A cross-review spawn: the tools `read` and `bash`, and "review" in the brief. */
const reviewerSpawn = (c: number, at: number, name = "reviewer"): ReviewCall => ({
    id: (reviewCallId += 1),
    c,
    at,
    action: "spawn",
    name,
    model: "other/model",
    tools: ["read", "bash"],
    review: true,
    brief: "Review the change set",
});

/** A coder spawn: not a cross-review. */
const coderSpawn = (c: number, at: number, name = "coder"): ReviewCall => ({
    id: (reviewCallId += 1),
    c,
    at,
    action: "spawn",
    name,
    model: "deepseek/deepseek-flash",
    tools: ["read", "bash", "edit", "write"],
    review: false,
    brief: "Write the code",
});

const sendTo = (c: number, at: number, name: string): ReviewCall => ({
    id: (reviewCallId += 1),
    c,
    at,
    action: "send",
    name,
});

/** `n` rounds in session `c`, the last one at `at`: 1 reviewer spawn, then `n - 1` sends to it, 1 minute apart. */
const roundsOf = (c: number, n: number, at: number) =>
    Array.from({ length: n }, (_, k) =>
        k === 0
            ? reviewerSpawn(c, at - (n - 1) * MINUTE)
            : sendTo(c, at - (n - 1 - k) * MINUTE, "reviewer"),
    );

/** Desk threads T1 to Tn of acme/widgets and irulan, each with its rounds; `times[i]` is thread i's last round. */
const roundThreads = (rounds: number[], times: number[], over: object = {}) => {
    const threads = rounds.map((_, i) => thread(`T${i + 1}`, over));
    const calls = rounds.flatMap((n, i) => roundsOf(threads[i]!.session, n, times[i]!));

    return { threads: threadMap(...threads), reviewCalls: calls };
};

/** `count` merged PRs of acme/widgets by irulan, 1 a day: Q1's acceptance rows for the gate of 8 decided PRs. */
const decidedDays = (count: number) => q1Ctx(earlierDays(count, (i) => [q1Pr(i)]));

test("Q1 rounds: a reviewer spawn and 2 sends are 3 rounds; coder calls, old calls and calls with no thread do not count", () => {
    const t1 = thread("T1");
    const t2 = thread("T2");
    const reviewCalls = [
        reviewerSpawn(t1.session, ago(2 * DAY)),
        coderSpawn(t1.session, ago(2 * DAY) + MINUTE),
        sendTo(t1.session, ago(2 * DAY) + HOUR, "reviewer"),
        sendTo(t1.session, ago(2 * DAY) + 2 * HOUR, "coder"),
        sendTo(t1.session, ago(2 * DAY) + 3 * HOUR, "reviewer"),
        // A send to a name with no spawn does not count.
        sendTo(t1.session, ago(2 * DAY) + 4 * HOUR, "nobody"),
        // T2: the reviewer spawn is 31 days old; the spawn and the send to it do not count.
        reviewerSpawn(t2.session, ago(31 * DAY)),
        sendTo(t2.session, ago(DAY), "reviewer"),
        // A session with no desk thread.
        reviewerSpawn(999, ago(DAY)),
        sendTo(999, ago(DAY) + MINUTE, "reviewer"),
    ];
    const result = checkQ1(
        emptyData({ decided: todayEmpty, threads: threadMap(t1, t2), reviewCalls }),
        q1Ctx([]),
    );
    const rounds = result.metrics.rounds;

    assert.equal(rounds.available, true);
    assert.deepEqual(rounds.thresholds, Q1_ROUND_THRESHOLDS);
    assert.deepEqual(rounds.threads, [
        {
            id: "T1",
            repo: "acme/widgets",
            agent: "irulan",
            rounds: 3,
            at: new Date(ago(2 * DAY) + 3 * HOUR).toISOString().slice(0, 16) + "Z",
        },
    ]);
    assert.deepEqual(rounds.totals, {
        threads: 1,
        median: 3,
        p90: 3,
        recent: { threads: 1, median: 3 },
        before: { threads: 0, median: null },
    });
    assert.deepEqual(Object.keys(rounds.repos), ["acme/widgets"]);
    assert.deepEqual(Object.keys(rounds.agents), ["irulan"]);
});

test("Q1 rounds: a send goes by the latest spawn of its name; a non-review spawn that reuses the name stops the count", () => {
    const t1 = thread("T1");
    const rounds = (reviewCalls: ReviewCall[]) =>
        checkQ1(
            emptyData({ decided: todayEmpty, threads: threadMap(t1), reviewCalls }),
            q1Ctx([]),
        ).metrics.rounds.threads.map((item: { rounds: number }) => item.rounds);

    // A cross-review spawn (1 round), then a coder spawn with the same name: the send goes to the coder.
    assert.deepEqual(
        rounds([
            reviewerSpawn(t1.session, ago(DAY)),
            coderSpawn(t1.session, ago(DAY) + MINUTE, "reviewer"),
            sendTo(t1.session, ago(DAY) + 2 * MINUTE, "reviewer"),
        ]),
        [1],
    );
    // The reverse order: the latest spawn is the cross-review, so its spawn and the send are 2 rounds.
    assert.deepEqual(
        rounds([
            coderSpawn(t1.session, ago(DAY), "reviewer"),
            reviewerSpawn(t1.session, ago(DAY) + MINUTE),
            sendTo(t1.session, ago(DAY) + 2 * MINUTE, "reviewer"),
        ]),
        [2],
    );
});

test("Q1 rounds: a session with 2 threads gives each call to the thread with the latest start at or before it", () => {
    const old = thread("T1", { session: 500, startedAt: ago(20 * DAY), repo: "acme/old" });
    const now = thread("T2", { session: 500, startedAt: ago(5 * DAY), repo: "acme/new" });
    const reviewCalls = [
        reviewerSpawn(500, ago(10 * DAY)),
        sendTo(500, ago(4 * DAY), "reviewer"),
        sendTo(500, ago(3 * DAY), "reviewer"),
    ];
    const result = checkQ1(
        emptyData({ decided: todayEmpty, threads: threadMap(old, now), reviewCalls }),
        q1Ctx([]),
    );

    assert.deepEqual(
        result.metrics.rounds.threads.map((item: { id: string; rounds: number }) => [
            item.id,
            item.rounds,
        ]),
        [
            ["T1", 1],
            ["T2", 2],
        ],
    );
});

test("Q1 rounds: rounds [1, 2, 3, 4, 10] give median 3 and P90 10; a row with no thread has median null", () => {
    const times = [1, 2, 3, 4, 5].map((n) => ago(n * DAY));
    const result = checkQ1(
        emptyData({ decided: todayEmpty, ...roundThreads([1, 2, 3, 4, 10], times) }),
        q1Ctx([]),
    );
    const row = {
        threads: 5,
        median: 3,
        p90: 10,
        recent: { threads: 5, median: 3 },
        before: { threads: 0, median: null },
    };

    assert.deepEqual(result.metrics.rounds.totals, row);
    assert.deepEqual(result.metrics.rounds.repos, { "acme/widgets": row });
    assert.deepEqual(result.metrics.rounds.agents, { irulan: row });
    // No decided PRs: no finding.
    assert.deepEqual(result.findings, []);
});

test("Q1 rounds finding: a median of 3 or more with 8 decided PRs; none with 7; none for unattributed", () => {
    const times = [1, 2, 3, 4, 5].map((n) => ago(n * DAY));
    const data = (over: object = {}) =>
        emptyData({ decided: todayEmpty, ...roundThreads([1, 2, 3, 4, 10], times, over) });
    const result = checkQ1(data(), decidedDays(8));

    assert.deepEqual(ids(result).sort(), ["Q1:rounds:agent:irulan", "Q1:rounds:repo:acme/widgets"]);

    const repo = result.findings.find((f) => f.id === "Q1:rounds:repo:acme/widgets")!;

    assert.equal(repo.severity, "medium");
    assert.equal(
        repo.text,
        "Review rounds of acme/widgets have a median of 3 and a P90 of 10 over 5 desk threads in 30 days",
    );
    assert.equal(repo.cases, 5);
    assert.deepEqual(repo.evidence, [
        "desk/T1.md 1 rounds",
        "desk/T2.md 2 rounds",
        "desk/T3.md 3 rounds",
        "desk/T4.md 4 rounds",
        "desk/T5.md 10 rounds",
    ]);
    assert.equal(repo.lastSeen, new Date(ago(DAY)).toISOString().slice(0, 16) + "Z");
    assert.match(
        result.findings.find((f) => f.id === "Q1:rounds:agent:irulan")!.text,
        /^Review rounds of agent irulan have a median of 3/,
    );

    // 7 decided PRs: under the gate.
    assert.deepEqual(ids(checkQ1(data(), decidedDays(7))), []);

    // The same rounds with no repository and no agent are unattributed: no finding, though the acceptance rows have
    // 8 decided PRs of `unattributed`.
    const unattributed = checkQ1(
        data({ repo: undefined, agents: [] }),
        q1Ctx(
            earlierDays(8, (i) => [q1Pr(i, { ref: `acme/widgets#${i}`, agent: "unattributed" })]),
        ),
    );

    assert.deepEqual(Object.keys(unattributed.metrics.rounds.repos), ["unattributed"]);
    assert.deepEqual(Object.keys(unattributed.metrics.rounds.agents), ["unattributed"]);
    assert.deepEqual(ids(unattributed), []);
});

test("Q1 rise finding: recent [3, 3] against [1, 2, 2] before gives only the rise findings; a rise of 0.5 gives none", () => {
    const times = [ago(DAY), ago(2 * DAY), ago(10 * DAY), ago(12 * DAY), ago(14 * DAY)];
    const result = checkQ1(
        emptyData({ decided: todayEmpty, ...roundThreads([3, 3, 1, 2, 2], times) }),
        decidedDays(8),
    );

    assert.equal(result.metrics.rounds.totals.median, 2);
    assert.deepEqual(result.metrics.rounds.totals.recent, { threads: 2, median: 3 });
    assert.deepEqual(result.metrics.rounds.totals.before, { threads: 3, median: 2 });
    assert.deepEqual(ids(result).sort(), [
        "Q1:rounds-rise:agent:irulan",
        "Q1:rounds-rise:repo:acme/widgets",
    ]);

    const rise = result.findings.find((f) => f.id === "Q1:rounds-rise:repo:acme/widgets")!;

    assert.equal(rise.severity, "medium");
    assert.equal(
        rise.text,
        "Review rounds of acme/widgets rose: a median of 3 over 2 desk threads in the last 7 days, against 2 over 3 in the 23 days before",
    );
    assert.deepEqual(rise.evidence, ["desk/T1.md 3 rounds", "desk/T2.md 3 rounds"]);
    assert.equal(rise.cases, 2);

    // Recent [2, 3]: a median of 2.5, 0.5 above 2.
    const small = checkQ1(
        emptyData({ decided: todayEmpty, ...roundThreads([2, 3, 1, 2, 2], times) }),
        decidedDays(8),
    );

    assert.equal(small.metrics.rounds.totals.recent.median, 2.5);
    assert.deepEqual(ids(small), []);
});

test("Q1 stops: 2 stops of 1 repository in 7 days are a finding; with 1 older than 7 days, none", () => {
    const t1 = thread("T1");
    const stops = (ages: number[]) =>
        ages.map((age, i) => ({ session: t1.session, id: `g${i + 1}`, at: ago(age) }));
    const result = checkQ1(
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1),
            goalStops: [
                ...stops([DAY, 3 * DAY]),
                // A stop in a session with no thread: unattributed repository, the session's agent.
                { session: 900, id: "g9", at: ago(2 * DAY) },
                { session: 900, id: "g10", at: ago(3 * DAY) },
                // Older than 30 days: not counted.
                { session: t1.session, id: "g0", at: ago(31 * DAY) },
            ],
            agentOf: { 900: "teg" },
        }),
        q1Ctx([]),
    );

    assert.deepEqual(ids(result), ["Q1:stops:repo:acme/widgets"]);

    const finding = result.findings[0]!;

    assert.equal(finding.severity, "medium");
    assert.equal(finding.cases, 2);
    assert.match(finding.text, /^2 night-shift goals of acme\/widgets stopped in the last 7 days/);
    assert.deepEqual(finding.evidence, [
        `${new Date(ago(3 * DAY)).toISOString().slice(0, 16)}Z goal g2 in session ${t1.session} desk/T1.md`,
        `${new Date(ago(DAY)).toISOString().slice(0, 16)}Z goal g1 in session ${t1.session} desk/T1.md`,
    ]);

    const stopsMetrics = result.metrics.stops;

    assert.equal(stopsMetrics.available, true);
    assert.deepEqual(stopsMetrics.thresholds, Q1_STOP_THRESHOLDS);
    assert.deepEqual(stopsMetrics.totals, { stops: 4, last7: 4, withChecks: 0, flaky: 0 });
    assert.deepEqual(stopsMetrics.repos, {
        "acme/widgets": { stops: 2, last7: 2, withChecks: 0, flaky: 0 },
        unattributed: { stops: 2, last7: 2, withChecks: 0, flaky: 0 },
    });
    assert.deepEqual(stopsMetrics.agents, {
        irulan: { stops: 2, last7: 2, withChecks: 0, flaky: 0 },
        teg: { stops: 2, last7: 2, withChecks: 0, flaky: 0 },
    });
    assert.deepEqual(
        stopsMetrics.goals.map((goal: { id: string; thread: string | null }) => [
            goal.id,
            goal.thread,
        ]),
        [
            ["g10", null],
            ["g2", "T1"],
            ["g9", null],
            ["g1", "T1"],
        ],
    );

    const older = checkQ1(
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1),
            goalStops: stops([DAY, 8 * DAY]),
        }),
        q1Ctx([]),
    );

    assert.deepEqual(older.metrics.stops.totals, { stops: 2, last7: 1, withChecks: 0, flaky: 0 });
    assert.deepEqual(ids(older), []);
});

test("Q1 stops: the failing jobs join the flaky keys by repository and job name, or by job id", () => {
    const t1 = thread("T1");
    const t2 = thread("T2", { repo: "Acme/Gears" });
    const flakyKeys = {
        files: ["reports/2026-10-20-flaky-scan/scan.json"],
        repos: ["acme/gears", "acme/other", "acme/widgets"],
        keys: [
            {
                key: "acme/widgets/ci.yml/race/TestRace",
                repo: "acme/widgets",
                workflow: "ci.yml",
                job: "Race Detection",
                test: "TestRace",
                jobIds: [11],
                file: "reports/2026-10-20-flaky-scan/scan.json",
            },
            {
                key: "acme/other/ci.yml/build/TestBuild",
                repo: "acme/other",
                workflow: "ci.yml",
                job: "build",
                test: "TestBuild",
                jobIds: [777],
                file: "reports/2026-10-20-flaky-scan/scan.json",
            },
            {
                key: "acme/gears/ci.yml/lint/TestLint",
                repo: "acme/gears",
                workflow: "ci.yml",
                job: "lint",
                test: "TestLint",
                jobIds: [],
                file: "reports/2026-10-20-flaky-scan/scan.json",
            },
        ],
    };
    const goalStops = [
        // By repository (case-insensitive) and the exact job name.
        {
            session: t1.session,
            id: "g1",
            at: ago(DAY),
            checks: [{ name: "Race Detection", repo: "ACME/Widgets", run: 5, job: 99 }],
            checksFrom: "record",
        },
        // By the job id only: another repository and another name.
        {
            session: t1.session,
            id: "g2",
            at: ago(2 * DAY),
            checks: [{ name: "Build all", repo: "acme/x", run: 6, job: 777 }],
            checksFrom: "record",
        },
        // A name from the fingerprint: the thread's repository, compared case-insensitively.
        {
            session: t2.session,
            id: "g3",
            at: ago(3 * DAY),
            checks: [{ name: "lint" }],
            checksFrom: "fingerprint",
        },
        // No match: a name that is not exact.
        {
            session: t1.session,
            id: "g4",
            at: ago(4 * DAY),
            checks: [{ name: "Race", repo: "acme/widgets" }],
            checksFrom: "record",
        },
        // No checks.
        { session: t1.session, id: "g5", at: ago(5 * DAY), checks: [], checksFrom: null },
    ];
    const result = checkQ1(
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1, t2),
            goalStops,
            flakyKeys,
        }),
        q1Ctx([]),
    );
    const stops = result.metrics.stops;
    const rows = Object.fromEntries(
        stops.goals.map((goal: { id: string }) => [goal.id, goal]),
    ) as Record<
        string,
        { checks: object[]; checksFrom: string | null; flakyKeys: string[]; flaky: boolean | null }
    >;

    assert.deepEqual(rows.g1!.flakyKeys, ["acme/widgets/ci.yml/race/TestRace"]);
    assert.equal(rows.g1!.flaky, true);
    assert.deepEqual(rows.g1!.checks, [
        { name: "Race Detection", repo: "ACME/Widgets", run: 5, job: 99 },
    ]);
    assert.equal(rows.g1!.checksFrom, "record");
    assert.deepEqual(rows.g2!.flakyKeys, ["acme/other/ci.yml/build/TestBuild"]);
    assert.equal(rows.g2!.flaky, true);
    assert.deepEqual(rows.g3!.flakyKeys, ["acme/gears/ci.yml/lint/TestLint"]);
    assert.equal(rows.g3!.checksFrom, "fingerprint");
    assert.deepEqual(rows.g4!.flakyKeys, []);
    assert.equal(rows.g4!.flaky, false);
    assert.deepEqual(rows.g5!.flakyKeys, []);
    assert.equal(rows.g5!.flaky, null);
    assert.equal(rows.g5!.checksFrom, null);
    assert.deepEqual(stops.totals, { stops: 5, last7: 5, withChecks: 4, flaky: 3 });
    assert.deepEqual(stops.repos["acme/widgets"], {
        stops: 4,
        last7: 4,
        withChecks: 3,
        flaky: 2,
    });
    assert.deepEqual(stops.flakyScans, flakyKeys.files);
    // The join adds no finding of its own: the stop finding stays as it was.
    assert.deepEqual(ids(result), ["Q1:stops:repo:acme/widgets"]);

    // The flaky source unavailable: `flaky` is unknown, not false, and the scans are null.
    for (const data of [
        emptyData({ decided: todayEmpty, threads: threadMap(t1, t2), goalStops, flakyKeys: null }),
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1, t2),
            goalStops,
            flakyKeys,
            sourceErrors: { flakyKeys: "boom" },
        }),
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1, t2),
            goalStops,
            flakyKeys: undefined,
        }),
    ]) {
        const off = checkQ1(data, q1Ctx([])).metrics.stops;

        assert.deepEqual(
            off.goals.map((goal: { flaky: boolean | null; flakyKeys: string[] }) => [
                goal.flaky,
                goal.flakyKeys,
            ]),
            [
                [null, []],
                [null, []],
                [null, []],
                [null, []],
                [null, []],
            ],
        );
        assert.equal(off.flakyScans, null);
        assert.equal(off.totals.flaky, 0);
        assert.equal(off.totals.withChecks, 4);
    }
});

test("Q1 stops: a check name that gh cut with ... matches a flaky key whose job starts with the rest", () => {
    const t1 = thread("T1");
    const long =
        "Install packages on target distros (debian, debian:12@sha256:9344f8b8992482f80cba753f323adeaf1769c0ab)";
    const cut =
        "Install packages on target distros (debian, debian:12@sha256:9344f8b8992482f80cba753f323adeaf1769...";
    const key = (name: string, job: string) => ({
        key: name,
        repo: "acme/widgets",
        workflow: "ci.yml",
        job,
        test: null,
        jobIds: [],
        file: "reports/2026-10-20-flaky-scan/scan.json",
    });
    const result = checkQ1(
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1),
            goalStops: [
                {
                    session: t1.session,
                    id: "g1",
                    at: ago(DAY),
                    checks: [{ name: cut, repo: "acme/widgets" }],
                    checksFrom: "record",
                },
                // A name with no ... must match exactly: a prefix is not enough.
                {
                    session: t1.session,
                    id: "g2",
                    at: ago(2 * DAY),
                    checks: [{ name: "Install packages", repo: "acme/widgets" }],
                    checksFrom: "record",
                },
            ],
            flakyKeys: {
                files: ["reports/2026-10-20-flaky-scan/scan.json"],
                repos: ["acme/widgets"],
                keys: [key("k-long", long), key("k-other", "Install packages on host")],
            },
        }),
        q1Ctx([]),
    );
    const goals = result.metrics.stops.goals as {
        id: string;
        flakyKeys: string[];
        flaky: boolean;
    }[];

    assert.deepEqual(
        goals.map((goal) => [goal.id, goal.flakyKeys, goal.flaky]),
        [
            ["g2", [], false],
            ["g1", ["k-long"], true],
        ],
    );
});

test("Q1 stops: flaky is false only when a scan read the repository of every check with no error; else null", () => {
    const t1 = thread("T1");
    const stop = (id: string, session: number, checks: object[]) => ({
        session,
        id,
        at: ago(DAY),
        checks,
        checksFrom: "record",
    });
    const result = checkQ1(
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1),
            goalStops: [
                // The scan had an error for acme/broken: it is not in `repos`.
                stop("g1", t1.session, [{ name: "build", repo: "acme/broken" }]),
                // No scan in the window read acme/nowhere.
                stop("g2", t1.session, [{ name: "build", repo: "acme/nowhere" }]),
                // Scanned, no matching key: not flaky (the repository compared case-insensitively).
                stop("g3", t1.session, [{ name: "build", repo: "ACME/Widgets" }]),
                // No repository on the check: the thread's (acme/widgets).
                stop("g4", t1.session, [{ name: "build" }]),
                // 1 check of a repository that no scan read: unknown.
                stop("g5", t1.session, [
                    { name: "build", repo: "acme/widgets" },
                    { name: "build", repo: "acme/nowhere" },
                ]),
                // An unattributed session and a check with no repository: unknown.
                stop("g6", 900, [{ name: "build" }]),
                // A match is flaky, also beside a check of a repository that no scan read.
                stop("g7", t1.session, [
                    { name: "race", repo: "acme/widgets" },
                    { name: "build", repo: "acme/nowhere" },
                ]),
            ],
            flakyKeys: {
                files: ["reports/2026-10-20-flaky-scan/scan.json"],
                repos: ["acme/widgets"],
                keys: [
                    {
                        key: "acme/widgets/ci.yml/race/TestRace",
                        repo: "acme/widgets",
                        workflow: "ci.yml",
                        job: "race",
                        test: "TestRace",
                        jobIds: [],
                        file: "reports/2026-10-20-flaky-scan/scan.json",
                    },
                ],
            },
        }),
        q1Ctx([]),
    );
    const stops = result.metrics.stops;

    assert.deepEqual(
        Object.fromEntries(
            stops.goals.map((goal: { id: string; flaky: boolean | null }) => [goal.id, goal.flaky]),
        ),
        { g1: null, g2: null, g3: false, g4: false, g5: null, g6: null, g7: true },
    );
    assert.equal(stops.totals.flaky, 1);
    assert.equal(stops.totals.withChecks, 7);
});

test("Q1 CI reruns: the scan's values, null for a repository with no value, and never 0 with no scan", () => {
    const data = (flakyScan: unknown) => emptyData({ decided: todayEmpty, flakyScan });
    // Acceptance rows for acme/widgets and acme/other.
    const days = q1Ctx(
        earlierDays(2, (i) => [i === 1 ? q1Pr(1) : q1Pr(2, { ref: "acme/other#2" })]),
    );
    const scan = {
        file: "reports/2026-10-20-flaky-scan/scan.json",
        generatedAt: "2026-10-20T10:00:00.000Z",
        window: { from: "2026-10-13", to: "2026-10-20T10:00:00.000Z" },
        repos: { "acme/widgets": 0, "acme/broken": null, "acme/busy": 7 },
    };
    const result = checkQ1(data(scan), days);

    assert.deepEqual(result.metrics.ciReruns, {
        available: true,
        file: scan.file,
        generatedAt: scan.generatedAt,
        window: scan.window,
        repos: { "acme/broken": null, "acme/busy": 7, "acme/other": null, "acme/widgets": 0 },
    });
    assert.deepEqual(result.findings, []);

    assert.deepEqual(checkQ1(data(null), days).metrics.ciReruns, {
        available: false,
        reason: "no flaky scan",
        repos: { "acme/other": null, "acme/widgets": null },
    });
});

test("Q1: a source error of each new source leaves the acceptance metrics and findings as they were", () => {
    const prs = [...caseB()];
    const times = [1, 2, 3, 4, 5].map((n) => ago(n * DAY));
    const base = () =>
        emptyData({
            decided: todayEmpty,
            ...roundThreads([1, 2, 3, 4, 10], times),
            goalStops: [
                { session: 101, id: "g1", at: ago(DAY) },
                { session: 101, id: "g2", at: ago(2 * DAY) },
            ],
            flakyScan: { file: "f", generatedAt: null, window: null, repos: { "acme/widgets": 2 } },
        });
    const days = q1Ctx(earlierDays(25, spread(prs)));
    const clean = checkQ1(base(), days);
    const failed = checkQ1(
        {
            ...base(),
            sourceErrors: { reviews: "boom 1", goalHistory: "boom 2", flakyScan: "boom 3" },
        },
        days,
    );

    const acceptance = (result: ReturnType<typeof checkQ1>) => {
        const {
            rounds: _r,
            stops: _s,
            ciReruns: _c,
            prRounds: _p,
            blockers: _b,
            ...rest
        } = result.metrics;

        return rest;
    };

    // The clean run has every kind of finding.
    assert.deepEqual(ids(clean).sort(), [
        "Q1:agent:irulan",
        "Q1:repo:acme/widgets",
        "Q1:rounds:agent:irulan",
        "Q1:rounds:repo:acme/widgets",
        "Q1:stops:repo:acme/widgets",
    ]);
    assert.deepEqual(ids(failed).sort(), ["Q1:agent:irulan", "Q1:repo:acme/widgets"]);
    assert.deepEqual(
        failed.findings,
        clean.findings.filter((f) => !/^Q1:(rounds|stops)/.test(f.id)),
    );
    assert.deepEqual(acceptance(failed), acceptance(clean));
    assert.deepEqual(failed.metrics.rounds, { available: false, reason: "boom 1" });
    assert.deepEqual(failed.metrics.stops, { available: false, reason: "boom 2" });
    assert.deepEqual(failed.metrics.ciReruns, { available: false, reason: "boom 3" });

    // runChecks still runs Q1: the new sources are not in its needs.
    const run = runChecks(
        { ...base(), sourceErrors: { reviews: "x", goalHistory: "y", flakyScan: "z" } },
        days,
    );

    assert.equal(run.skipped.Q1, undefined);
    assert.equal(run.metrics.Q1.totals.acceptance, 0.6);

    // Data from before these sources existed has no keys: each part says "no data".
    const old = { ...base() } as Record<string, unknown>;

    delete old.reviewCalls;
    delete old.goalStops;
    delete old.flakyScan;

    const before = checkQ1(old as ReturnType<typeof emptyData>, days);

    assert.deepEqual(acceptance(before), acceptance(clean));
    assert.deepEqual(before.metrics.rounds, { available: false, reason: "no data" });
    assert.deepEqual(before.metrics.stops, { available: false, reason: "no data" });
    assert.deepEqual(before.metrics.ciReruns, { available: false, reason: "no data" });
});

// ---------- P. Planning sessions ----------

const planResult = (id: number, at: number, text = "") => ({
    id,
    at,
    isError: text !== "",
    text,
});
const sourceRead = (id: number, at: number, tool = "bash") => ({ id, at, tool });

test("P1: calls, refusals, targeted refusals and source reads per planning session, and their sum", () => {
    const data = emptyData({
        agentOf: { 13: "duncan" },
        planSessions: [
            {
                thread: "T4",
                session: 13,
                results: [
                    planResult(1, ago(4 * HOUR)),
                    planResult(
                        2,
                        ago(3 * HOUR),
                        "[error] Plan T4 has no draft graph for rev abc1234: call plan tasks first.",
                    ),
                    planResult(
                        3,
                        ago(3 * HOUR),
                        "[error] Task t1 names a/b, which is not a repository of irulan.",
                    ),
                    planResult(
                        4,
                        ago(2 * HOUR),
                        "[error] Each option is 1 to 40 characters, on one line.",
                    ),
                    // Outside the window: not counted.
                    planResult(5, ago(30 * HOUR), "[error] tasks needs rev: the full revision."),
                ],
                sourceReads: [sourceRead(6, ago(2 * HOUR)), sourceRead(7, ago(HOUR), "read")],
            },
            {
                thread: "T5",
                session: 14,
                results: [planResult(8, ago(HOUR)), planResult(9, ago(HOUR))],
                sourceReads: [],
            },
        ],
    });
    const result = checkP1(data, ctx);
    const [t4, t5] = result.metrics.sessions;

    assert.equal(t4.thread, "T4");
    assert.equal(t4.agent, "duncan");
    assert.equal(t4.calls, 4);
    assert.equal(t4.refused, 3);
    assert.equal(t4.rate, 0.75);
    assert.equal(t4.targeted, 2);
    assert.equal(t4.targetedBy["no draft graph for rev"], 1);
    assert.equal(t4.targetedBy["is not a repository of"], 1);
    assert.equal(t4.targetedBy["tasks needs rev"], 0);
    assert.equal(t4.sourceReads, 2);
    assert.deepEqual([t5.calls, t5.refused, t5.rate, t5.targeted, t5.sourceReads], [2, 0, 0, 0, 0]);
    assert.deepEqual(
        { ...result.metrics.total, targetedBy: undefined },
        {
            sessions: 2,
            calls: 6,
            refused: 3,
            rate: 0.5,
            targeted: 2,
            targetedBy: undefined,
            sourceReads: 2,
        },
    );

    // 1 low finding for the session that read the source; none for the rate.
    assert.deepEqual(ids(result), ["P1:T4"]);
    assert.equal(result.findings[0]!.severity, "low");
    assert.equal(result.findings[0]!.cases, 2);
    assert.match(
        result.findings[0]!.text,
        /T4 \(duncan\): its planning session read the source 2 times/,
    );
});

test("P1: each of the 6 targeted texts is counted once; a session with nothing in the window is left out", () => {
    const results = PLAN_TARGETED.map((text, index) =>
        planResult(index + 1, ago(HOUR), `[error] x ${text} y`),
    );
    const data = emptyData({
        planSessions: [
            { thread: "T4", session: 13, results, sourceReads: [] },
            {
                thread: "T6",
                session: 15,
                results: [planResult(9, ago(30 * HOUR))],
                sourceReads: [],
            },
        ],
    });
    const result = checkP1(data, ctx);

    assert.equal(PLAN_TARGETED.length, 6);
    assert.equal(result.metrics.total.targeted, 6);
    assert.ok(Object.values(result.metrics.total.targetedBy).every((count) => count === 1));
    assert.deepEqual(
        result.metrics.sessions.map((item: { thread: string }) => item.thread),
        ["T4"],
    );
    assert.deepEqual(ids(result), []);
});

test("P1: no planning session gives 0 calls and a null rate, not 0", () => {
    const result = checkP1(emptyData(), ctx);

    assert.deepEqual(result.metrics.sessions, []);
    assert.equal(result.metrics.total.calls, 0);
    assert.equal(result.metrics.total.rate, null);
});

test("P1: a missing planning-session source skips P1 by name", () => {
    const result = runChecks(
        emptyData({ sourceErrors: { planSessions: "needs the desk threads" } }),
        ctx,
    );

    assert.match(result.skipped.P1!, /source unavailable: planSessions: needs the desk threads/);
    assert.equal(result.metrics.P1, undefined);
});

// ---------- Q1: cross-review rounds per PR and blocking points ----------

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

/** A review call with the PRs and the head its message names. */
const named = (
    call: ReviewCall,
    refs: string[] = [],
    bare: number[] = [],
    head: string | null = null,
) => ({ ...call, refs, bare, head });

test("Q1 prRounds: rounds per PR from the session records; a send takes the PR of the call before it", () => {
    const t1 = thread("T1");
    const s = t1.session;
    const at = ago(2 * DAY);
    const reviewCalls = [
        named(reviewerSpawn(s, at), ["acme/widgets#4", "stranger/x#1"], [], HEAD_A),
        // A send with no PR of its own takes acme/widgets#4; its head is its own.
        named(sendTo(s, at + MINUTE, "reviewer"), [], [], HEAD_B),
        named(sendTo(s, at + 2 * MINUTE, "reviewer")),
        // A bare number goes to the repository of the session's desk thread.
        named(reviewerSpawn(s, at + 3 * MINUTE, "rv5"), [], [5]),
        // A coder call names a PR and is no round.
        named(coderSpawn(s, at + 4 * MINUTE), ["acme/widgets#6"]),
        // A round with no PR: unattributed.
        named(reviewerSpawn(s, at + 5 * MINUTE, "rv0")),
        // Older than 30 days.
        named(reviewerSpawn(s, ago(31 * DAY), "old"), ["acme/widgets#7"]),
    ];
    const result = checkQ1(
        emptyData({ decided: todayEmpty, threads: threadMap(t1), reviewCalls }),
        q1Ctx([]),
    );

    assert.deepEqual(result.metrics.prRounds, {
        available: true,
        method: "sessions",
        windowDays: 30,
        totals: {
            prs: 2,
            rounds: 4,
            mean: 2,
            median: 2,
            p90: 3,
            atLeast3: 1,
            unattributed: 1,
        },
        prs: [
            {
                ref: "acme/widgets#4",
                rounds: 3,
                heads: 2,
                first: "2026-10-21T14:00Z",
                last: "2026-10-21T14:02Z",
            },
            {
                ref: "acme/widgets#5",
                rounds: 1,
                heads: 0,
                first: "2026-10-21T14:03Z",
                last: "2026-10-21T14:03Z",
            },
        ],
    });
    // No finding comes from it.
    assert.deepEqual(ids(result), []);
});

test("Q1 blockers: points of answers with their PR, head, state and guard; ambiguous and unmatched answers", () => {
    const t1 = thread("T1");
    const s = t1.session;
    const at = ago(DAY);
    const reviewCalls = [
        named(reviewerSpawn(s, at, "rv4"), ["acme/widgets#4"], [], HEAD_A),
        named(reviewerSpawn(s, at, "rv5"), ["acme/widgets#5"], [], HEAD_A),
        // 2 desk-owner refs: ambiguous.
        named(reviewerSpawn(s, at, "both"), ["acme/widgets#4", "acme/widgets#5"], [], HEAD_A),
        named(reviewerSpawn(s, at, "rv8"), ["acme/widgets#8"]),
        named(coderSpawn(s, at, "coder"), ["acme/widgets#4"], [], HEAD_A),
    ];
    const answer = (id: number, name: string, items: string[], ready: boolean | null = false) => ({
        id,
        c: s,
        at: at + id * MINUTE,
        name,
        ready,
        items,
    });
    const reviewAnswers = [
        answer(1, "rv4", ["1", "2"]),
        answer(2, "rv5", ["A1"]),
        answer(3, "both", ["1"]),
        answer(4, "rv8", ["#1"]),
        // A "Not ready" answer with no item it can read.
        answer(5, "rv4", []),
        // The coder's answer, and an answer with no review call: skipped.
        answer(6, "coder", ["1"]),
        answer(7, "nobody", ["1"]),
        { ...answer(8, "rv4", ["9"]), c: 999 },
    ];
    const guard = {
        final: true,
        state: "merged",
        guarded: true,
        test: true,
        agentsRule: false,
        corrections: 1,
        namesPr: false,
    };
    const cached = { final: true, state: "closed", guarded: null };
    const data = emptyData({
        decided: todayEmpty,
        threads: threadMap(t1),
        reviewCalls,
        reviewAnswers,
        blockerCache: { [`acme/widgets#5@${HEAD_A}`]: cached },
        blockerGuards: {
            prs: {
                "acme/widgets#4": { state: "merged", mergedAt: null, closedAt: null, head: HEAD_B },
                "acme/widgets#8": { state: "open", mergedAt: null, closedAt: null, head: HEAD_B },
            },
            guards: { [`acme/widgets#4@${HEAD_A}`]: guard },
            calls: 2,
            pending: 0,
        },
    });
    const blockers = checkQ1(data, q1Ctx([])).metrics.blockers;
    const base = { session: s, at: "", reviewer: "" };

    assert.equal(blockers.available, true);
    assert.equal(blockers.windowDays, 30);
    assert.deepEqual(
        blockers.points.map((point: typeof base & Record<string, unknown>) => ({
            ...point,
            ...base,
        })),
        [
            {
                ...base,
                ref: "acme/widgets#4",
                head: HEAD_A,
                item: "1",
                answer: 1,
                state: "merged",
                guard,
            },
            {
                ...base,
                ref: "acme/widgets#4",
                head: HEAD_A,
                item: "2",
                answer: 1,
                state: "merged",
                guard,
            },
            {
                ...base,
                ref: "acme/widgets#5",
                head: HEAD_A,
                item: "A1",
                answer: 2,
                state: "closed",
                guard: cached,
            },
            {
                ...base,
                ref: null,
                head: HEAD_A,
                item: "1",
                answer: 3,
                ambiguous: true,
                refs: ["acme/widgets#4", "acme/widgets#5"],
                state: "unknown",
                guard: null,
            },
            {
                ...base,
                ref: "acme/widgets#8",
                head: null,
                item: "#1",
                answer: 4,
                state: "open",
                guard: null,
            },
        ],
    );
    assert.equal(blockers.points[0].at, "2026-10-22T14:01Z");
    assert.equal(blockers.points[0].reviewer, "rv4");
    assert.deepEqual(blockers.totals, {
        answers: 5,
        points: 5,
        attributed: 4,
        ambiguous: 1,
        noPr: 0,
        noHead: 1,
        open: 1,
        merged: 2,
        closed: 1,
        pending: 0,
        evaluated: 2,
        guarded: 2,
        test: 2,
        agentsRule: 0,
        corrections: 2,
        namesPr: 0,
        rate: 1,
        unparsed: 1,
    });
    assert.deepEqual(ids(checkQ1(data, q1Ctx([]))), []);

    // Without GitHub: the points stay, the state is unknown, and a cached guard still applies.
    const offline = checkQ1(
        {
            ...data,
            blockerGuards: undefined,
            sourceErrors: { blockerGuards: "disabled by --no-github" },
        },
        q1Ctx([]),
    ).metrics.blockers;

    assert.equal(offline.available, true);
    assert.deepEqual(
        offline.points.map((point: { state: string; guard: object | null }) => [
            point.state,
            point.guard,
        ]),
        [
            ["unknown", null],
            ["unknown", null],
            ["closed", cached],
            ["unknown", null],
            ["unknown", null],
        ],
    );
    assert.equal(offline.totals.rate, null);

    // A merged PR with no guard yet is pending; the answers source failing makes the part unavailable.
    const pending = checkQ1(
        { ...data, blockerGuards: { ...data.blockerGuards, guards: {} } },
        q1Ctx([]),
    ).metrics.blockers;

    assert.equal(pending.totals.pending, 2);
    assert.deepEqual(
        checkQ1({ ...data, sourceErrors: { reviewAnswers: "boom" } }, q1Ctx([])).metrics.blockers,
        { available: false, reason: "boom" },
    );
});

test("Q1 blockers: guards says how the guard read went; a loader that failed is named, and the points stay", () => {
    const t1 = thread("T1");
    const at = ago(DAY);
    const data = (over: object) =>
        emptyData({
            decided: todayEmpty,
            threads: threadMap(t1),
            reviewCalls: [
                named(reviewerSpawn(t1.session, at, "rv"), ["acme/widgets#4"], [], HEAD_A),
            ],
            reviewAnswers: [
                { id: 1, c: t1.session, at: at + MINUTE, name: "rv", ready: false, items: ["1"] },
            ],
            ...over,
        });
    const blockers = (over: object) => checkQ1(data(over), q1Ctx([])).metrics.blockers;

    assert.deepEqual(
        blockers({
            blockerGuards: {
                prs: {},
                guards: {},
                calls: 3,
                pending: 1,
                errors: ["PR query failed", "blob query returned errors"],
            },
        }).guards,
        {
            available: true,
            errors: ["PR query failed", "blob query returned errors"],
            calls: 3,
            pending: 1,
        },
    );

    const failed = blockers({
        blockerGuards: undefined,
        sourceErrors: { blockerGuards: "boom" },
    });

    assert.deepEqual(failed.guards, {
        available: false,
        reason: "boom",
        errors: [],
        calls: null,
        pending: null,
    });
    assert.equal(failed.available, true);
    assert.equal(failed.totals.points, 1);
    assert.equal(failed.points[0].state, "unknown");
});

// ---------- R2. Routed threads end to end ----------

/** A routed thread, closed as done `daysAgo` days before NOW (`completed` unless `outcome` says else). */
const r2Thread = (
    id: string,
    {
        route = {},
        prs = {},
        daysAgo = 30,
        why = "done",
        outcome = "completed" as string | null,
        over = {},
    }: {
        route?: object;
        prs?: Record<string, object>;
        daysAgo?: number;
        why?: string;
        outcome?: string | null;
        over?: object;
    } = {},
) =>
    routed(id, route, {
        state: "closed",
        closed: {
            at: NOW - daysAgo * DAY,
            why,
            by: "sweep",
            ...(outcome === null ? {} : { outcome }),
        },
        prs,
        ...over,
    });

/** A desk PR link; no state when `state` is undefined. */
const r2Link = (state?: string) => ({ via: "seen", ...(state === undefined ? {} : { state }) });

/** 1 PR of a Q1 day record, decided `daysAgo` days before NOW. */
const r2Pr = (n: number, daysAgo: number, over: Partial<Q1Pr> = {}): Q1Pr =>
    q1Pr(n, { at: new Date(NOW - daysAgo * DAY).toISOString(), ...over });

/** 1 earlier complete Q1 day, 40 days back: R2 has no 30-day limit. */
const r2Earlier = (prs: Q1Pr[]) => [
    { date: "2026-09-13", json: { findings: [], metrics: { Q1: { day: q1Record(prs) } } } },
];

const r2Ctx = (earlier: object[] = [], results: object = {}) => ({ ...ctx, earlier, results });

/** The totals of R2 on some threads. */
const r2Totals = (threads: object[], c = r2Ctx(), over: object = {}) =>
    checkR2(emptyData({ threads: threadMap(...threads), ...over }), c).metrics.totals;

const outcomeOfR2 = (totals: Record<string, number>) =>
    ["open", "accepted", "notAccepted", "pending", "unknown"].filter((key) => totals[key] === 1);

test("R2: a merged PR with no revert for 14 days is accepted; the merge time comes from Q1, GitHub, or the close", () => {
    const prs = { "acme/widgets#1": r2Link("MERGED") };

    // Q1's record: merged 20 days ago.
    const fromQ1 = r2Totals(
        [r2Thread("T1", { prs, daysAgo: 19 })],
        r2Ctx(r2Earlier([r2Pr(1, 20)])),
    );

    assert.deepEqual(outcomeOfR2(fromQ1), ["accepted"]);
    assert.equal(fromQ1.closeAsMergeTime, 0);

    // No record: this run's GitHub read gives the merge time.
    const fromGithub = r2Totals([r2Thread("T1", { prs, daysAgo: 19 })], r2Ctx(), {
        github: {
            botPrs: [],
            prs: { "acme/widgets#1": { mergedAt: new Date(NOW - 20 * DAY).toISOString() } },
            checkRuns: {},
            autoDelete: {},
        },
    });

    assert.deepEqual(outcomeOfR2(fromGithub), ["accepted"]);
    assert.equal(fromGithub.closeAsMergeTime, 0);

    // Neither: the close is the late bound.
    const fromClose = r2Totals([r2Thread("T1", { prs, daysAgo: 20 })]);

    assert.deepEqual(outcomeOfR2(fromClose), ["accepted"]);
    assert.equal(fromClose.closeAsMergeTime, 1);

    // A desk link with no state takes Q1's state.
    assert.deepEqual(
        outcomeOfR2(
            r2Totals(
                [r2Thread("T1", { prs: { "acme/widgets#1": r2Link() } })],
                r2Ctx(r2Earlier([r2Pr(1, 20)])),
            ),
        ),
        ["accepted"],
    );
});

test("R2: before 14 days after the last merge, or the close with no PR, a thread is pending", () => {
    const prs = { "acme/widgets#1": r2Link("MERGED") };

    assert.deepEqual(
        outcomeOfR2(
            r2Totals([r2Thread("T1", { prs, daysAgo: 4 })], r2Ctx(r2Earlier([r2Pr(1, 5)]))),
        ),
        ["pending"],
    );
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { daysAgo: 3 })])), ["pending"]);
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { daysAgo: 15 })])), ["accepted"]);
    // A window link is not the thread's PR.
    assert.deepEqual(
        outcomeOfR2(
            r2Totals([
                r2Thread("T1", { prs: { "acme/widgets#1": { via: "window" } }, daysAgo: 15 }),
            ]),
        ),
        ["accepted"],
    );
});

test("R2: a PR state that is not known makes the thread unknown", () => {
    for (const link of [r2Link(), r2Link("MISSING"), r2Link("FROZEN"), r2Link("OPEN")]) {
        assert.deepEqual(
            outcomeOfR2(r2Totals([r2Thread("T1", { prs: { "acme/widgets#1": link } })])),
            ["unknown"],
            JSON.stringify(link),
        );
    }

    // Another close of a done thread is unknown too.
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { outcome: "odd" })])), ["unknown"]);
});

test("R2: a revert within 14 days, a reopening, a PR closed unmerged and a drop are not accepted", () => {
    const prs = { "acme/widgets#1": r2Link("MERGED") };
    const revertAt = (days: number) =>
        r2Ctx(
            r2Earlier([r2Pr(1, 30), r2Pr(2, days, { title: "Undo", reverts: ["acme/widgets#1"] })]),
        );

    // Reverted 10 days after the merge.
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { prs })], revertAt(20))), [
        "notAccepted",
    ]);
    // Reverted 20 days after the merge: too late to count.
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { prs })], revertAt(10))), ["accepted"]);
    // Reopened.
    assert.deepEqual(
        outcomeOfR2(
            r2Totals([r2Thread("T1")], r2Ctx(), {
                events: [event("T1", NOW - 35 * DAY, "reopened:queue", "reopened")],
            }),
        ),
        ["notAccepted"],
    );
    // A watch's reopen verifies the work: it is no rework.
    assert.deepEqual(
        outcomeOfR2(
            r2Totals([r2Thread("T1", { outcome: "verified" })], r2Ctx(), {
                events: [
                    event("T1", NOW - 35 * DAY, "reopened:watch:x.desk.watch:1:c/1", "watch set"),
                ],
            }),
        ),
        ["accepted"],
    );
    // A PR closed unmerged, beside a PR of unknown state.
    assert.deepEqual(
        outcomeOfR2(
            r2Totals([
                r2Thread("T1", {
                    prs: { "acme/widgets#1": r2Link(), "acme/widgets#2": r2Link("CLOSED") },
                }),
            ]),
        ),
        ["notAccepted"],
    );
    // Dropped, failed, abandoned, frozen.
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { why: "dropped", outcome: null })])), [
        "notAccepted",
    ]);
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { why: "failed", outcome: null })])), [
        "notAccepted",
    ]);
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { outcome: "abandoned" })])), [
        "notAccepted",
    ]);
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { outcome: "frozen" })])), [
        "notAccepted",
    ]);
    // Not closed.
    assert.deepEqual(outcomeOfR2(r2Totals([routed("T1")])), ["open"]);
});

test("R2: a worker spawn on another model or thinking than the assigned one is a deviation; a cross-review is not", () => {
    const data = emptyData({
        threads: threadMap(
            routed("T1", { assigned: "x/model" }),
            routed("T2", { assigned: "x/model" }),
            routed("T3", {}),
            routed("T4", { assigned: "x/model", assignedThinking: "high" }),
            routed("T5", { assigned: "p/model", profileModel: "p/model" }),
            routed("T6", { worker: "x/model" }),
        ),
        routeSpawns: [
            spawn({ c: 101, model: "y/model", thinking: null }),
            // A cross-review on another model, and the worker on the assigned one.
            spawn({ c: 102, model: "y/model", tools: ["read", "bash"], review: true }),
            spawn({ c: 102, model: "x/model", thinking: "high" }),
            // No assigned worker: nothing to deviate from.
            spawn({ c: 103, model: "y/model" }),
            spawn({ c: 104, model: "x/model", thinking: "low" }),
            // No model: the parent's model, which is the assigned one.
            spawn({ c: 105, model: null }),
            spawn({ c: 106, model: "x/model" }),
        ],
    });
    const rows = checkR2(data, r2Ctx()).metrics.rows;
    const row = (assigned: string) => rows.find((each) => each.assigned === assigned)!;

    // T1, T2, T4 and T6 (the named worker is the assigned one).
    assert.equal(row("x/model").count, 4);
    assert.equal(row("x/model").deviations, 2);
    assert.deepEqual(row("x/model").workers, { "x/model": 3, "y/model": 1 });
    assert.deepEqual(row("x/model").thinking, { "-": 2, high: 1, low: 1 });
    assert.equal(row("-").deviations, 0);
    assert.equal(row("p/model").deviations, 0);
    assert.deepEqual(row("p/model").workers, { "p/model": 1 });
    assert.equal(checkR2(data, r2Ctx()).metrics.totals.deviations, 2);
});

test("R2: the hand-fix rate counts the threads with a known edit row only", () => {
    const threads = [routed("T1"), routed("T2"), routed("T3")];
    const parentEdits = [
        { c: 101, firstAnswerAt: NOW - DAY, edits: 2 },
        { c: 102, firstAnswerAt: null, edits: 0 },
    ];
    const known = checkR2(
        emptyData({ threads: threadMap(...threads), parentEdits }),
        r2Ctx(),
    ).metrics;

    assert.equal(known.sources.parentEdits, true);
    assert.equal(known.rows[0]!.handFixRate, 0.5);
    assert.equal(known.rows[0]!.handFixKnown, 2);

    const failed = checkR2(
        emptyData({
            threads: threadMap(...threads),
            parentEdits: [],
            sourceErrors: { parentEdits: "no such table" },
        }),
        r2Ctx(),
    ).metrics;

    assert.equal(failed.sources.parentEdits, false);
    assert.equal(failed.rows[0]!.handFixRate, null);
    assert.equal(failed.rows[0]!.handFixKnown, 0);
});

test("R2: the accepted rate shows from 10 decided threads", () => {
    const accepted = Array.from({ length: 9 }, (_, i) => r2Thread(`T${i + 1}`));
    const nine = r2Totals(accepted);

    assert.equal(R2_THRESHOLDS.minDecided, 10);
    assert.equal(nine.decided, 9);
    assert.equal(nine.acceptedRate, null);

    const ten = r2Totals([...accepted, r2Thread("T10", { why: "dropped", outcome: null })]);

    assert.equal(ten.decided, 10);
    assert.equal(ten.acceptedRate, 0.9);
});

test("R2: cost per accepted, median rounds and blocking points from Q1; without Q1 they are unknown", () => {
    const threads = [
        r2Thread("T1", {
            prs: { "acme/widgets#1": r2Link("MERGED"), "acme/widgets#2": r2Link("MERGED") },
        }),
        r2Thread("T2", { prs: { "acme/widgets#3": r2Link() }, why: "dropped", outcome: null }),
        routed("T3"),
    ];
    const routeCosts = [
        { c: 101, at: NOW - 31 * DAY, cost: 1 },
        { c: 101, at: NOW - 31 * DAY, cost: 2 },
        { c: 102, at: NOW - 31 * DAY, cost: 1 },
        // An open thread is not decided: its cost is not in the cost per accepted thread.
        { c: 103, at: NOW - DAY, cost: 10 },
    ];
    const q1 = {
        Q1: {
            findings: [],
            metrics: {
                prRounds: {
                    available: true,
                    prs: [
                        { ref: "acme/widgets#1", rounds: 2 },
                        { ref: "acme/widgets#2", rounds: 1 },
                        { ref: "acme/widgets#3", rounds: 4 },
                    ],
                },
                blockers: {
                    available: true,
                    points: [{ ref: "acme/widgets#1" }, { ref: "acme/widgets#9" }],
                },
            },
        },
    };
    const data = emptyData({ threads: threadMap(...threads), routeCosts });
    const withQ1 = checkR2(data, r2Ctx([], q1)).metrics;

    assert.equal(withQ1.sources.q1, true);
    assert.equal(withQ1.totals.accepted, 1);
    assert.equal(withQ1.totals.costPerAccepted, 4);
    // T1 3 rounds, T2 4; T3 has no PR, so no rounds.
    assert.equal(withQ1.totals.medianRounds, 3.5);
    assert.equal(withQ1.totals.blockers, 1);

    const without = checkR2(data, r2Ctx()).metrics;

    assert.equal(without.sources.q1, false);
    assert.equal(without.totals.medianRounds, null);
    assert.equal(without.totals.blockers, null);
    assert.equal(without.totals.costPerAccepted, 4);
    assert.equal(r2Totals([routed("T1")]).costPerAccepted, null);
});

test("R2: a thread with no PR has no rounds and no blocking points, so it does not change medianRounds", () => {
    const results = {
        Q1: {
            findings: [],
            metrics: {
                prRounds: { available: true, prs: [{ ref: "acme/widgets#1", rounds: 3 }] },
                blockers: { available: true, points: [{ ref: "acme/widgets#1" }] },
            },
        },
    };
    const withPr = r2Thread("T1", { prs: { "acme/widgets#1": r2Link("MERGED") } });
    const one = r2Totals([withPr], r2Ctx([], results));
    const both = r2Totals([withPr, r2Thread("T2"), routed("T3")], r2Ctx([], results));

    assert.equal(one.medianRounds, 3);
    assert.equal(both.medianRounds, 3);
    assert.equal(both.blockers, 1);
    assert.equal(r2Totals([r2Thread("T2")], r2Ctx([], results)).medianRounds, null);
    assert.equal(r2Totals([r2Thread("T2")], r2Ctx([], results)).blockers, null);
});

test("R2: notAcceptedWhy counts each thread that is not accepted in the first reason found", () => {
    const merged = { "acme/widgets#1": r2Link("MERGED") };
    const reopen = (id: string) =>
        event(
            id,
            NOW - 35 * DAY,
            `reopened:${NOW - 35 * DAY}`,
            "reopened: new work in its session",
        );
    const totals = r2Totals(
        [
            r2Thread("T1", { why: "dropped", outcome: null }),
            r2Thread("T2", { outcome: "abandoned" }),
            // Reopened and a PR closed unmerged: the reopening is found first.
            r2Thread("T3", { prs: { "acme/widgets#3": r2Link("CLOSED") } }),
            r2Thread("T4", { prs: { "acme/widgets#4": r2Link("CLOSED") } }),
            r2Thread("T5", { prs: merged }),
            // Dropped and reopened: dropped is found first.
            r2Thread("T6", { why: "failed", outcome: null }),
            r2Thread("T7"),
        ],
        r2Ctx(
            r2Earlier([r2Pr(1, 30), r2Pr(2, 25, { title: "Undo", reverts: ["acme/widgets#1"] })]),
        ),
        { events: [reopen("T3"), reopen("T6")] },
    );

    assert.equal(totals.notAccepted, 6);
    assert.equal(totals.accepted, 1);
    assert.deepEqual(totals.notAcceptedWhy, { dropped: 3, closedPr: 1, reverted: 1, reopened: 1 });
    assert.deepEqual(totals.reopenedBy, { other: 1 });
    assert.deepEqual(r2Totals([]).notAcceptedWhy, {
        dropped: 0,
        closedPr: 0,
        reverted: 0,
        reopened: 0,
    });
});

test("R2: reopenedBy counts the kinds of reopening of the reopened threads, from the event key and text", () => {
    const at = NOW - 35 * DAY;
    const metrics = checkR2(
        emptyData({
            threads: threadMap(
                r2Thread("T1"),
                r2Thread("T2"),
                r2Thread("T3"),
                r2Thread("T4", { outcome: "verified" }),
                r2Thread("T5", { why: "dropped", outcome: null }),
            ),
            events: [
                event(
                    "T1",
                    at,
                    "reopened:acme/widgets#2:1",
                    "reopened: acme/widgets#2 attached by Clerk",
                ),
                event("T1", at + 1, "reopened:2", "reopened: a report after a supervisor message"),
                // The same kind twice counts once.
                event(
                    "T1",
                    at + 2,
                    "reopened:acme/widgets#3:3",
                    "reopened: acme/widgets#3 attached by Clerk",
                ),
                event("T2", at, "reopened:4", "reopened: acme/widgets#1 is failing"),
                event(
                    "T3",
                    at,
                    "reopened:reopen:k1",
                    "Brian reopened T3a (section Scope): the answer was yes",
                ),
                // A watch's reopen is no reopening.
                event(
                    "T4",
                    at,
                    "reopened:watch:x.desk.watch:1:c/1",
                    "reopened: watch set by odrade",
                ),
                // A dropped thread counts as dropped: its reopenings are not counted.
                event(
                    "T5",
                    at,
                    "reopened:acme/widgets#4:5",
                    "reopened: acme/widgets#4 attached by Clerk",
                ),
            ],
        }),
        r2Ctx(),
    ).metrics;
    const expected = { attached: 1, other: 1, checks: 1, ask: 1 };

    assert.deepEqual(metrics.totals.notAcceptedWhy, {
        dropped: 1,
        closedPr: 0,
        reverted: 0,
        reopened: 3,
    });
    assert.deepEqual(metrics.totals.reopenedBy, expected);
    assert.deepEqual(metrics.rows[0]!.reopenedBy, expected);
    assert.equal(metrics.totals.accepted, 1);
});

test("R2: the eligible share of routed night shifts; an unknown risk path (null, or no features) is not eligible", () => {
    const bench = { repo: "frostyard/nsl" };
    const noRisk = { riskPathNamed: false };
    const threads = [
        routed("T1", { features: noRisk }, bench),
        routed("T2", { worker: "x/model", features: noRisk }, bench),
        routed("T3", { features: noRisk }),
        routed("T4", { features: { riskPathNamed: true } }, bench),
        routed("T5", { features: noRisk }, bench),
        routed("T6", { kind: undefined, features: { kind: "debug", riskPathNamed: false } }, bench),
        routed("T7", { kind: "review", features: noRisk }, bench),
        // The router could not read a risk-path list: unknown.
        routed("T8", { features: { riskPathNamed: null } }, bench),
        // An older route with no features: unknown.
        routed("T9", {}, bench),
    ];
    // T5 is no night shift.
    const goals = [101, 102, 103, 104, 106, 107, 108, 109].map((session) => ({
        session,
        goal: { status: "done" },
    }));
    const metrics = checkR2(emptyData({ threads: threadMap(...threads), goals }), r2Ctx()).metrics;

    assert.ok(R2_BENCH_REPOS.includes("frostyard/nsl"));
    assert.deepEqual(metrics.eligible, { nightShifts: 8, eligible: 2, share: 0.25 });
    assert.equal(metrics.totals.eligible, 2);
    assert.deepEqual(checkR2(emptyData(), r2Ctx()).metrics.eligible, {
        nightShifts: 0,
        eligible: 0,
        share: null,
    });
});

test("R2: a stored revert of a PR with no Q1 record of its own makes the thread not accepted", () => {
    const prs = { "acme/widgets#1": r2Link("MERGED") };
    // Only the revert PR has a record: it reverts #1 explicitly, 10 days after #1 merged.
    const c = r2Ctx(r2Earlier([r2Pr(2, 20, { title: "Undo", reverts: ["acme/widgets#1"] })]));
    const github = (daysAgo: number) => ({
        github: {
            botPrs: [],
            prs: { "acme/widgets#1": { mergedAt: new Date(NOW - daysAgo * DAY).toISOString() } },
            checkRuns: {},
            autoDelete: {},
        },
    });

    // The merge time from this run's GitHub read.
    const fromGithub = r2Totals([r2Thread("T1", { prs, daysAgo: 29 })], c, github(30));

    assert.deepEqual(outcomeOfR2(fromGithub), ["notAccepted"]);
    assert.equal(fromGithub.notAcceptedWhy.reverted, 1);

    // The merge time from the close.
    const fromClose = r2Totals([r2Thread("T1", { prs, daysAgo: 30 })], c);

    assert.deepEqual(outcomeOfR2(fromClose), ["notAccepted"]);
    assert.equal(fromClose.notAcceptedWhy.reverted, 1);

    // A title revert needs the record of the PR it reverts, for its title: no record, no revert.
    const byTitle = r2Ctx(
        r2Earlier([r2Pr(2, 20, { title: 'Revert "Change 1"', revertsTitle: "Change 1" })]),
    );

    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { prs, daysAgo: 30 })], byTitle)), [
        "accepted",
    ]);
});

test("R2: the revert window ends 14 days after the thread's last merge, for a revert of any of its PRs", () => {
    // Day 0 is 30 days before NOW: PR A merges on day 0, PR B on day 10.
    const prs = { "acme/widgets#1": r2Link("MERGED"), "acme/widgets#2": r2Link("MERGED") };
    const revertOfA = (day: number) =>
        r2Ctx(
            r2Earlier([
                r2Pr(1, 30),
                r2Pr(2, 20),
                r2Pr(3, 30 - day, { title: "Undo A", reverts: ["acme/widgets#1"] }),
            ]),
        );

    // Day 20: 20 days after A, but 10 days after the last merge.
    const inside = r2Totals([r2Thread("T1", { prs, daysAgo: 19 })], revertOfA(20));

    assert.deepEqual(outcomeOfR2(inside), ["notAccepted"]);
    assert.equal(inside.notAcceptedWhy.reverted, 1);
    // Day 26: 16 days after the last merge.
    assert.deepEqual(outcomeOfR2(r2Totals([r2Thread("T1", { prs, daysAgo: 19 })], revertOfA(26))), [
        "accepted",
    ]);
});

test("R2: rows group by tier rule, tier, arm and assigned worker, and sort by count", () => {
    const metrics = checkR2(
        emptyData({
            threads: threadMap(
                routed("T1", { tierRule: "v1", arm: "router", assigned: "x/model" }),
                routed("T2", { tierRule: "v1", arm: "router", assigned: "x/model" }),
                routed("T3", { tierRule: "v1", arm: "control", assigned: "y/model" }),
                routed("T4", { tier: "low" }),
            ),
        }),
        r2Ctx(),
    ).metrics;

    assert.equal(metrics.routes, 4);
    assert.equal(metrics.windowDays, 14);
    assert.deepEqual(
        metrics.rows.map((row) => [row.tierRule, row.tier, row.arm, row.assigned, row.count]),
        [
            ["v1", "high", "router", "x/model", 2],
            ["-", "low", "-", "-", 1],
            ["v1", "high", "control", "y/model", 1],
        ],
    );
    assert.deepEqual(checkR2(emptyData(), r2Ctx()).findings, []);
});

test("runChecks: R2 runs after Q1 and reads its day record; the other checks keep their metric keys", () => {
    const node = {
        repository: { nameWithOwner: "acme/widgets" },
        number: 7,
        title: "Change 7",
        body: "",
        mergedAt: new Date(NOW - 20 * DAY).toISOString(),
        closedAt: new Date(NOW - 20 * DAY).toISOString(),
        author: { login: "frostyard-machines" },
    };
    const result = runChecks(
        emptyData({
            threads: threadMap(
                r2Thread("T1", { prs: { "acme/widgets#7": r2Link("MERGED") }, daysAgo: 1 }),
            ),
            decided: { ...todayEmpty, nodes: [node] },
        }),
        q1Ctx([]),
    );

    assert.deepEqual(Object.keys(result.metrics).slice(-2), ["Q1", "R2"]);
    assert.equal(result.metrics.R2.sources.q1, true);
    // Today's Q1 record gives the merge time, 20 days back: accepted, not pending.
    assert.equal(result.metrics.R2.totals.accepted, 1);
    assert.equal(result.metrics.R2.totals.closeAsMergeTime, 0);
    assert.deepEqual(Object.keys(result.metrics.R1), ["routes", "cells", "named"]);
    assert.deepEqual(Object.keys(result.metrics.Q1), [
        "day",
        "window",
        "thresholds",
        "totals",
        "repos",
        "agents",
        "rounds",
        "stops",
        "ciReruns",
        "prRounds",
        "blockers",
    ]);
    assert.deepEqual(Object.keys(result.metrics.R2), [
        "routes",
        "sources",
        "windowDays",
        "rows",
        "eligible",
        "totals",
    ]);
});
