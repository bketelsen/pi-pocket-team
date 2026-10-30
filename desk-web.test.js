// The Desk page's queue section: rendered with stand-ins for Pocket's page tools, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import setup, {
    approveLabel,
    badgeOf,
    groupOf,
    planAskLine,
    planRowLine,
    planStateLine,
    queueStatus,
    stillMounted,
} from "./desk-web/index.js";

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

    const need = out.slice(out.indexOf("<h2>Needs you"), out.indexOf("</section>"));

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

    const need = out.slice(out.indexOf("<h2>Needs you"), out.indexOf("</section>"));

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

    const need = out.slice(out.indexOf("<h2>Needs you"), out.indexOf("</section>"));

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
    const need = out.slice(out.indexOf("<h2>Needs you"), out.indexOf("</section>"));

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
