// The desk's nudges: the serialized sync runner, the pure rules of `nudge` (matching, coalescing, the gap, dedupe), the
// observed changes, then the `nudge` API, its durable `x.desk.nudge` task and the runner in Pocket's test harness. A fake
// `gh` answers every GitHub read: nothing goes to GitHub, and nothing reads Brian's data.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    type DeskApi,
    type DeskNudgesState,
    type DeskState,
    type JudgedIssue,
    type NudgeFact,
    type ObservedSnap,
    type PrFact,
    type Thread,
    DeskNudges,
    DeskObserved,
    DeskThreads,
    NUDGE_DELIVERIES_MAX,
    NUDGE_FACTS_MAX,
    NUDGE_GAP_MS,
    NUDGE_SEEN_MAX,
    NUDGE_SEEN_MS,
    NUDGE_WINDOW_MS,
    OBSERVED_KEPT,
    SyncRunner,
    nudgeDue,
    nudgeSupervisors,
    observeIssue,
    observePr,
    openThread,
    recordObserved,
    takeNudges,
} from "./desk.ts";

// ─── The serialized sync runner ──────────────────────────────────────────────

/** A promise and its resolve, for a read the test lets go of by hand. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });

    return { promise, resolve };
}

/** Let every queued microtask and promise step run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("SyncRunner", () => {
    test("a slow older read never commits after a newer one: B reads only after A committed", async () => {
        const runner = new SyncRunner();
        const log: string[] = [];
        const slowRead = deferred();
        const a = runner.run(1, "sweeper", async () => {
            log.push("A:read");
            await slowRead.promise;
            log.push("A:commit");

            return "a";
        });
        const b = runner.run(1, "sync", async () => {
            log.push("B:read");
            await settle();
            log.push("B:commit");

            return "b";
        });

        await settle();
        assert.deepEqual(log, ["A:read"], "B waits while A reads");
        assert.equal(runner.busy(1), true);
        assert.deepEqual(runner.waiting(1), ["sync"]);

        slowRead.resolve();
        assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
        assert.deepEqual(log, ["A:read", "A:commit", "B:read", "B:commit"]);
        assert.equal(runner.busy(1), false);
    });

    test("2 requests of the same source during a sync join 1 follow-up: its work runs once, both get its value", async () => {
        const runner = new SyncRunner();
        const hold = deferred();
        let runs = 0;
        const first = runner.run(1, "sweeper", () => hold.promise.then(() => "first"));
        const one = runner.run(1, "sync", async () => {
            runs += 1;

            return "follow-up";
        });
        const two = runner.run(1, "sync", async () => {
            runs += 100;

            return "never";
        });

        assert.equal(one, two, "the same promise");
        hold.resolve();
        assert.deepEqual(await Promise.all([first, one, two]), ["first", "follow-up", "follow-up"]);
        assert.equal(runs, 1);
    });

    test("different sources queue first in, first out; another supervisor has its own lane", async () => {
        const runner = new SyncRunner();
        const hold = deferred();
        const log: string[] = [];

        const work = (name: string) => async () => {
            log.push(name);
        };

        const running = runner.run(1, "sweeper", async () => {
            await hold.promise;
            log.push("sweeper");
        });
        const queued = [
            runner.run(1, "sync", work("sync")),
            runner.run(1, "nudge", work("nudge")),
            runner.run(1, "view", work("view")),
        ];
        const other = runner.run(2, "sync", work("other supervisor"));

        await other;
        assert.deepEqual(log, ["other supervisor"], "supervisor 2 does not wait for supervisor 1");
        assert.deepEqual(runner.waiting(1), ["sync", "nudge", "view"]);
        hold.resolve();
        await Promise.all([running, ...queued]);
        assert.deepEqual(log, ["other supervisor", "sweeper", "sync", "nudge", "view"]);
    });

    test("a rejection reaches only its callers, and the lane goes on", async () => {
        const runner = new SyncRunner();
        const hold = deferred();
        const failing = runner.run(1, "sweeper", async () => {
            await hold.promise;

            throw new Error("gh failed");
        });
        const next = runner.run(1, "sync", async () => "after");

        hold.resolve();
        await assert.rejects(failing, /gh failed/);
        assert.equal(await next, "after");
        assert.equal(runner.busy(1), false);

        // A work that throws at once fails only itself too.
        await assert.rejects(
            runner.run(1, "sync", () => {
                throw new Error("at once");
            }),
            /at once/,
        );
        assert.equal(await runner.run(1, "sync", async () => 3), 3);
    });

    test("tryRun: undefined at once when busy or queued, and its work never runs; else it runs", async () => {
        const runner = new SyncRunner();
        const hold = deferred();
        let ran = false;
        const running = runner.run(1, "sweeper", () => hold.promise);

        assert.equal(
            await runner.tryRun(1, "view", async () => {
                ran = true;

                return true;
            }),
            undefined,
        );
        assert.equal(ran, false);
        hold.resolve();
        await running;
        assert.equal(await runner.tryRun(1, "view", async () => true), true);
    });
});

// ─── The pure rules of `nudge` ───────────────────────────────────────────────

const UUIDS = Array.from(
    { length: 600 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
);
const SHA1 = "a".repeat(40);
const T0 = Date.parse("2026-11-10T12:00:00Z");
const SUPERVISOR = 41;

const emptyNudges = (): DeskNudgesState => ({
    seen: {},
    pending: {},
    running: {},
    last: {},
    tasks: {},
    syncs: [],
    unmatched: 0,
});

function threadOf(patch: Partial<Thread> = {}): Thread {
    return {
        id: "T1",
        key: "x.test:T1",
        origin: "delegate",
        title: "A fix",
        agents: ["duncan"],
        supervisor: SUPERVISOR,
        state: "open",
        startedAt: T0 - 3600_000,
        lastEventAt: T0 - 3600_000,
        prs: {},
        branches: [],
        asks: [],
        run: {},
        events: [],
        ...patch,
    };
}

function stateOf(threads: Thread[], patch: Partial<DeskState> = {}): DeskState {
    return {
        next: { T: threads.length + 1, F: 1 },
        threads: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
        grants: [],
        seen: {},
        ...patch,
    };
}

const fact = (index: number, patch: Partial<NudgeFact> = {}): NudgeFact => ({
    delivery: UUIDS[index]!,
    event: "pull_request",
    action: "labeled",
    repo: "frostyard/test",
    number: 7,
    ...patch,
});

describe("nudgeDue", () => {
    test("20 seconds after the first nudge, and 60 seconds after the last nudged sync", () => {
        assert.equal(nudgeDue(T0, undefined), T0 + NUDGE_WINDOW_MS);
        assert.equal(nudgeDue(T0, T0 - 50_000), T0 + 20_000);
        assert.equal(nudgeDue(T0, T0 - 10_000), T0 + 50_000);
    });
});

describe("nudgeSupervisors", () => {
    test("a PR or a linked issue of a thread that is open, or closed and reopenable; refs without case", () => {
        const state = stateOf([
            threadOf({ prs: { "frostyard/Test#7": { via: "attached", state: "OPEN" } } }),
            threadOf({ id: "T2", supervisor: 42, issues: ["frostyard/test#9"] }),
        ]);

        assert.deepEqual(nudgeSupervisors(state, fact(0), T0), [SUPERVISOR]);
        assert.deepEqual(
            nudgeSupervisors(state, fact(0, { number: 9, event: "issues" }), T0),
            [42],
        );
        assert.deepEqual(nudgeSupervisors(state, fact(0, { number: 8 }), T0), []);
        assert.deepEqual(nudgeSupervisors(state, fact(0, { repo: "frostyard/other" }), T0), []);

        const closed = (why: "done" | "dropped", ago: number) =>
            stateOf([
                threadOf({
                    state: "closed",
                    closed: { at: T0 - ago, why, by: "sweep" },
                    prs: { "frostyard/test#7": { via: "attached", state: "MERGED" } },
                }),
            ]);

        assert.deepEqual(nudgeSupervisors(closed("done", 3600_000), fact(0), T0), [SUPERVISOR]);
        assert.deepEqual(nudgeSupervisors(closed("done", 8 * 24 * 3600_000), fact(0), T0), []);
        assert.deepEqual(nudgeSupervisors(closed("dropped", 3600_000), fact(0), T0), []);
    });

    test("a watch with no result that waits for the PR, in any thread state", () => {
        const watch = (result?: boolean) =>
            stateOf([
                threadOf({
                    state: "closed",
                    closed: { at: T0 - 30 * 24 * 3600_000, why: "dropped", by: "brian" },
                    watch: {
                        checkOn: "2026-12-01",
                        check: "it merged",
                        setAt: T0,
                        setBy: "brian",
                        key: "k",
                        on: { kind: "pr", ref: "Frostyard/test#7", event: "merged" },
                        ...(result === undefined
                            ? {}
                            : {
                                  result: {
                                      at: T0,
                                      by: "brian",
                                      pass: result,
                                      text: "x",
                                      key: "r",
                                  },
                              }),
                    },
                }),
            ]);

        assert.deepEqual(nudgeSupervisors(watch(), fact(0), T0), [SUPERVISOR]);
        assert.deepEqual(nudgeSupervisors(watch(true), fact(0), T0), []);
    });

    test("a sha with no number matches a PR head of a live thread", () => {
        const state = stateOf([
            threadOf({ prs: { "frostyard/test#7": { via: "seen", state: "OPEN", head: SHA1 } } }),
        ]);
        const status = fact(0, { event: "status", number: undefined, sha: SHA1 });

        delete status.number;
        assert.deepEqual(nudgeSupervisors(state, status, T0), [SUPERVISOR]);
        assert.deepEqual(nudgeSupervisors(state, { ...status, sha: "b".repeat(40) }, T0), []);
    });

    test("the queue: a queued ref, or a queue label on an issue, is every supervisor with a sweeper", () => {
        const state = stateOf([], {
            sweepers: { "50": "task-1", "7": "task-2" },
            issues: {
                at: T0,
                ok: true,
                items: [
                    {
                        ref: "frostyard/snosi#3",
                        title: "x",
                        url: "u",
                        urgent: false,
                        signals: ["queue"],
                        by: "bketelsen",
                        at: T0,
                        threads: [],
                        fixedBy: [],
                    },
                ],
                ignored: [],
                seen: {},
                urgentSeen: {},
            },
        });

        assert.deepEqual(
            nudgeSupervisors(
                state,
                fact(0, { repo: "frostyard/SNOSI", number: 3, event: "issues" }),
                T0,
            ),
            [7, 50],
        );
        assert.deepEqual(
            nudgeSupervisors(
                state,
                fact(0, { repo: "frostyard/new", number: 1, event: "issues", label: "needs-plan" }),
                T0,
            ),
            [7, 50],
        );
        assert.deepEqual(
            nudgeSupervisors(
                state,
                fact(0, { repo: "frostyard/new", number: 1, event: "issues", label: "bug" }),
                T0,
            ),
            [],
        );
        assert.deepEqual(
            nudgeSupervisors(
                state,
                fact(0, { repo: "frostyard/new", number: 1, label: "agent-queue" }),
                T0,
            ),
            [],
            "a label on a PR is not the queue",
        );
    });
});

describe("takeNudges", () => {
    const linked = () =>
        stateOf([threadOf({ prs: { "frostyard/test#7": { via: "attached", state: "OPEN" } } })]);

    test("50 facts over 19 seconds: 1 pending entry of 50, due 20 seconds after the first, and 1 start", () => {
        const nudges = emptyNudges();
        const state = linked();
        const started: number[][] = [];

        for (let index = 0; index < 50; index += 1) {
            const now = T0 + Math.floor((index * 19_000) / 49);
            const { result, start } = takeNudges(
                nudges,
                state,
                [fact(index, { at: now - 5 })],
                now,
            );

            assert.deepEqual(result.outcomes, { [UUIDS[index]!]: "matched" });
            assert.deepEqual(result.supervisors, [SUPERVISOR]);
            started.push(start);

            if (start.length > 0) {
                // The caller recorded the task it started.
                nudges.tasks[String(SUPERVISOR)] = "task-1";
            }
        }

        assert.deepEqual(started.flat(), [SUPERVISOR], "1 task start in all");
        assert.deepEqual(Object.keys(nudges.pending), [String(SUPERVISOR)]);

        const entry = nudges.pending[String(SUPERVISOR)]!;

        assert.equal(entry.count, 50);
        assert.equal(entry.first, T0);
        assert.equal(entry.due, T0 + NUDGE_WINDOW_MS);
        assert.equal(entry.deliveries.length, 50);
        assert.deepEqual(entry.deliveries[0], { id: UUIDS[0], at: T0 - 5 });

        // A second call, the task recorded: nothing to start.
        assert.deepEqual(takeNudges(nudges, state, [fact(50)], T0 + 19_500).start, []);
    });

    test("after a sync started, a new nudge waits 60 seconds from it", () => {
        const nudges = emptyNudges();
        const state = linked();

        nudges.last[String(SUPERVISOR)] = T0;
        nudges.tasks[String(SUPERVISOR)] = "task-1";
        nudges.running[String(SUPERVISOR)] = { started: T0, count: 1, deliveries: [] };

        const { start } = takeNudges(nudges, state, [fact(0)], T0 + 5_000);

        assert.deepEqual(start, [], "the running task takes the follow-up");
        assert.ok(nudges.pending[String(SUPERVISOR)]!.due >= T0 + NUDGE_GAP_MS);
        takeNudges(nudges, state, [fact(1)], T0 + 6_000);
        assert.equal(nudges.pending[String(SUPERVISOR)]!.count, 2, "further nudges join it");
    });

    test("a lost task heals: a pending entry 10 minutes past due starts a new one", () => {
        const nudges = emptyNudges();
        const state = linked();

        takeNudges(nudges, state, [fact(0)], T0);
        nudges.tasks[String(SUPERVISOR)] = "lost";
        assert.deepEqual(takeNudges(nudges, state, [fact(1)], T0 + 5 * 60_000).start, []);
        assert.deepEqual(takeNudges(nudges, state, [fact(2)], T0 + 11 * 60_000).start, [
            SUPERVISOR,
        ]);
    });

    test("the same delivery id twice is a duplicate; no match is unmatched and counted", () => {
        const nudges = emptyNudges();
        const state = linked();

        takeNudges(nudges, state, [fact(0)], T0);

        const again = takeNudges(
            nudges,
            state,
            [fact(0), fact(0, { delivery: UUIDS[0]!.toUpperCase() })],
            T0 + 1,
        );

        assert.deepEqual(again.result.outcomes, {
            [UUIDS[0]!]: "duplicate",
            [UUIDS[0]!.toUpperCase()]: "duplicate",
        });
        assert.equal(nudges.pending[String(SUPERVISOR)]!.count, 1);

        const none = takeNudges(nudges, state, [fact(1, { number: 99 })], T0 + 2);

        assert.deepEqual(none.result, { outcomes: { [UUIDS[1]!]: "unmatched" }, supervisors: [] });
        assert.equal(nudges.unmatched, 1);
        assert.ok(
            nudges.seen[UUIDS[1]!] !== undefined,
            "an unmatched delivery is seen: a redelivery is a duplicate",
        );
    });

    test("invalid facts: not recorded, not seen", () => {
        const nudges = emptyNudges();
        const state = linked();
        const bad: NudgeFact[] = [
            fact(0, { delivery: "not-a-uuid" }),
            fact(1, { repo: "frostyard" }),
            fact(2, { repo: "a/b/c" }),
            fact(3, { number: 0 }),
            fact(4, { number: 1.5 }),
            fact(5, { number: 2 ** 31 }),
            fact(6, { sha: "abc" }),
            fact(7, { sha: "A".repeat(40) }),
        ];
        const { result, start } = takeNudges(nudges, state, bad, T0);

        assert.deepEqual(Object.values(result.outcomes), Array(bad.length).fill("invalid"));
        assert.deepEqual(start, []);
        assert.deepEqual(nudges.seen, {});
        assert.deepEqual(nudges.pending, {});
        assert.equal(nudges.unmatched, 0);
    });

    test("more than 500 facts in 1 call is an error; the deliveries list is capped, the count is not", () => {
        const nudges = emptyNudges();
        const state = linked();
        const many = UUIDS.slice(0, NUDGE_FACTS_MAX + 1).map((_, index) => fact(index));

        assert.throws(() => takeNudges(nudges, state, many, T0), /at most 500 facts/);
        takeNudges(nudges, state, many.slice(0, NUDGE_FACTS_MAX), T0);
        assert.equal(nudges.pending[String(SUPERVISOR)]!.count, NUDGE_FACTS_MAX);
        assert.equal(nudges.pending[String(SUPERVISOR)]!.deliveries.length, NUDGE_DELIVERIES_MAX);
    });

    test("seen is pruned by age, then the oldest above the most", () => {
        const nudges = emptyNudges();

        nudges.seen = { old: T0 - NUDGE_SEEN_MS - 1, fresh: T0 - 1000 };
        takeNudges(nudges, stateOf([]), [], T0);
        assert.deepEqual(Object.keys(nudges.seen), ["fresh"]);

        nudges.seen = Object.fromEntries(
            Array.from({ length: NUDGE_SEEN_MAX + 2 }, (_, index) => [
                `id${String(index)}`,
                T0 - 100_000 + index,
            ]),
        );
        takeNudges(nudges, stateOf([]), [], T0);
        assert.equal(Object.keys(nudges.seen).length, NUDGE_SEEN_MAX);
        assert.equal(nudges.seen.id0, undefined);
        assert.equal(nudges.seen.id1, undefined);
        assert.notEqual(nudges.seen.id2, undefined);
    });
});

// ─── Observed changes ────────────────────────────────────────────────────────

const pr = (patch: Partial<PrFact> = {}): PrFact => ({
    ref: "frostyard/test#7",
    repo: "frostyard/test",
    number: 7,
    title: "A fix",
    url: "https://github.com/frostyard/test/pull/7",
    state: "OPEN",
    author: "github-viewer",
    createdAt: 200,
    headRefName: "fix-7",
    isDraft: false,
    mergeable: "MERGEABLE",
    review: "",
    checks: "PENDING",
    head: SHA1,
    ready: false,
    readyAt: 0,
    headAt: 100,
    mergedAt: 0,
    closedAt: 0,
    feedback: [],
    failing: [],
    archived: false,
    labels: ["bug"],
    ...patch,
});

const classes = (changes: { class: string; at: number }[]) =>
    changes.map((change) => `${change.class}@${String(change.at)}`);

describe("observePr", () => {
    const base = (patch: Partial<PrFact> = {}): ObservedSnap =>
        observePr(undefined, pr(patch), T0).snap;

    test("no earlier read: a baseline only", () => {
        const { snap, changes } = observePr(undefined, pr(), T0);

        assert.deepEqual(changes, []);
        assert.deepEqual(snap, {
            state: "OPEN",
            head: SHA1,
            labels: ["bug"],
            checks: "PENDING",
            review: "",
            seen: T0,
        });
    });

    test("state: merged at mergedAt, closed at closedAt, reopened at 0", () => {
        assert.deepEqual(
            classes(
                observePr(base(), pr({ state: "MERGED", mergedAt: 5, closedAt: 5 }), T0).changes,
            ),
            ["state@5"],
        );
        assert.deepEqual(
            classes(observePr(base(), pr({ state: "CLOSED", closedAt: 6 }), T0).changes),
            ["state@6"],
        );
        assert.deepEqual(classes(observePr(base({ state: "CLOSED" }), pr(), T0).changes), [
            "state@0",
        ]);
    });

    test("labels: a set change; ready-for-human added at readyAt; order is no change; a cut read compares nothing", () => {
        const ready = observePr(
            base(),
            pr({ labels: ["bug", "ready-for-human"], ready: true, readyAt: 9 }),
            T0,
        );

        assert.deepEqual(classes(ready.changes), ["labels@9"]);
        assert.deepEqual(classes(observePr(base(), pr({ labels: [] }), T0).changes), ["labels@0"]);
        assert.deepEqual(
            observePr(base({ labels: ["b", "a"] }), pr({ labels: ["a", "b"] }), T0).changes,
            [],
        );

        const cut = observePr(base(), pr({ labels: ["other"], labelsCut: true }), T0);

        assert.deepEqual(cut.changes, []);
        assert.deepEqual(cut.snap.labels, ["bug"], "a cut read keeps the earlier labels");
        assert.deepEqual(
            observePr(base({ labels: undefined }), pr(), T0).changes,
            [],
            "no earlier labels: nothing to compare",
        );
    });

    test("head: a new head at headAt; an empty head is no change", () => {
        assert.deepEqual(
            classes(observePr(base(), pr({ head: "b".repeat(40), headAt: 77 }), T0).changes),
            ["head@77"],
        );
        assert.deepEqual(observePr(base(), pr({ head: "" }), T0).changes, []);
    });

    test("ci: a new check state; an empty one is no change", () => {
        assert.deepEqual(classes(observePr(base(), pr({ checks: "SUCCESS" }), T0).changes), [
            "ci@0",
        ]);
        assert.deepEqual(observePr(base(), pr({ checks: "" }), T0).changes, []);
    });

    test("review: a new decision at 0; a later review time at that time", () => {
        assert.deepEqual(classes(observePr(base(), pr({ review: "APPROVED" }), T0).changes), [
            "review@0",
        ]);

        const reviewed = base({ reviewedAt: 10 });

        assert.deepEqual(classes(observePr(reviewed, pr({ reviewedAt: 20 }), T0).changes), [
            "review@20",
        ]);
        assert.deepEqual(observePr(reviewed, pr({ reviewedAt: 10 }), T0).changes, []);
        assert.deepEqual(observePr(reviewed, pr(), T0).changes, [], "a read with no review time");
    });
});

describe("observeIssue", () => {
    const issue = (
        patch: Partial<JudgedIssue> = {},
        signals?: ("queue" | "urgent" | "plan")[],
    ): JudgedIssue => ({
        ref: "frostyard/snosi#3",
        title: "x",
        url: "u",
        open: true,
        ignored: [],
        cut: false,
        closing: [],
        ...(signals === undefined
            ? {}
            : {
                  item: {
                      ref: "frostyard/snosi#3",
                      title: "x",
                      url: "u",
                      urgent: false,
                      signals,
                      by: "bketelsen",
                      at: 33,
                      threads: [],
                      fixedBy: [],
                  },
              }),
        ...patch,
    });

    test("a baseline, then state and signals", () => {
        const first = observeIssue(undefined, issue({}, ["queue"]), T0);

        assert.deepEqual(first.changes, []);
        assert.deepEqual(
            classes(observeIssue(first.snap, issue({ open: false }, ["queue"]), T0).changes),
            ["state@0"],
        );
        assert.deepEqual(
            classes(observeIssue(first.snap, issue({}, ["plan", "queue"]), T0).changes),
            ["labels@33"],
        );
        assert.deepEqual(classes(observeIssue(first.snap, issue(), T0).changes), ["labels@0"]);
        assert.deepEqual(
            observeIssue(first.snap, issue({ cut: true }), T0).changes,
            [],
            "a cut read proves nothing",
        );

        const change = observeIssue(first.snap, issue({ open: false }, ["queue"]), T0).changes[0];

        assert.deepEqual(change, {
            repo: "frostyard/snosi",
            number: 3,
            kind: "issue",
            class: "state",
            at: 0,
            seen: T0,
        });
    });

    test("recordObserved: once per ref without case, the queue only when it worked, changes capped, old refs forgotten", () => {
        const observed = { last: {}, changes: [] } as {
            last: Record<string, ObservedSnap>;
            changes: { class: string; at: number }[];
        };
        const github = (patch: Partial<PrFact>) => ({
            viewer: "v",
            repos: {
                "frostyard/test": {
                    archived: false,
                    open: [pr({ ref: "frostyard/TEST#7", ...patch })],
                },
            },
            prs: { "frostyard/test#7": pr(patch) },
        });

        recordObserved(observed as never, github({}), undefined, T0);
        assert.deepEqual(Object.keys(observed.last), ["frostyard/test#7"]);
        recordObserved(observed as never, github({ checks: "SUCCESS" }), undefined, T0 + 1);
        assert.deepEqual(classes(observed.changes), ["ci@0"], "1 change, not 1 for each list");

        const queue = (error?: string) => ({
            found: [issue({}, ["queue"])],
            checked: {},
            unread: [],
            ...(error === undefined ? {} : { error }),
        });

        recordObserved(observed as never, undefined, queue("down"), T0 + 2);
        assert.equal(
            observed.last["frostyard/snosi#3"],
            undefined,
            "a failed queue read records nothing",
        );
        recordObserved(observed as never, undefined, queue(), T0 + 3);
        assert.notEqual(observed.last["frostyard/snosi#3"], undefined);

        observed.changes = Array.from({ length: OBSERVED_KEPT }, () => ({ class: "ci", at: 0 }));
        recordObserved(
            observed as never,
            github({ checks: "FAILURE" }),
            undefined,
            T0 + 31 * 24 * 3600_000,
        );
        assert.equal(observed.changes.length, OBSERVED_KEPT);
        assert.deepEqual(
            Object.keys(observed.last),
            ["frostyard/test#7"],
            "the issue no sweep read for 30 days left",
        );
    });
});

// ─── With the Pi Pocket app ─────────────────────────────────────────────────

const dataDir = join(root, "data");
const definitions = join(root, "agents");
const configPath = join(root, "desk.json");
const fixturePath = join(root, "github.json");
const fakeGh = join(root, "fake-gh.sh");
const REF = "frostyard/test#7";

let shift = 0;
let app: App;
let supervisorId: ConversationId;
let threadId = "";

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
/** Pi, scripted: `run-tool <name> <json>` calls that tool once; a tool result gets "ok". */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    const run = /run-tool (\S+) (\{.*\})\s*$/s.exec(text);

    if (run !== null) {
        return fauxAssistantMessage(
            [fauxToolCall(run[1] ?? "", JSON.parse(run[2] ?? "{}") as object)],
            {
                stopReason: "toolUse",
            },
        );
    }

    return answer(`echo: ${text}`);
});

