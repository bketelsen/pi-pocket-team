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
    checkJ1,
    inDeepseekPeak,
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

    assert.equal(CHECKS.length, 24);
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
});

test("runChecks: a check that throws is skipped and the run goes on", () => {
    const data = emptyData({ odrade: undefined });
    const result = runChecks(data, ctx);

    assert.match(result.skipped.I1!, /^check failed:/);
    assert.match(result.skipped.I2!, /^check failed:/);
    assert.ok(result.metrics.A1);
});

test("runChecks: a database that cannot be read skips the checks that need it", () => {
    const data = emptyData({
        sourceErrors: { desk: "no such table", entries: "no such table", costs: "no such table" },
    });
    const result = runChecks(data, ctx);

    assert.match(result.skipped.A4!, /source unavailable: entries: no such table/);
    assert.ok(!("I1" in result.skipped));
});
