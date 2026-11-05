// The cross-review parsers and joins of `audit/reviews.mjs`, on invented texts in the shapes of real reviewer briefs
// and answers. No real text is here.
import assert from "node:assert/strict";
import test from "node:test";
import { DAY, MINUTE } from "./common.mjs";
import { NOW, ago, emptyData, thread, threadMap } from "./fixtures/builders.mjs";
import {
    ANSWER,
    blockingItems,
    callPr,
    guardCacheOf,
    headIn,
    ownersOf,
    prRefsIn,
    reviewPoints,
    reviewRounds,
    threadAt,
    verdictIn,
} from "./reviews.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(39) + "1";
const SHA_C = "c0ffee".repeat(6) + "abcd";

// ---------- prRefsIn ----------

test("prRefsIn: a repository then `PR #N` on the same line is 1 ref", () => {
    assert.deepEqual(prRefsIn("Repository: frostyard/repogen, PR #87. Review the diff."), {
        refs: ["frostyard/repogen#87"],
        bare: [],
    });
});

test("prRefsIn: a worktree path is no ref; the repository in parentheses after it is", () => {
    assert.deepEqual(
        prRefsIn("Work in /var/home/team/projects/fleet--teg-bc9fe05d (bketelsen/fleet, PR #110)."),
        { refs: ["bketelsen/fleet#110"], bare: [] },
    );
    // A path alone names no PR, and its parts are no repository.
    assert.deepEqual(prRefsIn("Read /var/home/team/projects/acme/widgets/README.md, PR 4"), {
        refs: [],
        bare: [4],
    });
});

test("prRefsIn: a PR URL, an OWNER/NAME#N and `pull request #N`, in text order, each once", () => {
    assert.deepEqual(
        prRefsIn(
            [
                "First acme/widgets#12, then https://github.com/acme/gadgets/pull/7.",
                "Again acme/widgets#12, and acme/tools pull request #3.",
            ].join("\n"),
        ),
        { refs: ["acme/widgets#12", "acme/gadgets#7", "acme/tools#3"], bare: [] },
    );
    // A ref inside a longer path or word is not one.
    assert.deepEqual(prRefsIn("see x/acme/widgets#5 and ./acme/widgets#6").refs, []);
});

test("prRefsIn: bare numbers are `PR #N`, `PR N` and `pull request #N` that are not the number of a ref", () => {
    assert.deepEqual(
        prRefsIn("Review PR #41. Compare with PR 40 and pull request #39. acme/widgets#41 is it."),
        { refs: ["acme/widgets#41"], bare: [40, 39] },
    );
    // A repository and a PR more than 40 characters apart, or with a `#` between, are no ref.
    assert.deepEqual(prRefsIn("acme/widgets is the repository of this long sentence about PR #8"), {
        refs: [],
        bare: [8],
    });
    assert.deepEqual(prRefsIn("acme/widgets, issue #4, PR #9"), { refs: [], bare: [9] });
    assert.deepEqual(prRefsIn(""), { refs: [], bare: [] });
});

// ---------- headIn ----------

test("headIn: the SHA after the word head; else the second SHA of a range or a pair; else null", () => {
    assert.equal(headIn(`Base ${SHA_A}\nHead: \`${SHA_B}\``), SHA_B);
    assert.equal(headIn(`Review the PR head (${SHA_C}) only.`), SHA_C);
    assert.equal(headIn(`git diff ${SHA_A}..${SHA_B}`), SHA_B);
    assert.equal(headIn(`git diff ${SHA_A}...${SHA_C}`), SHA_C);
    assert.equal(headIn(`base and head: ${SHA_A} ${SHA_B}`), SHA_A);
    assert.equal(headIn(`git diff ${SHA_A} ${SHA_B}`), SHA_B);
    // A SHA too far after `head`, a short SHA, or no SHA: null.
    assert.equal(headIn(`The head commit of the branch that we reviewed is ${SHA_A}`), null);
    assert.equal(headIn("head abc1234"), null);
    assert.equal(headIn(undefined), null);
});

// ---------- blockingItems and verdictIn ----------

