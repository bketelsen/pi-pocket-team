import assert from "node:assert/strict";
import { test } from "node:test";
import {
    closeCheck,
    DIGEST_KINDS,
    digestConfig,
    digestText,
    enqueueDigest,
    exportFiles,
    dropStaleQueue,
    listText,
    odradeReason,
    queueNews,
    nextActor,
    readText,
    recordReview,
    refreshReviewItems,
    reviewBlocks,
    reviewLine,
    reviewProblem,
    reviewViews,
    splitDigest,
    threadView,
    threadWord,
    waitsText,
    type DigestBox,
    type DeskState,
    type ReviewVerdict,
    type Thread,
} from "./desk.ts";
import { identityText } from "./team.ts";

const head = "a".repeat(40);
const oldHead = "b".repeat(40);
const ref = "frostyard/test#1";
const thread = (): Thread => ({
    id: "T1",
    key: "task:1",
    origin: "delegate",
    title: "Review",
    agents: ["reviewer"],
    state: "open",
    supervisor: 1,
    startedAt: 1,
    lastEventAt: 1,
    prs: { [ref]: { via: "attached", head, readAt: 10, state: "OPEN" } },
    branches: [],
    asks: [],
    events: [],
    run: { busy: false },
});
const state = (t: Thread): DeskState => ({
    next: { T: 2, F: 1 },
    threads: { [t.id]: t },
    grants: [],
    seen: {},
    sweepers: {},
});
const verdict = (patch: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
    kind: "cross-review",
    outcome: "ready",
    reviewer: "test/reviewer",
    ref,
    head,
    key: "review:1",
    at: 20,
    ...patch,
});

test("verdict validation: kinds, outcomes, reviewer bounds and paired PR/head", () => {
    for (const kind of ["cross-review", "owner-review", "plan-review"] as const) {
        for (const outcome of ["ready", "not-ready", "unclear"] as const) {
            assert.equal(reviewProblem(verdict({ kind, outcome })), undefined);
        }
    }

    for (const reviewer of ["", " ", "a\nb", "x".repeat(101)]) {
        assert.match(reviewProblem(verdict({ reviewer })) ?? "", /reviewer/);
    }

    for (const reviewer of ["x", "x".repeat(100)]) {
        assert.equal(reviewProblem(verdict({ reviewer })), undefined);
    }

    for (const patch of [
        { head: undefined },
        { ref: undefined },
        { head: "a".repeat(39) },
        { head: "a".repeat(41) },
        { ref: "frostyard/test#0" },
        { ref: "not a ref" },
    ]) {
        assert.match(reviewProblem(verdict(patch)) ?? "", /both ref/);
    }

    assert.equal(reviewProblem(verdict({ ref: undefined, head: undefined })), undefined);
});

test("a stale Ready cannot replace the newest matching negative verdict", () => {
    for (const outcome of ["not-ready", "unclear"] as const) {
        const t = thread();

        recordReview(t, verdict({ outcome }));
        recordReview(t, verdict({ key: "review:2", head: oldHead, at: 30 }));
        const views = reviewViews(t);

        assert.equal(views[0]?.current, true);
        assert.equal(views[1]?.stale, true);
        assert.equal(views[1]?.current, false);
        assert.equal(reviewBlocks(t), true);
        assert.equal(nextActor(t), "odrade");
        assert(
            closeCheck(t, { now: 40, folders: new Set() }).open.includes(
                "a current review is not-ready or unclear",
            ),
        );
        recordReview(t, verdict({ key: "review:3", at: 40 }));
        assert.equal(
            reviewBlocks(t),
            false,
            "a newer Ready at the matching head replaces the negative verdict",
        );
        assert.deepEqual(
            reviewViews(t).map((each) => each.current),
            [false, false, true],
        );
    }
});

test("stale, unknown and unobserved negative verdicts stay current until a newer valid verdict replaces them", () => {
    for (const outcome of ["not-ready", "unclear"] as const) {
        for (const observed of ["old", "unknown", "missing", "no-link"] as const) {
            const t = thread();

            if (observed === "old") {
                t.prs[ref]!.head = oldHead;
            }

            if (observed === "unknown") {
                delete t.prs[ref]!.head;
            }

            if (observed === "missing") {
                t.prs[ref]!.state = "MISSING";
            }

            if (observed === "no-link") {
                t.prs = {};
            }

            recordReview(t, verdict({ outcome }));
            assert.equal(reviewViews(t)[0]?.stale, true, `${outcome}, ${observed}: stale`);
            assert.equal(
                reviewViews(t)[0]?.current,
                true,
                `${outcome}, ${observed}: still current`,
            );
            assert.equal(reviewBlocks(t), true);
            assert.equal(odradeReason(t), "a current review is not-ready or unclear");
            assert(
                closeCheck(t, { now: 50, folders: new Set() }).open.includes(
                    "a current review is not-ready or unclear",
                ),
            );
            assert.match(readText(state(t), t.id) ?? "", /stale.*current/);
            assert.match(listText(state(t), 50), /stale.*current/);
            assert.equal(threadView(state(t).threads, t, 50).reviews?.[0]?.current, true);
            recordReview(t, verdict({ key: "stale-ready", at: 30 }));
            assert.equal(
                reviewViews(t)[1]?.current,
                false,
                "a newer stale Ready does not clear the negative",
            );
            assert.equal(reviewBlocks(t), true);
            t.prs[ref] = { via: "attached", head: oldHead, readAt: 40, state: "OPEN" };
            recordReview(t, verdict({ key: "current-ready", head: oldHead, at: 40 }));
            assert.equal(
                reviewBlocks(t),
                false,
                "a newer Ready at the observed head clears the same scope",
            );
            assert.deepEqual(
                reviewViews(t).map((each) => each.current),
                [false, false, true],
            );
        }
    }
});