const deskApi = () =>
    (globalThis as unknown as Record<symbol, DeskApi | undefined>)[
        Symbol.for("pi-pocket-team.desk")
    ];
const nudgesNow = async () => (await app.harness.snapshot(DeskNudges, context))!;
const threadNow = async () =>
    (await app.harness.snapshot(DeskThreads, context))!.threads[threadId]!;

/** The live tasks of a kind. */
async function liveTasks(kind: string) {
    return (await app.harness.inspect(context)).tasks.filter((task) => task.record.kind === kind);
}

/** The shared runner of this data folder, as `desk.ts` keeps it. */
function sharedRunnerOfApp(): SyncRunner {
    const runners = (
        globalThis as unknown as Record<
            symbol,
            Map<string, { version: number; runner: SyncRunner }>
        >
    )[Symbol.for("pi-pocket-team.desk.runner")];
    const slot = runners?.get(dataDir);

    assert(slot !== undefined, "desk.ts keeps a runner for the data folder");

    return slot.runner;
}

const facts = (count: number, from = 0): NudgeFact[] =>
    Array.from({ length: count }, (_, index) => ({
        delivery: UUIDS[from + index]!,
        at: Date.now() + shift - 1000 + index,
        event: "pull_request",
        action: "synchronize",
        repo: "frostyard/test",
        number: 7,
    }));

