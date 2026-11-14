// The Desk page's queue section: rendered with stand-ins for Pocket's page tools, no browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    unreadText,
    completedLines,
    panelStep,
    newestReads,
    planReader,
    planEnded,
    planSessionsOf,
    stepLine,
    stepStateText,
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
    MAX_RECORDS,
    meterCard,
    meterGrantsText,
    meterLedgerText,
    meterRows,
    PARTIAL_MARK,
    prEventsText,
    prUrl,
    recordsPath,
    recordsStaleText,
    recordsStep,
    residualKnowledge,
    rowKey,
    rowParts,
    tableRows,
    threadKindText,
    usageAvailable,
    usageKnowledge,
    usageNote,
    usageReadLines,
    usageText,
    useRecords,
    utcDay,
    withOwner,
    withRepo,
} from "./desk-web/dashboard.js";
import {
    actBody,
    boardAct,
    boardController,
    boardKeyFor,
    boardMarkup,
    boardPath,
    boardSplit,
    launchBody,
    limitsText,
    makeBoard,
    newBoardKey,
    rowActs,
    rowStateText,
    rowStatus,
} from "./desk-web/board.js";

const NOW = Date.now();

/** A thread-less view with this queue. */
const viewWith = (issues) => ({
    threads: [],
    seen: 0,
    others: {},
    github: null,
    cap: { counted: 0, cap: 12, full: false, grants: 0, waiting: 0 },
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

/** Render the page with this view. `onBadge` takes each rail update; `tab` is the view the switch shows. */
const render = async (view, onBadge = () => {}, tab = "desk") => {
    let page;

    setup({
        html,
        // The page's only `useState("desk")` is the view switch.
        useState: (value) => [
            value === "desk" ? tab : typeof value === "function" ? value() : value,
            () => {},
        ],
        useEffect: () => {},
        useRef: () => ({ current: null }),
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

test("unreadText: the unread links, the oldest first, at most 10, then how many more", () => {
    assert.equal(unreadText(undefined), null);
    assert.equal(unreadText([]), null);
    assert.equal(
        unreadText([
            { thread: "T12", ref: "frostyard/x#5", age: 6 * 3600_000 },
            { thread: "T13", ref: "frostyard/y#2", age: 45 * 60_000 },
        ]),
        "Unread: T12 (frostyard/x#5, 6 h), T13 (frostyard/y#2, 45 min)",
    );

    const many = Array.from({ length: 12 }, (_, index) => ({
        thread: `T${index}`,
        ref: "frostyard/x#1",
        age: 3 * 86400_000,
    }));

    assert.match(unreadText(many), /^Unread: T0 \(frostyard\/x#1, 3 d\), .*, and 2 more$/);
});

test("the header warns of PR links that no read gave facts for", async () => {
    const out = await render({
        ...viewWith(undefined),
        github: {
            at: NOW,
            ok: true,
            unread: [{ thread: "T12", ref: "frostyard/x#5", age: 6 * 3600_000 }],
        },
    });

    assert.match(out, /desk-warn">Unread: T12 \(frostyard\/x#5, 6 h\)/);

    const fresh = await render({ ...viewWith(undefined), github: { at: NOW, ok: true } });

    assert.doesNotMatch(fresh, /Unread:/);
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

test("a full desk with a refused delegation says Allow 1 tells Odrade, and how many extra OKs wait", async () => {
    const out = await render({
        ...viewWith(null),
        cap: { counted: 13, cap: 12, full: true, grants: 2, waiting: 1 },
    });

    assert.match(
        out,
        /The desk is full: 13 of 12 count\. 1 delegation waits\. Allow 1 lets Odrade open 1 more thread, and tells her to delegate the work that waited\./,
    );
    assert.match(out, /2 extra allowed/);
    assert.match(out, /> Allow 1 /);
    assert.doesNotMatch(out, /nothing waits/);
});

test("a full desk with 2 refused delegations says 2 wait", async () => {
    const out = await render({
        ...viewWith(null),
        cap: { counted: 12, cap: 12, full: true, grants: 0, waiting: 2 },
    });

    assert.match(out, /The desk is full: 12 of 12 count\. 2 delegations wait\./);
    assert.match(out, /> Allow 1 /);
    assert.doesNotMatch(out, /extra allowed/);
});

test("a full desk where nothing waits shows a quiet line and no Allow 1", async () => {
    const out = await render({
        ...viewWith(null),
        cap: { counted: 12, cap: 12, full: true, grants: 0, waiting: 0 },
    });

    assert.match(out, /12 of 12 count; nothing waits/);
    assert.doesNotMatch(out, /Allow 1/);
    assert.doesNotMatch(out, /The desk is full/);
    assert.doesNotMatch(out, /class="desk-full"/);
});

test("a full desk from an older server, with no waiting count, shows no Allow 1", async () => {
    const out = await render({
        ...viewWith(null),
        cap: { counted: 13, cap: 12, full: true, grants: 1 },
    });

    assert.match(out, /13 of 12 count; nothing waits · 1 extra allowed/);
    assert.doesNotMatch(out, /Allow 1/);
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
    assert.match(need, /T1a\s*<\/p>\s*<div class="desk-md"><p>Which one\?<\/p>/);
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
    assert.match(need, /T1a\s*<\/p>\s*<div class="desk-md"><p>Which one\?<\/p>/);
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

test("a watch with an event shows it beside the date, and a due one says how the event fired", async () => {
    const out = await render({
        ...viewWith(null),
        threads: [
            threadView({
                id: "T3",
                title: "Sleeping T3",
                asleep: true,
                watch: {
                    checkOn: "2026-12-01",
                    check: "the blob sweep",
                    setBy: "odrade",
                    due: false,
                    on: "pr:frostyard/test#12 merged",
                },
            }),
            threadView({
                id: "T4",
                title: "Due T4",
                watch: {
                    checkOn: "2026-12-02",
                    check: "the label check",
                    setBy: "odrade",
                    due: true,
                    on: "closed:T9",
                    onFired: "T9 closed as dropped",
                },
            }),
            threadView({
                id: "T5",
                title: "Sleeping T5",
                asleep: true,
                watch: { checkOn: "2026-12-03", check: "old", setBy: "odrade", due: false },
            }),
        ],
    });

    assert.match(out, /check on 2026-12-01 or on pr:frostyard\/test#12 merged/);
    assert.match(out, /due: the label check \(T9 closed as dropped\)/);
    assert.match(out, /check on 2026-12-03(?! or)/, "a dated watch shows its date only");
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

test("a ready row shows its level, and a row with no level shows no level mark", async () => {
    const out = await render({
        ...viewWith(null),
        ready: [
            {
                ref: "frostyard/test#12",
                title: "A risky fix",
                thread: "T1",
                agents: ["duncan"],
                level: "L1/L2",
                at: NOW,
            },
            {
                ref: "frostyard/test#13",
                title: "No level yet",
                thread: "T2",
                agents: ["irulan"],
                at: NOW,
            },
        ],
    });

    const start = out.indexOf("<h2>Ready to merge");
    const part = out.slice(start, out.indexOf("</section>", start));

    assert.match(
        part,
        /class="?desk-level desk-level-L1L2"?\s*>L1\/L2</,
        "the level shows beside the ref",
    );

    const rows = part.split('<li class="desk-row">').slice(1);

    assert.equal(rows.length, 2);
    assert.match(rows[0], /desk-level-L1L2/);
    assert.doesNotMatch(rows[1], /desk-level/, "a row with no level shows no level mark");
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
    assert.match(need, /T406b[^<]*<\/p>\s*<div class="desk-md"><p>Keep the old blob store\?<\/p>/);
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

    assert.match(need, /F7a[^<]*<\/p>\s*<div class="desk-md"><p>Adopt it\?<\/p>/);
    assert.match(need, /aria-label=Answered F7a/);
    assert.doesNotMatch(need, /Attach/);
    assert.doesNotMatch(need, /Drop/);
    assert.doesNotMatch(need, /Park|Keep|Wake/);
    assert.doesNotMatch(need, /Watch|Clear the watch|Pass the check|Fail the check/);
    assert.doesNotMatch(need, /ready to merge/);
});

/**
 * Render the page with hooks that keep their state, and with the handlers it gives: `act(pattern, event)` calls the
 * handler whose template text, up to it, matches `pattern`, and draws the page again.
 */
const interactive = async (view) => {
    let page;
    const states = [];
    let index = 0;
    let handlers = [];
    const flat = (value) =>
        Array.isArray(value)
            ? value.map(flat).join("")
            : typeof value === "function"
              ? "[fn]"
              : value === null || value === undefined
                ? ""
                : String(value);
    const capture = (strings, ...values) =>
        strings.reduce((out, text, at) => {
            const before = out + text;

            if (at < values.length && typeof values[at] === "function") {
                handlers.push({ before, handler: values[at] });
            }

            return before + (at < values.length ? flat(values[at]) : "");
        }, "");

    setup({
        html: capture,
        useState: (initial) => {
            const slot = index;

            index += 1;

            if (!(slot in states)) {
                states[slot] = typeof initial === "function" ? initial() : initial;
            }

            return [
                states[slot],
                (next) => {
                    states[slot] = typeof next === "function" ? next(states[slot]) : next;
                },
            ];
        },
        useEffect: () => {},
        useRef: () => ({ current: null }),
        Loader: () => "",
        style() {},
        api: async () => view,
        page: (each) => {
            page = each;
        },
        rail: () => ({ update: () => {} }),
        on: () => () => {},
        onDispose() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const draw = () => {
        index = 0;
        handlers = [];

        return page.component().replace(/\s+/g, " ");
    };

    let out = draw();

    return {
        out: () => out,
        act: (pattern, event = {}) => {
            const found = handlers.find((each) => pattern.test(each.before));

            assert(found !== undefined, `a handler for ${String(pattern)}`);
            found.handler(event);
            out = draw();
        },
    };
};

test("Closed in the last 7 days: a thread closed as done has Watch with its form; a plan, a dropped one and a failed one have none", async () => {
    const closed = (id, patch = {}) =>
        threadView({
            id,
            title: `Closed ${id}`,
            state: "closed",
            next: "none",
            closed: { at: NOW - 1000, why: "done", by: "odrade", outcome: "completed" },
            ...patch,
        });
    const page = await interactive({
        ...viewWith(null),
        threads: [
            closed("T5", {
                watch: {
                    checkOn: "2026-10-01",
                    check: "an old check",
                    setBy: "odrade",
                    due: true,
                    result: { pass: true, by: "odrade", text: "gone" },
                },
            }),
            closed("T6", { origin: "plan" }),
            closed("T7", { closed: { at: NOW - 1000, why: "dropped", by: "brian" } }),
            closed("T8", { closed: { at: NOW - 1000, why: "failed", by: "desk" } }),
        ],
    });

    assert.match(page.out(), /Closed in the last 7 days \(4\)/);
    assert.doesNotMatch(page.out(), /aria-label=Watch T5/, "the section is shut");

    page.act(/class="desk-closed"\s+onToggle=$/, { currentTarget: { open: true } });

    const part = page.out().slice(page.out().indexOf("Closed in the last 7 days"));

    assert.match(part, /aria-label=Watch T5/, "a thread closed as done takes a watch");
    assert.doesNotMatch(part, /aria-label=Watch T6/, "a plan thread has no watch");
    assert.doesNotMatch(part, /aria-label=Watch T7/, "a dropped thread has no watch");
    assert.doesNotMatch(part, /aria-label=Watch T8/, "a failed thread has no watch");
    assert.doesNotMatch(part, /Clear the watch|Pass the check|Fail the check/);
    assert.doesNotMatch(part, /Set the watch on T5/, "the form waits for the tap");

    page.act(/aria-label=Watch T5\s+onClick=$/);

    const open = page.out().slice(page.out().indexOf("Closed in the last 7 days"));

    assert.match(open, /aria-label=The check's date for T5/);
    assert.match(open, /aria-label=The check's time for T5 \(optional\)/);
    assert.match(open, /aria-label=The check for T5/);
    assert.match(open, /aria-label=Set the watch on T5/);
    assert.doesNotMatch(open, /Clear the watch|Pass the check|Fail the check/);
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
    // A queued consult shows its state as the desk names it: the page has no fixed list of states.
    assert.equal(
        consultLine({ id: "k5", agent: "irulan", state: "queued", age: 5 * 60000 }),
        "k5 irulan · queued · 5 min",
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

test("the operational view is the default: the page opens on Desk, with the Dashboard and the Board 1 tap away", async () => {
    const out = await render(viewWith(null));

    assert.match(out, /role="group" aria-label="Desk view"/);
    assert.match(out, /data-tab="desk" aria-pressed=true onClick=\[fn\] > Desk </);
    assert.match(out, /data-tab="dashboard" aria-pressed=false onClick=\[fn\] > Dashboard </);
    assert.match(out, /data-tab="board" aria-pressed=false onClick=\[fn\] > Board </);
    assert.deepEqual(
        [...out.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1]),
        ["desk", "dashboard", "board"],
        "Board is the third tab",
    );
    assert.match(out, /<h1>Desk<\/h1>/);
    assert.doesNotMatch(out, /dash-controls/);
});

test("the 3 views share 1 box: the same classes for the width, and the switch as its first child", async () => {
    const boxes = {};

    for (const tab of ["desk", "dashboard", "board"]) {
        const out = await render(viewWith(null), () => {}, tab);
        const box = /<div class="([^"]*)"> <div class="desk-tabs"/.exec(out);

        assert.ok(box, `${tab}: the view switch is the first child of the view's box`);
        assert.match(
            out,
            new RegExp(`data-tab="${tab}" aria-pressed=true`),
            `${tab}: its tab is pressed`,
        );
        boxes[tab] = box[1].split(" ").filter((name) => name === "desk" || name === "desk-view");
    }

    assert.deepEqual(boxes, {
        desk: ["desk", "desk-view"],
        dashboard: ["desk", "desk-view"],
        board: ["desk", "desk-view"],
    });

    // The box's width is the Dashboard's, in 1 rule, and no view sets a width of its own.
    const css = readFileSync(new URL("./desk-web/desk.css", import.meta.url), "utf8");
    const rule = /\.desk\.desk-view \{([^}]*)\}/.exec(css);

    assert.ok(rule, "desk.css has the .desk.desk-view rule");
    assert.match(rule[1], /max-width: 1200px;/);

    for (const own of [".dash-page", ".dash-tabs-wrap", ".board-page", ".dash", ".desk.dash"]) {
        const block = new RegExp(`(^|\\n)${own.replaceAll(".", "\\.")} \\{([^}]*)\\}`).exec(css);

        assert.doesNotMatch(
            block?.[2] ?? "",
            /width|padding|margin/,
            `${own} sets no width, padding or margin`,
        );
    }
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

test("no good usage read: every table row shows tokens and cost as unknown, and sorts them last; a good read keeps the facts", () => {
    const zero = metrics({ usage: { totalTokens: 0, cost: null, state: "none" } });
    const some = metrics({ usage: { totalTokens: 500, cost: 0, state: "complete" } });
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
        assert.equal(cellText("tokens", { metrics: some, coverage }), null, "the scope total too");
        assert.equal(cellText("open", { metrics: some, coverage }), "0", "only usage goes unknown");
    }

    for (const coverage of [usageCoverage("failed", 1), usageCoverage("partial", 1)]) {
        assert.deepEqual(cells(coverage), [
            ["a", "500", "$0.00"],
            ["a/two", "500", "$0.00"],
            ["a/one", "0", null],
            ["Unattributed", "0", null],
        ]);
    }
});

test("usageKnowledge: each row's own state, with the source's availability as an extra rule", () => {
    const good = usageCoverage("ok", 1);
    const never = usageCoverage("never", null);
    const firstFailed = usageCoverage("failed", null);

    assert.equal(usageKnowledge({ state: "complete" }, good), "known");
    assert.equal(usageKnowledge({ state: "none" }, good), "known");
    assert.equal(usageKnowledge({ state: "partial" }, good), "partial");
    assert.equal(usageKnowledge({ state: "unknown" }, good), "unknown");
    assert.equal(
        usageKnowledge({ state: "complete" }, undefined),
        "known",
        "no coverage hides nothing",
    );
    assert.equal(usageKnowledge(undefined, good), "unknown");

    for (const coverage of [never, firstFailed]) {
        for (const state of ["complete", "partial", "unknown", "none"]) {
            assert.equal(
                usageKnowledge({ state }, coverage),
                "unknown",
                `${state} with no good read`,
            );
        }
    }

    assert.equal(usageText("6,500", "known"), "6,500");
    assert.equal(usageText("6,500", "partial"), `6,500${PARTIAL_MARK}`);
    assert.equal(usageText("6,500", "partial"), "6,500 (partial)");
    assert.equal(usageText("6,500", "unknown"), null);
    assert.equal(usageText(null, "partial"), null, "an unknown cost stays unknown, not partial");
    assert.equal(usageText("$0.00", "known"), "$0.00", "an explicit 0 stays 0");

    assert.deepEqual(
        usageReadLines(
            { state: "partial", sessionStates: { complete: 2, partial: 1, unknown: 3 } },
            good,
        ),
        { read: "partial", sessions: "2 complete, 1 partial, 3 unknown" },
    );
    assert.deepEqual(
        usageReadLines(
            { state: "none", sessionStates: { complete: 0, partial: 0, unknown: 0 } },
            good,
        ),
        { read: "none", sessions: "0 complete, 0 partial, 0 unknown" },
    );
    assert.equal(usageReadLines({ state: "complete" }, never).read, "unknown");
    assert.equal(usageReadLines({}, good).sessions, null);
});

test("per-row usage: unknown is a dash and sorts last, partial is marked and sorts by its number, 0 stays 0", () => {
    const coverage = usageCoverage("ok", 1);
    const row = (name, usage) => ({
        kind: "project",
        name,
        owner: "a",
        coverage,
        metrics: metrics({ usage }),
    });
    const rows = [
        row("a/complete", { state: "complete", totalTokens: 300, cost: 0 }),
        row("a/partial", { state: "partial", totalTokens: 6500, cost: 0.75 }),
        row("a/unknown", { state: "unknown", totalTokens: null, cost: null }),
        row("a/none", { state: "none", totalTokens: 0, cost: null }),
        row("a/partial-no-cost", { state: "partial", totalTokens: 10, cost: null }),
    ];
    const texts = rows.map((each) => [each.name, cellText("tokens", each), cellText("cost", each)]);

    assert.deepEqual(texts, [
        ["a/complete", "300", "$0.00"],
        ["a/partial", "6,500 (partial)", "$0.75 (partial)"],
        ["a/unknown", null, null],
        ["a/none", "0", null],
        ["a/partial-no-cost", "10 (partial)", null],
    ]);

    const names = (sort) => sortRows(rows, sort).map((each) => each.name);

    assert.deepEqual(names({ key: "tokens", dir: "desc" }), [
        "a/partial",
        "a/complete",
        "a/partial-no-cost",
        "a/none",
        "a/unknown",
    ]);
    assert.deepEqual(names({ key: "tokens", dir: "asc" }), [
        "a/none",
        "a/partial-no-cost",
        "a/complete",
        "a/partial",
        "a/unknown",
    ]);
    assert.deepEqual(names({ key: "cost", dir: "asc" }), [
        "a/complete",
        "a/partial",
        "a/none",
        "a/partial-no-cost",
        "a/unknown",
    ]);

    // The same rows with no good read: every usage value is unknown.
    const lost = rows.map((each) => ({ ...each, coverage: usageCoverage("never", null) }));

    assert(
        lost.every((each) => cellText("tokens", each) === null && cellText("cost", each) === null),
    );
    assert.deepEqual(
        tableRows(
            {
                coverage,
                rows: {
                    projects: [{ repo: "a/x", owner: "a", metrics: rows[1].metrics }],
                    owners: [{ owner: "a", metrics: rows[2].metrics }],
                    unattributed: rows[3].metrics,
                },
            },
            { key: "name", dir: "asc" },
        ).map((each) => cellText("tokens", each)),
        [null, "6,500 (partial)", "0"],
        "each row from its own usage: the unknown owner, the partial project, the unattributed none",
    );
});

test("dashboardStates: the usage-unknown limitation is a notice with its own words", () => {
    const text =
        "Some counted sessions have no complete usage read: their usage is unknown or partial, not 0.";
    const snapshot = stateSnapshot();

    snapshot.coverage.limitations = [
        { code: "tracked-work-only", text: "Only Desk-tracked work counts." },
        { code: "usage-unknown", text },
    ];

    assert.deepEqual(dashboardStates(snapshot), [{ code: "usage-unknown", tone: "warn", text }]);
    snapshot.coverage.limitations = [{ code: "tracked-work-only", text: "x" }];
    assert.deepEqual(dashboardStates(snapshot), []);
});

test("the drill-down: the records path of each row kind, the PR link, and the words", () => {
    const range = { from: "2026-10-01", to: "2026-10-30" };

    assert.equal(
        recordsPath({ kind: "project", name: "frostyard/snosi", owner: "frostyard" }, range),
        "dashboard/records?from=2026-10-01&to=2026-10-30&repo=frostyard%2Fsnosi",
    );
    assert.equal(
        recordsPath({ kind: "owner", name: "frostyard", owner: "frostyard" }, range),
        "dashboard/records?from=2026-10-01&to=2026-10-30&owner=frostyard",
    );
    assert.equal(
        recordsPath({ kind: "unattributed", name: "Unattributed", owner: "" }, range),
        "dashboard/records?from=2026-10-01&to=2026-10-30&unattributed=1",
    );
    assert.equal(recordsPath({ kind: "total", name: "Scope total" }, range), null);
    assert.equal(rowKey({ kind: "project", name: "a/b" }), "project:a/b");
    assert.notEqual(rowKey({ kind: "owner", name: "a" }), rowKey({ kind: "project", name: "a" }));
    assert.equal(MAX_RECORDS, 200);

    assert.equal(prUrl({ repo: "a/b.c", number: 7 }), "https://github.com/a/b.c/pull/7");
    assert.equal(prUrl({ repo: "a/b/../c", number: 7 }), null);
    assert.equal(prUrl({ repo: "javascript:alert(1)", number: 7 }), null);
    assert.equal(prUrl({ repo: "a/b", number: 0 }), null);
    assert.equal(prUrl({ repo: "a/b", number: 1.5 }), null);
    assert.equal(prUrl({ repo: "a/b", number: "7" }), null);
    assert.equal(prUrl(undefined), null);

    assert.equal(threadKindText({ kind: "now", state: "parked" }), "parked now");
    assert.equal(threadKindText({ kind: "success", state: "closed" }), "closed: success");
    assert.equal(threadKindText({ kind: "abandoned", state: "closed" }), "closed: abandoned");
    assert.equal(threadKindText({ kind: "failed", state: "closed" }), "closed: failed");
    assert.equal(
        threadKindText({ kind: "dropped", state: "closed" }),
        "closed: dropped (excluded)",
    );
    assert.equal(threadKindText({ kind: "frozen", state: "closed" }), "closed: frozen (excluded)");
    assert.equal(
        threadKindText({ kind: "unknown", state: "closed" }),
        "closed: unknown outcome (excluded)",
    );
    assert.equal(
        prEventsText({ state: "MERGED", events: ["created", "merged"] }),
        "merged · created in range, merged in range",
    );
    assert.equal(prEventsText({ state: "OPEN", events: ["open-now"] }), "open · open now");
    assert.equal(
        prEventsText({ state: null, events: ["closed-unmerged"] }),
        "not read · closed unmerged in range",
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

test("lint: an undefined name in a page module is an error (no-undef), and browser globals are known", async () => {
    // `npm run lint` runs this config: a name that only another component declares (a ReferenceError at runtime) fails.
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: import.meta.dirname });

    for (const file of ["desk-web/index.js", "desk-web/dashboard.js", "team-web/index.js"]) {
        const config = await eslint.calculateConfigForFile(file);

        assert.equal(config.rules["no-undef"]?.[0], 2, file);
    }

    const [bad] = await eslint.lintText(
        "export const view = (html) => html`<button aria-label=${backLabel}>Back</button>`;\n",
        { filePath: "desk-web/probe.js" },
    );

    assert.deepEqual(
        bad.messages.map((message) => [message.ruleId, message.message]),
        [["no-undef", "'backLabel' is not defined."]],
    );

    const [good] = await eslint.lintText(
        "export const later = () => {\n    const abort = new AbortController();\n\n    setTimeout(() => abort.abort(), 0);\n\n    return document.title;\n};\n",
        { filePath: "desk-web/probe.js" },
    );

    assert.deepEqual(good.messages, []);
});

test("rowParts: a row has the same shape open or closed, so its button keeps the focus", () => {
    const line = { type: "tr", key: "row" };
    const drill = { type: "tr", key: "records" };
    const closed = rowParts(line, null);
    const open = rowParts(line, drill);

    assert.equal(closed.length, 2);
    assert.equal(open.length, 2);
    assert.equal(closed[0], line, "the row first, closed");
    assert.equal(open[0], line, "the row first, open: the same slot, so it is not mounted again");
    assert.equal(closed[1], null, "a hole that keeps the slot of the drill-down");
    assert.equal(open[1], drill);
    assert.deepEqual(rowParts(line, undefined), [line, null]);
});

test("recordsStep: a read again keeps the list shown; a failed read again marks it stale with its own time", () => {
    const first = { asOf: 10, threads: [{ id: "T1" }], prs: [], truncated: { threads: 0, prs: 0 } };
    const second = {
        asOf: 70,
        threads: [{ id: "T2" }],
        prs: [],
        truncated: { threads: 0, prs: 0 },
    };
    const loading = recordsStep(null, { type: "start" });

    assert.deepEqual(loading, { status: "loading", answer: null, error: null, asOf: null });
    assert.deepEqual(recordsStep(loading, { type: "failure", error: "HTTP 500" }), {
        status: "error",
        answer: null,
        error: "HTTP 500",
        asOf: null,
    });

    const done = recordsStep(loading, { type: "answer", answer: first });

    assert.deepEqual(done, { status: "done", answer: first, error: null, asOf: 10 });
    // The next snapshot: the old list stays while it reads again.
    const again = recordsStep(done, { type: "start" });

    assert.deepEqual(again, { status: "refreshing", answer: first, error: null, asOf: 10 });

    const stale = recordsStep(again, { type: "failure", error: "HTTP 502" });

    assert.deepEqual(stale, { status: "stale", answer: first, error: "HTTP 502", asOf: 10 });
    // Read again once more: the stale mark stays until a good answer.
    assert.deepEqual(recordsStep(stale, { type: "start" }), {
        status: "refreshing",
        answer: first,
        error: "HTTP 502",
        asOf: 10,
    });
    assert.deepEqual(recordsStep(stale, { type: "answer", answer: second }), {
        status: "done",
        answer: second,
        error: null,
        asOf: 70,
    });
});

/** 1 component's hooks, enough for `useRecords`: state with updaters, and 1 effect run again when its deps change. */
const hookHost = () => {
    const slot = { state: undefined, deps: null, cleanup: null };

    return {
        slot,
        unmount: () => slot.cleanup?.(),
        hooks: {
            useState: (initial) => {
                if (slot.state === undefined) {
                    slot.state = { value: typeof initial === "function" ? initial() : initial };
                }

                return [
                    slot.state.value,
                    (next) => {
                        slot.state.value =
                            typeof next === "function" ? next(slot.state.value) : next;
                    },
                ];
            },
            useEffect: (effect, deps) => {
                if (
                    slot.deps === null ||
                    deps.some((dep, index) => !Object.is(dep, slot.deps[index]))
                ) {
                    slot.cleanup?.();
                    slot.deps = deps;
                    slot.cleanup = effect();
                }
            },
        },
    };
};

test("useRecords: a new snapshot with the same path reads the open drill-down again (the 60-second refresh)", async () => {
    const path = "dashboard/records?from=2026-10-01&to=2026-10-30&repo=frostyard%2Fsnosi";
    const answers = [
        { asOf: 10, threads: [{ id: "T1" }], prs: [], truncated: { threads: 0, prs: 0 } },
        {
            asOf: 70,
            threads: [{ id: "T1" }, { id: "T2" }],
            prs: [],
            truncated: { threads: 0, prs: 0 },
        },
    ];
    const calls = [];
    let fail = false;

    const api = async (each, body, { signal }) => {
        calls.push({ path: each, signal });

        if (fail) {
            throw new Error("HTTP 502");
        }

        return answers[Math.min(calls.length - 1, answers.length - 1)];
    };

    const mounted = new Set();
    const host = hookHost();
    const render = (stamp) => useRecords({ ...host.hooks, api, mounted }, path, stamp);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const first = { asOf: 10 };
    const second = { asOf: 70 };
    const third = { asOf: 130 };

    assert.equal(render(first).status, "loading");
    await settle();
    assert.deepEqual(render(first), {
        status: "done",
        answer: answers[0],
        error: null,
        asOf: 10,
    });
    // The same snapshot again (any other render): no new read.
    assert.equal(calls.length, 1);

    // The refresh brings a new snapshot; the path stays. The open records read again, and the old list stays meanwhile.
    render(second);
    // The effect's state shows at the next render, as in Preact.
    const reading = render(second);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, path);
    assert.deepEqual(reading, { status: "refreshing", answer: answers[0], error: null, asOf: 10 });
    await settle();
    assert.deepEqual(render(second), {
        status: "done",
        answer: answers[1],
        error: null,
        asOf: 70,
    });

    // A failed read again keeps the list, marked stale with the time of its own snapshot.
    fail = true;
    render(third);
    await settle();
    assert.deepEqual(render(third), {
        status: "stale",
        answer: answers[1],
        error: "HTTP 502",
        asOf: 70,
    });
    assert.equal(mounted.size, 1, "1 read at a time");

    // A newer snapshot during a read aborts the older read; unmount aborts the last and leaves the module's set.
    fail = false;
    render({ asOf: 190 });
    render({ asOf: 250 });
    assert.equal(calls.at(-2).signal.aborted, true);
    host.unmount();
    assert.equal(calls.at(-1).signal.aborted, true);
    assert.equal(mounted.size, 0);
    await settle();
    assert.equal(host.slot.state.value.status, "refreshing", "an aborted read changes nothing");
});

test("useRecords: the list keeps the asOf of its own records answer, not the dashboard's snapshot", async () => {
    // The records route reads at its own instant, after the dashboard's snapshot. A later stale notice must name the
    // time of the list, not the older time of the snapshot.
    const path = "dashboard/records?from=2026-10-01&to=2026-10-30&repo=frostyard%2Fsnosi";
    const answer = {
        asOf: 65,
        threads: [{ id: "T1" }],
        prs: [],
        truncated: { threads: 0, prs: 0 },
    };
    let fail = false;

    const api = async () => {
        if (fail) {
            throw new Error("HTTP 502");
        }

        return answer;
    };

    const host = hookHost();
    const render = (stamp) => useRecords({ ...host.hooks, api, mounted: new Set() }, path, stamp);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = { asOf: 60 };
    const later = { asOf: 120 };

    render(snapshot);
    await settle();
    assert.equal(render(snapshot).asOf, 65, "the time of the records answer, not 60");

    fail = true;
    render(later);
    await settle();
    assert.deepEqual(render(later), {
        status: "stale",
        answer,
        error: "HTTP 502",
        asOf: 65,
    });

    // An answer with no good time shows no time, never the dashboard's.
    assert.equal(
        recordsStep(null, { type: "answer", answer: { ...answer, asOf: "65" } }).asOf,
        null,
    );
    assert.equal(
        recordsStep(null, { type: "answer", answer: { ...answer, asOf: Number.NaN } }).asOf,
        null,
    );
});

test("recordsStaleText: the notice names the time of the list, or says that it is unknown", () => {
    assert.equal(
        recordsStaleText("HTTP 502", Date.UTC(2026, 9, 31, 12, 5)),
        "The threads and PRs could not be read again: HTTP 502. This list is from 2026-10-31 12:05 UTC, older than the numbers of the row.",
    );
    assert.equal(
        recordsStaleText("HTTP 502", null),
        "The threads and PRs could not be read again: HTTP 502. The time of this list is unknown: it can be older than the numbers of the row.",
    );
});

test("residualKnowledge: the residual follows its own availability, not the dated usage's", () => {
    const residual = { sessions: 1, counters: { totalTokens: 55, cost: 0.02 } };
    const ok = { sources: { usage: { status: "ok", lastGoodAt: 1 } } };
    const scope = (patch = {}) => ({
        state: "unknown",
        totalTokens: null,
        residuals: { settled: 1, pending: 0, mismatch: 0, unavailable: 0, absent: 6 },
        undated: { counters: {}, residual },
        ...patch,
    });

    assert.equal(usageKnowledge(scope(), ok), "unknown");
    assert.equal(
        residualKnowledge(scope(), ok),
        "known",
        "every counted session unknown: the residual stays",
    );
    assert.equal(residualKnowledge(scope({ state: "complete" }), ok), "known");
    assert.equal(
        residualKnowledge(
            scope({
                residuals: { settled: 1, pending: 0, mismatch: 1, unavailable: 0, absent: 0 },
            }),
            ok,
        ),
        "partial",
    );
    assert.equal(
        residualKnowledge(
            scope({
                residuals: { settled: 1, pending: 0, mismatch: 0, unavailable: 1, absent: 0 },
            }),
            ok,
        ),
        "partial",
    );
    assert.equal(
        residualKnowledge(scope({ undated: { counters: {}, residual: null } }), ok),
        "unknown",
    );
    assert.equal(
        residualKnowledge(scope(), { sources: { usage: { status: "never", lastGoodAt: null } } }),
        "unknown",
    );
    assert.equal(residualKnowledge(null, ok), "unknown");
});

// ─── The Plan panel, the stepper and the completed plans ─────────────────────

test("planSessionsOf: each planning session gives its plan; an older view gives none", () => {
    const sessions = planSessionsOf({
        planSessions: [
            { plan: "T1", session: 31 },
            { plan: "T4", session: 40 },
        ],
    });

    assert.equal(sessions.get(31), "T1");
    assert.equal(sessions.get(40), "T4");
    assert.equal(sessions.get(7), undefined);
    assert.equal(planSessionsOf({}).size, 0);
    assert.equal(planSessionsOf(null).size, 0);
});

test("panelStep: add once, remove once, and keep when nothing changed", () => {
    assert.equal(panelStep(false, true), "add");
    assert.equal(panelStep(true, true), "keep");
    assert.equal(panelStep(true, false), "remove");
    assert.equal(panelStep(false, false), "keep");
});

test("panelStep: before the first view the panel is added at once and kept; after it, a plain session removes it", () => {
    // No view yet: the planning sessions are not known, so the panel is there whatever the session.
    assert.equal(panelStep(false, false, false), "add");
    assert.equal(panelStep(false, true, false), "add");
    assert.equal(panelStep(true, false, false), "keep");
    assert.equal(panelStep(true, true, false), "keep");
    // The first view came: the rule of the planning sessions.
    assert.equal(panelStep(true, false, true), "remove");
    assert.equal(panelStep(true, true, true), "keep");
});

test("panelStep: a failed read with no view yet removes the panel once; a good view decides again", () => {
    // Before the first read ends: added and kept.
    assert.equal(panelStep(false, false, false, false), "add");
    assert.equal(panelStep(true, false, false, false), "keep");
    // The first read failed: removed, and kept out while there is no view.
    assert.equal(panelStep(true, false, false, true), "remove");
    assert.equal(panelStep(true, true, false, true), "remove");
    assert.equal(panelStep(false, true, false, true), "keep");
    // A good read: in a planning session it comes again; in a plain session it stays out.
    assert.equal(panelStep(false, true, true, false), "add");
    assert.equal(panelStep(false, false, true, false), "keep");
});

test("planReader: a changed read aborts the first read and fails: the error shows; a failed refresh keeps the plan", async () => {
    const shown = [];
    const errors = [];
    const answers = [];
    const signals = [];
    const reader = planReader(
        (signal) => {
            const answer = deferred();

            answers.push(answer);
            signals.push(signal);

            return answer.promise;
        },
        (plan, first) => shown.push(`${plan}${first ? " first" : ""}`),
        (message) => errors.push(message),
    );

    // The first read, then a changed event's read, which aborts it.
    const first = reader.open().catch((failure) => failure.message);
    const changed = reader.open().catch((failure) => failure.message);

    assert.equal(signals[0].aborted, true);
    answers[0].reject(new Error("aborted"));
    answers[1].reject(new Error("The plan read failed."));
    assert.equal(await first, "aborted");
    assert.equal(await changed, "The plan read failed.");
    assert.deepEqual(errors, ["The plan read failed."], "the error shows: no loader for ever");
    assert.deepEqual(shown, []);

    // Retry: the plan shows, the first time.
    const retry = reader.open();

    answers[2].resolve("T1 v1");
    await retry;
    assert.deepEqual(shown, ["T1 v1 first"]);

    // A refresh that fails while the plan shows: no error, the plan stays.
    const refresh = reader.open().catch(() => "failed");

    answers[3].reject(new Error("A refresh failed."));
    await refresh;
    assert.deepEqual(errors, ["The plan read failed."]);
    assert.deepEqual(shown, ["T1 v1 first"]);
});

/** A promise and its resolve and reject: an answer that comes when the test says. */
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
};

test("newestReads: the first read finishes last, and the view keeps the newer answer", async () => {
    const reads = newestReads();
    const shown = [];
    const first = deferred();
    const second = deferred();
    const signals = [];

    const read = (answer) => (signal) => {
        signals.push(signal);

        return answer.promise;
    };

    const one = reads.run(read(first), (plan) => shown.push(plan));
    const two = reads.run(read(second), (plan) => shown.push(plan));

    assert.equal(signals[0].aborted, true, "a new read aborts the one before it");
    second.resolve("newer");
    assert.equal(await two, "newer");
    first.resolve("older");
    assert.equal(await one, "older", "the read gives its own answer back");
    assert.deepEqual(shown, ["newer"]);
});

test("newestReads: only the newest read's error shows, and stop drops a read in flight", async () => {
    const reads = newestReads({ abort: false });
    const shown = [];
    const errors = [];
    const first = deferred();
    const second = deferred();
    const signals = [];
    const run = (answer) =>
        reads
            .run(
                (signal) => {
                    signals.push(signal);

                    return answer.promise;
                },
                (view) => shown.push(view),
                (failure) => errors.push(failure.message),
            )
            .catch(() => "failed");

    const one = run(first);
    const two = run(second);

    assert.equal(signals[0].aborted, false, "a threads read is not aborted");
    second.resolve("newer");
    first.reject(new Error("older failed"));
    assert.equal(await one, "failed");
    await two;
    assert.deepEqual(shown, ["newer"]);
    assert.deepEqual(errors, [], "the older read's error is dropped");

    const third = deferred();
    const three = run(third);

    third.reject(new Error("newest failed"));
    await three;
    assert.deepEqual(errors, ["newest failed"]);

    const fourth = deferred();
    const four = run(fourth);

    reads.stop();
    fourth.resolve("late");
    await four;
    assert.deepEqual(shown, ["newer"], "a read that stop dropped shows nothing");
});

test("the stepper's words: each state for a screen reader, and a step's detail with its day", () => {
    assert.equal(stepStateText("done"), "done");
    assert.equal(stepStateText("current"), "current");
    assert.equal(stepStateText("todo"), "not reached");

    const day = (at) => `day ${at}`;

    assert.equal(stepLine({ detail: "rev 3f2a9c1", at: 5 }, day), "rev 3f2a9c1 · day 5");
    assert.equal(stepLine({ detail: "2/4 tasks done" }, day), "2/4 tasks done");
    assert.equal(stepLine({ at: 9 }, day), "day 9");
    assert.equal(stepLine({}, day), "");
});

test("planEnded: a done or dropped plan takes no act", () => {
    assert.equal(planEnded({ state: "done" }), true);
    assert.equal(planEnded({ state: "dropped" }), true);
    assert.equal(planEnded({ state: "verifying" }), false);
    assert.equal(planEnded(null), false);
});

test("completedLines: the lead and the days, the rounds and the tasks", () => {
    const day = (at) => `d${at}`;

    assert.deepEqual(
        completedLines(
            {
                id: "T5",
                title: "Sign the ISO",
                lead: "lucilla",
                outcome: "verified",
                startedAt: 1,
                approvedAt: 2,
                endedAt: 3,
                rounds: 2,
                failed: 1,
                tasks: { done: 4, total: 4 },
            },
            day,
        ),
        [
            "lead lucilla · started d1 · approved d2 · ended d3",
            "2 verify rounds (1 failed) · 4/4 tasks",
        ],
    );
    assert.deepEqual(
        completedLines(
            {
                id: "T6",
                title: "Old idea",
                lead: "teg",
                outcome: "dropped",
                startedAt: 1,
                rounds: 1,
                failed: 0,
            },
            day,
        ),
        ["lead teg · started d1 · not approved", "1 verify round (0 failed) · no approved graph"],
    );
});

test("the Plans section shows the Completed plans button with its count", async () => {
    const out = await render({ ...viewWith(null), plans: [], plansDone: 3 });

    assert.match(out, /Completed plans \(3\)/);

    const older = await render({ ...viewWith(null), plans: [] });

    assert.match(older, /Completed plans \(0\)/);
});

/** Set the module up with panels: the panels it adds and removes, and the conversation listener it gives. */
const withPanels = async (view, conversation, api = async () => view) => {
    const log = [];
    const panels = [];

    let listener = () => {};

    let changed = () => {};

    setup({
        html,
        useState: (value) => [typeof value === "function" ? value() : value, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        Loader: () => "",
        style() {},
        api,
        page() {},
        rail: () => ({ update() {} }),
        on: (name, handler) => {
            if (name === "changed") {
                changed = handler;
            }

            return () => {};
        },
        onDispose() {},
        conversationId: () => conversation,
        panel(spec) {
            panels.push(spec);
            log.push(`add ${spec.id} ${spec.title} ${spec.wide} ${spec.icon}`);

            return { update() {}, remove: () => log.push("remove") };
        },
        closePanel: () => log.push("close"),
        openPanel: (id) => log.push(`open ${id}`),
        openConversation: (id) => log.push(`conversation ${id}`),
        onConversation(next) {
            listener = next;
            next(conversation);

            return () => {};
        },
    });

    const atSetup = [...log];

    await new Promise((resolve) => setTimeout(resolve, 20));

    return {
        log,
        atSetup,
        show: (id) => listener(id),
        changed: () => changed(),
        drawPanel: () => String(panels.at(-1).component({ close() {} })).replace(/\s+/g, " "),
    };
};

const ADDED = "add plan Plan true file";

test("the Plan panel is added at once, before the first view; after it, a plain session removes it", async () => {
    const view = { ...viewWith(null), plans: [], planSessions: [{ plan: "T1", session: 31 }] };
    const plain = await withPanels(view, 7);

    assert.deepEqual(plain.atSetup, [ADDED], "added before the first view");
    assert.deepEqual(
        plain.log,
        [ADDED, "close", "remove"],
        "the first view removes it from a plain session",
    );

    const planning = await withPanels(view, 31);

    assert.deepEqual(planning.atSetup, [ADDED]);
    assert.deepEqual(
        planning.log,
        [ADDED],
        "kept beside the planning session, and not added again",
    );
});

test("a failed first read removes the panel; a good read adds it again in a planning session only", async () => {
    const planning = { ...viewWith(null), plans: [], planSessions: [{ plan: "T1", session: 31 }] };
    const answers = [];

    const run = async (conversation) => {
        answers.length = 0;

        const made = await withPanels(null, conversation, () => {
            const answer = deferred();

            answers.push(answer);

            return answer.promise;
        });

        // The first read runs: the panel is there, with a loader.
        assert.deepEqual(made.log, [ADDED]);
        assert.match(made.drawPanel(), /<\[fn\] label="Reading the desk" \/>/, "the Loader");

        answers[0].reject(new Error("The desk is out of reach."));
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(made.log, [ADDED, "close", "remove"], "a failed first read removes it");

        // The next change reads again, and the view comes.
        made.changed();
        answers[1].resolve(planning);
        await new Promise((resolve) => setTimeout(resolve, 10));

        return made.log;
    };

    assert.deepEqual(
        await run(31),
        [ADDED, "close", "remove", ADDED],
        "added again beside a planning session",
    );
    assert.deepEqual(
        await run(7),
        [ADDED, "close", "remove"],
        "not added again in a plain session",
    );
});

test("2 thread reads that finish in reverse order: the newer view stays, and the panel stays", async () => {
    const reads = [];
    const newer = { ...viewWith(null), plans: [], planSessions: [{ plan: "T1", session: 31 }] };
    const older = { ...viewWith(null), plans: [], planSessions: [] };
    const { log, changed, drawPanel } = await withPanels(null, 31, (path) => {
        const answer = deferred();

        reads.push({ path, answer });

        return answer.promise;
    });

    // The first read (from setup) waits; a change starts a second read.
    changed();
    assert.deepEqual(
        reads.map((each) => each.path),
        ["threads", "threads"],
    );
    reads[1].answer.resolve(newer);
    await new Promise((resolve) => setTimeout(resolve, 10));
    reads[0].answer.resolve(older);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(log, [ADDED], "the older view did not remove the panel");
    assert.match(drawPanel(), /id=T1 mode="panel"/, "the panel shows the plan of the newer view");
});

test("the Plan panel is added only beside a planning session, once, and goes when another session shows", async () => {
    const view = { ...viewWith(null), plans: [], planSessions: [{ plan: "T1", session: 31 }] };
    const { log, show } = await withPanels(view, 31);

    assert.deepEqual(log, ["add plan Plan true file"]);

    // The same session again, and a second planning session's view: the same spec is not added again.
    show(31);
    assert.deepEqual(log, ["add plan Plan true file"]);

    show(7);
    assert.deepEqual(log, ["add plan Plan true file", "close", "remove"]);

    show(null);
    assert.deepEqual(log, ["add plan Plan true file", "close", "remove"]);

    show(31);
    assert.deepEqual(log, [
        "add plan Plan true file",
        "close",
        "remove",
        "add plan Plan true file",
    ]);
});

test("an app with no panels adds none, and the page still draws", async () => {
    const out = await render({
        ...viewWith(null),
        plans: [],
        planSessions: [{ plan: "T1", session: 31 }],
    });

    assert.match(out, /Plans <span class="desk-count">0/);
});

// ─── The Board view (the goal board) ─────────────────────────────────────────

const LIMITS_LINE = "8 at once, 3 running · cap 16, 9 count, 2 kept free · 120 of 250 rounds today";

/** 1 board row as `GET board` gives it. */
const boardRow = (patch = {}) => ({
    id: 1,
    rev: 1,
    state: "proposed",
    agent: "teg",
    repo: "frostyard/teg",
    title: "Tend teg",
    task: "Fix the flaky tests.",
    stopWhen: "CI is green",
    max: 20,
    until: "06:45",
    kind: "goal",
    order: 10,
    by: "teg",
    attempts: [],
    ...patch,
});

/** A board of supervisor 7, in launch order: 1 row in each state the page acts on, and 1 launched. */
const boardAnswer = (rows) => ({
    supervisors: [7],
    supervisor: 7,
    rows: rows ?? [
        boardRow({ id: 3, rev: 2, title: "Row three", note: "first", order: 5 }),
        boardRow({ id: 1, rev: 1, state: "picked", title: "Row one", kind: "sweep" }),
        boardRow({ id: 4, rev: 3, state: "waiting", title: "Row four", order: 40 }),
        boardRow({
            id: 5,
            rev: 1,
            state: "failed",
            title: "Row five",
            error: "over the day's round budget",
            order: 50,
        }),
        boardRow({
            id: 6,
            rev: 4,
            state: "unknown",
            title: "Row six",
            error: "it threw",
            order: 60,
        }),
        boardRow({
            id: 7,
            rev: 1,
            state: "launched",
            title: "Row seven",
            thread: "T12",
            next: "agent",
            order: 70,
        }),
        boardRow({ id: 8, rev: 2, state: "picked", title: "Row eight", order: 80 }),
    ],
    limits: {
        line: LIMITS_LINE,
        atOnce: 8,
        running: 3,
        cap: 16,
        counted: 9,
        reserve: 2,
        rounds: 120,
        roundsMax: 250,
    },
});

/** `html` that keeps each handler, so a test can tap a button by its `data-act`. */
const tapHtml = () => {
    const handlers = [];
    const flat = (value) =>
        Array.isArray(value)
            ? value.map(flat).join("")
            : typeof value === "function"
              ? `[fn${String(handlers.push(value) - 1)}]`
              : value === null || value === undefined
                ? ""
                : String(value);
    const tag = (strings, ...values) =>
        strings.reduce(
            (out, text, index) => out + text + (index < values.length ? flat(values[index]) : ""),
            "",
        );

    return { tag, handlers };
};

/** The markup of the controller's view now, and a tap on the button whose `data-act` is `act`. */
const boardScreen = (ctl) => {
    const { tag, handlers } = tapHtml();
    const out = boardMarkup(tag, ctl.view(), ctl).replace(/\s+/g, " ");

    return {
        out,
        tap: (act) => {
            const found = new RegExp(`data-act="?${act}"? [^>]*?onClick=\\[fn(\\d+)\\]`).exec(out);

            assert(found !== null, `a button ${act} in: ${out}`);

            return handlers[Number(found[1])]();
        },
        has: (act) => new RegExp(`data-act="?${act}"? `).test(out),
    };
};

/** A fake `pocket.api` for the board: `board` answers the GET, `post` each POST (a value, an Error, or a function). */
const boardApi = ({
    board = boardAnswer(),
    post = (body) => ({ ...boardAnswer(), pass: [], body }),
} = {}) => {
    const calls = [];

    return {
        calls,
        posts: () => calls.filter((call) => call[0] === "POST"),
        call: async (path, body) => {
            calls.push(body === undefined ? ["GET", path] : ["POST", path, body]);

            if (body === undefined) {
                return typeof board === "function" ? board() : board;
            }

            const answer = typeof post === "function" ? await post(body) : post;

            if (answer instanceof Error) {
                throw answer;
            }

            return answer;
        },
    };
};

/** Keys k1, k2, … in the order they are made. */
const keyMaker = () => {
    let made = 0;

    return () => `key-000${String((made += 1))}`;
};

/** A loaded controller on a fake API. */
const loadedBoard = async (api) => {
    const ctl = boardController(api.call, { make: keyMaker() });

    await ctl.load();

    return ctl;
};

test("Board: the rows in launch order, with the limits line, each with its facts, note, state and rev", async () => {
    const api = boardApi();
    const ctl = await loadedBoard(api);
    const { out } = boardScreen(ctl);

    assert.deepEqual(api.calls, [["GET", "board"]]);
    assert.match(out, /<h1>Board<\/h1>/);
    assert.ok(out.includes(LIMITS_LINE), "the limits line");

    const order = [
        "#3 Row three",
        "#1 Row one",
        "#4 Row four",
        "#5 Row five",
        "#6 Row six",
        "#7 Row seven",
        "#8 Row eight",
    ].map((title) => out.indexOf(title));

    assert(
        order.every((at) => at >= 0),
        JSON.stringify(order),
    );
    assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b),
        "the rows in the answer's order",
    );
    assert.ok(out.includes("teg frostyard/teg · goal · max 20 · until 06:45"));
    assert.ok(out.includes("teg frostyard/teg · sweep · max 20 · until 06:45"));
    assert.ok(out.includes("Note: first"));
    assert.ok(out.includes("proposed · rev 2"));
    assert.ok(out.includes("launched (running) · rev 1 · T12 (next: agent)"));
    assert.ok(out.includes("failed · rev 1 · error: over the day's round budget"));
    assert.ok(out.includes("unknown · rev 4 · error: it threw"));
    assert.doesNotMatch(out, /Task<\/dt>/, "the task is closed until a tap");
});

test("Board: a tap on a row opens its task, objective and stop condition", async () => {
    const ctl = await loadedBoard(
        boardApi({ board: boardAnswer([boardRow({ id: 3, objective: "Keep CI green." })]) }),
    );

    boardScreen(ctl).tap("open:3");

    const { out } = boardScreen(ctl);

    assert.match(out, /aria-expanded=true/);
    assert.match(out, /<dt>Task<\/dt> <dd>Fix the flaky tests\.<\/dd>/);
    assert.match(out, /<dt>Objective<\/dt><dd>Keep CI green\.<\/dd>/);
    assert.match(out, /<dt>Stop when<\/dt> <dd>CI is green<\/dd>/);
});

test("Board: each state shows its acts: proposed pick, edit, drop; picked unpick, edit, drop; waiting drop; failed reopen; unknown resolve", () => {
    const ops = (state) => rowActs({ state }).map((act) => act.op);

    assert.deepEqual(ops("proposed"), ["pick", "edit", "drop"]);
    assert.deepEqual(ops("picked"), ["unpick", "edit", "drop"]);
    assert.deepEqual(ops("waiting"), ["drop"]);
    assert.deepEqual(ops("failed"), ["reopen"]);
    assert.deepEqual(ops("unknown"), ["resolve"]);
    assert.deepEqual(ops("starting"), []);
    assert.deepEqual(ops("launched"), []);
    assert.deepEqual(ops("dropped"), []);
});

test("Board: Pick, Unpick, Drop and Reopen each post once, with the rev the page shows and 1 key", async () => {
    const cases = [
        ["pick:3", { op: "pick", rows: [{ row: 3, rev: 2 }] }],
        ["unpick:1", { op: "unpick", rows: [{ row: 1, rev: 1 }] }],
        ["drop:4", { op: "drop", row: 4, rev: 3 }],
        ["drop:3", { op: "drop", row: 3, rev: 2 }],
        ["reopen:5", { op: "reopen", row: 5, rev: 1 }],
    ];

    for (const [act, body] of cases) {
        const api = boardApi();
        const ctl = await loadedBoard(api);

        await boardScreen(ctl).tap(act);

        assert.deepEqual(api.posts(), [["POST", "board/7", { ...body, key: "key-0001" }]], act);
    }
});

test("Board: Edit changes only max and until, and posts once with the shown rev", async () => {
    const api = boardApi();
    const ctl = await loadedBoard(api);

    await boardScreen(ctl).tap("edit:3");
    assert.equal(api.posts().length, 0, "Edit opens the form; it posts nothing");

    const form = boardScreen(ctl).out;

    assert.match(form, /value=20/);
    assert.match(form, /value=06:45/);
    ctl.editField("max", "12");
    ctl.editField("until", "07:30");
    await boardScreen(ctl).tap("save:3");

    assert.deepEqual(api.posts(), [
        [
            "POST",
            "board/7",
            { op: "edit", row: 3, rev: 2, fields: { max: 12, until: "07:30" }, key: "key-0001" },
        ],
    ]);
    assert.equal(ctl.view().editing, null, "a done edit closes the form");
});

test("Board: Resolve binds a thread, or fails the row; each posts once with the shown rev", async () => {
    const bind = boardApi();
    const ctl = await loadedBoard(bind);

    await boardScreen(ctl).tap("resolve:6");
    assert.equal(bind.posts().length, 0, "Resolve opens the form");
    ctl.resolveField(" T12 ");
    await boardScreen(ctl).tap("bind:6");
    assert.deepEqual(bind.posts(), [
        ["POST", "board/7", { op: "resolve", row: 6, rev: 4, thread: "T12", key: "key-0001" }],
    ]);

    const fail = boardApi();
    const other = await loadedBoard(fail);

    await boardScreen(other).tap("resolve:6");
    await boardScreen(other).tap("fail:6");
    assert.deepEqual(fail.posts(), [
        ["POST", "board/7", { op: "resolve", row: 6, rev: 4, key: "key-0001" }],
    ]);
});

test("Board: Launch picks posts once, with every picked row and its shown rev; it is off with no pick", async () => {
    const api = boardApi();
    const ctl = await loadedBoard(api);
    const screen = boardScreen(ctl);

    assert.match(screen.out, /data-act="launch" disabled=false/);
    assert.match(screen.out, /Launch picks \(2\)/);
    await screen.tap("launch");
    assert.deepEqual(api.posts(), [
        [
            "POST",
            "board/7",
            {
                op: "launch",
                rows: [
                    { row: 1, rev: 1 },
                    { row: 8, rev: 2 },
                ],
                key: "key-0001",
            },
        ],
    ]);

    const none = await loadedBoard(boardApi({ board: boardAnswer([boardRow({ id: 3 })]) }));

    assert.match(boardScreen(none).out, /data-act="launch" disabled=true/);
    assert.equal(launchBody([boardRow()]), null);
    await none.launch();
});

test("Board: a second tap while the act runs posts nothing; a failed act keeps its key; a done act gets a new key", async () => {
    let open;
    let answer;
    const api = boardApi({
        post: () =>
            new Promise((resolve) => {
                open = resolve;
            }).then(() => answer),
    });
    const ctl = await loadedBoard(api);
    const first = boardScreen(ctl).tap("pick:3");

    assert.match(boardScreen(ctl).out, /data-act=pick:3 disabled=true/);
    // Not awaited: with no guard, this second act would wait on its own post.
    void ctl.act(actBody(boardAnswer().rows[0], "pick"));
    assert.equal(api.posts().length, 1, "1 post while the act runs");
    answer = Object.assign(new Error("The desk did not answer."), { status: 502 });
    open();
    await first;
    assert.match(boardScreen(ctl).out, /error-box" role="alert">The desk did not answer\./);

    const again = boardScreen(ctl).tap("pick:3");

    answer = { ...boardAnswer(), pass: [] };
    open();
    await again;

    const third = boardScreen(ctl).tap("pick:3");

    open();
    await third;
    assert.deepEqual(
        api.posts().map((call) => call[2].key),
        ["key-0001", "key-0001", "key-0002"],
    );
});

test("Board: a 409 shows its message and loads the board again", async () => {
    const newer = boardAnswer([boardRow({ id: 3, rev: 5, title: "Row three, changed" })]);
    let reads = 0;
    const api = boardApi({
        board: () => {
            reads += 1;

            return reads === 1 ? boardAnswer() : newer;
        },
        post: conflict("Row 3 changed (rev 5 now): read it with desk board, then pick again."),
    });
    const ctl = await loadedBoard(api);

    await boardScreen(ctl).tap("pick:3");
    assert.deepEqual(api.calls, [
        ["GET", "board"],
        ["POST", "board/7", { op: "pick", rows: [{ row: 3, rev: 2 }], key: "key-0001" }],
        ["GET", "board"],
    ]);

    const { out } = boardScreen(ctl);

    assert.ok(
        out.includes(
            "Row 3 changed (rev 5 now): read it with desk board, then pick again. The board is loaded again.",
        ),
    );
    assert.ok(out.includes("Row three, changed"));
    assert.ok(out.includes("proposed · rev 5"));
});

test("Board: after a 409 the same act takes a new key, so a key too old to replay is not sent again", async () => {
    let posts = 0;
    const api = boardApi({
        post: () => {
            posts += 1;

            return posts === 1
                ? conflict("This request is too old to replay: load the board again.")
                : { rows: boardAnswer().rows, limits: boardAnswer().limits, pass: [] };
        },
    });
    const ctl = await loadedBoard(api);

    await boardScreen(ctl).tap("pick:3");
    await boardScreen(ctl).tap("pick:3");

    const keys = api.calls.filter((call) => call[0] === "POST").map((call) => call[2].key);

    assert.deepEqual(keys, ["key-0001", "key-0002"]);
});

test("boardAct: a 409 loads again and the error says so; another error only shows; success gives the answer", async () => {
    const stale = fakeApi({
        "board/7": conflict("Row 3 is waiting: pick takes a proposed row."),
        board: { rows: [] },
    });

    assert.deepEqual(await boardAct(stale.call, () => stale.call("board"), 7, { op: "pick" }), {
        ok: false,
        conflict: true,
        error: "Row 3 is waiting: pick takes a proposed row. The board is loaded again.",
        reloaded: { rows: [] },
    });
    assert.deepEqual(stale.calls, [
        ["POST", "board/7", { op: "pick" }],
        ["GET", "board"],
    ]);

    const bad = fakeApi({
        "board/7": Object.assign(new Error("max must be 1 to 100."), { status: 400 }),
    });

    assert.deepEqual(await boardAct(bad.call, () => bad.call("board"), 7, { op: "edit" }), {
        ok: false,
        error: "max must be 1 to 100.",
    });
    assert.equal(bad.calls.length, 1, "a 400 loads nothing");

    const ok = fakeApi({ "board/7": { rows: [1] } });

    assert.deepEqual(await boardAct(ok.call, () => ok.call("board"), 7, { op: "drop" }), {
        ok: true,
        answer: { rows: [1] },
    });
});

test("Board: the supervisor choice shows with more than 1 supervisor, and reads that board", async () => {
    const api = boardApi({ board: { ...boardAnswer(), supervisors: [7, 9] } });
    const ctl = await loadedBoard(api);

    assert.match(boardScreen(ctl).out, /<option value=9>Supervisor conversation 9<\/option>/);
    await ctl.choose(9);
    assert.deepEqual(api.calls.at(-1), ["GET", "board?supervisor=9"]);
    assert.equal(boardPath(null), "board");

    const single = await loadedBoard(boardApi());

    assert.doesNotMatch(boardScreen(single).out, /<select/);
});

// Through the markup only, with no import of the label helper: on a board.js without titles, this test fails on its
// assertions, not on a missing export.
test("Board: a supervisor's option is its session title and id, else its conversation id", async () => {
    const options = async (titles) =>
        boardScreen(
            await loadedBoard(
                boardApi({ board: { ...boardAnswer(), supervisors: [7, 9, 11], titles } }),
            ),
        ).out;
    const out = await options({ 9: "Odrade", 11: "  " });

    assert.match(out, /<option value=9>Odrade \(9\)<\/option>/);
    assert.match(out, /<option value=7>Supervisor conversation 7<\/option>/);
    assert.match(out, /<option value=11>Supervisor conversation 11<\/option>/);
    assert.match(await options(undefined), /<option value=9>Supervisor conversation 9<\/option>/);
});

test("Board: with no supervisor, 1 line says so, and no act posts", async () => {
    const api = boardApi({ board: { supervisors: [], supervisor: null, rows: [], limits: null } });
    const ctl = await loadedBoard(api);

    assert.ok(boardScreen(ctl).out.includes("The desk knows no supervisor yet"));
    assert.equal(limitsText({ supervisor: 7, limits: { line: LIMITS_LINE } }), LIMITS_LINE);
    await ctl.act({ op: "launch", rows: [{ row: 1, rev: 1 }] });
    assert.equal(api.posts().length, 0);
});

test("Board keys start with the page's time in ms: <ms>-<random>, as the route takes it", () => {
    const at = Date.UTC(2026, 10, 7, 20, 0);
    const key = newBoardKey("pick", at);

    assert.match(key, /^1794[0-9]{9}-board-pick-[a-z0-9]+$/);
    assert.ok(key.startsWith(`${String(at)}-`));
    assert.match(key, /^[A-Za-z0-9_-]{8,100}$/);
    assert.notEqual(newBoardKey("pick", at), key, "a random part");
    assert.match(newBoardKey("a b/c"), /^[0-9]+-board-a-b-c-[a-z0-9]+$/);
});

test("Board keys and texts: 1 key per act, another rev is another act; the state line", () => {
    const keys = {};
    const make = keyMaker();
    const body = actBody(boardRow({ id: 3, rev: 2 }), "drop");

    assert.equal(boardKeyFor(keys, 7, body, make), "key-0001");
    assert.equal(boardKeyFor(keys, 7, body, make), "key-0001");
    assert.equal(
        boardKeyFor(keys, 7, actBody(boardRow({ id: 3, rev: 3 }), "drop"), make),
        "key-0002",
    );
    assert.equal(rowStateText(boardRow({ state: "waiting", rev: 4 })), "waiting · rev 4");
    assert.deepEqual(actBody(boardRow(), "edit", { max: "x", until: "6" }).fields, {
        max: "x",
        until: "6",
    });
});

test("Board status: rowStatus gives 1 status for each state; a launched row runs until its thread closes or its shift ends", () => {
    for (const [state, status] of [
        ["proposed", "proposed"],
        ["picked", "picked"],
        ["waiting", "waiting"],
        ["starting", "running"],
        ["launched", "running"],
        ["failed", "failed"],
        ["unknown", "unknown"],
        ["dropped", "dropped"],
        ["something-new", "proposed"],
    ]) {
        assert.equal(rowStatus(boardRow({ state })), status, state);
    }

    assert.equal(rowStatus(boardRow({ state: "launched", threadState: "open" })), "running");
    assert.equal(rowStatus(boardRow({ state: "launched", threadState: "parked" })), "running");
    assert.equal(rowStatus(boardRow({ state: "launched", threadState: "closed" })), "finished");
    assert.equal(
        rowStatus(boardRow({ state: "launched", threadState: "open", shiftEnded: true })),
        "finished",
    );
    assert.equal(rowStatus(boardRow({ state: "launched", thread: "T12" })), "running");
    // Thread facts never change another state's status.
    assert.equal(rowStatus(boardRow({ state: "failed", threadState: "closed" })), "failed");
    assert.equal(rowStatus(undefined), "proposed");
});

test("Board split: each state goes to its side: the finishing rows to done, every other row to active in its order", () => {
    const rows = [
        boardRow({ id: 1, state: "proposed" }),
        boardRow({ id: 2, state: "picked" }),
        boardRow({ id: 3, state: "waiting" }),
        boardRow({ id: 4, state: "starting" }),
        boardRow({ id: 5, state: "failed" }),
        boardRow({ id: 6, state: "unknown" }),
        boardRow({ id: 7, state: "launched" }),
        boardRow({ id: 8, state: "launched", thread: "T1", threadState: "open" }),
        boardRow({ id: 9, state: "launched", thread: "T2", threadState: "closed" }),
        boardRow({ id: 10, state: "launched", thread: "T3", shiftEnded: true }),
        boardRow({ id: 11, state: "dropped" }),
        boardRow({ id: 12, state: "something-new" }),
    ];
    const { active, done } = boardSplit(rows);

    assert.deepEqual(
        active.map((row) => row.id),
        [1, 2, 3, 4, 5, 6, 7, 8, 12],
        "the rows that wait for an act or run, in the input order",
    );
    // They carry no changedAt: each counts as 0, so the input order stays.
    assert.deepEqual(
        done.map((row) => row.id),
        [9, 10, 11],
        "the launched rows that finished and the dropped ones",
    );
});

test("Board split: done is newest changedAt first, a missing one last, and a tie keeps the input order", () => {
    const rows = [
        boardRow({ id: 1, state: "dropped", changedAt: 300 }),
        boardRow({ id: 2, state: "dropped", changedAt: 900 }),
        boardRow({ id: 3, state: "dropped" }),
        boardRow({ id: 4, state: "launched", thread: "T2", threadState: "closed", changedAt: 300 }),
        boardRow({ id: 5, state: "dropped", changedAt: 900 }),
        boardRow({ id: 6, state: "dropped", changedAt: "900" }),
    ];

    assert.deepEqual(
        boardSplit(rows).done.map((row) => row.id),
        [2, 5, 1, 4, 3, 6],
    );
    assert.deepEqual(boardSplit(rows).active, []);
});

test("Board split: no rows at all give 2 empty lists", () => {
    assert.deepEqual(boardSplit([]), { active: [], done: [] });
    assert.deepEqual(boardSplit(undefined), { active: [], done: [] });
});

test("Board status: the state line says running or finished for a launched row, and keeps every other state's text", () => {
    assert.equal(
        rowStateText(
            boardRow({
                state: "launched",
                rev: 3,
                thread: "T12",
                next: "agent",
                threadState: "open",
            }),
        ),
        "launched (running) · rev 3 · T12 (next: agent)",
    );
    assert.equal(
        rowStateText(boardRow({ state: "launched", rev: 3, thread: "T12", threadState: "closed" })),
        "launched (finished) · rev 3 · T12",
    );
    assert.equal(
        rowStateText(boardRow({ state: "launched", rev: 2, thread: "T9", shiftEnded: true })),
        "launched (finished) · rev 2 · T9",
    );
    assert.equal(rowStateText(boardRow({ state: "starting", rev: 5 })), "starting · rev 5");
    assert.equal(rowStateText(boardRow({ state: "dropped", rev: 6 })), "dropped · rev 6");
});

test("Board hold: the state line of a waiting row that the meter holds says held and its reason; another state does not", () => {
    const held = { reason: "Anthropic week 95% ≥ 90%, resets Fri 09:00", at: 1 };

    assert.equal(
        rowStateText(boardRow({ state: "waiting", rev: 4, held })),
        "waiting · rev 4 · held: Anthropic week 95% ≥ 90%, resets Fri 09:00",
    );
    assert.equal(rowStateText(boardRow({ state: "starting", rev: 5, held })), "starting · rev 5");
    assert.equal(rowStateText(boardRow({ state: "waiting", rev: 4 })), "waiting · rev 4");
});

test("Board status: each row carries its state class and its status class, and desk.css colors each status", async () => {
    const rows = [
        boardRow({ id: 1, state: "proposed" }),
        boardRow({ id: 2, state: "picked" }),
        boardRow({ id: 3, state: "waiting" }),
        boardRow({ id: 4, state: "starting" }),
        boardRow({ id: 5, state: "launched", thread: "T1", threadState: "open" }),
        boardRow({ id: 6, state: "launched", thread: "T2", threadState: "closed" }),
        boardRow({ id: 7, state: "launched", thread: "T3", threadState: "open", shiftEnded: true }),
        boardRow({ id: 8, state: "failed", error: "no" }),
        boardRow({ id: 9, state: "unknown", error: "it threw" }),
        boardRow({ id: 10, state: "dropped" }),
    ];
    const ctl = await loadedBoard(boardApi({ board: boardAnswer(rows) }));
    const { out } = boardScreen(ctl);
    const classes = [...out.matchAll(/<li class=(board-row [^>]*?) ?>/g)].map((found) => found[1]);

    assert.deepEqual(classes, [
        "board-row board-proposed board-status-proposed",
        "board-row board-picked board-status-picked",
        "board-row board-waiting board-status-waiting",
        "board-row board-starting board-status-running",
        "board-row board-launched board-status-running",
        "board-row board-failed board-status-failed",
        "board-row board-unknown board-status-unknown",
        // The done rows come last, in the Done fold: their changedAt is the same, so they keep the input order.
        "board-row board-launched board-status-finished",
        "board-row board-launched board-status-finished",
        "board-row board-dropped board-status-dropped",
    ]);
    // The state word stays on each row: color is never the only sign.
    assert.ok(out.includes("launched (finished) · rev 1 · T2"));
    assert.ok(out.includes("launched (running) · rev 1 · T1"));

    const css = readFileSync(new URL("./desk-web/desk.css", import.meta.url), "utf8");

    for (const status of [
        "proposed",
        "picked",
        "waiting",
        "running",
        "finished",
        "failed",
        "unknown",
        "dropped",
    ]) {
        assert.match(
            css,
            new RegExp(`\\.board-row\\.board-status-${status} \\{[^}]*border-color:`),
            `desk.css colors board-status-${status}`,
        );
    }

    // No status rule sets a background: a tint lowers the --muted lines (facts, state) under 4.5:1.
    for (const rule of css.matchAll(/([^{}]*\.board-status-[^{}]*)\{([^}]*)\}/g)) {
        assert.doesNotMatch(rule[2], /background/, `no background in ${rule[1].trim()}`);
    }

    // A running launched row is not green: the old always-green launched rule is gone.
    assert.doesNotMatch(css, /\.board-row\.board-launched \{/);
});

test("Board: the Done fold comes after the active rows, newest first, and is closed", async () => {
    const ctl = await loadedBoard(
        boardApi({
            board: boardAnswer([
                boardRow({ id: 3, title: "Row three", changedAt: 100 }),
                boardRow({
                    id: 9,
                    state: "dropped",
                    title: "Row nine",
                    changedAt: 200,
                }),
                boardRow({
                    id: 7,
                    state: "launched",
                    title: "Row seven",
                    thread: "T12",
                    threadState: "closed",
                    changedAt: 900,
                }),
                boardRow({ id: 1, title: "Row one", changedAt: 800 }),
            ]),
        }),
    );
    const screen = boardScreen(ctl);
    const { out } = screen;
    const at = (text) => out.indexOf(text);

    assert.ok(at('<details class="board-done">') >= 0, out);
    assert.ok(out.includes('<summary class="board-done-summary">Done (2)</summary>'), out);
    assert.doesNotMatch(out, /<details[^>]*\bopen\b/, "the fold is closed");

    // The active rows first, in the input order, then the fold with the newest change first.
    assert.ok(at("#3 Row three") >= 0 && at("#3 Row three") < at("#1 Row one"));
    assert.ok(at("#1 Row one") < at("<details"));
    assert.ok(at("<details") < at("#7 Row seven"));
    assert.ok(at("#7 Row seven") < at("#9 Row nine"));

    // A row in the fold is the same row item as above: a tap on its head opens it.
    assert.ok(screen.has("open:9"), out);

    const folded = out.slice(at("<details"));

    assert.match(folded, /data-act="?open:7"? /, "the fold's row has its open button");
});

test("Board: a board with no done row shows no fold", async () => {
    const ctl = await loadedBoard(boardApi({ board: boardAnswer([boardRow({ id: 3 })]) }));
    const { out } = boardScreen(ctl);

    assert.doesNotMatch(out, /<details/);
    assert.ok(!out.includes("Done ("), "no Done summary");
    assert.ok(out.includes('<ol class="board-rows">'), out);
});

test("Board: a board with only done rows says no row waits or runs, and shows the fold", async () => {
    const ctl = await loadedBoard(
        boardApi({
            board: boardAnswer([boardRow({ id: 9, state: "dropped", title: "Row nine" })]),
        }),
    );
    const { out } = boardScreen(ctl);

    assert.ok(out.includes("No row waits or runs."), out);
    assert.ok(out.includes('<summary class="board-done-summary">Done (1)</summary>'), out);
    assert.ok(out.includes("#9 Row nine"), out);
    // The main list is left out, not drawn empty.
    assert.doesNotMatch(out, /<ol class="board-rows">\s*<\/ol>/);
});

test("makeBoard: the view reads at once, reads again on changed, and stops listening when it unmounts", async () => {
    const reads = [];
    const listeners = [];
    const offs = [];
    const cleanups = [];
    const disposes = [];
    const { tag } = tapHtml();
    const Board = makeBoard({
        html: tag,
        useState: (value) => [value, () => {}],
        useRef: () => ({ current: null }),
        useEffect: (effect) => cleanups.push(effect()),
        api: async (path) => {
            reads.push(path);

            return boardAnswer();
        },
        on: (event, listener) => {
            listeners.push([event, listener]);

            return () => offs.push(event);
        },
        onDispose: (dispose) => disposes.push(dispose),
    });

    assert.equal(disposes.length, 1, "1 dispose for the module");
    assert.match(Board(), /Loading the board/);
    assert.deepEqual(reads, ["board"]);
    assert.deepEqual(
        listeners.map(([event]) => event),
        ["changed"],
    );
    listeners[0][1]();
    assert.deepEqual(reads, ["board", "board"]);
    cleanups[0]();
    assert.deepEqual(offs, ["changed"], "the listener goes with the view");
});

test("Board: Edit and Resolve post the rev their form opened on, also after a reload gave a newer rev", async () => {
    /** A board whose rows move to a newer rev at each read after the first. */
    const moving = () => {
        let reads = 0;

        return boardApi({
            board: () => {
                reads += 1;

                return boardAnswer([
                    boardRow({ id: 3, rev: reads === 1 ? 1 : 2, title: "Row three" }),
                    boardRow({
                        id: 6,
                        rev: reads === 1 ? 4 : 5,
                        state: "unknown",
                        title: "Row six",
                    }),
                ]);
            },
        });
    };

    const edits = moving();
    const ctl = await loadedBoard(edits);

    await boardScreen(ctl).tap("edit:3");
    ctl.editField("max", "9");
    // A `changed` event reads the board again while the form is open: row 3 is rev 2 now.
    await ctl.load();
    assert.ok(boardScreen(ctl).out.includes("proposed · rev 2"));
    await boardScreen(ctl).tap("save:3");
    assert.deepEqual(edits.posts(), [
        [
            "POST",
            "board/7",
            { op: "edit", row: 3, rev: 1, fields: { max: 9, until: "06:45" }, key: "key-0001" },
        ],
    ]);

    const resolves = moving();
    const other = await loadedBoard(resolves);

    await boardScreen(other).tap("resolve:6");
    await other.load();
    assert.ok(boardScreen(other).out.includes("unknown · rev 5"));
    other.resolveField("T12");
    await boardScreen(other).tap("bind:6");
    assert.deepEqual(resolves.posts(), [
        ["POST", "board/7", { op: "resolve", row: 6, rev: 4, thread: "T12", key: "key-0001" }],
    ]);
});

test("Board: a POST answer for supervisor A that comes after the choice of B changes nothing on B's board", async () => {
    const pending = [];
    const calls = [];

    const api = (path, body) => {
        calls.push(body === undefined ? ["GET", path] : ["POST", path, body]);

        return new Promise((resolve) => {
            pending.push({ path, resolve });
        });
    };

    /** End the pending call for `path` with `answer`, then let the controller take it. */
    const answer = async (path, value) => {
        const at = pending.findIndex((each) => each.path === path);

        assert(at >= 0, `a pending ${path}`);
        pending.splice(at, 1)[0].resolve(value);
        await new Promise((resolve) => setImmediate(resolve));
    };

    const boardA = {
        ...boardAnswer([boardRow({ id: 3, rev: 1, title: "A row" })]),
        supervisors: [7, 9],
    };
    const boardB = {
        ...boardAnswer([boardRow({ id: 30, rev: 1, title: "B row" })]),
        supervisors: [7, 9],
        supervisor: 9,
    };
    const ctl = boardController(api, { make: keyMaker() });
    const loaded = ctl.load();

    await answer("board", boardA);
    await loaded;

    const acting = boardScreen(ctl).tap("pick:3");

    assert.match(boardScreen(ctl).out, /aria-label="The supervisor's board" value=7 disabled=true/);

    const choosing = ctl.choose(9);

    assert.match(boardScreen(ctl).out, /data-act="launch" disabled=true/, "no act while B loads");
    await answer("board?supervisor=9", boardB);
    await choosing;
    await answer("board/7", {
        ...boardAnswer([boardRow({ id: 3, rev: 1, state: "picked", title: "A row" })]),
        pass: [],
    });
    await acting;

    assert.equal(ctl.view().board.supervisor, 9);
    assert.deepEqual(
        ctl.view().board.rows.map((row) => row.title),
        ["B row"],
    );
    assert.equal(ctl.view().busy, false);
    assert.deepEqual(
        calls.map((call) => call.slice(0, 2)),
        [
            ["GET", "board"],
            ["POST", "board/7"],
            ["GET", "board?supervisor=9"],
        ],
    );

    // A GET of an earlier selection is dropped too: choose 7, then 9, and the answer for 7 comes last.
    const first = ctl.choose(7);

    // No act while a board loads: its buttons are off, and an act posts nothing.
    assert.match(boardScreen(ctl).out, /data-act=pick:30 disabled=true/);
    // Not awaited: with no guard, this act would wait on its own post.
    void ctl.act(actBody(boardB.rows[0], "pick"));
    assert.equal(calls.filter((call) => call[0] === "POST").length, 1, "no post while loading");

    const second = ctl.choose(9);

    await answer("board?supervisor=9", boardB);
    await second;
    await answer("board?supervisor=7", boardA);
    await first;
    assert.equal(ctl.view().board.supervisor, 9);
});

test("Board: a failed read of another supervisor's board puts the selection back on the board shown, and no act goes to it under another name", async () => {
    const pending = [];
    const calls = [];

    const api = (path, body) => {
        calls.push(body === undefined ? ["GET", path] : ["POST", path, body]);

        return new Promise((resolve, reject) => {
            pending.push({ path, resolve, reject });
        });
    };

    const settle = async (path, how, value) => {
        const at = pending.findIndex((each) => each.path === path);

        assert(at >= 0, `a pending ${path}`);
        pending.splice(at, 1)[0][how](value);
        await new Promise((resolve) => setImmediate(resolve));
    };

    const boardA = {
        ...boardAnswer([boardRow({ id: 3, rev: 1, state: "picked", title: "A row" })]),
        supervisors: [7, 9],
    };
    const ctl = boardController(api, { make: keyMaker() });
    const loaded = ctl.load();

    await settle("board", "resolve", boardA);
    await loaded;

    const choosing = ctl.choose(9);

    await settle("board?supervisor=9", "reject", new Error("The read failed."));
    await choosing;

    // The board on the screen is still A's, and the select names A again, with the error.
    assert.equal(ctl.view().board.supervisor, 7);
    assert.equal(ctl.view().chosen, 7);
    assert.equal(ctl.view().error, "The read failed.");
    assert.match(boardScreen(ctl).out, /aria-label="The supervisor's board" value=7 /);

    // An act goes to the board that the select and the screen both name.
    void ctl.launch();
    assert.deepEqual(calls.at(-1).slice(0, 2), ["POST", "board/7"]);
});

// ─── The Subscriptions card (plan T1747, S4) ────────────────────────────────

const METER_AT = Date.UTC(2026, 10, 14, 2, 56);
const LEDGER = {
    lastHour: 70,
    today: 228,
    days7: 2263,
    partial: true,
    top: [{ model: "claude-opus-5-5", cost: 2263 }],
};
const METER_LINE =
    "Anthropic: week 95% used (critical), resets Wed 11:00 (in 4d 13h) · week, Fable 19%";

/** 1 Anthropic row of the dashboard's `meter` field, with its main window in `state`. */
const anthropicRow = (state, patch = {}) => ({
    provider: "anthropic",
    label: "Anthropic",
    line: METER_LINE,
    readAt: METER_AT,
    lastAttempt: { at: METER_AT, ok: true },
    mainWindowId: "weekly_all",
    windows: [
        {
            id: "weekly_all",
            label: "week",
            scoped: false,
            state,
            ...(state === "awaiting" ? {} : { percent: 95 }),
            active: true,
        },
        {
            id: "weekly_scoped:Fable",
            label: "week, Fable",
            scoped: true,
            state: "fresh",
            percent: 19,
            active: false,
        },
    ],
    ledger: LEDGER,
    ...patch,
});
const OPENAI_ROW = {
    provider: "openai",
    label: "OpenAI",
    line: "OpenAI: no provider report (Pi's ChatGPT sign-in has no usage endpoint)",
    windows: [],
    ledger: { lastHour: 0, today: 0, days7: 0, partial: false, top: [] },
};
const meterOf = (...providers) => ({
    at: METER_AT,
    providers,
    coverage: { complete: true, done: 3, total: 3 },
});

test("meterRows: fresh gets a gauge; stale, awaiting and none get their text in its place", () => {
    const stale = anthropicRow("stale", {
        readAt: METER_AT - 25 * 60_000,
        line: "Anthropic: week 95% used (read 25 min ago; last attempt: HTTP 429), resets Wed 11:00 (in 4d 13h)",
    });
    const awaiting = anthropicRow("awaiting", {
        line: "Anthropic: week: reset passed, awaiting provider report · reset seen 03:10",
    });

    assert.deepEqual(meterRows(undefined), []);
    assert.deepEqual(meterRows({ at: 1 }), []);
    assert.deepEqual(meterRows(meterOf(anthropicRow("fresh"), OPENAI_ROW)), [
        {
            provider: "anthropic",
            label: "Anthropic",
            line: METER_LINE,
            grants: null,
            ledger: "list price: $70 last hour, $228 today, $2,263 in 7 days (partial); top: claude-opus-5-5 $2,263",
            state: "fresh",
            gauge: { percent: 95, label: "95% of the week used" },
            status: null,
        },
        {
            provider: "openai",
            label: "OpenAI",
            line: null,
            grants: null,
            ledger: "list price: $0 last hour, $0 today, $0 in 7 days",
            state: "none",
            gauge: null,
            status: "no provider report (Pi's ChatGPT sign-in has no usage endpoint)",
        },
    ]);

    const [staleRow] = meterRows(meterOf(stale));

    assert.equal(staleRow.state, "stale");
    assert.equal(staleRow.gauge, null);
    assert.equal(staleRow.status, "week 95% used, read 25 min ago");
    assert.equal(staleRow.line, stale.line);

    const [awaitingRow] = meterRows(meterOf(awaiting));

    assert.equal(awaitingRow.state, "awaiting");
    assert.equal(awaitingRow.gauge, null);
    assert.equal(awaitingRow.status, "reset passed, awaiting provider report");
});

test("meterGrantsText and meterLedgerText: the grants by label with their first expiry, the note, and the ledger", () => {
    assert.equal(
        meterGrantsText(
            {
                grants: [
                    {
                        label: "Weekly",
                        resetsLeft: 1,
                        endsAt: METER_AT + 26 * 86400_000 + 5 * 3600_000,
                    },
                    { label: "Weekly", resetsLeft: 1, endsAt: METER_AT + 30 * 86400_000 },
                    { label: "Fable", resetsLeft: 2, endsAt: METER_AT + 3 * 3600_000 },
                    { label: "Session", resetsLeft: 1 },
                ],
            },
            METER_AT,
        ),
        "resets granted: Weekly ×2 (first expires in 26d) · Fable ×2 (first expires in 3h) · Session ×1",
    );
    assert.equal(
        meterGrantsText({ grantsNote: "not readable (surface)" }, METER_AT),
        "grants: not readable (surface)",
    );
    assert.equal(meterGrantsText({}, METER_AT), null);
    assert.equal(
        meterLedgerText({ ...LEDGER, partial: false, unknownCost: 3 }),
        "list price: $70 last hour, $228 today, $2,263 in 7 days; top: claude-opus-5-5 $2,263; 3 answers with no cost",
    );
    assert.equal(meterLedgerText(undefined), null);
});

test("the Subscriptions card: a gauge with its label for fresh, the state text for stale, awaiting and none", () => {
    const out = meterCard(
        html,
        meterOf(
            anthropicRow("fresh", { grantsNote: "not readable (surface)" }),
            anthropicRow("stale", { provider: "stale", readAt: METER_AT - 25 * 60_000 }),
            anthropicRow("awaiting", { provider: "awaiting" }),
            OPENAI_ROW,
        ),
    ).replace(/\s+/g, " ");

    assert.match(out, /<h3 id="dash-meter">Subscriptions<\/h3>/);
    assert.match(
        out,
        /data-provider=anthropic data-state=fresh> <strong class="dash-meter-label">Anthropic<\/strong> <span class="dash-meter-gauge" ><meter min="0" max="100" value=95 aria-label=95% of the week used>95%<\/meter ><span>95% of the week used<\/span><\/span >/,
    );
    assert.ok(out.includes(`<span class="small dash-meter-line">${METER_LINE}</span>`));
    assert.ok(out.includes('<span class="small">grants: not readable (surface)</span>'));
    assert.match(
        out,
        /data-provider=stale data-state=stale> .*?<span class="dash-meter-state">week 95% used, read 25 min ago<\/span>/,
    );
    assert.match(
        out,
        /data-provider=awaiting data-state=awaiting> .*?<span class="dash-meter-state">reset passed, awaiting provider report<\/span>/,
    );
    assert.match(
        out,
        /data-provider=openai data-state=none> <strong class="dash-meter-label">OpenAI<\/strong> <span class="dash-meter-state">no provider report \(Pi's ChatGPT sign-in has no usage endpoint\)<\/span> <span class="small muted">list price: \$0 last hour, \$0 today, \$0 in 7 days<\/span>/,
    );
    assert.equal((out.match(/<meter /g) ?? []).length, 1, "only the fresh row has a gauge");
    assert.match(out, /Account-wide: the filters do not apply\./);
});
