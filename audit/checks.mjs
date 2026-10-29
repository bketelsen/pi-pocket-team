// The daily audit's checks. Each one is a pure function of `(data, ctx)` and returns `{ findings, metrics }`.
//
// `data` is the plain object that `sources.mjs` builds; `ctx` is `{ now, since, hours }`. A check reads nothing and
// writes nothing. `runChecks` runs every check in a try/catch: a check that throws, or whose source is missing, goes
// to `skipped`, and the run goes on. See docs/plans/daily-audit.md, Section 4.
import {
    DAY,
    HOUR,
    MINUTE,
    SECRET,
    branchLeft,
    bump,
    dollars,
    money,
    iso,
    median,
    quote,
    refsIn,
    safeLine,
} from "./common.mjs";

// ---------- Helpers ----------

const MAX_EVIDENCE = 20;

/**
 * One finding. Its id is `<check>:<subject>`, or the check alone: stable from day to day. A text that matches the
 * secret filter is replaced, and an evidence line that matches is dropped.
 */
export function makeFinding({
    check,
    subject,
    severity,
    text,
    evidence = [],
    lastSeen,
    cases = 1,
    waste,
}) {
    const lines = evidence.map((line) => safeLine(String(line).slice(0, 160))).filter(Boolean);

    return {
        id: subject === undefined ? check : `${check}:${subject}`,
        check,
        severity,
        text: SECRET.test(text) ? `${check}: (text dropped by the secret filter)` : text,
        evidence:
            lines.length > MAX_EVIDENCE
                ? [...lines.slice(0, MAX_EVIDENCE), `… and ${lines.length - MAX_EVIDENCE} more`]
                : lines,
        ...(lastSeen ? { lastSeen: iso(lastSeen) } : {}),
        cases,
        ...(waste ? { waste: dollars(waste) } : {}),
    };
}

const windowOf = (ctx) => (ms) => ms >= ctx.since && ms <= ctx.now;

const byThreadCache = new WeakMap();

/** Every event, by thread, oldest first. */
function eventsByThread(data) {
    if (!byThreadCache.has(data.events)) {
        const map = new Map();

        for (const event of data.events) {
            map.set(event.thread, [...(map.get(event.thread) ?? []), event]);
        }

        byThreadCache.set(data.events, map);
    }

    return byThreadCache.get(data.events);
}

/** The model spend of a session between 2 times (assistant entries only). */
const costBetween = (data, session, from, to) =>
    data.costRows
        .filter((row) => row.c === session && row.at >= from && row.at <= to)
        .reduce((sum, row) => sum + row.cost, 0);

const threadOfSession = (data, session) =>
    Object.values(data.threads).find((thread) => thread.session === session);

const agentName = (data, session) => data.agentOf[session] ?? "?";

/** The first line of a tool error, with the harness tags and thread ids taken out. */
const errorLine = (text) =>
    text
        .replace(/<\/?harness>|\[error\]/g, "")
        .replace(/\b[TF]\d+[a-z]?\b/g, "T<n>")
        .trim()
        .split("\n")[0]
        .slice(0, 160);

const slug = (text) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);

const NOT_WORK = /^(busy|report|archived)/;

/** An event that shows no work: busy and idle, reports, a clean folder, nothing unpushed. */
const showsNoWork = (event) =>
    NOT_WORK.test(event.key) ||
    event.key.startsWith("closed") ||
    (event.key.startsWith("dirty") && /clean/.test(event.text)) ||
    (event.key.startsWith("ahead") && /nothing/.test(event.text));

const prUrl = (ref) => `https://github.com/${ref.replace("#", "/pull/")}`;

// ---------- A. Desk lifecycle ----------