test("blockingItems: each answer format gives its item labels", () => {
    // A numbered list with the severity in bold.
    assert.deepEqual(
        blockingItems(
            [
                "1. **Medium · Blocking: yes** — `src/a.ts:12`",
                "   Text.",
                "2. **Low · Blocking: no** — `src/b.ts:3`",
                "3. **High · Blocking: yes · `src/c.ts:9`**",
            ].join("\n"),
        ),
        ["1", "3"],
    );
    // A heading, then a bullet that says it is blocking.
    assert.deepEqual(
        blockingItems(
            "### 1. A missing check\n\n- **Severity:** medium\n- **Blocking:** yes\n\n### 2. A typo\n- **Blocking:** no",
        ),
        ["1"],
    );
    // Lettered items, and lettered re-review items.
    assert.deepEqual(
        blockingItems(
            "**A1 — Medium; blocking: yes**\n**A2 — Low; blocking: no**\n**B1 — Medium; blocking: yes**",
        ),
        ["A1", "B1"],
    );
    assert.deepEqual(
        blockingItems("**A-R1 — Medium; blocking: yes**\n**A-R2 — Low; blocking: no**"),
        ["A-R1"],
    );
    // A resolved item that was blocking is no point.
    assert.deepEqual(
        blockingItems("1. **Resolved — Medium · Previously blocking**\n2. **Resolved — Low**"),
        [],
    );
    // 1 unnumbered point is `#1`.
    assert.deepEqual(blockingItems("**Severity: medium · Blocking: yes**\nThe test is missing."), [
        "#1",
    ]);
    // No blocking point.
    assert.deepEqual(blockingItems("**Blocking: none**"), []);
    assert.deepEqual(blockingItems("### 1. Medium — blocking: yes\n### 2. Low — blocking: yes"), [
        "1",
        "2",
    ]);
});

test("verdictIn: Not ready is false, Ready is true, neither is null", () => {
    assert.equal(verdictIn("**Not ready.** Blocking: yes"), false);
    assert.equal(verdictIn("Verdict: Ready. Blocking: none."), true);
    assert.equal(verdictIn("It is already merged."), null);
    assert.equal(verdictIn(""), null);
});

test("ANSWER: a subagent answer, maybe after a from mark; other texts are not", () => {
    assert.equal(ANSWER.exec("[subagent xr-1 answered, no reply needed] Ready")?.[1], "xr-1");
    assert.equal(ANSWER.exec("[from: Brian] [subagent rv answered] Not ready")?.[1], "rv");
    assert.equal(ANSWER.exec("Please see [subagent rv answered]"), null);
    assert.equal(ANSWER.exec("[subagent rv failed]"), null);
});

// ---------- Joins ----------

const t1 = thread("T1", { repo: "acme/widgets", prs: { "other/thing#2": {} } });

test("ownersOf: the lower-case owners of each thread's repo and PRs", () => {
    assert.deepEqual(
        [...ownersOf({ threads: threadMap(t1, thread("T2", { repo: "Bketelsen/fleet" })) })].sort(),
        ["acme", "bketelsen", "other"],
    );
});

test("callPr: the first desk-owner ref; else a bare number in the thread's repository; else null", () => {
    const data = { threads: threadMap(t1) };
    const call = (over: object) => ({ c: t1.session, at: NOW, refs: [], bare: [], ...over });

    assert.deepEqual(callPr(call({ refs: ["stranger/x#1", "acme/widgets#4"] }), data), {
        ref: "acme/widgets#4",
        count: 1,
        refs: ["acme/widgets#4"],
    });
    assert.deepEqual(callPr(call({ refs: ["acme/widgets#4", "ACME/gadgets#5"] }), data).count, 2);
    assert.equal(callPr(call({ bare: [9, 10] }), data).ref, "acme/widgets#9");
    // A ref of a stranger and a bare number: the bare number in the thread's repository.
    assert.equal(callPr(call({ refs: ["stranger/x#1"], bare: [9] }), data).ref, "acme/widgets#9");
    // No thread for the session.
    assert.equal(callPr(call({ c: 999, bare: [9] }), data).ref, null);
    assert.equal(callPr(call({}), data).ref, null);
});

test("threadAt: the latest thread of a session started at or before the time", () => {
    const old = thread("T1", { session: 5, startedAt: ago(5 * DAY) });
    const now = thread("T2", { session: 5, startedAt: ago(DAY) });
    const data = { threads: threadMap(old, now) };

    assert.equal(threadAt(data, 5, ago(2 * DAY))?.id, "T1");
    assert.equal(threadAt(data, 5, NOW)?.id, "T2");
    assert.equal(threadAt(data, 6, NOW), undefined);
});

const spawn = (
    id: number,
    at: number,
    message: { refs?: string[]; bare?: number[]; head?: string | null },
) => ({
    id,
    c: t1.session,
    at,
    action: "spawn",
    name: "rv",
    tools: ["read", "bash"],
    review: true,
    brief: "Review it",
    refs: [],
    bare: [],
    head: null,
    ...message,
});
const send = (
    id: number,
    at: number,
    message: { refs?: string[]; bare?: number[]; head?: string | null },
) => ({
    id,
    c: t1.session,
    at,
    action: "send",
    name: "rv",
    refs: [],
    bare: [],
    head: null,
    ...message,
});