async function nudge(list: NudgeFact[]) {
    const api = deskApi();

    assert(api?.nudge !== undefined, "the desk publishes nudge");

    let result: Awaited<ReturnType<NonNullable<DeskApi["nudge"]>>> | undefined;

    await app.harness.commit(async (tx) => {
        result = await api.nudge!(tx, list, Date.now() + shift);
    }, context);

    return result!;
}

async function restartApp(by: number): Promise<void> {
    await app.close();
    shift = by;
    app = await openApp(model, dataDir, () => Date.now() + shift);
}

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;
    mkdirSync(definitions, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
    );

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });

    for (const each of ["desk.ts", "_desk-usage.ts", "_desk-dashboard.ts", "_desk-metrics.ts"]) {
        cpSync(join(import.meta.dirname, each), join(dropIns, each));
    }

    cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), { recursive: true });
    // A fake `gh`: every read gets this answer, and nothing goes to GitHub.
    writeFileSync(fixturePath, JSON.stringify({ data: { viewer: { login: "github-viewer" } } }));
    writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`, { mode: 0o755 });
    process.env.PI_POCKET_DESK_GH = fakeGh;
    process.env.PI_POCKET_DESK_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));

    app = await openApp(model, dataDir, () => Date.now() + shift);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);

    const folder = join(root, "odrade");

    mkdirSync(folder, { recursive: true });
    supervisorId = await newSession(app, folder);

    const commandId = app.webs.commands().find((each) => each.name === "team-agent")?.id;

    await app.extensionCommands.run(supervisorId, owner(app), {
        commandId,
        args: "odrade",
        requestId: crypto.randomUUID(),
    });

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);
        const { thread } = openThread(state, {
            key: "x.test.nudge:T1",
            supervisor: Number(supervisorId),
            agents: ["odrade"],
            repo: "frostyard/test",
            title: "A PR the hooks know",
            at: Date.now(),
        });
        const stored = state.threads[thread.id]!;

        threadId = thread.id;
        stored.state = "open";
        stored.prs[REF] = { via: "attached", state: "OPEN" };
        delete stored.session;
        delete stored.address;
        stored.run = { busy: false };
    }, context);
});

after(async () => {
    await app?.close();
    cleanUp();
});

describe("nudge in Pocket", () => {
    test("50 facts for a thread's PR: 1 task, 1 sync after the due time with the delivery times, then the task ends", async () => {
        const sent = facts(50);
        const result = await nudge(sent);

        assert.deepEqual(result.supervisors, [Number(supervisorId)]);
        assert.deepEqual(new Set(Object.values(result.outcomes)), new Set(["matched"]));

        const tasks = await liveTasks("x.desk.nudge");

        assert.equal(tasks.length, 1, "1 task");
        assert.equal(tasks[0]!.record.conversationId, Number(supervisorId));

        const pending = (await nudgesNow()).pending[String(supervisorId)]!;

        assert.equal(pending.count, 50);
        assert.equal((await nudgesNow()).tasks[String(supervisorId)], String(tasks[0]!.record.id));
        await until(
            async () =>
                (await liveTasks("x.desk.nudge")).every(
                    (task) => (task.record.state as { status?: string }).status === "sleeping",
                ),
            "the task sleeps until its due time",
        );
        assert.equal((await nudgesNow()).syncs.length, 0, "no sync before the due time");

        await restartApp(NUDGE_WINDOW_MS + 10_000);
        await until(
            async () =>
                (await nudgesNow()).syncs.length === 1 &&
                (await liveTasks("x.desk.nudge")).length === 0,
            "the nudged sync and the end of its task",
            20_000,
        );

        const nudges = await nudgesNow();
        const sync = nudges.syncs[0]!;

        assert.equal(sync.supervisor, Number(supervisorId));
        assert.equal(sync.count, 50);
        assert.equal(sync.deliveries.length, 50);
        assert.deepEqual(
            sync.deliveries,
            sent.map((one) => ({ id: one.delivery, at: one.at })),
        );
        assert.equal(sync.error, undefined);
        assert.ok(sync.started >= pending.due, "it started at or after its due time");
        assert.ok(sync.committed >= sync.started);
        assert.deepEqual(nudges.tasks, {});
        assert.deepEqual(nudges.pending, {});
        assert.deepEqual(nudges.running, {});
        assert.ok(
            Number((await threadNow()).run.sweptAt) >= sync.started,
            "the sync swept the thread",
        );
    });

    test("the same delivery ids again change nothing", async () => {
        const before = JSON.stringify(await nudgesNow());
        const result = await nudge(facts(50));

        assert.deepEqual(new Set(Object.values(result.outcomes)), new Set(["duplicate"]));
        assert.deepEqual(result.supervisors, []);
        assert.equal((await liveTasks("x.desk.nudge")).length, 0);

        const now = await nudgesNow();

        assert.deepEqual(now.pending, {});
        assert.equal(now.syncs.length, 1);
        assert.deepEqual(Object.keys(now.seen).sort(), Object.keys(JSON.parse(before).seen).sort());
    });

    test("while the lane is busy, desk sync waits: it commits only after the work before it ended", async () => {
        const runner = sharedRunnerOfApp();
        const supervisor = Number(supervisorId);
        let release: (() => void) | undefined;
        const held = runner.run(supervisor, "test", async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });

        await until(() => release !== undefined, "the test work holds the lane");

        const before = (await threadNow()).run.sweptAt;
        const call = say(app, supervisorId, `run-tool desk ${JSON.stringify({ action: "sync" })}`);

        await until(
            () => runner.waiting(supervisor).includes("sync"),
            "desk sync waits in the lane",
        );
        assert.equal(
            (await threadNow()).run.sweptAt,
            before,
            "no sync commit while the lane is held",
        );

        release!();
        await held;
        await call;
        assert.notEqual(
            (await threadNow()).run.sweptAt,
            before,
            "the sync committed after the work ended",
        );
        assert.equal(runner.busy(supervisor), false);
    });

    test("each sync records the changes it saw on the PR: a baseline first, then a new head", async () => {
        const node = (oid: string) => ({
            nameWithOwner: "frostyard/test",
            isArchived: false,
            pullRequest: {
                number: 7,
                title: "A fix",
                url: "https://github.com/frostyard/test/pull/7",
                state: "OPEN",
                isDraft: false,
                createdAt: "2026-11-10T10:00:00Z",
                headRefName: "fix-7",
                mergeable: "MERGEABLE",
                reviewDecision: "",
                author: { login: "github-viewer" },
                labels: { nodes: [] },
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid,
                                committedDate: "2026-11-10T11:00:00Z",
                                statusCheckRollup: {
                                    state: "PENDING",
                                    contexts: { totalCount: 0, nodes: [] },
                                },
                            },
                        },
                    ],
                },
            },
        });
        const answerWith = (oid: string) =>
            writeFileSync(
                fixturePath,
                JSON.stringify({ data: { viewer: { login: "github-viewer" }, p0: node(oid) } }),
            );
        const sync = () =>
            say(app, supervisorId, `run-tool desk ${JSON.stringify({ action: "sync" })}`);

        answerWith(SHA1);
        await sync();

        const first = (await app.harness.snapshot(DeskObserved, context))!;

        assert.equal(first.last[REF]?.head, SHA1, "a baseline of the PR");
        assert.equal(first.last[REF]?.state, "OPEN");

        const changes = first.changes.length;

        answerWith("b".repeat(40));
        await sync();

        const next = (await app.harness.snapshot(DeskObserved, context))!;
        const added = next.changes.slice(changes);

        assert.deepEqual(
            added.map((change) => [
                change.repo,
                change.number,
                change.kind,
                change.class,
                change.at,
            ]),
            [["frostyard/test", 7, "pr", "head", Date.parse("2026-11-10T11:00:00Z")]],
        );
    });
});
