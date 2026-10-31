// The Desk page's queue section: rendered with stand-ins for Pocket's page tools, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import setup, {
    answerBody,
    approveLabel,
    attemptLine,
    commentLine,
    consultLine,
    findingsLine,
    diffText,
    forgetKey,
    historyLine,
    isConflict,
    revisingLine,
    withoutAsk,
    keyFor,
    keyForForm,
    deskAct,
    dropPlanAct,
    clearIfSent,
    draftKey,
    sameForm,
    shownMarks,
    markKey,
    markText,
    newKey,
    newPlanBody,
    newPlanState,
    nextMark,
    planAnswerBody,
    reopenIsScope,
    roundLine,
    taskLine,
    tasksSummary,
    toggleTask,
    withMark,
    badgeOf,
    groupOf,
    planAskLine,
    planRowLine,
    planStateLine,
    queueStatus,
    stillMounted,
} from "./desk-web/index.js";
import {
    addDays,
    barLayout,
    cellText,
    COLUMNS,
    dashboardPath,
    dashboardStates,
    defaultSelection,
    formatCount,
    formatDuration,
    formatMoney,
    formatPerWeek,
    formatRate,
    formatUtc,
    isUnknown,
    makeDashboard,
    nextSort,
    noTrackedWork,
    ownerChoices,
    rangeLine,
    repoChoices,
    sortRows,
    tableRows,
    usageAvailable,
    usageNote,
    utcDay,
    withOwner,
    withRepo,
} from "./desk-web/dashboard.js";

const NOW = Date.now();

/** A thread-less view with this queue. */
const viewWith = (issues) => ({
    threads: [],
    seen: 0,
    others: {},
    github: null,
    cap: { counted: 0, cap: 12, full: false, grants: 0 },
    counts: {},
    issues,
});

const item = (patch = {}) => ({
    ref: "frostyard/snosi#1123",
    title: "Fix the ISO build",
    url: "https://github.com/frostyard/snosi/issues/1123",
    urgent: false,
    agent: "murbella",
    signal: "label",
    names: ["label agent-queue", "assigned"],
    by: "bketelsen",
    at: NOW - 2 * 86400_000,
    threads: [],
    fixedBy: [],
    parts: 0,
    unverified: false,
    ...patch,
});

/** `html` as a string join: enough to read what the page says. */
const html = (strings, ...values) => {
    const flat = (value) =>
        Array.isArray(value)
            ? value.map(flat).join("")
            : typeof value === "function"
              ? "[fn]"
              : value === null || value === undefined
                ? ""
                : String(value);

    return strings.reduce(
        (out, text, index) => out + text + (index < values.length ? flat(values[index]) : ""),
        "",
    );
};