test("reviewRounds and reviewPoints: a send takes the PR of the call before it, and not its head", () => {
    const data = emptyData({
        threads: threadMap(t1),
        reviewCalls: [
            spawn(1, ago(2 * DAY), { refs: ["acme/widgets#4"], head: SHA_A }),
            send(2, ago(2 * DAY) + MINUTE, {}),
        ],
        reviewAnswers: [
            {
                id: 3,
                c: t1.session,
                at: ago(2 * DAY) + 2 * MINUTE,
                name: "rv",
                ready: false,
                items: ["1"],
            },
        ],
    });

    assert.deepEqual(
        reviewRounds(data, { now: NOW }).map((round: { ref: string; head: string }) => [
            round.ref,
            round.head,
        ]),
        [
            ["acme/widgets#4", SHA_A],
            ["acme/widgets#4", null],
        ],
    );
    assert.deepEqual(reviewPoints(data, { now: NOW }), {
        answers: 1,
        unparsed: 0,
        points: [
            {
                ref: "acme/widgets#4",
                head: null,
                item: "1",
                at: ago(2 * DAY) + 2 * MINUTE,
                session: t1.session,
                reviewer: "rv",
                answer: 3,
            },
        ],
    });
});

test("guardCacheOf: final guards of earlier days by ref@head; the newest day wins", () => {
    const day = (date: string, guard: object) => ({
        date,
        json: {
            metrics: { Q1: { blockers: { points: [{ ref: "acme/w#1", head: SHA_A, guard }] } } },
        },
    });

    assert.deepEqual(
        guardCacheOf([
            day("2026-10-22", { final: true, guarded: true }),
            day("2026-10-21", { final: true, guarded: false }),
            day("2026-10-20", { final: false }),
            { date: "2026-10-19", json: { findings: [] } },
        ]),
        { [`acme/w#1@${SHA_A}`]: { final: true, guarded: true } },
    );
    assert.deepEqual(guardCacheOf([day("2026-10-22", { final: false })]), {});
    assert.deepEqual(guardCacheOf(undefined), {});
});

test("reviewRounds and reviewPoints: a spawn before the 30-day window still sets the round and the PR of a send and an answer in it", () => {
    const data = emptyData({
        threads: threadMap(t1),
        reviewCalls: [
            spawn(1, ago(31 * DAY), { refs: ["acme/widgets#4"], head: SHA_A }),
            send(2, ago(29 * DAY), { head: SHA_B }),
        ],
        reviewAnswers: [
            {
                id: 3,
                c: t1.session,
                at: ago(29 * DAY) + MINUTE,
                name: "rv",
                ready: false,
                items: ["1", "2"],
            },
            // An answer before the window is not counted.
            {
                id: 4,
                c: t1.session,
                at: ago(31 * DAY) + MINUTE,
                name: "rv",
                ready: false,
                items: ["1"],
            },
        ],
    });

    // 1 round in the window: the send. The spawn is before the window and is not counted.
    assert.deepEqual(reviewRounds(data, { now: NOW }), [
        {
            ref: "acme/widgets#4",
            head: SHA_B,
            at: ago(29 * DAY),
            session: t1.session,
            reviewer: "rv",
        },
    ]);

    const found = reviewPoints(data, { now: NOW });

    assert.equal(found.answers, 1);
    assert.deepEqual(
        found.points.map((point: { ref: string; head: string; item: string }) => [
            point.ref,
            point.head,
            point.item,
        ]),
        [
            ["acme/widgets#4", SHA_B, "1"],
            ["acme/widgets#4", SHA_B, "2"],
        ],
    );
});

test("reviewRounds and reviewPoints: a spawn 60 days ago still sets the round and the PR of a send and an answer 29 days ago", () => {
    const data = emptyData({
        threads: threadMap(t1),
        reviewCalls: [
            spawn(1, ago(60 * DAY), { refs: ["acme/widgets#4"], head: SHA_A }),
            send(2, ago(29 * DAY), { head: SHA_C }),
        ],
        reviewAnswers: [
            {
                id: 3,
                c: t1.session,
                at: ago(29 * DAY) + MINUTE,
                name: "rv",
                ready: false,
                items: ["1"],
            },
        ],
    });

    assert.deepEqual(
        reviewRounds(data, { now: NOW }).map((round: { ref: string; head: string }) => [
            round.ref,
            round.head,
        ]),
        [["acme/widgets#4", SHA_C]],
    );
    assert.deepEqual(
        reviewPoints(data, { now: NOW }).points.map(
            (point: { ref: string; head: string; item: string }) => [
                point.ref,
                point.head,
                point.item,
            ],
        ),
        [["acme/widgets#4", SHA_C, "1"]],
    );
});