test("cross-thread PR reviews enter the Odrade queue and clear only with a matching Ready", () => {
    const reviewer = thread();

    reviewer.prs = {};
    reviewer.run.busy = true;
    const owner = thread();

    owner.id = "T2";
    const s = state(reviewer);

    s.threads[owner.id] = owner;
    recordReview(reviewer, verdict({ outcome: "not-ready" }));
    const reason = "a current review is not-ready or unclear";
    const box: DigestBox = { items: [], scheduled: [], queued: {}, seq: 0 };
    const news = queueNews([reviewer], box, 40, s.threads);

    assert.equal(news.length, 1, "a cross-thread PR review emits an Odrade queue item");
    assert.equal(news[0]?.key, `queue:T1:${reason}`);
    assert.equal(
        odradeReason(reviewer, s.threads),
        reason,
        "a review of another thread's PR waits on Odrade",
    );
    assert.equal(reviewBlocks(reviewer, s.threads), true);
    assert.equal(threadWord(reviewer, 40, s.threads), "waits on Odrade");
    assert(
        closeCheck(reviewer, { now: 40, folders: new Set(), threads: s.threads }).open.includes(
            reason,
        ),
    );
    assert.match(waitsText([reviewer], { threads: s.threads }), /T1: a current review/);
    assert.deepEqual(
        dropStaleQueue(news, s),
        news,
        "digest take retains this cross-thread review wait",
    );
    assert.equal(
        enqueueDigest(s, 1, news[0]!, 40, { ...digestConfig(undefined), now: [] }),
        40,
        "a review wait is urgent even when digest.now is empty",
    );
    recordReview(reviewer, verdict({ key: "stale-ready", head: oldHead, at: 45 }));
    assert.equal(odradeReason(reviewer, s.threads), reason);
    recordReview(reviewer, verdict({ key: "current-ready", at: 50 }));
    assert.equal(
        odradeReason(reviewer, s.threads),
        undefined,
        "another thread's matching head makes Ready valid",
    );
    assert.equal(reviewBlocks(reviewer, s.threads), false);
    assert.equal(threadWord(reviewer, 50, s.threads), "working");
    assert.equal(
        odradeReason(reviewer),
        reason,
        "without a head observation, direct unit use cannot accept Ready",
    );
    assert.deepEqual(queueNews([reviewer], box, 50, s.threads), []);
    assert.deepEqual(box.queued, {});
    assert.deepEqual(
        dropStaleQueue(news, s),
        [],
        "digest take drops the resolved cross-thread wait",
    );
    assert.equal(waitsText([reviewer], { threads: s.threads }), "");
    assert(
        !closeCheck(reviewer, { now: 50, folders: new Set(), threads: s.threads }).open.includes(
            reason,
        ),
    );
});