/** Render the page with this view. `onBadge` takes each rail update. */
const render = async (view, onBadge = () => {}) => {
    let page;

    setup({
        html,
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        Loader: () => "",
        style() {},
        api: async () => view,
        page: (each) => {
            page = each;
        },
        rail: () => ({ update: onBadge }),
        on: () => () => {},
        onDispose() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    return page.component().replace(/\s+/g, " ");
};

const clock = () => "19:02";

test("queueStatus: a good read says nothing; a failure, a cut read and a queue that is off each say it", () => {
    assert.equal(queueStatus(null, clock), null);
    assert.equal(queueStatus({ ok: true, at: 1, items: [], ignored: [] }, clock), null);
    assert.deepEqual(queueStatus({ ok: false, at: 1, error: "HTTP 502" }, clock), {
        text: "queue read failed at 19:02: HTTP 502",
        warn: true,
    });
    assert.deepEqual(
        queueStatus({ ok: true, at: 1, incomplete: ["queue: 5 of 9 labeled issues read"] }, clock),
        {
            text: "queue read incomplete: queue: 5 of 9 labeled issues read",
            warn: true,
        },
    );
    assert.deepEqual(
        queueStatus({ ok: false, at: 1, off: true, error: "the queue read is off" }, clock),
        {
            text: "queue read is off",
            warn: false,
        },
    );
});

test("a row names every counted signal, the actor and the age", async () => {
    const out = await render(viewWith({ at: NOW, ok: true, items: [item()], ignored: [] }));

    assert.match(out, /Brian queued/);
    assert.match(out, /label agent-queue, assigned · bketelsen, 2 d ago/);
    assert.doesNotMatch(out, /queue read failed/);
});

test("an old item with no names shows its signal kind", async () => {
    const { names: _names, ...old } = item();
    const out = await render(viewWith({ at: NOW, ok: true, items: [old], ignored: [] }));

    assert.match(out, /label · bketelsen, 2 d ago/);
});

test("a failed read shows its warning also when the queue is empty", async () => {
    const out = await render(
        viewWith({ at: NOW, ok: false, error: "exit code 1: HTTP 502", items: [], ignored: [] }),
    );

    assert.match(out, /desk-warn>queue read failed at [^<]*: exit code 1: HTTP 502/);
    assert.doesNotMatch(out, /desk-queue/, "no section with no row");
});

test("an incomplete read shows a warning also when the queue is empty", async () => {
    const out = await render(
        viewWith({
            at: NOW,
            ok: true,
            incomplete: ["queue: 500 of 612 labeled issues read"],
            items: [],
            ignored: [],
        }),
    );

    assert.match(out, /queue read incomplete: queue: 500 of 612 labeled issues read/);
});

test("a queue that is turned off shows a short line, not a failure", async () => {
    const empty = await render(
        viewWith({
            at: NOW,
            ok: false,
            off: true,
            error: "the queue read is off",
            items: [],
            ignored: [],
        }),
    );

    assert.match(empty, /queue read is off/);
    assert.doesNotMatch(empty, /failed/);
    assert.doesNotMatch(empty, /desk-warn/);

    const withRows = await render(
        viewWith({
            at: NOW,
            ok: false,
            off: true,
            error: "the queue read is off",
            items: [item()],
            ignored: [],
        }),
    );

    assert.match(withRows, /queue read is off/);
    assert.match(withRows, /label agent-queue, assigned/);
    assert.doesNotMatch(withRows, /failed/);
});

test("a good empty queue shows nothing", async () => {
    const out = await render(viewWith({ at: NOW, ok: true, items: [], ignored: [] }));

    assert.doesNotMatch(out, /Brian queued/);
    assert.doesNotMatch(out, /queue read/);
});

test("the top count opens the Other PRs section: grouped by repository, each a link with its author and age", async () => {
    const out = await render({
        ...viewWith(null),
        others: { "frostyard/test": 3, "frostyard/empty": 0, "frostyard/old": 2 },
        otherPrs: {
            "frostyard/test": [
                {
                    ref: "frostyard/test#9",
                    number: 9,
                    title: "Bump x from 1 to 2",
                    author: "dependabot[bot]",
                    url: "https://github.com/frostyard/test/pull/9",
                    createdAt: NOW - 3 * 86400_000,
                    draft: true,
                    checks: "FAILURE",
                },
                {
                    ref: "frostyard/test#8",
                    number: 8,
                    title: "A script link",
                    author: "someone",
                    url: "javascript:alert(1)",
                    createdAt: NOW - 30 * 60_000,
                    draft: false,
                    checks: "SUCCESS",
                },
            ],
        },
    });

    assert.match(
        out,
        /aria-controls="desk-others" onClick=\[fn\] > 5 other PRs \(dependabot and others\)/,
    );
    assert.match(
        out,
        /<details id="desk-others" class="desk-closed desk-others"> <summary>Other PRs \(5\)<\/summary>/,
    );
    assert.doesNotMatch(out, /<details[^>]* open/, "collapsed by default");
    assert.match(
        out,
        /<a class="desk-link" href=https:\/\/github\.com\/frostyard\/test\/pull\/9 target="_blank" rel="noopener"><span class="mono">frostyard\/test#9<\/span> <span class="desk-title">Bump x from 1 to 2<\/span><\/a> <span class="small muted"> \(dependabot\[bot\], 3 d ago\)<\/span >/,
    );
    assert.match(out, /desk-chip">draft</);
    assert.match(out, /checks fail/);
    assert.doesNotMatch(out, /href=javascript/, "an unsafe URL is no link");
    assert.match(
        out,
        /frostyard\/test#8<\/span> <span class="desk-title">A script link<\/span> <span class="small muted"> \(someone, 30 min ago\)/,
    );
    assert.match(
        out,
        /… and 1 more: <a class="desk-link" href=https:\/\/github\.com\/frostyard\/test\/pulls/,
    );
    assert.doesNotMatch(out, /frostyard\/empty/, "a repository with no other PR has no group");
    assert.match(
        out,
        /frostyard\/old <span class="desk-count">2<\/span>.*The list comes with the next sweep\./,
    );
    assert.ok(
        out.indexOf("frostyard/old") < out.indexOf("frostyard/test#9"),
        "repositories in name order",
    );
});

test("no other PR: no count and no section", async () => {
    const out = await render(viewWith(null));

    assert.doesNotMatch(out, /other PR/);
    assert.doesNotMatch(out, /desk-others/);
});

test("a full desk says Allow 1 tells Odrade, and how many extra OKs wait", async () => {
    const out = await render({
        ...viewWith(null),
        cap: { counted: 13, cap: 12, full: true, grants: 2 },
    });

    assert.match(
        out,
        /The desk is full: 13 of 12 count\. Allow 1 lets Odrade open 1 more thread, and tells her to delegate the work that waited\./,
    );
    assert.match(out, /2 extra allowed/);
    assert.match(out, /> Allow 1 /);
});

test("a desk with room shows no banner", async () => {
    const out = await render(viewWith(null));

    assert.doesNotMatch(out, /The desk is full/);
    assert.doesNotMatch(out, /extra allowed/);
    assert.doesNotMatch(out, /desk-full/);
});

// ─── An open ask needs Brian, whatever else the thread is ────────────────────

/** One thread of the page's view, as the server sends it. */
const threadView = (patch = {}) => ({
    id: "T1",
    title: "A task",
    origin: "delegate",
    agents: ["duncan"],
    repo: "frostyard/test",
    state: "open",
    next: "agent",
    stale: false,
    open: false,
    prs: [],
    asks: [],
    answered: [],
    resolved: [],
    lastEventAt: NOW - 60_000,
    asleep: false,
    ...patch,
});

/** The ask the thread waits on. */
const openAsk = { id: "T1a", text: "Which one?", at: NOW - 1000 };

test("a found thread with an open ask is under Needs you, with its ask card and its attach actions", async () => {
    let badge = null;
    const out = await render(
        {
            ...viewWith(null),
            threads: [
                threadView({ id: "F2", origin: "found", title: "A found PR", asks: [openAsk] }),
            ],
        },
        (next) => {
            badge = next.badge;
        },
    );

    const need = out.slice(
        out.indexOf("<h2>Needs you"),
        out.indexOf("</section>", out.indexOf("<h2>Needs you")),
    );

    assert.match(need, /F2/);
    assert.match(need, /T1a · Which one\?/);
    assert.match(need, /aria-label=Answered T1a/);
    assert.match(need, /> Answered </);
    assert.match(need, /Attach to…/, "it can still be attached");
    assert.doesNotMatch(out, /<h2>Found /, "it is not in Found");
    assert.equal(badge, 1, "the badge counts it");
});

test("a watched thread with an open ask is under Needs you, with its ask card and its check date", async () => {
    let badge = null;
    const out = await render(
        {
            ...viewWith(null),
            threads: [
                threadView({
                    id: "T3",
                    title: "A sleeping task",
                    asleep: true,
                    next: "brian",
                    asks: [openAsk],
                    watch: {
                        checkOn: "2026-12-01",
                        check: "the blob sweep",
                        setBy: "odrade",
                        due: false,
                    },
                }),
            ],
        },
        (next) => {
            badge = next.badge;
        },
    );

    const need = out.slice(
        out.indexOf("<h2>Needs you"),
        out.indexOf("</section>", out.indexOf("<h2>Needs you")),
    );

    assert.match(need, /T3/);
    assert.match(need, /T1a · Which one\?/);
    assert.match(need, /> Answered </);
    assert.match(need, /check on 2026-12-01/, "the watch date still shows");
    assert.doesNotMatch(out, /<h2>Watching /, "it is not in Watching");
    assert.equal(badge, 1, "the badge counts it");
});

test("a watch with a time shows the time in its row; one without shows the date only", async () => {
    const watching = (id, watch) =>
        threadView({
            id,
            title: `Sleeping ${id}`,
            asleep: true,
            watch: { check: "the blob sweep", setBy: "odrade", due: false, ...watch },
        });
    const out = await render({
        ...viewWith(null),
        threads: [
            watching("T3", { checkOn: "2026-12-01", checkTime: "09:00" }),
            watching("T4", { checkOn: "2026-12-02" }),
        ],
    });

    assert.match(out, /check on 2026-12-01 09:00/);
    assert.match(out, /check on 2026-12-02(?! \d)/);
});

test("groupOf: an ask comes first after parked; else closed, asleep, found, Brian, stale, the reviewer", () => {
    assert.equal(groupOf(threadView({ state: "closed" })), "closed");
    assert.equal(
        groupOf(threadView({ state: "closed", asks: [openAsk] })),
        "need",
        "a thread closed with an open ask still needs Brian",
    );
    assert.equal(groupOf(threadView({ state: "parked", asks: [openAsk] })), "parked");
    assert.equal(groupOf(threadView({ asks: [openAsk] })), "need");
    assert.equal(groupOf(threadView({ asleep: true, asks: [openAsk] })), "need");
    assert.equal(groupOf(threadView({ origin: "found", asks: [openAsk] })), "need");
    assert.equal(groupOf(threadView({ asleep: true, origin: "found" })), "watching");
    assert.equal(groupOf(threadView({ origin: "found" })), "found");
    assert.equal(groupOf(threadView({ next: "brian" })), "need");
    assert.equal(groupOf(threadView({ stale: true })), "stale");
    assert.equal(groupOf(threadView({ next: "reviewer" })), "review");
    assert.equal(groupOf(threadView({})), "working");
});

test("groupOf: a plan thread shows under Needs you with an open ask, else only in the Plans section", () => {
    assert.equal(groupOf(threadView({ origin: "plan", asks: [openAsk] })), "need");
    assert.equal(groupOf(threadView({ origin: "plan" })), "plans");
    assert.equal(groupOf(threadView({ origin: "plan", stale: true })), "plans");
    assert.equal(groupOf(threadView({ origin: "plan", state: "closed" })), "closed");
});

test("badgeOf: an open ask counts, also when asleep; a plain sleeping thread does not", () => {
    const view = (threads) => ({ ...viewWith(null), threads });

    assert.equal(badgeOf(null), 0);
    assert.equal(badgeOf(view([threadView({ next: "brian" })])), 1);
    assert.equal(badgeOf(view([threadView({ stale: true })])), 1);
    assert.equal(badgeOf(view([threadView({})])), 0);
    assert.equal(badgeOf(view([threadView({ state: "closed", asks: [openAsk] })])), 1);
    assert.equal(
        badgeOf(view([threadView({ state: "closed", next: "brian", stale: true })])),
        0,
        "a closed thread with no open ask never counts",
    );
    assert.equal(badgeOf(view([threadView({ state: "parked", asks: [openAsk] })])), 0);
    assert.equal(badgeOf(view([threadView({ origin: "found", asks: [openAsk] })])), 1);

    const sleeping = threadView({ id: "T3", asleep: true, next: "odrade" });
    const sleepingAsked = threadView({ id: "T4", asleep: true, next: "brian", asks: [openAsk] });

    assert.equal(groupOf(sleeping), "watching");
    assert.equal(badgeOf(view([sleeping])), 0, "a plain sleeping thread does not count");
    assert.equal(badgeOf(view([sleepingAsked])), 1);
});

/** 1 PR of a thread's row: the page's view, with the label on it. */
const pagePr = (ref = "frostyard/test#12", patch = {}) => ({
    ref,
    url: `https://github.com/frostyard/test/pull/12`,
    state: "OPEN",
    via: "seen",
    guessed: false,
    ready: true,
    ...patch,
});

test("badgeOf: each PR ready to merge counts 1, and its thread does not count twice", () => {
    const withReady = (threads, ready) => ({ ...viewWith(null), threads, ready });
    const readyPr = (patch = {}) => ({
        ref: "frostyard/test#12",
        thread: "T1",
        agents: ["duncan"],
        at: NOW,
        ...patch,
    });

    // A thread that counts only because it needs Brian, and holds the PR: the PR counts, and the thread does not.
    const brian = threadView({ id: "T1", next: "brian", prs: [pagePr()] });

    assert.equal(badgeOf(withReady([brian], [])), 1, "the thread alone counts");
    assert.equal(
        badgeOf(withReady([brian], [readyPr()])),
        1,
        "the PR counts, and the thread does not count again",
    );
    assert.equal(badgeOf(withReady([], [readyPr(), readyPr({ ref: "frostyard/test#13" })])), 2);

    // A thread that counts for another reason keeps its own count.
    const asked = threadView({ id: "T1", next: "brian", asks: [openAsk] });

    assert.equal(badgeOf(withReady([asked], [readyPr()])), 2, "the open ask counts beside the PR");

    const stale = threadView({ id: "T1", next: "brian", stale: true });

    assert.equal(
        badgeOf(withReady([stale], [readyPr()])),
        2,
        "a stale thread counts beside the PR",
    );

    // An older view has no ready list.
    assert.equal(badgeOf({ ...viewWith(null), threads: [brian] }), 1);
});

test("badgeOf: 1 row for a PR on 2 threads counts the PR 1 time", () => {
    // The server's `readyPrs` gives 1 row for the same PR on 2 threads: the badge counts that row, not the 2 threads.
    const view = (threads) => ({
        ...viewWith(null),
        threads,
        ready: [{ ref: "frostyard/test#12", thread: "T1", agents: ["duncan"], at: NOW }],
    });
    const one = threadView({ id: "T1", next: "brian", prs: [pagePr()] });
    const two = threadView({ id: "T2", next: "brian", prs: [pagePr()] });

    assert.equal(badgeOf(view([one, two])), 1, "the PR counts, and neither thread counts");

    // A thread that counts for another reason keeps its own count: an open ask, or a stale clock.
    assert.equal(
        badgeOf(
            view([one, threadView({ id: "T2", next: "brian", prs: [pagePr()], asks: [openAsk] })]),
        ),
        2,
        "the open ask counts beside the PR",
    );
    assert.equal(
        badgeOf(view([one, threadView({ id: "T2", next: "brian", stale: true, prs: [pagePr()] })])),
        2,
        "a stale thread counts beside the PR",
    );
    // A PR that is not in the list does not stop the thread from counting.
    assert.equal(
        badgeOf(
            view([
                one,
                threadView({ id: "T2", next: "brian", prs: [pagePr("frostyard/test#99")] }),
            ]),
        ),
        2,
        "another PR is no row of Ready to merge",
    );
});

test("Ready to merge sits after Needs you, with the link, the head, the thread, and the CI state", async () => {
    const out = await render({
        ...viewWith(null),
        counts: { ready: 2 },
        threads: [threadView({ id: "T9", next: "brian", title: "Needs him" })],
        ready: [
            {
                ref: "frostyard/test#12",
                title: "A fix",
                url: "https://github.com/frostyard/test/pull/12",
                head: "a1b2c3d",
                checks: "SUCCESS",
                thread: "T1",
                agents: ["duncan"],
                at: NOW,
            },
            {
                ref: "frostyard/test#13",
                title: "No CI yet",
                thread: "T2",
                agents: ["irulan"],
                at: NOW,
            },
        ],
    });

    const need = out.indexOf("<h2>Needs you");
    const start = out.indexOf("<h2>Ready to merge");
    const part = out.slice(start, out.indexOf("</section>", start));

    assert(need >= 0 && start > need, "it comes after Needs you");
    assert.match(part, /class="desk-count">2</);
    assert.match(
        part,
        /<a class="desk-link" href=https:\/\/github.com\/frostyard\/test\/pull\/12 target="_blank" rel="noopener"/,
    );
    assert.match(part, /A fix/);
    assert.match(part, /<code class="desk-pr-head">a1b2c3d<\/code>/);
    assert.match(part, /aria-label=Open T1/, "the thread opens from the row");
    assert.match(part, /duncan · success/);
    assert.match(part, /irulan · no checks/);
    assert.match(part, /A PR leaves the list when it merges, closes, or loses the label\./);
    assert.match(out, /2 ready to merge/);
});

test("no PR is ready: no section and no count", async () => {
    const out = await render(viewWith(null));

    assert.doesNotMatch(out, /Ready to merge/);
    assert.match(out, /0 need you · 0 ready to merge/);
});

test("a thread closed with an open ask shows in Needs you with its answer controls, and not under Closed", async () => {
    let badge;
    const out = await render(
        {
            ...viewWith(null),
            threads: [
                threadView({
                    id: "T406",
                    title: "A closed watch",
                    state: "closed",
                    closed: {
                        at: NOW - 30 * 86400_000,
                        why: "done",
                        by: "odrade",
                        outcome: "done",
                    },
                    asks: [{ ...openAsk, id: "T406b", text: "Keep the old blob store?" }],
                }),
                threadView({
                    id: "T407",
                    title: "A plain closed one",
                    state: "closed",
                    closed: { at: NOW - 1000, why: "done", by: "odrade", outcome: "done" },
                }),
            ],
        },
        (next) => {
            badge = next.badge;
        },
    );

    const need = out.slice(
        out.indexOf("<h2>Needs you"),
        out.indexOf("</section>", out.indexOf("<h2>Needs you")),
    );

    assert.match(need, /T406/);
    assert.match(need, /T406b · Keep the old blob store\?/);
    assert.match(need, /Answered T406b/, "Brian can answer it");
    assert.doesNotMatch(need, /T407/);
    assert.match(out, /Closed in the last 7 days \(1\)/, "only the plain one is under Closed");
    assert.equal(badge, 1, "the badge counts it");
});

test("a closed found thread with an open ask and a watch shows the answer controls, and no Attach, Drop or watch controls", async () => {
    const out = await render({
        ...viewWith(null),
        threads: [
            threadView({
                id: "F7",
                title: "A closed found PR",
                state: "closed",
                origin: "found",
                closed: { at: NOW - 1000, why: "done", by: "odrade", outcome: "done" },
                asks: [{ ...openAsk, id: "F7a", text: "Adopt it?" }],
                prs: [{ ref: "frostyard/test#9", state: "OPEN", next: "brian" }],
                watch: {
                    checkOn: "2026-12-01",
                    check: "the blob sweep",
                    setBy: "odrade",
                    due: false,
                },
            }),
        ],
    });
    const need = out.slice(
        out.indexOf("<h2>Needs you"),
        out.indexOf("</section>", out.indexOf("<h2>Needs you")),
    );

    assert.match(need, /F7a · Adopt it\?/);
    assert.match(need, /aria-label=Answered F7a/);
    assert.doesNotMatch(need, /Attach/);
    assert.doesNotMatch(need, /Drop/);
    assert.doesNotMatch(need, /Park|Keep|Wake/);
    assert.doesNotMatch(need, /Watch|Clear the watch|Pass the check|Fail the check/);
    assert.doesNotMatch(need, /ready to merge/);
});

// ─── The plan rows and the plan view ────────────────────────────────────────

const plan = (patch = {}) => ({
    id: "T560",
    title: "Snow ISO signing",
    state: "drafting",
    rev: "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567",
    lead: "lucilla",
    asks: 2,
    waiting: [],
    ...patch,
});

test("a plan row names its state, its asks and its lead", () => {
    assert.equal(planRowLine(plan()), "drafting · 2 asks · lead lucilla");
    assert.equal(planRowLine(plan({ asks: 1 })), "drafting · 1 ask · lead lucilla");
    assert.equal(planRowLine(plan({ state: "building" })), "building · 2 asks · lead lucilla");
});

test("a plan in review shows its approval, and no undefined", () => {
    assert.equal(planRowLine(plan({ state: "review" })), "review · Approve 3f2a9c1");
    assert.equal(planRowLine(null), "");
});

test("the plan view's state line names the graph and its tasks", () => {
    assert.equal(planStateLine(plan()), "drafting · rev 3f2a9c1 · lead lucilla · no graph");
    assert.equal(
        planStateLine(
            plan({
                state: "review",
                graph: { version: 2, state: "draft", tasks: [{}, {}, {}, {}] },
            }),
        ),
        "review · rev 3f2a9c1 · lead lucilla · graph v2: 4 tasks",
    );
    assert.equal(
        planStateLine(plan({ graph: { version: 1, state: "draft", tasks: [{}] } })),
        "drafting · rev 3f2a9c1 · lead lucilla · graph v1: 1 task",
    );
});

test("the approve button names the revision and the graph it sends", () => {
    assert.equal(
        approveLabel(plan({ graph: { version: 2, state: "draft", tasks: [] } })),
        "Approve 3f2a9c1 + graph v2",
    );
});

test("an ask shows open, its answer, or that the write did not come", () => {
    assert.equal(
        planAskLine({ id: "T560b", text: "Where do the keys live?", open: true, written: false }),
        "T560b: Where do the keys live? · open",
    );
    assert.equal(
        planAskLine({
            id: "T560b",
            text: "Where do the keys live?",
            open: false,
            written: false,
            answer: { words: "In the TPM.", by: "brian", at: NOW },
        }),
        "T560b: Where do the keys live? → In the TPM. (brian) · not written",
    );
    assert.equal(
        planAskLine({
            id: "T560b",
            text: "Where do the keys live?",
            open: false,
            written: true,
            answer: { words: "In the TPM.", by: "brian", at: NOW },
        }),
        "T560b: Where do the keys live? → In the TPM. (brian)",
    );
});

test("a withdrawn ask says why, and no write-back waits for it", () => {
    assert.equal(
        planAskLine({
            id: "T560c",
            text: "Name the rotation period.",
            open: false,
            written: false,
            resolved: { why: "Brian knows this one.", by: "odrade" },
        }),
        "T560c: Name the rotation period. · withdrawn: Brian knows this one.",
    );
    assert.equal(
        planAskLine({
            id: "T560c",
            text: "Name the rotation period.",
            open: false,
            written: false,
            resolved: { why: "The desk ended it." },
        }),
        "T560c: Name the rotation period. · resolved: The desk ended it.",
    );
});

test("an answer that comes after the view left changes nothing", () => {
    assert.equal(stillMounted({ gone: false }), true);
    assert.equal(stillMounted({ gone: true }), false);
    assert.equal(stillMounted(undefined), true);
});

test("a page answer sends the generation of a plan ask, and none for another ask", () => {
    assert.deepEqual(answerBody("TPM", 0), { words: "TPM", gen: 0 });
    assert.deepEqual(answerBody("TPM", 2), { words: "TPM", gen: 2 });
    assert.deepEqual(answerBody("yes", undefined), { words: "yes" });
});

// ─── Plan acts (part E) ─────────────────────────────────────────────────────

test("an act's key is made once in a view, and a done act gets a new one", () => {
    const keys = {};
    let made = 0;
    const make = (act) => `${act}-key-${++made}`;

    assert.equal(keyFor(keys, "approve", make), "approve-key-1");
    assert.equal(keyFor(keys, "approve", make), "approve-key-1", "a second tap sends the same key");
    assert.equal(keyFor(keys, "comment-idea", make), "comment-idea-key-2");
    forgetKey(keys, "approve");
    assert.equal(keyFor(keys, "approve", make), "approve-key-3");
    assert.match(newKey("reopen-T560b"), /^reopen-T560b-[a-z0-9]+-[a-z0-9]+$/);
    assert.match(newKey("a b"), /^[A-Za-z0-9_-]{8,100}$/);
});

test("a 409 is a conflict: the view loads again", () => {
    assert.equal(isConflict({ status: 409 }), true);
    assert.equal(isConflict({ status: 400 }), false);
    assert.equal(isConflict(undefined), false);
});

test("a marks cell goes blank, yes, partly, no, and blank again", () => {
    assert.equal(markKey(1, "r2"), "1/r2");
    assert.equal(nextMark(undefined), "yes");
    assert.equal(nextMark("yes"), "partly");
    assert.equal(nextMark("partly"), "no");
    assert.equal(nextMark("no"), undefined);
    assert.equal(markText(undefined), "·");
    assert.equal(markText("partly"), "partly");

    const marks = withMark({ "0/r1": "yes" }, "1/r1", "no");

    assert.deepEqual(marks, { "0/r1": "yes", "1/r1": "no" });
    assert.deepEqual(
        withMark(marks, "0/r1", undefined),
        { "1/r1": "no" },
        "a blank cell is no key",
    );
    assert.deepEqual(withMark(undefined, "0/r1", "yes"), { "0/r1": "yes" });
});

test("a plan answer sends the generation, and a why and marks only when there are some", () => {
    assert.deepEqual(planAnswerBody("TPM", 1, "  ", undefined), { words: "TPM", gen: 1 });
    assert.deepEqual(planAnswerBody("TPM", 0, " No new hardware. ", { "0/r1": "yes" }), {
        words: "TPM",
        gen: 0,
        why: "No new hardware.",
        marks: { "0/r1": "yes" },
    });
});

test("a reopen after the approval is a scope change; the task list toggles", () => {
    assert.equal(reopenIsScope({ state: "drafting" }), false);
    assert.equal(reopenIsScope({ state: "review" }), false);
    assert.equal(reopenIsScope({ state: "building" }), true);
    assert.equal(reopenIsScope({ state: "verifying" }), true);
    assert.deepEqual(toggleTask(["t1"], "t2"), ["t1", "t2"]);
    assert.deepEqual(toggleTask(["t1", "t2"], "t1"), ["t2"]);
});

test("New plan is off, and says why, until a supervisor, a lead and a place are there", () => {
    const info = (patch = {}) => ({
        startPlan: true,
        supervisors: [42, 7],
        leads: [{ id: "lucilla", name: "Lucilla" }],
        plans: { open: 1, max: 3 },
        ...patch,
    });

    assert.deepEqual(newPlanState(null), { off: "Reading the roster." });
    assert.match(newPlanState(info({ startPlan: false })).off, /Team module is off or older/);
    assert.match(
        newPlanState(info({ supervisors: [] })).off,
        /needs the supervisor's conversation/,
    );
    assert.equal(
        newPlanState(info({ plans: { open: 3, max: 3 } })).off,
        "3 plans are open (plans.max 3): a plan must finish or be dropped first.",
    );
    assert.match(newPlanState(info({ leads: [] })).off, /No roster agent/);
    assert.deepEqual(newPlanState(info()), { supervisor: 42, pick: true }, "the newest supervisor");
    assert.deepEqual(newPlanState(info(), 7), { supervisor: 7, pick: true }, "Brian's pick");
    assert.deepEqual(newPlanState(info(), 99), { supervisor: 42, pick: true }, "an unknown pick");
    assert.deepEqual(newPlanState(info({ supervisors: [42] })), { supervisor: 42, pick: false });
});

test("the New plan body is checked, and the model goes only when it is set", () => {
    assert.deepEqual(
        newPlanBody(
            { title: " Keys ", idea: " Rotate them. ", lead: "lucilla", model: " " },
            "k-1",
        ),
        { body: { title: "Keys", idea: "Rotate them.", lead: "lucilla", key: "k-1" } },
    );
    assert.deepEqual(
        newPlanBody({ title: "Keys", idea: "Rotate.", lead: "lucilla", model: "a/b" }, "k-1").body
            .model,
        "a/b",
    );
    assert.match(newPlanBody({ title: "", idea: "x", lead: "l" }, "k").error, /title/);
    assert.match(newPlanBody({ title: "t", idea: "x".repeat(201), lead: "l" }, "k").error, /idea/);
    assert.match(newPlanBody({ title: "t", idea: "x", lead: "" }, "k").error, /lead/);
});

test("tasks, attempts, rounds, comments and diff lines read as 1 line each", () => {
    assert.equal(
        attemptLine({
            thread: "T575",
            prs: [
                { ref: "frostyard/snow#3", head: "abcdef0123456789" },
                { ref: "frostyard/snow#4" },
            ],
            end: { how: "merged" },
        }),
        "T575 · merged · frostyard/snow#3 at abcdef0 · frostyard/snow#4",
    );
    assert.equal(
        attemptLine({
            thread: "T576",
            prs: [],
            end: { how: "no-change", noChange: { reason: "It signs already.", evidence: "x" } },
        }),
        "T576 · no-change · no change: It signs already.",
    );
    assert.equal(attemptLine({ thread: "T577", prs: [] }), "T577 · open");
    assert.equal(
        taskLine({
            agent: "teg",
            repo: "frostyard/nsl",
            state: "done",
            deps: ["t1"],
            carried: { why: "It merged." },
        }),
        "teg · frostyard/nsl · done · deps: t1 · carried: It merged.",
    );
    assert.equal(
        tasksSummary({ version: 2, tasks: [{ state: "done" }, { state: "ready" }] }),
        "Tasks (graph v2: 2 tasks, 1 done)",
    );
    assert.equal(
        roundLine({
            pass: false,
            reviewer: "openai/gpt-6.1-sol",
            tasks: [
                { task: "t1", pass: true },
                { task: "t2", pass: false },
            ],
        }),
        "failed · openai/gpt-6.1-sol · failed: t2",
    );
    assert.equal(
        commentLine({ id: "c3", by: "Brian", text: "Name the period.", state: "open" }),
        "c3 Brian: Name the period.",
    );
    assert.equal(
        commentLine({
            id: "c3",
            by: "Brian",
            text: "x",
            state: "done",
            settled: { rev: "3f2a9c1d4e" },
        }),
        "c3 Brian: x · settled by rev 3f2a9c1",
    );
    assert.equal(diffText({ op: "+", text: "new" }), "+ new");
});

test("a consult and the findings of an ask, in 1 line each", () => {
    assert.equal(
        consultLine({ id: "k2", agent: "teg", state: "running", ask: "T5b", age: 12 * 60000 }),
        "k2 teg · running · on T5b · 12 min",
    );
    assert.equal(
        consultLine({
            id: "k1",
            agent: "lucilla",
            state: "answered",
            age: 30000,
            finding: "f1",
        }),
        "k1 lucilla · answered · 1 min · finding f1",
    );
    assert.equal(
        consultLine({
            id: "k3",
            agent: "paul",
            state: "failed",
            age: 61 * 60000,
            end: { why: "timeout" },
        }),
        "k3 paul · failed · 61 min · no finding after 60 min",
    );
    assert.equal(
        consultLine({
            id: "k4",
            agent: "paul",
            state: "stopped",
            age: 0,
            end: { why: "stopped", by: "brian" },
        }),
        "k4 paul · stopped · 0 min · stopped by brian",
    );
    assert.equal(
        findingsLine([
            { agent: "lucilla", stance: "supports" },
            { agent: "teg", stance: "objects" },
        ]),
        "Findings: lucilla supports · teg objects",
    );
    assert.equal(findingsLine([]), "");
    assert.equal(findingsLine(undefined), "");
});

test("the Plans section shows New plan, off with its reason before the roster is read", async () => {
    const out = await render({ ...viewWith(null), plans: [] });

    assert.match(out, /Plans <span class="desk-count">0/);
    assert.match(out, /New plan/);
    assert.match(out, /Reading the roster\./);
});

test("a reopen's history, a scope change and a cleared draft read right", () => {
    assert.equal(
        historyLine({
            history: [
                { answer: { words: "TPM", by: "Brian" } },
                { answer: { words: "A file", by: "Brian" } },
            ],
        }),
        "Earlier: TPM (Brian) · A file (Brian)",
    );
    assert.equal(
        revisingLine({ by: "Brian", why: "The key moves.", tasks: [] }),
        "Under revision (Brian): The key moves. · stopped: none",
    );
    assert.equal(
        revisingLine({ by: "Brian", why: "x", tasks: ["t1", "t2"] }),
        "Under revision (Brian): x · stopped: t1, t2",
    );
    assert.deepEqual(withoutAsk({ T1a: { "0/r1": "yes" }, T1b: {} }, "T1a"), { T1b: {} });
});

test("a form's key stays while its values stay, and a changed field makes a new key", () => {
    const keys = {};
    let made = 0;
    const make = (act) => `${act}-${++made}`;
    const form = { title: "Keys", idea: "Rotate.", lead: "lucilla", model: "", supervisor: 7 };

    assert.equal(keyForForm(keys, "new-plan", form, make), "new-plan-1");
    assert.equal(keyForForm(keys, "new-plan", { ...form }, make), "new-plan-1", "a second tap");
    assert.equal(keyForForm(keys, "new-plan", { ...form, lead: "teg" }, make), "new-plan-2");
    assert.equal(
        keyForForm(keys, "new-plan", { ...form, lead: "teg", supervisor: 8 }, make),
        "new-plan-3",
    );
    forgetKey(keys, "new-plan");
    assert.equal(
        keyForForm(keys, "new-plan", form, make),
        "new-plan-4",
        "a done start gets a new key",
    );
});

test("a marks save right after a load sends the stored marks, so it clears nothing", () => {
    const ask = { id: "T5a", gen: 0, open: true, marks: { "0/r1": "yes", "1/r2": "no" } };

    assert.deepEqual(
        shownMarks({}, ask),
        { "0/r1": "yes", "1/r2": "no" },
        "no edit: the stored marks",
    );
    assert.deepEqual(shownMarks({ "T5a:0": { "0/r1": "partly" } }, ask), { "0/r1": "partly" });
    assert.deepEqual(shownMarks({}, { id: "T5b", gen: 0, open: true }), {});
    assert.deepEqual(
        shownMarks({ "T5a:0": { "0/r1": "no" } }, { ...ask, open: false }),
        ask.marks,
        "an answered ask shows its stored marks",
    );
});

test("a draft belongs to 1 generation of its ask: after a reopen it is not shown or sent", () => {
    assert.equal(draftKey({ id: "T5a", gen: 0 }), "T5a:0");
    assert.equal(draftKey({ id: "T5a", gen: 1 }), "T5a:1");
    assert.equal(draftKey({ id: "F7a" }), "F7a:0", "an ask with no generation");

    const drafts = { "T5a:0": { "0/r1": "yes" } };
    const reopened = { id: "T5a", gen: 1, open: true };

    assert.deepEqual(shownMarks(drafts, reopened), {}, "the draft of generation 0 does not show");
    assert.equal({ "T5a:0": "TPM" }[draftKey(reopened)], undefined, "nor its answer");
});

test("a changed payload after a failed send gets a new key, and a send clears only the text it sent", () => {
    const keys = {};
    let made = 0;
    const make = (act) => `${act}-${++made}`;
    const first = { section: "idea", text: "Name the period.", rev: "abc" };

    assert.equal(keyForForm(keys, "comment-idea", first, make), "comment-idea-1");
    // The send failed; Brian sends the same text again: the same key.
    assert.equal(keyForForm(keys, "comment-idea", { ...first }, make), "comment-idea-1");
    // He changed the text: a new comment, with a new key.
    assert.equal(
        keyForForm(
            keys,
            "comment-idea",
            { ...first, text: "Name the period and the owner." },
            make,
        ),
        "comment-idea-2",
    );

    assert.equal(clearIfSent(" Name the period. ", "Name the period."), "");
    assert.equal(
        clearIfSent("Name the period. And more", "Name the period."),
        "Name the period. And more",
        "text typed after the send stays",
    );
    assert.equal(clearIfSent(undefined, ""), "");
    assert.equal(sameForm({ title: "a", idea: "b" }, { title: "a", idea: "b" }), true);
    assert.equal(sameForm({ title: "a", idea: "b!" }, { title: "a", idea: "b" }), false);
});

/** A fake API: each path's answer, or the refusal it throws; it records each call in order. */
const fakeApi = (answers) => {
    const calls = [];

    return {
        calls,
        call: async (path, body) => {
            calls.push(body === undefined ? ["GET", path] : ["POST", path, body]);

            const answer = answers[path];

            if (answer instanceof Error) {
                throw answer;
            }

            return answer;
        },
    };
};

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

test("a 409 on a plan answer from Needs you loads the view again, and the error stays", async () => {
    const newer = { threads: [{ id: "T5", asks: [{ id: "T5a", gen: 1 }] }] };
    const api = fakeApi({
        "asks/T5a/answer": conflict("T5a was reopened since you read it."),
        threads: newer,
    });
    const done = await deskAct(api.call, () => api.call("threads"), "asks/T5a/answer", {
        words: "TPM",
        gen: 0,
    });

    assert.deepEqual(api.calls, [
        ["POST", "asks/T5a/answer", { words: "TPM", gen: 0 }],
        ["GET", "threads"],
    ]);
    assert.deepEqual(done, {
        ok: false,
        error: "T5a was reopened since you read it.",
        reloaded: newer,
    });

    // A plain refusal (400) loads nothing; a done act gives its view.
    const plain = fakeApi({ "asks/T5a/answer": new Error("An answer is 1 to 1000 characters.") });

    assert.deepEqual(
        await deskAct(plain.call, () => plain.call("threads"), "asks/T5a/answer", {}),
        {
            ok: false,
            error: "An answer is 1 to 1000 characters.",
        },
    );
    assert.deepEqual(
        plain.calls.map((each) => each[1]),
        ["asks/T5a/answer"],
    );

    const ok = fakeApi({ "asks/T5a/answer": newer });

    assert.deepEqual(await deskAct(ok.call, () => ok.call("threads"), "asks/T5a/answer", {}), {
        ok: true,
        next: newer,
    });
});

test("a 409 on the plan's Drop loads the plan again, and the error says so and stays", async () => {
    const newer = { id: "T5", state: "drafting", waiting: ["T5a open"] };
    const api = fakeApi({
        "threads/T5/drop": conflict("the drop refused: T5 has an open ask: T5a."),
        "plans/T5": newer,
    });
    const done = await dropPlanAct(api.call, () => api.call("plans/T5"), "T5", "not now");

    assert.deepEqual(api.calls, [
        ["POST", "threads/T5/drop", { reason: "not now" }],
        ["GET", "plans/T5"],
    ]);
    assert.deepEqual(done, {
        ok: false,
        error: "the drop refused: T5 has an open ask: T5a. The view is loaded again.",
        reloaded: newer,
    });

    const ok = fakeApi({ "threads/T5/drop": {} });

    assert.deepEqual(await dropPlanAct(ok.call, () => ok.call("plans/T5"), "T5", "done"), {
        ok: true,
    });
    assert.equal(ok.calls.length, 1, "a done drop loads nothing here");
});

// ─── The Dashboard view's helpers ────────────────────────────────────────────

test("the operational view is the default: the page opens on Desk, with the Dashboard 1 tap away", async () => {
    const out = await render(viewWith(null));

    assert.match(out, /role="group" aria-label="Desk view"/);
    assert.match(out, /data-tab="desk" aria-pressed=true onClick=\[fn\] > Desk </);
    assert.match(out, /data-tab="dashboard" aria-pressed=false onClick=\[fn\] > Dashboard </);
    assert.match(out, /<h1>Desk<\/h1>/);
    assert.doesNotMatch(out, /dash-controls/);
});

test("unknown is never 0: each format gives null for unknown, and a real 0 for 0", () => {
    for (const value of [null, undefined, NaN, Infinity]) {
        assert.equal(isUnknown(value), true);
        assert.equal(formatCount(value), null);
        assert.equal(formatRate(value), null);
        assert.equal(formatDuration(value), null);
        assert.equal(formatMoney(value), null);
        assert.equal(formatPerWeek(value), null);
        assert.equal(formatUtc(value), null);
    }

    assert.equal(isUnknown(0), false);
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(9320), "9,320");
    assert.equal(formatRate(0), "0%");
    assert.equal(formatRate(0.8), "80%");
    assert.equal(formatRate(2 / 3), "66.7%");
    assert.equal(formatDuration(0), "0 min");
    assert.equal(formatDuration(45 * 60_000), "45 min");
    assert.equal(formatDuration(9 * 3600_000), "9 h");
    assert.equal(formatDuration(47.5 * 3600_000), "47.5 h");
    assert.equal(formatDuration(129 * 3600_000), "5.4 d");
    assert.equal(formatMoney(0), "$0.00");
    assert.equal(formatMoney(0.001), "$0.0010");
    assert.equal(formatMoney(0.9), "$0.90");
    assert.equal(formatMoney(1234.5), "$1,234.50");
    assert.equal(formatPerWeek(8 / (29.5 / 7)), "1.9");
    assert.equal(formatPerWeek(2), "2");
    assert.equal(formatUtc(Date.UTC(2026, 9, 30, 12, 5)), "2026-10-30 12:05 UTC");
    assert.equal(utcDay(Date.UTC(2026, 9, 30, 23, 59)), "2026-10-30");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-10-30", -29), "2026-10-01");
});

test("dashboardPath: a preset sends its first day, never before the boundary's day; custom sends both", () => {
    const today = "2026-10-30";

    assert.equal(dashboardPath(defaultSelection(), today), "dashboard?from=2026-10-01");
    assert.equal(
        dashboardPath({ ...defaultSelection(), preset: 7 }, today, "2026-08-01"),
        "dashboard?from=2026-10-24",
    );
    assert.equal(
        dashboardPath({ ...defaultSelection(), preset: 90 }, today, "2026-08-15"),
        "dashboard?from=2026-08-15",
    );
    assert.equal(
        dashboardPath(
            {
                preset: "custom",
                from: "2026-10-20",
                to: "2026-10-10",
                owner: "frostyard",
                repo: "",
            },
            today,
            "2026-08-15",
        ),
        "dashboard?from=2026-10-20&to=2026-10-10&owner=frostyard",
        "the route judges a custom range",
    );
    assert.equal(
        dashboardPath({ ...defaultSelection(), owner: "a", repo: "a/b" }, today),
        "dashboard?from=2026-10-01&owner=a&repo=a%2Fb",
    );
});

test("the scope: an owner drops another owner's repository; a repository brings its owner; choices stay", () => {
    const choices = { owners: ["a", "b"], repos: ["a/one", "a/two", "b/three"] };
    const base = defaultSelection();

    assert.deepEqual(withOwner({ ...base, owner: "a", repo: "a/one" }, "b"), {
        ...base,
        owner: "b",
        repo: "",
    });
    assert.deepEqual(withOwner({ ...base, owner: "a", repo: "a/one" }, "a"), {
        ...base,
        owner: "a",
        repo: "a/one",
    });
    assert.deepEqual(withOwner({ ...base, owner: "a", repo: "a/one" }, ""), base);
    assert.deepEqual(withRepo(base, "b/three"), { ...base, owner: "b", repo: "b/three" });
    assert.deepEqual(withRepo({ ...base, owner: "b", repo: "b/three" }, ""), {
        ...base,
        owner: "b",
    });
    assert.deepEqual(repoChoices(choices, base), choices.repos);
    assert.deepEqual(repoChoices(choices, { ...base, owner: "a" }), ["a/one", "a/two"]);
    assert.deepEqual(ownerChoices(choices, base), ["a", "b"]);
    // A chosen value that a later snapshot no longer lists stays offered.
    assert.deepEqual(repoChoices(choices, { ...base, owner: "a", repo: "a/gone" }), [
        "a/one",
        "a/two",
        "a/gone",
    ]);
    assert.deepEqual(ownerChoices(choices, { ...base, owner: "c" }), ["a", "b", "c"]);
    assert.deepEqual(repoChoices(undefined, base), []);
});

/** A metric set with only the fields the table and the states read. */
const metrics = (patch = {}) => ({
    completion: { rate: null, success: 0, denominator: 0, ...patch.completion },
    cycleTime: { medianMs: null, ...patch.cycleTime },
    timeToSolve: { medianMs: null, p90Ms: null, count: 0, nowUnresolved: 0, ...patch.timeToSolve },
    workload: { total: 0, ...patch.workload },
    prs: { merged: 0, tracked: 0, ...patch.prs },
    usage: { totalTokens: 0, cost: null, sessions: 0, ...patch.usage },
    population: { delivery: 0, coordinators: 0, ...patch.population },
});

test("sortRows: by a column either way, unknown last both ways, then by name", () => {
    const rows = [
        { name: "b", metrics: metrics({ usage: { cost: 2 } }) },
        { name: "a", metrics: metrics({ usage: { cost: null } }) },
        { name: "c", metrics: metrics({ usage: { cost: 0 } }) },
        { name: "d", metrics: metrics({ usage: { cost: 2 } }) },
    ];
    const names = (sort) => sortRows(rows, sort).map((row) => row.name);

    assert.deepEqual(names({ key: "cost", dir: "asc" }), ["c", "b", "d", "a"]);
    assert.deepEqual(names({ key: "cost", dir: "desc" }), ["b", "d", "c", "a"]);
    assert.deepEqual(names({ key: "name", dir: "desc" }), ["d", "c", "b", "a"]);
    assert.deepEqual(names({ key: "nope", dir: "asc" }), ["a", "b", "c", "d"]);
    assert.deepEqual(nextSort({ key: "cost", dir: "desc" }, "cost"), { key: "cost", dir: "asc" });
    assert.deepEqual(nextSort({ key: "cost", dir: "asc" }, "tokens"), {
        key: "tokens",
        dir: "desc",
    });
    assert.deepEqual(nextSort({ key: "cost", dir: "asc" }, "name"), { key: "name", dir: "asc" });
    assert.equal(COLUMNS[0].key, "name");
});

test("tableRows: each owner's subtotal from the answer (never computed), its projects, then unattributed", () => {
    const owner = metrics({ completion: { rate: 0.5, success: 1, denominator: 2 } });
    const snapshot = {
        rows: {
            projects: [
                { repo: "b/x", owner: "b", metrics: metrics({ workload: { total: 1 } }) },
                { repo: "a/y", owner: "a", metrics: metrics({ workload: { total: 3 } }) },
                { repo: "a/z", owner: "a", metrics: metrics({ workload: { total: 5 } }) },
            ],
            owners: [
                { owner: "a", metrics: owner },
                { owner: "b", metrics: metrics({ workload: { total: 9 } }) },
            ],
            unattributed: metrics(),
        },
    };
    const rows = tableRows(snapshot, { key: "open", dir: "desc" });

    assert.deepEqual(
        rows.map((row) => `${row.kind}:${row.name}`),
        [
            "owner:b",
            "project:b/x",
            "owner:a",
            "project:a/z",
            "project:a/y",
            "unattributed:Unattributed",
        ],
    );
    assert.equal(rows[2].metrics, owner, "the route's own subtotal, as it is");
    assert.equal(
        tableRows(
            { rows: { ...snapshot.rows, unattributed: null } },
            { key: "name", dir: "asc" },
        ).at(-1).kind,
        "project",
    );
});

/** A snapshot with only the fields the states read. */
const stateSnapshot = (patch = {}) => {
    const source = (status) => ({ status, at: 1, lastGoodAt: 1, checkedAt: 1, error: null });

    return {
        asOf: Date.UTC(2026, 9, 30, 12),
        totals:
            patch.totals ??
            metrics({ population: { delivery: 2 }, completion: { denominator: 2 } }),
        coverage: {
            status: patch.status ?? "started",
            sources: {
                threads: source(patch.threads ?? "ok"),
                github: source(patch.github ?? "ok"),
                usage: { ...source(patch.usage ?? "ok"), error: patch.usageError ?? null },
            },
            progress: {
                github: { pending: 0, complete: patch.githubComplete ?? true, overdue: 0 },
                usage: { pending: 2, complete: patch.usageComplete ?? true, ledgerUnavailable: 0 },
            },
        },
    };
};

test("dashboardStates: each state is distinct, and a good snapshot has none", () => {
    const codes = (snapshot, options) =>
        dashboardStates(snapshot, options).map((state) => state.code);

    assert.deepEqual(codes(stateSnapshot()), []);
    assert.deepEqual(codes(null), [], "loading: no snapshot and no error");
    assert.deepEqual(codes(null, { error: "HTTP 502" }), ["refresh-failed"]);
    assert.deepEqual(codes(stateSnapshot({ status: "not started" })), ["not-started"]);
    assert.deepEqual(codes(stateSnapshot({ threads: "stale" })), ["stale-source"]);
    assert.deepEqual(codes(stateSnapshot({ github: "failed" })), ["failed-source"]);
    assert.deepEqual(codes(stateSnapshot({ github: "never" })), ["never-source"]);
    assert.deepEqual(codes(stateSnapshot({ usage: "never" })), ["usage-unavailable"]);
    assert.deepEqual(codes(stateSnapshot({ usage: "failed" })), [
        "failed-source",
        "usage-unavailable",
    ]);
    assert.deepEqual(codes(stateSnapshot({ usageComplete: false })), ["partial"]);
    assert.deepEqual(codes(stateSnapshot({ githubComplete: false })), ["partial"]);
    assert.deepEqual(codes(stateSnapshot({ totals: metrics() })), ["no-work"]);
    assert.equal(noTrackedWork(metrics()), true);
    assert.equal(noTrackedWork(metrics({ usage: { sessions: 1 } })), false);
    assert.deepEqual(codes(stateSnapshot({ totals: metrics({ population: { delivery: 1 } }) })), [
        "no-closures",
    ]);
    assert.deepEqual(
        codes(stateSnapshot(), { error: "HTTP 500", rangeError: "from must not be after to." }),
        ["bad-range", "refresh-failed"],
    );

    const [failed] = dashboardStates(stateSnapshot(), { error: "HTTP 500" });

    assert.match(failed.text, /stale: they are from 2026-10-30 12:00 UTC/);
    assert.equal(failed.tone, "err");
    assert.match(
        dashboardStates(stateSnapshot({ usageComplete: false }))[0].text,
        /usage: 2 sessions pending/,
    );
});

test("rangeLine names the range, a partial today, a clamp, and the scope", () => {
    const line = (range, scope) => rangeLine({ asOf: Date.UTC(2026, 9, 30, 12), range, scope });

    assert.equal(
        line(
            { from: "2026-10-01", to: "2026-10-30", days: 30, partialToday: true, clamped: false },
            { kind: "all" },
        ),
        "Showing 2026-10-01 to 2026-10-30 UTC (30 days), today up to 2026-10-30 12:00 UTC · all tracked work",
    );
    assert.equal(
        line(
            { from: "2026-10-01", to: "2026-10-01", days: 1, partialToday: false, clamped: true },
            { kind: "repo", owner: "a", repo: "a/b" },
        ),
        "Showing 2026-10-01 to 2026-10-01 UTC (1 day), moved to the recovery boundary's day · repository a/b",
    );
});

test("makeDashboard registers 1 dispose with the module, and gives a component", () => {
    const disposes = [];
    const component = makeDashboard({
        html,
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
        Loader: () => "",
        api: async () => assert.fail("no read without a mount"),
        onDispose: (dispose) => disposes.push(dispose),
    });

    assert.equal(typeof component, "function");
    assert.equal(disposes.length, 1);
    assert.doesNotThrow(() => disposes[0]());
});

/** A coverage with only the usage source the availability rule reads. */
const usageCoverage = (status, lastGoodAt) => ({
    sources: { usage: { status, lastGoodAt, at: 1, checkedAt: null, error: null } },
});

test("usageAvailable: never collected and a failed first read are unknown; partial and failed after a good read keep their facts", () => {
    const never = usageCoverage("never", null);
    const firstFailed = usageCoverage("failed", null);
    const failedLater = usageCoverage("failed", Date.UTC(2026, 9, 29));
    const partial = usageCoverage("partial", Date.UTC(2026, 9, 30));

    assert.equal(usageAvailable(never), false);
    assert.equal(usageAvailable(firstFailed), false);
    assert.equal(usageAvailable(failedLater), true);
    assert.equal(usageAvailable(partial), true);
    assert.equal(usageAvailable(usageCoverage("ok", 1)), true);
    assert.equal(usageAvailable(usageCoverage("stale", 1)), true);
    assert.equal(usageAvailable(undefined), true, "an answer with no coverage hides nothing");

    assert.match(usageNote(never), /never collected: tokens and cost are unknown/);
    assert.match(
        usageNote(firstFailed),
        /first usage read failed: there is no good read yet, so tokens and cost are unknown/,
    );
    assert.match(usageNote(failedLater), /last good facts/);
    assert.equal(usageNote(partial), null);

    const words = (coverage) =>
        dashboardStates({
            ...stateSnapshot(),
            coverage: {
                ...stateSnapshot().coverage,
                sources: { ...stateSnapshot().coverage.sources, usage: coverage.sources.usage },
            },
        })
            .filter((state) => state.code === "usage-unavailable")
            .map((state) => state.text);

    assert.deepEqual(words(never), [`Usage is unavailable. ${usageNote(never)}`]);
    assert.deepEqual(words(firstFailed), [`Usage is unavailable. ${usageNote(firstFailed)}`]);
    assert.deepEqual(words(failedLater), [`Usage is unavailable. ${usageNote(failedLater)}`]);
    assert.deepEqual(words(partial), []);
});

test("unknown usage: every table row shows tokens and cost as unknown, and sorts them last; known usage keeps its facts", () => {
    const zero = metrics({ usage: { totalTokens: 0, cost: null } });
    const some = metrics({ usage: { totalTokens: 500, cost: 0 } });
    const rows = {
        projects: [
            { repo: "a/one", owner: "a", metrics: zero },
            { repo: "a/two", owner: "a", metrics: some },
        ],
        owners: [{ owner: "a", metrics: some }],
        unattributed: zero,
    };
    const cells = (coverage) =>
        tableRows({ rows, coverage }, { key: "tokens", dir: "desc" }).map((row) => [
            row.name,
            cellText("tokens", row),
            cellText("cost", row),
        ]);

    for (const coverage of [usageCoverage("never", null), usageCoverage("failed", null)]) {
        assert.deepEqual(cells(coverage), [
            ["a", null, null],
            ["a/one", null, null],
            ["a/two", null, null],
            ["Unattributed", null, null],
        ]);
        assert.equal(
            cellText("tokens", { metrics: zero, usageUnknown: true }),
            null,
            "the scope total too",
        );
    }

    for (const coverage of [usageCoverage("failed", 1), usageCoverage("partial", 1)]) {
        assert.deepEqual(cells(coverage), [
            ["a", "500", "$0.00"],
            ["a/two", "500", "$0.00"],
            ["a/one", "0", null],
            ["Unattributed", "0", null],
        ]);
    }

    assert.equal(
        cellText("open", { metrics: some, usageUnknown: true }),
        "0",
        "only usage goes unknown",
    );
});

test("barLayout: 1 column for each day, and a gap that lets 1 to 366 days fit", () => {
    assert.deepEqual(barLayout(7), { gap: 2, style: "--dash-days: 7; --dash-bar-gap: 2px" });
    assert.deepEqual(barLayout(31), { gap: 2, style: "--dash-days: 31; --dash-bar-gap: 2px" });
    assert.deepEqual(barLayout(90), { gap: 1, style: "--dash-days: 90; --dash-bar-gap: 1px" });
    assert.deepEqual(barLayout(366), { gap: 0, style: "--dash-days: 366; --dash-bar-gap: 0px" });
    assert.equal(barLayout(0).style, "--dash-days: 1; --dash-bar-gap: 2px");

    // The gaps alone never take more than 92 px, whatever the range.
    for (let days = 1; days <= 366; days += 1) {
        assert(barLayout(days).gap * (days - 1) <= 92, String(days));
    }
});