/** A1: a thread that reopens 2 or more times in 24 hours (high at 4). */
export function checkA1(data, ctx) {
    const inWindow = windowOf(ctx);
    const byThread = eventsByThread(data);
    const reopens = data.events.filter(
        (event) => inWindow(event.at) && event.key.startsWith("reopened"),
    );
    const reasons = {};

    for (const event of reopens) {
        bump(reasons, event.text.replace(/[\w.-]+\/[\w.-]+#\d+/, "<ref>"));
    }

    // An empty reopen: between the reopen and the next close there is no PR, ask, branch, dirty-folder
    // or shift event: only busy and idle, reports, and the close.
    let empty = 0;
    let emptyCost = 0;
    const perThread = new Map();
    const wasteOf = {};
    const emptyOf = {};

    for (const event of reopens) {
        const later = (byThread.get(event.thread) ?? []).filter((other) => other.at > event.at);
        const close = later.find((other) => other.key.startsWith("closed"));
        const between = later.filter((other) => !close || other.at < close.at);

        if (close && between.every(showsNoWork)) {
            const cost = costBetween(
                data,
                data.threads[event.thread]?.session ?? -1,
                event.at,
                close.at,
            );

            empty += 1;
            emptyCost += cost;
            bump(wasteOf, event.thread, cost);
            bump(emptyOf, event.thread);
        }

        perThread.set(event.thread, [...(perThread.get(event.thread) ?? []), event]);
    }

    // What began the turn that reopened the thread: the newest user entry of its session before it.
    const topic = (text) => {
        const body = text.replace(/^[\s\S]*?<linked-session-message>\s*/, "");

        return /^(Night muster gather|Add to your muster)/.test(body)
            ? "muster gather"
            : /^Review task|review request/i.test(body)
              ? "review task"
              : /after-merge|close-out|after-check|merged/i.test(body.slice(0, 200))
                ? "after-merge step"
                : "new task or question";
    };

    const triggers = {};

    for (const event of reopens) {
        const thread = data.threads[event.thread];
        const users = thread?.session ? (data.userEntries[thread.session] ?? []) : [];
        const last = users.filter((user) => user.at <= event.at).at(-1);
        const text = last?.text ?? "";
        const from = text.match(/^\[via linked session (session-[\w-]+)\]/)?.[1];

        bump(
            triggers,
            !last
                ? "unknown"
                : text.startsWith("[scheduled]")
                  ? "its own schedule"
                  : from && from === thread.run?.returnAddress
                    ? `supervisor: ${topic(text)}`
                    : from
                      ? "a message from another agent"
                      : "a person",
        );
    }

    const findings = [];

    for (const [id, list] of perThread) {
        const maxIn24h = Math.max(
            ...list.map((a) => list.filter((b) => b.at >= a.at && b.at - a.at < DAY).length),
        );

        if (maxIn24h >= 2) {
            const empties = emptyOf[id] ?? 0;
            const cost = dollars(wasteOf[id] ?? 0);

            findings.push(
                makeFinding({
                    check: "A1",
                    subject: id,
                    severity: maxIn24h >= 4 ? "high" : "medium",
                    text: `${id} reopened ${list.length} times (${maxIn24h} in 24 h): ${[...new Set(list.map((e) => e.text))].join("; ")}${empties > 0 ? `. ${empties} of these reopens did no work, and cost ${money(cost)}` : ""}`,
                    evidence: [
                        `desk/${id}.md`,
                        ...(empties > 0
                            ? [`${empties} empty reopens of ${id}, ${money(cost)}`]
                            : []),
                        ...list.map((e) => `${iso(e.at)} ${e.text}`),
                    ],
                    lastSeen: list.at(-1).at,
                    cases: list.length,
                    waste: wasteOf[id],
                }),
            );
        }
    }

    return {
        findings,
        metrics: { total: reopens.length, reasons, triggers, empty, emptyCost: dollars(emptyCost) },
    };
}

/** A2: a thread in a supervisor's `Desk queue:` continues 3 or more times in the window (high at 6). */
export function checkA2(data, ctx) {
    const inWindow = windowOf(ctx);
    const byThread = eventsByThread(data);
    const supervisors = [
        ...new Set(Object.values(data.threads).map((thread) => thread.supervisor)),
    ].filter((id) => id !== undefined);
    const items = [];
    let queueCost = 0;
    const continues = new Set();

    for (const supervisor of supervisors) {
        const users = data.userEntries[supervisor] ?? [];

        for (const [index, entry] of users.entries()) {
            if (
                !entry.text.startsWith("Desk queue: these threads wait on you:") ||
                !inWindow(entry.at)
            ) {
                continue;
            }

            const cost = costBetween(data, supervisor, entry.at, users[index + 1]?.at ?? ctx.now);
            const found = [...entry.text.matchAll(/\b([TF]\d+): ([^;.]+)/g)];

            queueCost += cost;
            continues.add(`${supervisor}|${entry.at}`);

            for (const [, id, why] of found) {
                items.push({ id, why, at: entry.at, share: cost / found.length });
            }
        }
    }

    // A "silent session" item for work that was already done: the next event on the thread after the item, other
    // than busy and idle and reports, is its close.
    let done = 0;

    for (const item of items.filter((i) => i.why === "silent session")) {
        const next = (byThread.get(item.id) ?? []).find(
            (event) => event.at > item.at && !/^(busy|report)/.test(event.key),
        );

        if (next?.key.startsWith("closed")) {
            done += 1;
        }
    }

    const perThread = new Map();

    for (const item of items) {
        perThread.set(item.id, [...(perThread.get(item.id) ?? []), item]);
    }

    const findings = [];

    for (const [id, list] of perThread) {
        if (list.length >= 3) {
            const cost = dollars(list.reduce((sum, item) => sum + item.share, 0));

            findings.push(
                makeFinding({
                    check: "A2",
                    subject: id,
                    severity: list.length >= 6 ? "high" : "medium",
                    text: `${id} was in the supervisor's queue ${list.length} times (${list[0].why}) from ${iso(list[0].at)} to ${iso(list.at(-1).at)}. Its share of the supervisor's spend on these continues was ${money(cost)}`,
                    evidence: [
                        `desk/${id}.md`,
                        `queue share of ${id}: ${money(cost)}`,
                        ...list.map((i) => `${iso(i.at)} ${i.why}`),
                    ],
                    lastSeen: list.at(-1).at,
                    cases: list.length,
                    waste: cost,
                }),
            );
        }
    }

    return {
        findings,
        metrics: {
            continues: continues.size,
            items: items.length,
            silentThenClosed: done,
            cost: dollars(queueCost),
        },
    };
}

/** A3: 3 or more close-out wake-ups on one thread. */
export function checkA3(data, ctx) {
    const inWindow = windowOf(ctx);
    const sent = data.events.filter(
        (event) => inWindow(event.at) && event.text === "close-out wake-up sent",
    );
    const per = {};

    for (const event of sent) {
        bump(per, event.thread);
    }

    return {
        findings: Object.entries(per)
            .filter(([, count]) => count >= 3)
            .map(([id, count]) =>
                makeFinding({
                    check: "A3",
                    subject: id,
                    severity: "low",
                    text: `${id} got ${count} close-out wake-ups`,
                    evidence: [`desk/${id}.md`],
                    cases: count,
                }),
            ),
        metrics: { sent: sent.length, threads: Object.keys(per).length },
    };
}

/** A4: the same error of a desk or team tool 2 or more times. */
export function checkA4(data, ctx) {
    const inWindow = windowOf(ctx);
    const per = new Map();

    for (const error of data.toolErrors) {
        if (
            !error.isError ||
            !inWindow(error.at) ||
            error.text.includes("The desk is full") ||
            !["desk", "team", "team_delegate", "team_message", "team_sessions"].includes(error.tool)
        ) {
            continue;
        }

        const key = `${error.tool}: ${errorLine(error.text)}`;

        per.set(key, [...(per.get(key) ?? []), error]);
    }

    return {
        findings: [...per]
            .filter(([, list]) => list.length >= 2)
            .map(([key, list]) =>
                makeFinding({
                    check: "A4",
                    subject: slug(key),
                    severity: "low",
                    text: `${list.length}× ${key}`,
                    evidence: list.map((e) => `${iso(e.at)} session ${e.c}`),
                    lastSeen: Math.max(...list.map((e) => e.at)),
                    cases: list.length,
                }),
            ),
        metrics: { errors: Object.fromEntries([...per].map(([k, v]) => [k, v.length])) },
    };
}

/**
 * A5: threads closed `failed`, found threads open more than 24 h, `The desk is full` refusals, watches due more
 * than 1 day ago with no result. The asks open more than 24 h and the OKs used are metrics.
 */
export function checkA5(data, ctx) {
    const inWindow = windowOf(ctx);
    const findings = [];
    const threads = Object.values(data.threads);
    const found = threads.filter((thread) => thread.id.startsWith("F"));

    for (const thread of threads) {
        if (thread.closed?.why === "failed" && inWindow(thread.closed.at)) {
            findings.push(
                makeFinding({
                    check: "A5",
                    subject: `failed:${thread.id}`,
                    severity: "medium",
                    text: `${thread.id} closed as failed (${thread.closed.by}): ${quote(thread.title ?? "", 80) ?? ""}`.trim(),
                    evidence: [`desk/${thread.id}.md`, `${iso(thread.closed.at)} closed`],
                    lastSeen: thread.closed.at,
                }),
            );
        }
    }

    const foundHours = found.map((thread) => ({
        id: thread.id,
        open: thread.state !== "closed",
        hours: Math.round(((thread.closed?.at ?? ctx.now) - thread.startedAt) / HOUR),
    }));

    for (const item of foundHours) {
        if (item.open && item.hours >= 24) {
            findings.push(
                makeFinding({
                    check: "A5",
                    subject: `found:${item.id}`,
                    severity: "low",
                    text: `Found thread ${item.id} has stayed open ${item.hours} h`,
                    evidence: [`desk/${item.id}.md`],
                }),
            );
        }
    }

    const refusals = data.toolErrors.filter(
        (error) =>
            inWindow(error.at) &&
            ["team_delegate", "team"].includes(error.tool) &&
            error.text.includes("The desk is full"),
    );

    if (refusals.length > 0) {
        findings.push(
            makeFinding({
                check: "A5",
                subject: "refusals",
                severity: "medium",
                text: `${refusals.length} ${refusals.length === 1 ? "delegation was" : "delegations were"} refused: the desk is full`,
                evidence: refusals.map((e) => `${iso(e.at)} session ${e.c}`),
                lastSeen: Math.max(...refusals.map((e) => e.at)),
                cases: refusals.length,
            }),
        );
    }

    for (const thread of threads) {
        const watch = thread.watch;

        if (watch?.dueAt && !watch.result && ctx.now - watch.dueAt > DAY) {
            findings.push(
                makeFinding({
                    check: "A5",
                    subject: `watch:${thread.id}`,
                    severity: "low",
                    text: `${thread.id} has a watch due since ${iso(watch.dueAt)} with no result`,
                    evidence: [`desk/${thread.id}.md`],
                }),
            );
        }
    }

    const staleAsks = threads.flatMap((thread) =>
        (thread.asks ?? []).filter((ask) => !ask.answer && ctx.now - ask.at > DAY),
    );
    const okUsed = (data.grants ?? []).filter((grant) => grant.usedBy && inWindow(grant.at));

    return {
        findings,
        metrics: {
            failed: findings.filter((f) => f.id.startsWith("A5:failed")).length,
            foundThreads: foundHours,
            refusals: refusals.length,
            okUsed: okUsed.length,
            asksOpenOver24h: staleAsks.length,
        },
    };
}

// ---------- B. Repair wake-ups ----------

const REPAIR_KEY = /^repair:(.+#\d+):([0-9a-f]+):(\w+)$/;

/** B1: a repair wake-up for a commit where no check name failed. */
export function checkB1(data, ctx) {
    const inWindow = windowOf(ctx);
    const repairs = [];

    for (const thread of Object.values(data.threads)) {
        for (const [key, value] of Object.entries(thread.run?.repairs ?? {})) {
            if (inWindow(value.at)) {
                repairs.push({ thread: thread.id, key, ...value });
            }
        }
    }

    const perRef = new Map();
    let falseCount = 0;

    for (const repair of repairs) {
        const [, ref, oid, kind] = repair.key.match(REPAIR_KEY) ?? [];

        if (kind !== "FAILURE") {
            continue;
        }

        const repo = ref.split("#")[0];
        const runs = data.github?.checkRuns?.[`${repo}@${oid}`];

        if (!runs) {
            continue;
        }

        // Only the runs known at the wake-up count: a run with no `completed_at`, or one that completed by then.
        // A check name fails when these runs hold a failure (failure, timed_out or action_required; cancelled and
        // skipped are not faults) and no success completed later than the newest failure. Runs with no times: any
        // success counts as later.
        const names = new Map();

        for (const run of runs) {
            const done = run.completed_at ? Date.parse(run.completed_at) : null;

            if (done === null || Number.isNaN(done) || done <= repair.at) {
                names.set(run.name, [...(names.get(run.name) ?? []), { ...run, done }]);
            }
        }

        const failing = [...names].filter(([, known]) => {
            const failures = known.filter((run) =>
                ["failure", "timed_out", "action_required"].includes(run.conclusion),
            );

            if (failures.length === 0) {
                return false;
            }

            const lastFailure = Math.max(...failures.map((run) => run.done ?? 0));

            return !known.some(
                (run) =>
                    run.conclusion === "success" &&
                    (run.done === null || run.done === undefined || run.done > lastFailure),
            );
        });

        if (failing.length === 0) {
            const cancelled = [...names]
                .filter(([, known]) => known.some((run) => run.conclusion === "cancelled"))
                .map(
                    ([name, known]) => `${name} (${known.map((run) => run.conclusion).join(", ")})`,
                );

            falseCount += 1;
            perRef.set(ref, [...(perRef.get(ref) ?? []), { repair, repo, oid, cancelled }]);
        }
    }

    return {
        findings: [...perRef].map(([ref, list]) =>
            makeFinding({
                check: "B1",
                subject: ref,
                severity: "high",
                text: `${list[0].repair.thread}: ${list.length} repair wake-up${list.length === 1 ? "" : "s"} for ${ref}, but no check failed there; cancelled runs: ${[...new Set(list.flatMap((i) => i.cancelled))].join("; ") || "none"}`,
                evidence: [
                    `desk/${list[0].repair.thread}.md`,
                    ...list.map((i) => `https://github.com/${i.repo}/commit/${i.oid}/checks`),
                ],
                lastSeen: Math.max(...list.map((i) => i.repair.at)),
                cases: list.length,
            }),
        ),
        metrics: { total: repairs.length, withoutRealFailure: falseCount },
    };
}

const NOT_FAILING = /does not fail|not failing|only "?cancelled/i;

/** B2: an agent's report after a repair wake-up that says the PR does not fail. */
export function checkB2(data, ctx) {
    const inWindow = windowOf(ctx);
    const findings = [];
    let total = 0;

    for (const thread of Object.values(data.threads)) {
        const wakeups = data.events.filter(
            (event) =>
                event.thread === thread.id &&
                inWindow(event.at) &&
                event.key.startsWith("repair:") &&
                /repair wake-up to the agent/.test(event.text),
        );

        if (wakeups.length === 0 || !thread.session) {
            continue;
        }

        const first = Math.min(...wakeups.map((event) => event.at));
        const replies = (data.reports[thread.session] ?? []).filter(
            (report) => report.at > first && NOT_FAILING.test(report.text),
        );

        total += wakeups.length;

        if (replies.length > 0) {
            findings.push(
                makeFinding({
                    check: "B2",
                    subject: thread.id,
                    severity: "medium",
                    text: `${thread.id}: ${replies.length} agent report${replies.length === 1 ? "" : "s"} after a repair wake-up say the PR does not fail`,
                    evidence: [
                        `desk/${thread.id}.md`,
                        ...replies.map((report) => `${iso(report.at)} report (${report.from})`),
                    ],
                    lastSeen: Math.max(...replies.map((report) => report.at)),
                    cases: replies.length,
                }),
            );
        }
    }

    return { findings, metrics: { wakeups: total, notFailingReplies: findings.length } };
}

// ---------- C. Attribution ----------

/** C1: a PR attached by the window rule, then detached. */
export function checkC1(data, ctx) {
    const inWindow = windowOf(ctx);
    const attaches = data.events.filter(
        (event) => inWindow(event.at) && /attached \(window\)$/.test(event.text),
    );
    const findings = [];

    for (const event of attaches) {
        const ref = event.text.split(" ")[0];
        const later = data.events.find(
            (other) =>
                other.at >= event.at &&
                other.thread === event.thread &&
                other.text === `detached ${ref}`,
        );

        if (!later) {
            continue;
        }

        const target = data.events.find(
            (other) =>
                other.at >= later.at &&
                other.text === `${ref} attached` &&
                other.thread !== event.thread,
        );

        findings.push(
            makeFinding({
                check: "C1",
                subject: ref,
                severity: "medium",
                text: `${ref} was attached to ${event.thread} by the window rule, then detached${target ? ` and attached to ${target.thread}` : ""}`,
                evidence: [
                    `desk/${event.thread}.md`,
                    `${iso(event.at)} ${event.thread} ${event.text}`,
                    `${iso(later.at)} ${later.text}`,
                ],
                lastSeen: later.at,
            }),
        );
    }

    const vias = {};

    for (const thread of Object.values(data.threads)) {
        for (const pr of Object.values(thread.prs ?? {})) {
            bump(vias, pr.via);
        }
    }

    return {
        findings,
        metrics: { windowAttaches: attaches.length, windowMoved: findings.length, vias },
    };
}

// ---------- D. The desk against GitHub ----------

/** The asks answered `merged` in the window, once for each PR ref in the ask, with GitHub's PR. */
function mergedAnswers(data, ctx) {
    const inWindow = windowOf(ctx);
    const rows = [];

    for (const thread of Object.values(data.threads)) {
        for (const ask of thread.asks ?? []) {
            const answer = ask.answer;

            if (!answer || !inWindow(answer.at) || !/^merged\b/i.test(answer.words ?? "")) {
                continue;
            }

            for (const ref of refsIn(ask.text, thread.repo)) {
                const pr = data.github?.prs?.[ref];

                if (pr) {
                    rows.push({ thread, ask, answer, ref, pr });
                }
            }
        }
    }

    return rows;
}

/** D1: an ask answered `merged`, and GitHub did not merge, or merged 15 minutes or more later. */
export function checkD1(data, ctx) {
    const rows = mergedAnswers(data, ctx);
    const lags = [];
    const perRef = new Map();

    for (const row of rows) {
        const mergedAt = row.pr.mergedAt ? Date.parse(row.pr.mergedAt) : undefined;

        if (mergedAt) {
            lags.push(Math.round((mergedAt - row.answer.at) / 1000));
        }

        if (!mergedAt || mergedAt - row.answer.at >= 15 * MINUTE) {
            perRef.set(row.ref, [...(perRef.get(row.ref) ?? []), { ...row, mergedAt }]);
        }
    }

    lags.sort((a, b) => a - b);

    return {
        findings: [...perRef].map(([ref, list]) => {
            const first = list[0];

            return makeFinding({
                check: "D1",
                subject: ref,
                severity: "high",
                text: `${first.ask.id} answered "${quote(first.answer.words, 40) ?? ""}" by ${first.answer.by} at ${iso(first.answer.at)}, but ${ref} ${first.mergedAt ? `merged ${Math.round((first.mergedAt - first.answer.at) / MINUTE)} min later` : `is ${first.pr.state}`}`,
                evidence: [`desk/${first.thread.id}.md`, prUrl(ref)],
                lastSeen: first.answer.at,
                cases: list.length,
            });
        }),
        metrics: {
            checked: rows.length,
            lagSeconds: {
                median: lags.length === 0 ? null : lags[Math.floor(lags.length / 2)],
                max: lags.at(-1) ?? null,
                mergedBeforeAnswer: lags.filter((lag) => lag <= 0).length,
                mergedAfterAnswer: lags.filter((lag) => lag > 0).length,
            },
        },
    };
}

/** D1b: after a `merged` answer, a new ask on the same thread about the same PR in 10 minutes, before GitHub merged. */
export function checkD1b(data, ctx) {
    const perRef = new Map();

    for (const row of mergedAnswers(data, ctx)) {
        const mergedAt = row.pr.mergedAt ? Date.parse(row.pr.mergedAt) : undefined;
        const again = (row.thread.asks ?? []).find(
            (other) =>
                other.at > row.answer.at &&
                other.at - row.answer.at < 10 * MINUTE &&
                refsIn(other.text, row.thread.repo).includes(row.ref),
        );

        if (again && mergedAt && mergedAt > row.answer.at) {
            perRef.set(row.ref, [...(perRef.get(row.ref) ?? []), { ...row, mergedAt, again }]);
        }
    }

    return {
        findings: [...perRef].map(([ref, list]) => {
            const first = list[0];

            return makeFinding({
                check: "D1b",
                subject: ref,
                severity: "medium",
                text: `${first.ask.id} answered "${quote(first.answer.words, 40) ?? ""}" at ${iso(first.answer.at)}; GitHub merged ${ref} ${Math.round((first.mergedAt - first.answer.at) / 1000)} s later; in between, ${first.again.id} asked Brian again`,
                evidence: [
                    `desk/${first.thread.id}.md`,
                    `${first.again.id}: ${quote(first.again.text, 80) ?? ""}`,
                ],
                lastSeen: first.again.at,
                cases: list.length,
            });
        }),
        metrics: { reasks: [...perRef.values()].flat().length },
    };
}

/** D2: the desk's PR state on an open thread differs from GitHub, and GitHub changed before the last sweep. */
export function checkD2(data, ctx) {
    const findings = [];

    for (const thread of Object.values(data.threads)) {
        if (thread.state === "closed") {
            continue;
        }

        for (const [ref, pr] of Object.entries(thread.prs ?? {})) {
            const now = data.github?.prs?.[ref];
            const sweptAt = thread.run?.sweptAt ?? 0;

            if (
                !now ||
                pr.state === now.state ||
                pr.state === "FROZEN" ||
                ctx.now - sweptAt >= HOUR
            ) {
                continue;
            }

            const changed = Date.parse(now.mergedAt ?? now.closedAt ?? "");

            if (changed && changed < sweptAt) {
                findings.push(
                    makeFinding({
                        check: "D2",
                        subject: ref,
                        severity: "medium",
                        text: `${thread.id}: desk says ${ref} is ${pr.state}, GitHub says ${now.state} since ${iso(changed)}`,
                        evidence: [`desk/${thread.id}.md`, prUrl(ref)],
                        lastSeen: sweptAt,
                    }),
                );
            }
        }
    }

    return { findings, metrics: { stateDrift: findings.length } };
}

// ---------- E. Reports and messaging ----------

const wordsOf = (text) => new Set(text.toLowerCase().match(/[a-z0-9#._-]{3,}/g) ?? []);

const jaccard = (a, b) => {
    const both = [...a].filter((word) => b.has(word)).length;

    return both / (a.size + b.size - both || 1);
};

const prRefs = (text) => [...new Set(text.match(/#\d+/g) ?? [])].sort().join(" ");

/** The reports of every session, oldest first, in the window, with the thread of each. */
function reportsInWindow(data, ctx) {
    const inWindow = windowOf(ctx);

    return Object.entries(data.reports).map(([session, list]) => ({
        session: Number(session),
        thread: threadOfSession(data, Number(session)),
        reports: list.filter((report) => inWindow(report.at)).sort((a, b) => a.at - b.at),
    }));
}

/**
 * E1: 2 reports on one thread within 30 min. Sure when 80% or more of the words are the same and the `#n` refs are
 * the same: finding `E1`. From 50% (or 80% with other refs): a candidate `E1?`, and its pair goes to the LLM.
 */
export function checkE1(data, ctx) {
    const findings = [];
    const pairs = [];
    let reports = 0;
    let duplicates = 0;
    let candidates = 0;
    const sources = {};

    for (const { session, thread, reports: list } of reportsInWindow(data, ctx)) {
        const label = thread?.id ?? `session-${session}`;
        const sure = [];
        const maybe = [];

        reports += list.length;
        list.forEach((report) => bump(sources, report.from));

        for (let i = 1; i < list.length; i += 1) {
            const [a, b] = [list[i - 1], list[i]];

            if (b.at - a.at >= 30 * MINUTE) {
                continue;
            }

            const similar = jaccard(wordsOf(a.text), wordsOf(b.text));

            if (similar < 0.5) {
                continue;
            }

            const row = { a, b, similar };

            if (similar >= 0.8 && prRefs(a.text) === prRefs(b.text)) {
                sure.push(row);
            } else {
                maybe.push(row);
                pairs.push({ finding: `E1?:${label}`, check: "E1?", thread: label, a, b });
            }
        }

        duplicates += sure.length;
        candidates += maybe.length;

        for (const [check, severity, rows] of [
            ["E1", "medium", sure],
            ["E1?", "low", maybe],
        ]) {
            if (rows.length === 0) {
                continue;
            }

            const last = rows.at(-1);

            findings.push(
                makeFinding({
                    check,
                    subject: label,
                    severity,
                    text: `${label}: ${rows.length} report pair${rows.length === 1 ? "" : "s"} within 30 min, ${Math.round(last.similar * 100)}% the same words in the last${check === "E1?" ? " (the LLM decides)" : ""}`,
                    evidence: [
                        `desk/${label}.md`,
                        ...rows.map(
                            (row) =>
                                `${iso(row.a.at)} ${row.a.from} and ${iso(row.b.at)} ${row.b.from}: ${Math.round(row.similar * 100)}%`,
                        ),
                    ],
                    lastSeen: last.b.at,
                    cases: rows.length,
                }),
            );
        }
    }

    return { findings, metrics: { total: reports, sources, duplicates, candidates }, pairs };
}

/** E2: `team_message` or `team` calls that failed: no address (medium), a side-door block (low, 2 or more). */
export function checkE2(data, ctx) {
    const inWindow = windowOf(ctx);
    const failed = data.toolErrors.filter(
        (error) =>
            error.isError && inWindow(error.at) && ["team_message", "team"].includes(error.tool),
    );
    const noAddress = failed.filter((error) =>
        /No linked session has that address/.test(error.text),
    );
    const blocked = failed.filter((error) => /blocked/i.test(error.text));
    const findings = [];
    const perThread = new Map();

    for (const error of noAddress) {
        const label = threadOfSession(data, error.c)?.id ?? `session-${error.c}`;

        perThread.set(label, [...(perThread.get(label) ?? []), error]);
    }

    for (const [label, list] of perThread) {
        findings.push(
            makeFinding({
                check: "E2",
                subject: label,
                severity: "medium",
                text: `${label} (${agentName(data, list[0].c)}): ${list.length} message${list.length === 1 ? "" : "s"} failed: no linked session has that address here`,
                evidence: [
                    `desk/${label}.md`,
                    ...list.map((e) => `${iso(e.at)} ${e.tool}, entry ${e.id}`),
                ],
                lastSeen: Math.max(...list.map((e) => e.at)),
                cases: list.length,
            }),
        );
    }

    if (blocked.length >= 2) {
        findings.push(
            makeFinding({
                check: "E2",
                subject: "blocked",
                severity: "low",
                text: `${blocked.length} calls of team or team_message were blocked (the side door: use team_message for a report)`,
                evidence: blocked.map((e) => `${iso(e.at)} ${e.tool}, session ${e.c}`),
                lastSeen: Math.max(...blocked.map((e) => e.at)),
                cases: blocked.length,
            }),
        );
    }

    return {
        findings,
        metrics: { failed: failed.length, noAddress: noAddress.length, blocked: blocked.length },
    };
}

/**
 * E3: a night shift's report and a `team_message` from the same session within 30 min: 3 or more pairs. A
 * `team_message` is a twin only when no new request came to the shift session between the shift report and it: a
 * person's message, or another agent's message (for example `[via linked session …]`), makes it an answer to that
 * request. Those answers are the metric `answeredAfterShift`.
 */
export function checkE3(data, ctx) {
    const twins = [];
    const pairs = [];
    let shiftReports = 0;
    let answeredAfterShift = 0;

    for (const { session, thread, reports } of reportsInWindow(data, ctx)) {
        const label = thread?.id ?? `session-${session}`;
        const requests = data.userEntries[thread?.session ?? session] ?? [];
        const answered = new Set();

        const askedBetween = (shift, message) => {
            const from = Math.min(shift.at, message.at);
            const to = Math.max(shift.at, message.at);

            return requests.some(
                (entry) =>
                    entry.at > from &&
                    entry.at < to &&
                    !/^\[night-shift\]|^\[subagent |^\[scheduled\]/.test(entry.text),
            );
        };

        for (const shift of reports.filter((report) => report.from === "night-shift")) {
            shiftReports += 1;

            const twin = reports.find(
                (report) =>
                    report.from === "team_message" &&
                    Math.abs(report.at - shift.at) <= 30 * MINUTE &&
                    !askedBetween(shift, report),
            );

            for (const report of reports) {
                if (
                    report.from === "team_message" &&
                    Math.abs(report.at - shift.at) <= 30 * MINUTE &&
                    askedBetween(shift, report)
                ) {
                    answered.add(report.key);
                }
            }

            if (twin) {
                twins.push({
                    label,
                    gap: Math.round(Math.abs(twin.at - shift.at) / MINUTE),
                    at: Math.max(shift.at, twin.at),
                });
                pairs.push({ finding: "E3", check: "E3", thread: label, a: shift, b: twin });
            }
        }

        // One answering message counts 1 time for the session, however many shift reports are near it.
        answeredAfterShift += answered.size;
    }

    return {
        findings:
            twins.length >= 3
                ? [
                      makeFinding({
                          check: "E3",
                          severity: "medium",
                          text: `${twins.length} of ${shiftReports} night shift reports have a team_message from the same session within 30 min (the agent reported twice)`,
                          evidence: twins.map(
                              (twin) => `${twin.label}: ${twin.gap} min apart, ${iso(twin.at)}`,
                          ),
                          lastSeen: Math.max(...twins.map((twin) => twin.at)),
                          cases: twins.length,
                      }),
                  ]
                : [],
        metrics: { shiftReports, shiftPlusMessage: twins.length, answeredAfterShift },
        pairs: twins.length >= 3 ? pairs : [],
    };
}

// ---------- F. Night and day shifts ----------

/** The goals that were set or ended, or ran a round, in the window. */
function activeGoals(data, ctx) {
    const inWindow = windowOf(ctx);

    return data.goals.filter(
        ({ goal }) =>
            inWindow(goal.setAt ?? 0) ||
            inWindow(goal.endedAt ?? 0) ||
            (goal.rounds ?? []).some((round) => inWindow(round.at)),
    );
}

/** F1: shift endings by reason. A `failed` (error) or `max-rounds` ending is a finding; each `blocked` is listed. */
export function checkF1(data, ctx) {
    const inWindow = windowOf(ctx);
    const endings = {};
    const findings = [];

    for (const { session, goal } of data.goals) {
        const endedAt = goal.endedAt ?? goal.setAt ?? 0;

        if (goal.status === "running" ? !inWindow(goal.setAt ?? 0) : !inWindow(endedAt)) {
            continue;
        }

        bump(
            endings,
            goal.status === "running"
                ? "running"
                : `${goal.status}${goal.reason ? `: ${goal.reason}` : ""}`,
        );

        const severity =
            goal.reason === "failed" || goal.reason === "max-rounds"
                ? "medium"
                : goal.reason === "blocked"
                  ? "low"
                  : undefined;

        if (severity) {
            findings.push(
                makeFinding({
                    check: "F1",
                    subject: String(goal.id ?? session),
                    severity,
                    text: `Shift in session ${session} (${agentName(data, session)}) ended ${goal.reason}${goal.why ? `: ${quote(goal.why, 80) ?? ""}` : ""}`,
                    evidence: [
                        `${iso(endedAt)} ended`,
                        `${goal.round ?? 0} of ${goal.maxRounds ?? "?"} rounds`,
                    ],
                    lastSeen: endedAt,
                }),
            );
        }
    }

    return { findings, metrics: { endings } };
}

/** F2: 2 or more shifts with 2 or more rounds that end under 60 s after a `continue` round. */
export function checkF2(data, ctx) {
    const fast = [];
    let fastRounds = 0;

    for (const { session, goal } of activeGoals(data, ctx)) {
        const rounds = goal.rounds ?? [];
        let quick = 0;

        for (let i = 1; i < rounds.length; i += 1) {
            if (rounds[i].at - rounds[i - 1].at < 60_000 && rounds[i - 1].verdict === "continue") {
                quick += 1;
            }
        }

        fastRounds += quick;

        if (quick >= 2) {
            fast.push({ session, quick, rounds: rounds.length, goal });
        }
    }

    return {
        findings:
            fast.length >= 2
                ? [
                      makeFinding({
                          check: "F2",
                          severity: "medium",
                          text: `${fast.length} shifts spent 2 or more rounds in under 60 s each (the agent waits on its subagent)`,
                          evidence: fast.map(
                              (item) =>
                                  `session ${item.session} (${agentName(data, item.session)}): ${item.quick} of ${item.rounds} rounds under 60 s, max ${item.goal.maxRounds}`,
                          ),
                          cases: fast.length,
                      }),
                  ]
                : [],
        metrics: { roundsUnder60s: fastRounds, shiftsWithFastRounds: fast.length },
    };
}

/** True when a UTC time is in DeepSeek's peak: 01:00 to 04:00 and 06:00 to 10:00. */
export const inDeepseekPeak = (ms) => {
    const hour = new Date(ms).getUTCHours();

    return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
};

/**
 * A cross-review reviewer (Brian's cross-review policy): a read-only subagent with exactly the tools `read` and
 * `bash`, whose name or brief says "review". It runs on another model family by design.
 */
export function isCrossReviewSpawn(spawn) {
    const tools = spawn.tools;

    return (
        Array.isArray(tools) &&
        tools.length === 2 &&
        tools.includes("read") &&
        tools.includes("bash") &&
        (spawn.review === true || /review/i.test(`${spawn.name ?? ""} ${spawn.brief ?? ""}`))
    );
}

/** F3: a subagent on a model other than the brief's worker, and a DeepSeek worker that starts in its peak. */
export function checkF3(data, ctx) {
    const findings = [];
    let wrongSpawns = 0;
    let reviewerSpawns = 0;
    let peakRounds = 0;

    for (const { session, goal } of activeGoals(data, ctx)) {
        if (!goal.worker) {
            continue;
        }

        const from = goal.setAt ?? 0;
        const to = goal.endedAt ?? ctx.now;
        const other = data.spawns.filter(
            (spawn) =>
                spawn.c === session &&
                spawn.at >= from &&
                spawn.at <= to + HOUR &&
                spawn.model !== goal.worker,
        );
        const wrong = other.filter((spawn) => !isCrossReviewSpawn(spawn));

        reviewerSpawns += other.length - wrong.length;

        if (wrong.length > 0) {
            wrongSpawns += wrong.length;
            findings.push(
                makeFinding({
                    check: "F3",
                    subject: `model:${goal.id ?? session}`,
                    severity: "medium",
                    text: `Shift in session ${session} (${agentName(data, session)}) named the worker ${goal.worker}, but ${wrong.length} subagent${wrong.length === 1 ? "" : "s"} ran on ${[...new Set(wrong.map((spawn) => spawn.model ?? "no model given"))].join(", ")}`,
                    evidence: wrong.map((spawn) => `${iso(spawn.at)} spawn, entry ${spawn.id}`),
                    lastSeen: Math.max(...wrong.map((spawn) => spawn.at)),
                    cases: wrong.length,
                }),
            );
        }

        if (goal.worker.startsWith("deepseek/")) {
            const rounds = goal.rounds ?? [];
            // A round starts when the one before it ended; round 1 starts at the goal's start, or when it was set.
            const starts = rounds.flatMap((round, index) => {
                const before = rounds[index - 1];

                if (before && before.n === round.n - 1) {
                    return [{ n: round.n, start: before.at }];
                }

                return round.n === 1 ? [{ n: 1, start: goal.start ?? goal.setAt ?? 0 }] : [];
            });
            const peak = starts.filter((round) => inDeepseekPeak(round.start));

            if (peak.length > 0) {
                peakRounds += peak.length;
                findings.push(
                    makeFinding({
                        check: "F3",
                        subject: `peak:${goal.id ?? session}`,
                        severity: "low",
                        text: `Shift in session ${session} (${agentName(data, session)}) ran ${peak.length} round${peak.length === 1 ? "" : "s"} on ${goal.worker} that started in DeepSeek's peak hours (01:00 to 04:00 and 06:00 to 10:00 UTC)`,
                        evidence: peak.map(
                            (round) => `round ${round.n} started ${iso(round.start)}`,
                        ),
                        lastSeen: Math.max(...peak.map((round) => round.start)),
                        cases: peak.length,
                    }),
                );
            }
        }
    }

    return { findings, metrics: { wrongModelSpawns: wrongSpawns, reviewerSpawns, peakRounds } };
}

// ---------- G. Schedules ----------

/** G1: schedule outcomes (`completed`, `aborted`, `failed`); a `failed` run; a run more than 1 h after it was due. */
export function checkG1(data, ctx) {
    const inWindow = windowOf(ctx);
    const outcomes = {};
    const failed = [];
    const late = [];

    for (const task of data.schedules) {
        if (task.status === "running") {
            if (task.next !== undefined && ctx.now - task.next > HOUR) {
                late.push({
                    text: `schedule ${task.scheduleId} was due ${iso(task.next)} and has not run`,
                    at: task.next,
                });
            }

            continue;
        }

        if (!inWindow(task.endedAt ?? 0)) {
            continue;
        }

        bump(outcomes, task.status);

        if (task.status === "failed") {
            failed.push(task);
        }

        // A one-shot schedule ends when it sends: its end time is its send time.
        if (
            task.status === "completed" &&
            !task.every &&
            task.firstNext !== undefined &&
            task.endedAt - task.firstNext > HOUR
        ) {
            late.push({
                text: `schedule ${task.scheduleId} was due ${iso(task.firstNext)} and ran ${iso(task.endedAt)}`,
                at: task.endedAt,
            });
        }
    }

    const findings = [];

    if (failed.length > 0) {
        findings.push(
            makeFinding({
                check: "G1",
                subject: "failed",
                severity: "medium",
                text: `${failed.length} schedule run${failed.length === 1 ? "" : "s"} failed`,
                evidence: failed.map(
                    (task) =>
                        `${iso(task.endedAt)} schedule ${task.scheduleId}, task ${task.taskId}`,
                ),
                lastSeen: Math.max(...failed.map((task) => task.endedAt)),
                cases: failed.length,
            }),
        );
    }

    if (late.length > 0) {
        findings.push(
            makeFinding({
                check: "G1",
                subject: "late",
                severity: "medium",
                text: `${late.length} schedule run${late.length === 1 ? " was" : "s were"} more than 1 h late`,
                evidence: late.map((item) => item.text),
                lastSeen: Math.max(...late.map((item) => item.at)),
                cases: late.length,
            }),
        );
    }

    return { findings, metrics: { outcomes, late: late.length } };
}

// ---------- H. GitHub ----------

const botList = (data) =>
    (data.github?.botPrs ?? []).flatMap((ref) =>
        data.github.prs[ref] ? [{ ref, pr: data.github.prs[ref] }] : [],
    );

/** H1: merged bot PRs whose head branch still exists 1 h after the merge (medium at 5 or more). */
export function checkH1(data, ctx) {
    const left = botList(data).filter(({ pr }) => branchLeft(pr, ctx.now));
    const repos = [...new Set(left.map(({ ref }) => ref.split("#")[0]))];
    const off = repos.filter((repo) => data.github.autoDelete?.[repo] === false);

    return {
        findings:
            left.length > 0
                ? [
                      makeFinding({
                          check: "H1",
                          severity: left.length >= 5 ? "medium" : "low",
                          text: `${left.length} merged bot PRs still have their head branch on GitHub; ${off.length} of their ${repos.length} repositories have "delete head branches" off`,
                          evidence: [
                              ...left.map(({ ref, pr }) => `${ref} (${pr.headRefName})`),
                              `off in: ${off.join(", ")}`,
                          ],
                          cases: left.length,
                      }),
                  ]
                : [],
        metrics: { mergedBranchLeft: left.length, autoDeleteOff: off },
    };
}

/** H2: bot PRs that are on no desk thread. */
export function checkH2(data) {
    const onDesk = new Set(
        Object.values(data.threads).flatMap((thread) => Object.keys(thread.prs ?? {})),
    );
    const missing = botList(data).filter(({ ref }) => !onDesk.has(ref));

    return {
        findings:
            missing.length > 0
                ? [
                      makeFinding({
                          check: "H2",
                          severity: "low",
                          text: `${missing.length} bot ${missing.length === 1 ? "PR is" : "PRs are"} on no desk thread`,
                          evidence: missing.map(({ ref, pr }) => `${ref} ${pr.state}`),
                          cases: missing.length,
                      }),
                  ]
                : [],
        metrics: { notOnDesk: missing.length },
    };
}

/**
 * H3: more than 20% of the bot PRs had a commit whose check rollup is FAILURE or ERROR (with 5 PRs or more), and
 * open bot PRs with no update for 48 h.
 */
export function checkH3(data, ctx) {
    const prs = botList(data);
    const states = {};
    const red = prs.filter(({ pr }) =>
        (pr.commits?.nodes ?? []).some((node) =>
            ["FAILURE", "ERROR"].includes(node.commit?.statusCheckRollup?.state),
        ),
    );
    const idle = prs.filter(
        ({ pr }) =>
            pr.state === "OPEN" && pr.updatedAt && ctx.now - Date.parse(pr.updatedAt) >= 48 * HOUR,
    );
    const findings = [];

    prs.forEach(({ pr }) => bump(states, pr.state));

    const rate = prs.length === 0 ? 0 : red.length / prs.length;

    if (prs.length >= 5 && rate > 0.2) {
        findings.push(
            makeFinding({
                check: "H3",
                subject: "ci",
                severity: "medium",
                text: `${red.length} of ${prs.length} bot PRs (${Math.round(rate * 100)}%) had a commit with failing checks`,
                evidence: red.map(({ ref }) => prUrl(ref)),
                cases: red.length,
            }),
        );
    }

    if (idle.length > 0) {
        findings.push(
            makeFinding({
                check: "H3",
                subject: "idle",
                severity: "low",
                text: `${idle.length} open bot PR${idle.length === 1 ? " has" : "s have"} had no update for 48 h`,
                evidence: idle.map(
                    ({ ref, pr }) => `${prUrl(ref)} (updated ${iso(Date.parse(pr.updatedAt))})`,
                ),
                cases: idle.length,
            }),
        );
    }

    return {
        findings,
        metrics: {
            botPrs: prs.length,
            states,
            withAFailingCommit: red.length,
            failingRate: Math.round(rate * 100) / 100,
            idle: idle.length,
        },
    };
}

// ---------- I. Odrade's notes ----------

/** The audit's own output folders: the checks of group I leave them out, so the audit does not report itself. */
const OWN_OUTPUT = /-daily-audit(\/|$)/;

/** I1: `reports/*` entries that Odrade's `README.md` does not link. The audit's own folders are left out. */
export function checkI1(data) {
    const notes = data.odrade;
    const reports = notes.reports.filter((name) => !OWN_OUTPUT.test(`${name}/`));
    const missing = reports.filter((name) => !notes.readme.includes(`reports/${name}`));

    return {
        findings:
            missing.length > 0
                ? [
                      makeFinding({
                          check: "I1",
                          severity: "low",
                          text: `${missing.length} of ${reports.length} reports ${missing.length === 1 ? "is" : "are"} not in Odrade's README index`,
                          evidence: missing.map((name) => `reports/${name}`),
                          cases: missing.length,
                      }),
                  ]
                : [],
        metrics: { reports: reports.length, notInIndex: missing.length },
    };
}

/**
 * I2: uncommitted files in Odrade's repository (the audit's own folders left out) and the last commit older than
 * 13 h (the digests commit at 07:30 and 20:00, so 12.5 h is the longest normal gap).
 */
export function checkI2(data, ctx) {
    const dirty = data.odrade.dirty.filter((line) => !OWN_OUTPUT.test(line));
    const age = data.odrade.lastCommitAt === null ? undefined : ctx.now - data.odrade.lastCommitAt;
    const stale = age === undefined || age > 13 * HOUR;

    return {
        findings:
            dirty.length > 0 && stale
                ? [
                      makeFinding({
                          check: "I2",
                          severity: "low",
                          text: `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"} in Odrade's notes, and the last commit is ${age === undefined ? "unknown" : `${Math.round(age / HOUR)} h old`}`,
                          evidence: dirty.map((line) => line.slice(0, 120)),
                          cases: dirty.length,
                      }),
                  ]
                : [],
        metrics: {
            uncommitted: dirty.length,
            hoursSinceCommit: age === undefined ? null : Math.round((age / HOUR) * 10) / 10,
        },
    };
}

/**
 * I3: each agent's home folder that has uncommitted files and whose last commit is older than 24 h. The agent commits
 * its home at the end of each task, so a home dirty for a day means tasks are not closed (the homes of
 * `TEAM_HOMES_DIR`; Odrade's home is I2's).
 */
export function checkI3(data, ctx) {
    const homes = data.homes ?? [];
    const dirty = homes.filter((home) => home.dirty.length > 0);
    const findings = [];

    for (const home of dirty) {
        const age = home.lastCommitAt === null ? undefined : ctx.now - home.lastCommitAt;

        if (age !== undefined && age <= 24 * HOUR) {
            continue;
        }

        findings.push(
            makeFinding({
                check: "I3",
                subject: home.id,
                severity: "low",
                text: `${home.dirty.length} uncommitted file${home.dirty.length === 1 ? "" : "s"} in ${home.id}'s home, and the last commit is ${age === undefined ? "unknown" : `${Math.round(age / HOUR)} h old`}`,
                evidence: home.dirty.map((line) => line.slice(0, 120)),
                cases: home.dirty.length,
            }),
        );
    }

    return {
        findings,
        metrics: {
            homes: homes.length,
            dirty: dirty.length,
        },
    };
}

// ---------- J. Spend ----------

const roundAll = (object) =>
    Object.fromEntries(
        Object.entries(object)
            .sort((a, b) => b[1] - a[1])
            .map(([key, value]) => [key, dollars(value)]),
    );

/**
 * J1: spend per day, per agent and per thread; a day 50% above the median of the 7 days before it; waste (A1 empty
 * reopens + A2 queue continues) above $5.
 */
export function checkJ1(data, ctx) {
    const inWindow = windowOf(ctx);
    const perAgent = {};
    const perThread = {};
    const sessionThread = new Map(
        Object.values(data.threads)
            .filter((thread) => thread.session)
            .map((thread) => [thread.session, thread.id]),
    );
    let total = 0;

    for (const row of data.costRows) {
        if (!inWindow(row.at)) {
            continue;
        }

        total += row.cost;
        bump(perAgent, data.agentOf[row.c] ?? "other", row.cost);

        const thread = sessionThread.get(row.c);

        if (thread) {
            bump(perThread, thread, row.cost);
        }
    }

    // The 7 days before the window, 24 h each.
    const baseline = Array.from({ length: 7 }, (_, index) => {
        const to = ctx.since - index * DAY;

        return data.costRows
            .filter((row) => row.at > to - DAY && row.at <= to)
            .reduce((sum, row) => sum + row.cost, 0);
    });
    // A day with no cost rows is a day before the data starts, not a day of no spend: it is left out, and the
    // median needs 3 days.
    const withData = baseline.filter((value) => value > 0);
    const middle = withData.length >= 3 ? median(withData) : null;
    const perDay = (total * DAY) / (ctx.hours * HOUR);
    const a1 = ctx.results?.A1 ?? checkA1(data, ctx);
    const a2 = ctx.results?.A2 ?? checkA2(data, ctx);
    const waste = (a1.metrics.emptyCost ?? 0) + (a2.metrics.cost ?? 0);
    const findings = [];

    if (middle !== null && perDay > middle * 1.5) {
        findings.push(
            makeFinding({
                check: "J1",
                subject: "spike",
                severity: "medium",
                text: `Spend of ${money(perDay)} a day is ${Math.round((perDay / middle) * 100)}% of the 7-day median (${money(middle)})`,
                evidence: Object.entries(roundAll(perAgent))
                    .slice(0, 5)
                    .map(([agent, cost]) => `${agent} ${money(cost)}`),
            }),
        );
    }

    if (waste > 5) {
        findings.push(
            makeFinding({
                check: "J1",
                subject: "waste",
                severity: "medium",
                text: `${money(waste)} went to turns that did no work: empty reopens ${money(a1.metrics.emptyCost ?? 0)} (A1), queue continues ${money(a2.metrics.cost ?? 0)} (A2)`,
                evidence: [],
            }),
        );
    }

    return {
        findings,
        metrics: {
            total: dollars(total),
            perDay: dollars(perDay),
            median7: middle === null ? null : dollars(middle),
            perAgent: roundAll(perAgent),
            topThreads: Object.fromEntries(Object.entries(roundAll(perThread)).slice(0, 8)),
            waste: { emptyReopens: a1.metrics.emptyCost ?? 0, queue: a2.metrics.cost ?? 0 },
        },
    };
}

// ---------- R. Model routing (shadow) ----------

/** The model that really ran a thread's work: the night-shift goal's worker, else its most common subagent model. */
function usedModel(data, thread) {
    const worker = (data.goals ?? [])
        .filter((item) => item.session === thread.session)
        .map((item) => item.goal?.worker)
        .find((each) => typeof each === "string" && each !== "");

    if (worker !== undefined) {
        return worker;
    }

    const counts = {};

    // `routeSpawns`: every spawn of the routed threads' sessions, with no time limit.
    for (const spawn of data.routeSpawns ?? []) {
        if (spawn.c !== thread.session) {
            continue;
        }

        if (typeof spawn.model !== "string" || spawn.model === "") {
            continue;
        }

        // A cross-review reviewer runs on another model family by design: it is not the worker.
        if (isCrossReviewSpawn(spawn)) {
            continue;
        }

        bump(counts, spawn.model);
    }

    const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

    return best === undefined ? "-" : best[0];
}

/** The night-shift goal of a thread's session, when it has one. */
const goalOfThread = (data, thread) =>
    (data.goals ?? []).find((item) => item.session === thread.session)?.goal;

/**
 * R1: the model router's shadow records, joined to what happened. Each cell is 1 (kind, suggested tier, suggested
 * model, status, model used): how many threads, how many are open, how many closed as done, how many did not, the
 * goals' statuses, the rounds and the cost, and the reopenings. It makes no finding: in shadow mode the table compares
 * the suggestion with what really ran. A rate shows only for 10 threads or more, and no time window applies: a record
 * is compared for as long as it is there.
 */
export function checkR1(data, ctx) {
    const cells = new Map();
    let routes = 0;

    for (const thread of Object.values(data.threads ?? {})) {
        const route = thread.route;

        if (!route || typeof route !== "object") {
            continue;
        }

        routes += 1;
        const used = usedModel(data, thread);
        const key = [
            route.kind ?? "-",
            route.tier ?? "-",
            route.model ?? "-",
            route.status ?? "-",
            used,
        ].join("\u0000");
        const cell = cells.get(key) ?? {
            kind: route.kind ?? "-",
            tier: route.tier ?? "-",
            model: route.model ?? "-",
            status: route.status ?? "-",
            used,
            count: 0,
            open: 0,
            success: 0,
            notSuccess: 0,
            goals: {},
            rounds: [],
            costs: [],
            reopenings: 0,
        };

        cells.set(key, cell);
        cell.count += 1;

        const closed = thread.closed;

        if (closed === undefined) {
            cell.open += 1;
        } else if (
            closed.why === "done" &&
            (closed.outcome === undefined ||
                closed.outcome === "completed" ||
                closed.outcome === "verified")
        ) {
            cell.success += 1;
        } else if (
            closed.why === "dropped" ||
            closed.why === "failed" ||
            closed.outcome === "abandoned"
        ) {
            cell.notSuccess += 1;
        }

        const goal = goalOfThread(data, thread);

        if (goal !== undefined) {
            bump(
                cell.goals,
                goal.status === undefined
                    ? "-"
                    : `${goal.status}${goal.reason ? `: ${goal.reason}` : ""}`,
            );

            if (typeof goal.round === "number") {
                cell.rounds.push(goal.round);
            }
        }

        if (thread.session !== undefined) {
            // `routeCosts`: the same rows as `costRows`, for this session, with no time limit.
            const rows = (data.routeCosts ?? []).filter((row) => row.c === thread.session);

            if (rows.length > 0) {
                cell.costs.push(rows.reduce((sum, row) => sum + row.cost, 0));
            }
        }

        cell.reopenings += (eventsByThread(data).get(thread.id) ?? []).filter((event) =>
            String(event.key).startsWith("reopened"),
        ).length;
    }

    const list = [...cells.values()]
        .map((cell) => ({
            kind: cell.kind,
            tier: cell.tier,
            model: cell.model,
            status: cell.status,
            used: cell.used,
            count: cell.count,
            open: cell.open,
            success: cell.success,
            notSuccess: cell.notSuccess,
            successRate:
                cell.count >= 10 ? Math.round((cell.success / cell.count) * 100) / 100 : null,
            goals: cell.goals,
            medianRounds: cell.rounds.length === 0 ? null : median(cell.rounds),
            medianCost: cell.costs.length === 0 ? null : dollars(median(cell.costs)),
            reopenings: cell.reopenings,
        }))
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.kind.localeCompare(b.kind) ||
                a.tier.localeCompare(b.tier) ||
                a.model.localeCompare(b.model) ||
                a.status.localeCompare(b.status) ||
                a.used.localeCompare(b.used),
        );

    return { findings: [], metrics: { routes, cells: list } };
}

// ---------- The registry ----------

/** Each check, with the sources it needs. A source that is in `data.sourceErrors` skips the check. */
export const CHECKS = [
    ["A1", checkA1, ["desk", "entries", "costs"]],
    ["A2", checkA2, ["desk", "entries", "costs"]],
    ["A3", checkA3, ["desk"]],
    ["A4", checkA4, ["entries"]],
    ["A5", checkA5, ["desk", "entries"]],
    ["B1", checkB1, ["desk", "github"]],
    ["B2", checkB2, ["desk", "reports"]],
    ["C1", checkC1, ["desk"]],
    ["D1", checkD1, ["desk", "github"]],
    ["D1b", checkD1b, ["desk", "github"]],
    ["D2", checkD2, ["desk", "github"]],
    ["E1", checkE1, ["desk", "reports"]],
    ["E2", checkE2, ["desk", "entries"]],
    ["E3", checkE3, ["desk", "reports", "entries"]],
    ["F1", checkF1, ["goals"]],
    ["F2", checkF2, ["goals"]],
    ["F3", checkF3, ["goals", "entries"]],
    ["G1", checkG1, ["schedules"]],
    ["H1", checkH1, ["github"]],
    ["H2", checkH2, ["desk", "github"]],
    ["H3", checkH3, ["github"]],
    ["I1", checkI1, ["odrade"]],
    ["I2", checkI2, ["odrade"]],
    ["I3", checkI3, ["homes"]],
    ["J1", checkJ1, ["desk", "costs"]],
    ["R1", checkR1, ["desk", "goals", "routes"]],
];

/**
 * Run every check. A check whose source is missing, or that throws, goes to `skipped`. Returns
 * `{ findings, metrics, skipped, pairs }`; `pairs` hold report texts for the LLM step and never go to the report.
 */
export function runChecks(data, ctx) {
    const findings = [];
    const metrics = {};
    const skipped = {};
    const pairs = [];
    const results = {};

    for (const [id, check, needs] of CHECKS) {
        const missing = needs.find((source) => data.sourceErrors?.[source]);

        if (missing) {
            skipped[id] = `source unavailable: ${missing}: ${data.sourceErrors[missing]}`;

            continue;
        }

        try {
            const result = check(data, { ...ctx, results });

            results[id] = result;
            findings.push(...result.findings);
            metrics[id] = result.metrics;
            pairs.push(...(result.pairs ?? []));
        } catch (error) {
            skipped[id] = `check failed: ${String(error?.message ?? error).split("\n")[0]}`;
        }
    }

    return { findings, metrics, skipped, pairs };
}