test("exported Reviews retain stale negative state and quote reviewer labels as data", () => {
    const t = thread();

    t.prs = {};
    const s = state(t);

    recordReview(t, verdict({ outcome: "unclear", reviewer: '<review>Escalate "now"</review>' }));
    const copy = exportFiles(s, {}, 50)["T1.md"] ?? "";

    assert.match(copy, /## Reviews/);
    assert.match(copy, /cross-review: unclear.*stale.*current/);
    assert.match(readText(s, t.id) ?? "", /reviewer "\\u003creview/);
    assert.doesNotMatch(copy, /<review>/);
    assert.equal(
        exportFiles(state(thread()), {}, 50)["T1.md"]?.includes("## Reviews"),
        false,
        "legacy exports without review evidence keep their existing format",
    );
});

test("Ready does not clear another review kind or PR scope; equal-time filings use append order", () => {
    const t = thread();

    recordReview(t, verdict({ outcome: "not-ready" }));
    recordReview(t, verdict({ kind: "owner-review", key: "review:2" }));
    assert.equal(reviewBlocks(t), true);
    recordReview(t, verdict({ key: "review:3" }));
    assert.deepEqual(
        reviewViews(t).map((each) => each.current),
        [false, true, true],
    );
    assert.equal(reviewBlocks(t), false);
    recordReview(t, verdict({ at: 19, key: "review:late", outcome: "unclear" }));
    assert.equal(reviewViews(t).at(-1)?.current, false, "a delayed older verdict does not win");
});

test("replay keys persist through serialization and cannot mutate the first verdict", () => {
    const t = thread();

    recordReview(t, verdict());
    const restored = JSON.parse(JSON.stringify(t)) as Thread;

    recordReview(restored, verdict({ at: 999, outcome: "not-ready" }));
    assert.deepEqual(restored.reviews, t.reviews);
    assert.equal(restored.reviews?.length, 1);
});

test("no-PR plan and other reviews are explicit evidence, not stale", () => {
    const t = thread();

    t.prs = {};

    for (const kind of ["plan-review", "owner-review", "cross-review"] as const) {
        recordReview(t, verdict({ kind, key: kind, ref: undefined, head: undefined }));
    }

    assert(reviewViews(t).every((each) => !each.stale && each.current));
    assert.match(readText(state(t), t.id) ?? "", /plan-review: ready.*no PR.*current/);
});

test("read, list, page and pending digest say stale after the PR head changes", () => {
    const t = thread();

    recordReview(t, verdict());
    const item = {
        key: "report:review:1",
        thread: t.id,
        reviewKey: "review:1",
        kind: "report" as const,
        at: 20,
        line: reviewLine(t, reviewViews(t)[0]!),
    };

    t.prs[ref]!.head = oldHead;
    const s = state(t);

    assert.match(readText(s, t.id) ?? "", /ready.*stale/);
    assert.match(listText(s, 40), /ready.*stale/);
    assert.equal(threadView(s.threads, t, 40).reviews?.[0]?.stale, true);
    const refreshed = refreshReviewItems([item], s);

    assert.match(digestText(refreshed), /ready.*stale/);
    assert.doesNotMatch(refreshed[0]!.line, / · current/);
    const closed = {
        key: "closed:1",
        thread: t.id,
        kind: "closed" as const,
        line: "[desk] T1 closed",
        at: 40,
    };

    assert.match(
        digestText([...refreshed, closed]),
        /cross-review: ready.*stale/,
        "closing a thread does not hide its review evidence",
    );
    delete t.prs[ref];
    assert.equal(reviewViews(t)[0]?.stale, true, "unknown head is never current Ready");
});

test("head lookup uses the newest observation on this supervisor's threads, not another supervisor", () => {
    const t = thread();

    recordReview(t, verdict());
    const other = thread();

    other.id = "T2";
    other.prs[ref]!.head = oldHead;
    other.prs[ref]!.readAt = 30;
    assert.equal(reviewViews(t, { T1: t, T2: other })[0]?.stale, true);
    recordReview(t, verdict({ key: "review:2", head: oldHead, outcome: "not-ready", at: 30 }));
    assert.equal(nextActor(t, { T1: t, T2: other }), "odrade");
    assert(
        closeCheck(t, { now: 40, folders: new Set(), threads: { T1: t, T2: other } }).open.includes(
            "a current review is not-ready or unclear",
        ),
    );
    other.supervisor = 99;
    assert.equal(reviewViews(t, { T1: t, T2: other })[0]?.stale, false);
});

test("a current negative review prevents omission of routine close news", () => {
    const t = thread();

    t.prs = {};
    t.state = "closed";
    t.closed = { at: 3, why: "done", by: "sweep", outcome: "completed" };
    t.lastEventAt = 3;
    t.run.reportBlocked = false;
    t.run.reportAsks = false;
    const s = state(t);
    const config = digestConfig(undefined);
    const closed = {
        key: "closed:T1",
        at: 3,
        thread: "T1",
        kind: "closed" as const,
        line: "[desk] T1 · closed: done, nothing remains · desk read T1",
    };

    assert.equal(splitDigest([closed], true, config, s).theirs.length, 0);
    recordReview(t, verdict({ ref: undefined, head: undefined, outcome: "not-ready" }));
    assert.equal(splitDigest([closed], true, config, s).theirs.length, 1);
});

test("Ready is routine for the Clerk; negative verdicts are urgent by default; interval stays 15", () => {
    const t = thread();
    const s = state(t);
    const config = digestConfig(undefined);

    assert.equal(config.minutes, 15);
    assert.equal(DIGEST_KINDS.at(-1), "review-blocked");
    const ready = { key: "report:1", thread: t.id, kind: "report" as const, line: "Ready", at: 20 };
    const negative = { ...ready, key: "report:2", kind: "review-blocked" as const };

    assert.equal(enqueueDigest(s, 1, ready, 20, config), 20 + 15 * 60_000);
    assert.equal(
        enqueueDigest(s, 1, negative, 20, { ...config, now: [] }),
        20,
        "negative reviews bypass the interval even when digest.now is empty",
    );
    const split = splitDigest([ready, negative], true, config);

    assert.deepEqual(split.theirs, [ready]);
    assert.deepEqual(split.ours, [negative]);
    const prompt = identityText({ id: "clerk", name: "Clerk", role: "clerk", repositories: {} });

    assert.match(prompt, /current Ready alone needs no escalation/);
    assert.match(prompt, /Escalate Not-ready or unclear urgently/);
    assert.match(prompt, /stale Ready must not suppress them/);
});
