// The daily audit's checks. Each one is a pure function of `(data, ctx)` and returns `{ findings, metrics }`.
//
// `data` is the plain object that `sources.mjs` builds; `ctx` is `{ now, since, hours }`, and for `runChecks` also
// `date` and `earlier` (the earlier days' JSON, which Q1 sums). A check reads nothing and
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
    newYorkDate,
    quote,
    refsIn,
    safeLine,
} from "./common.mjs";
import {
    REVIEW_WINDOW_DAYS,
    isCrossReviewSpawn,
    reviewPoints,
    reviewRounds,
    threadAt as q1ThreadAt,
} from "./reviews.mjs";

export { isCrossReviewSpawn };

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

/**
 * The first line of a tool error, with the harness tags, thread ids and revs taken out. A rev is a whole word of 7 to
 * 40 hex characters (a commit or a plan revision).
 */
export const errorLine = (text) =>
    text
        .replace(/<\/?harness>|\[error\]/g, "")
        .replace(/\b[TF]\d+[a-z]?\b/g, "T<n>")
        // A rev has at least 1 digit: a plain word of a to f only (such as "defaced") stays.
        .replace(/\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g, "<rev>")
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

/** A4: the same error of a desk, team or plan tool 2 or more times. */
export function checkA4(data, ctx) {
    const inWindow = windowOf(ctx);
    const per = new Map();

    for (const error of data.toolErrors) {
        if (
            !error.isError ||
            !inWindow(error.at) ||
            error.text.includes("The desk is full") ||
            !["desk", "team", "team_delegate", "team_message", "team_sessions", "plan"].includes(
                error.tool,
            )
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
                    !/^\[(?:shift|night-shift)\]|^\[subagent |^\[scheduled\]/.test(entry.text),
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
                          text: `${twins.length} of ${shiftReports} shift reports have a team_message from the same session within 30 min (the agent reported twice)`,
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
 * The head commit's node of a PR: the node of `headRefOid`, else the last node when every commit came. `null` when it
 * is not known (a PR with more than 50 commits).
 */
function headCommit(pr) {
    const nodes = pr.commits?.nodes ?? [];

    if (typeof pr.headRefOid === "string") {
        return nodes.find((node) => node.commit?.oid === pr.headRefOid) ?? null;
    }

    const totalCount = pr.commits?.totalCount;

    if ((totalCount === undefined || totalCount === nodes.length) && nodes.length > 0) {
        return nodes[nodes.length - 1];
    }

    return null;
}

/**
 * H3: more than 20% of the bot PRs had a commit whose check rollup is FAILURE or ERROR (with 5 PRs or more), and
 * open bot PRs with no update for 48 h. The metrics split the PRs with a failing commit (measurement only): red then
 * fixed (merged, green head), red at merge (merged, failing head), and other (not merged, or head unknown or pending).
 */
export function checkH3(data, ctx) {
    const prs = botList(data);
    const states = {};
    const red = prs.filter(({ pr }) =>
        (pr.commits?.nodes ?? []).some((node) =>
            ["FAILURE", "ERROR"].includes(node.commit?.statusCheckRollup?.state),
        ),
    );
    let redThenFixed = 0;
    let redAtMerge = 0;
    let redOther = 0;
    const redAtMergePrs = [];

    for (const { ref, pr } of red) {
        const headState =
            pr.state === "MERGED" ? headCommit(pr)?.commit?.statusCheckRollup?.state : undefined;

        if (headState === "FAILURE" || headState === "ERROR") {
            redAtMerge += 1;
            redAtMergePrs.push(ref);
        } else if (headState === "SUCCESS") {
            // The PR is in `red`, and its head is green: the failing commit came before the head.
            redThenFixed += 1;
        } else {
            redOther += 1;
        }
    }

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
            redThenFixed,
            redAtMerge,
            redOther,
            redAtMergePrs,
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
 * How a routed thread ended: `open` (not closed), `success` (closed as done, and every PR merged or verified, or none),
 * `notSuccess` (dropped, failed, or a PR closed unmerged), or undefined (closed in another way: no count holds it).
 */
function outcomeOf(thread) {
    const closed = thread.closed;

    if (closed === undefined) {
        return "open";
    }

    if (
        closed.why === "done" &&
        (closed.outcome === undefined ||
            closed.outcome === "completed" ||
            closed.outcome === "verified")
    ) {
        return "success";
    }

    if (closed.why === "dropped" || closed.why === "failed" || closed.outcome === "abandoned") {
        return "notSuccess";
    }

    return undefined;
}

/** The counts of 1 group of routes beside a named worker. */
const zeroNamedStats = () => ({ count: 0, open: 0, success: 0, notSuccess: 0, suggestionRan: 0 });

/**
 * R1: the model router's shadow records of night shifts, joined to what happened. Each cell is 1 (kind, suggested tier, suggested
 * model, status, named worker, model used): how many threads, how many are open, how many closed as done, how many did
 * not, the goals' statuses, the rounds and the cost, and the reopenings. `named` is the model the supervisor named
 * (`route.worker`), or `-` when none was named: since the router also runs beside a named worker, the named worker
 * shows in its own cell. It makes no finding: in shadow mode the table compares the suggestion with what really ran. A
 * rate shows only for 10 threads or more, and no time window applies: a record is compared for as long as it is there.
 *
 * The metric `named` looks at the routes with the status `shadow` and a `worker` only: how many there are, and, for
 * those whose suggested model is the named worker (`same`) and the rest (`differs`), how many threads (`count`), how
 * many are open, closed as success, or closed as not success (the cells' rules), and for how many the suggestion is
 * also the model that really ran (`suggestionRan`). It says whether the router would have chosen what the supervisor
 * chose, and how those threads ended.
 */
export function checkR1(data, ctx) {
    const cells = new Map();
    const named = { routes: 0, same: zeroNamedStats(), differs: zeroNamedStats() };
    let routes = 0;

    for (const thread of Object.values(data.threads ?? {})) {
        const route = thread.route;

        if (!route || typeof route !== "object") {
            continue;
        }

        // R1 measures night shifts. Since routes carry `briefHash`, every delegation gets one: a new route counts here
        // only when its session has a night-shift goal. An older route (no `briefHash`) was always a night shift's.
        if (route.briefHash !== undefined && goalOfThread(data, thread) === undefined) {
            continue;
        }

        routes += 1;
        const used = usedModel(data, thread);
        const key = [
            route.kind ?? "-",
            route.tier ?? "-",
            route.model ?? "-",
            route.status ?? "-",
            route.worker ?? "-",
            used,
        ].join("\u0000");
        const cell = cells.get(key) ?? {
            kind: route.kind ?? "-",
            tier: route.tier ?? "-",
            model: route.model ?? "-",
            status: route.status ?? "-",
            named: route.worker ?? "-",
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

        const outcome = outcomeOf(thread);

        if (outcome !== undefined) {
            cell[outcome] += 1;
        }

        if (route.status === "shadow" && typeof route.worker === "string" && route.worker !== "") {
            const stats = route.model === route.worker ? named.same : named.differs;

            named.routes += 1;
            stats.count += 1;

            if (outcome !== undefined) {
                stats[outcome] += 1;
            }

            if (used === route.model) {
                stats.suggestionRan += 1;
            }
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
            named: cell.named,
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
                a.named.localeCompare(b.named) ||
                a.used.localeCompare(b.used),
        );

    return { findings: [], metrics: { routes, cells: list, named } };
}

// ---------- Q. Quality metrics ----------

/** Q1's thresholds: first guesses, to tune after 2 weeks of records (plan T801, "Gap 1"). */
export const Q1_THRESHOLDS = { minDecided: 8, minCovered: 25, below: 0.75 };
/** Q1 sums this many days, today included. */
const Q1_DAYS = 30;

const REVERTS_REF = /\bReverts ([\w.-]+\/[\w.-]+)#(\d+)/g;
const REVERT_TITLE = /^Revert "(.*)"$/s;

/** The date `days` days after `date` (`YYYY-MM-DD`; negative goes back). */
const shiftDate = (date, days) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

const repoOfRef = (ref) => ref.split("#")[0];

/** The agent of each PR ref on the desk: `agents[0]` of a thread that holds it, threads by id, agents first. */
function prAgents(threads) {
    const byRef = new Map();
    const list = Object.values(threads ?? {}).sort((a, b) =>
        String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
    );

    for (const thread of list) {
        for (const ref of Object.keys(thread.prs ?? {})) {
            const agent = Array.isArray(thread.agents) ? thread.agents[0] : undefined;

            if (typeof agent === "string" && agent !== "" && !byRef.has(ref)) {
                byRef.set(ref, agent);
            }
        }
    }

    return byRef;
}

/** 1 PR of Q1's day record, from 1 search node. No body is kept. */
function decidedPr(node, agents) {
    const ref = `${node.repository.nameWithOwner}#${node.number}`;
    const merged = Boolean(node.mergedAt);
    const title = String(node.title ?? "");
    const out = {
        ref,
        state: merged ? "merged" : "closed",
        at: node.closedAt ?? node.mergedAt ?? null,
        agent: agents.get(ref) ?? "unattributed",
        author: node.author?.login ?? null,
        title,
    };

    if (merged) {
        const reverts = [
            ...new Set(
                [...String(node.body ?? "").matchAll(REVERTS_REF)].map((m) => `${m[1]}#${m[2]}`),
            ),
        ];
        const revertsTitle = REVERT_TITLE.exec(title)?.[1];

        if (reverts.length > 0) {
            out.reverts = reverts;
        }

        if (revertsTitle !== undefined) {
            out.revertsTitle = revertsTitle;
        }
    }

    return out;
}

/** Today's record for Q1: the PRs the run saw decided, or `complete: false` and why. */
function q1Day(data) {
    const error = data.sourceErrors?.decided;
    const source = data.decided;

    if (error || !source) {
        return {
            from: source?.from ?? null,
            until: source?.until ?? null,
            complete: false,
            reason: error ?? "no data",
            calls: source?.calls ?? 0,
            prs: [],
        };
    }

    const day = {
        from: source.from,
        until: source.until,
        complete: source.complete === true,
        ...(source.complete === true ? {} : { reason: source.reason ?? "incomplete" }),
        calls: source.calls ?? 0,
        prs: [],
    };

    // Partial data is never judged, and never kept.
    if (day.complete) {
        const agents = prAgents(data.threads);
        const byRef = new Map();

        for (const node of source.nodes ?? []) {
            const pr = decidedPr(node, agents);

            byRef.set(pr.ref, pr);
        }

        day.prs = [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
    }

    return day;
}

const zeroQ1Row = () => ({
    merged: 0,
    closedUnmerged: 0,
    reverted: 0,
    decided: 0,
    acceptance: null,
});

/** The unrounded acceptance of a row, or null. */
const q1Rate = (row) => (row.decided === 0 ? null : (row.merged - row.reverted) / row.decided);

/** Each merged PR of the set that a merged revert PR in the set reverts, with the revert PRs that revert it. */
function revertsOf(prs) {
    const merged = prs.filter((pr) => pr.state === "merged");
    const byRef = new Map(merged.map((pr) => [pr.ref, pr]));
    const reverted = new Map();
    const add = (ref, revert) => reverted.set(ref, [...(reverted.get(ref) ?? []), revert]);

    for (const revert of merged) {
        if (revert.reverts?.length > 0) {
            for (const ref of revert.reverts) {
                if (ref !== revert.ref && byRef.has(ref)) {
                    add(ref, revert);
                }
            }
        } else if (typeof revert.revertsTitle === "string") {
            for (const pr of merged) {
                if (
                    pr.ref !== revert.ref &&
                    repoOfRef(pr.ref) === repoOfRef(revert.ref) &&
                    pr.title === revert.revertsTitle
                ) {
                    add(pr.ref, revert);
                }
            }
        }
    }

    return reverted;
}

/** The refs of the merged PRs that a merged revert PR in the set reverts. */
const revertedRefs = (prs) => new Set(revertsOf(prs).keys());

/** Q1's review-round thresholds: first guesses, to tune after 2 weeks of records (plan T801, "Gap 1"). */
export const Q1_ROUND_THRESHOLDS = { median: 3, rise: 1, recentDays: 7, windowDays: 30 };
/** Q1's 3-failure stop thresholds: `min` stops of 1 repository in the last `days` days. */
export const Q1_STOP_THRESHOLDS = { min: 2, days: 7 };

const UNATTRIBUTED = "unattributed";

const byThreadId = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

/** A new Q1 part that cannot be judged: its source failed, or the data has no such key. */
const q1Unavailable = (data, source, key) => {
    if (data.sourceErrors?.[source]) {
        return { available: false, reason: data.sourceErrors[source] };
    }

    return data[key] === undefined ? { available: false, reason: "no data" } : undefined;
};

const q1RepoOf = (thread) =>
    typeof thread?.repo === "string" && thread.repo !== "" ? thread.repo : UNATTRIBUTED;

const q1AgentOf = (thread) => {
    const agent = Array.isArray(thread?.agents) ? thread.agents[0] : undefined;

    return typeof agent === "string" && agent !== "" ? agent : undefined;
};

/** The nearest-rank 90th percentile, or null. */
const p90 = (values) => {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.ceil(0.9 * sorted.length) - 1];
};

const medianOrNull = (values) => (values.length === 0 ? null : median(values));

/** 1 row of review rounds: `list` holds `{ rounds, at }` of each thread. */
function roundRow(list, now) {
    const recentFrom = now - Q1_ROUND_THRESHOLDS.recentDays * DAY;
    const from = now - Q1_ROUND_THRESHOLDS.windowDays * DAY;
    const recent = list.filter((item) => item.at >= recentFrom);
    const before = list.filter((item) => item.at < recentFrom && item.at >= from);
    const rounds = (items) => items.map((item) => item.rounds);

    return {
        threads: list.length,
        median: medianOrNull(rounds(list)),
        p90: p90(rounds(list)),
        recent: { threads: recent.length, median: medianOrNull(rounds(recent)) },
        before: { threads: before.length, median: medianOrNull(rounds(before)) },
    };
}

const sortedKeys = (rows) =>
    Object.fromEntries(Object.entries(rows).sort((a, b) => a[0].localeCompare(b[0])));

/**
 * Q1's review rounds per desk thread, from 30 days of `subagent` spawn and send calls. A cross-review spawn is 1
 * round; a send is 1 round when the latest earlier spawn of that name in the same session is a cross-review spawn.
 * Each call goes to the desk thread of its session (`q1ThreadAt`); a call with no thread does not count.
 */
function q1Rounds(data, ctx) {
    const unavailable = q1Unavailable(data, "reviews", "reviewCalls");

    if (unavailable) {
        return { metrics: unavailable, items: [] };
    }

    const from = ctx.now - Q1_ROUND_THRESHOLDS.windowDays * DAY;
    const calls = (Array.isArray(data.reviewCalls) ? data.reviewCalls : [])
        .filter((call) => typeof call?.at === "number" && call.at >= from)
        .map((call, index) => ({ call, index }))
        .sort((a, b) => a.call.at - b.call.at || a.call.id - b.call.id || a.index - b.index)
        .map((item) => item.call);
    const latestSpawn = new Map();
    const byThread = new Map();

    for (const call of calls) {
        const key = `${call.c}\u0000${call.name}`;
        let round = false;

        if (call.action === "spawn") {
            round = isCrossReviewSpawn(call);
            latestSpawn.set(key, round);
        } else if (call.action === "send") {
            round = latestSpawn.get(key) === true;
        }

        if (!round) {
            continue;
        }

        const thread = q1ThreadAt(data, call.c, call.at);

        if (!thread) {
            continue;
        }

        const item = byThread.get(thread.id) ?? {
            id: thread.id,
            repo: q1RepoOf(thread),
            agent: q1AgentOf(thread) ?? UNATTRIBUTED,
            rounds: 0,
            at: 0,
        };

        item.rounds += 1;
        item.at = Math.max(item.at, call.at);
        byThread.set(thread.id, item);
    }

    const items = [...byThread.values()].sort((a, b) => byThreadId(a.id, b.id));

    const group = (field) => {
        const lists = {};

        for (const item of items) {
            (lists[item[field]] ??= []).push(item);
        }

        return sortedKeys(
            Object.fromEntries(
                Object.entries(lists).map(([name, list]) => [name, roundRow(list, ctx.now)]),
            ),
        );
    };

    return {
        metrics: {
            available: true,
            thresholds: { ...Q1_ROUND_THRESHOLDS },
            totals: roundRow(items, ctx.now),
            repos: group("repo"),
            agents: group("agent"),
            threads: items.map((item) => ({
                id: item.id,
                repo: item.repo,
                agent: item.agent,
                rounds: item.rounds,
                at: iso(item.at),
            })),
        },
        items,
    };
}

/** Q1's review-round findings: a high median, and a rise of the last 7 days, gated by 8 decided PRs. */
function roundFindings(rounds, acceptance, ctx) {
    if (!rounds.metrics.available) {
        return [];
    }

    const findings = [];
    const recentFrom = ctx.now - Q1_ROUND_THRESHOLDS.recentDays * DAY;
    const evidence = (list) => list.map((item) => `desk/${item.id}.md ${item.rounds} rounds`);
    const newest = (list) => Math.max(...list.map((item) => item.at));
    const t = Q1_ROUND_THRESHOLDS;

    for (const [kind, field, rows, decided] of [
        ["repo", "repo", rounds.metrics.repos, acceptance.repos],
        ["agent", "agent", rounds.metrics.agents, acceptance.agents],
    ]) {
        for (const [name, row] of Object.entries(rows)) {
            if (name === UNATTRIBUTED || (decided[name]?.decided ?? 0) < Q1_THRESHOLDS.minDecided) {
                continue;
            }

            const label = kind === "repo" ? name : `agent ${name}`;
            const list = rounds.items.filter((item) => item[field] === name);

            if (row.median !== null && row.median >= t.median) {
                findings.push(
                    makeFinding({
                        check: "Q1",
                        subject: `rounds:${kind}:${name}`,
                        severity: "medium",
                        text: `Review rounds of ${label} have a median of ${row.median} and a P90 of ${row.p90} over ${row.threads} desk thread${row.threads === 1 ? "" : "s"} in ${t.windowDays} days`,
                        evidence: evidence(list),
                        lastSeen: newest(list),
                        cases: row.threads,
                    }),
                );
            }

            if (
                row.recent.threads >= 1 &&
                row.before.threads >= 1 &&
                row.recent.median - row.before.median >= t.rise
            ) {
                const recent = list.filter((item) => item.at >= recentFrom);

                findings.push(
                    makeFinding({
                        check: "Q1",
                        subject: `rounds-rise:${kind}:${name}`,
                        severity: "medium",
                        text: `Review rounds of ${label} rose: a median of ${row.recent.median} over ${row.recent.threads} desk thread${row.recent.threads === 1 ? "" : "s"} in the last ${t.recentDays} days, against ${row.before.median} over ${row.before.threads} in the ${t.windowDays - t.recentDays} days before`,
                        evidence: evidence(recent),
                        lastSeen: newest(recent),
                        cases: row.recent.threads,
                    }),
                );
            }
        }
    }

    return findings;
}

/** Q1's 3-failure stops of the last 30 days, per repository and per agent; 2 in 7 days for 1 repository is medium. */
function q1Stops(data, ctx) {
    const unavailable = q1Unavailable(data, "goalHistory", "goalStops");

    if (unavailable) {
        return { metrics: unavailable, findings: [] };
    }

    // The flaky keys to join with the failing jobs: unknown (`null`), not none, when the source failed or is absent.
    const flakySource =
        data.sourceErrors?.flakyKeys || data.flakyKeys === null || data.flakyKeys === undefined
            ? undefined
            : data.flakyKeys;
    const flakyList = Array.isArray(flakySource?.keys) ? flakySource.keys : [];
    const scannedRepos = new Set(
        (Array.isArray(flakySource?.repos) ? flakySource.repos : [])
            .filter((repo) => typeof repo === "string")
            .map((repo) => repo.toLowerCase()),
    );
    const from = ctx.now - 30 * DAY;
    const last7From = ctx.now - Q1_STOP_THRESHOLDS.days * DAY;
    const goals = (Array.isArray(data.goalStops) ? data.goalStops : [])
        .filter((stop) => typeof stop?.at === "number" && stop.at >= from)
        .map((stop) => {
            const thread = q1ThreadAt(data, stop.session, stop.at);
            const repo = q1RepoOf(thread);
            const checks = q1StopChecks(stop.checks);
            const flakyKeys = q1FlakyKeysOf(checks, repo, flakyList);

            return {
                id: String(stop.id),
                session: stop.session,
                thread: thread?.id ?? null,
                repo,
                agent: q1AgentOf(thread) ?? data.agentOf?.[stop.session] ?? UNATTRIBUTED,
                at: stop.at,
                checks,
                checksFrom: checks.length > 0 ? (stop.checksFrom ?? null) : null,
                flakyKeys,
                flaky:
                    checks.length === 0 || flakySource === undefined
                        ? null
                        : q1FlakyOf(checks, repo, flakyKeys, scannedRepos),
            };
        })
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const zero = () => ({ stops: 0, last7: 0, withChecks: 0, flaky: 0 });
    const totals = zero();
    const repos = {};
    const agents = {};

    for (const goal of goals) {
        for (const row of [
            totals,
            (repos[goal.repo] ??= zero()),
            (agents[goal.agent] ??= zero()),
        ]) {
            row.stops += 1;
            row.last7 += goal.at >= last7From ? 1 : 0;
            row.withChecks += goal.checks.length > 0 ? 1 : 0;
            row.flaky += goal.flaky === true ? 1 : 0;
        }
    }

    const findings = [];

    for (const [repo, row] of Object.entries(sortedKeys(repos))) {
        if (repo === UNATTRIBUTED || row.last7 < Q1_STOP_THRESHOLDS.min) {
            continue;
        }

        const recent = goals.filter((goal) => goal.repo === repo && goal.at >= last7From);

        findings.push(
            makeFinding({
                check: "Q1",
                subject: `stops:repo:${repo}`,
                severity: "medium",
                text: `${row.last7} shift goals of ${repo} stopped in the last ${Q1_STOP_THRESHOLDS.days} days because the same check failure came 3 times in a row (${row.stops} in 30 days)`,
                evidence: recent.map(
                    (goal) =>
                        `${iso(goal.at)} goal ${goal.id} in session ${goal.session}${goal.thread === null ? "" : ` desk/${goal.thread}.md`}`,
                ),
                lastSeen: Math.max(...recent.map((goal) => goal.at)),
                cases: row.last7,
            }),
        );
    }

    return {
        metrics: {
            available: true,
            thresholds: { ...Q1_STOP_THRESHOLDS },
            totals,
            repos: sortedKeys(repos),
            agents: sortedKeys(agents),
            goals: goals.map((goal) => ({ ...goal, at: iso(goal.at) })),
            flakyScans: flakySource === undefined ? null : [...(flakySource.files ?? [])],
        },
        findings,
    };
}

/** A stop's failing jobs, as new plain objects: entries with a non-empty `name` only. */
function q1StopChecks(list) {
    return (Array.isArray(list) ? list : [])
        .filter((each) => typeof each?.name === "string" && each.name !== "")
        .map((each) => {
            const check = { name: each.name };

            for (const field of ["repo", "run", "job"]) {
                if (each[field] !== undefined) {
                    check[field] = each[field];
                }
            }

            return check;
        });
}

/** The marker that `gh pr checks` puts at the end of a check name it cuts. */
const GH_CUT = "...";

/**
 * Does a check name name a flaky key's job? Exactly, or, for a name that `gh` cut (it ends with `...`), when the job
 * starts with the rest of the name.
 */
function q1JobMatches(name, job) {
    if (typeof job !== "string") {
        return false;
    }

    if (name.endsWith(GH_CUT)) {
        const prefix = name.slice(0, -GH_CUT.length);

        return prefix !== "" && job.startsWith(prefix);
    }

    return job === name;
}

/** The repository of a failing job: the check's own, else the goal's thread repository unless unattributed. */
const q1CheckRepo = (check, threadRepo) =>
    typeof check.repo === "string"
        ? check.repo
        : threadRepo !== UNATTRIBUTED
          ? threadRepo
          : undefined;

/**
 * Is a stop's failure flaky? `true` when a key matches; `false` only when a scan read the repository of every check
 * with no error, so that no key means "not flaky"; else unknown (`null`): a repository that no scan read, or read with
 * an error.
 */
function q1FlakyOf(checks, threadRepo, flakyKeys, scannedRepos) {
    if (flakyKeys.length > 0) {
        return true;
    }

    return checks.every((check) => {
        const repo = q1CheckRepo(check, threadRepo);

        return repo !== undefined && scannedRepos.has(repo.toLowerCase());
    })
        ? false
        : null;
}

/**
 * The sorted flaky keys that match a stop's failing jobs: a key of the check's repository (else the goal's thread
 * repository, unless unattributed; compared case-insensitively) whose `job` names the check, or a key whose job ids
 * hold the check's job id.
 */
function q1FlakyKeysOf(checks, threadRepo, keys) {
    const found = new Set();

    for (const check of checks) {
        const repo = q1CheckRepo(check, threadRepo);

        for (const key of keys) {
            const sameRepo =
                typeof repo === "string" &&
                typeof key?.repo === "string" &&
                key.repo.toLowerCase() === repo.toLowerCase();
            const byName = sameRepo && q1JobMatches(check.name, key.job);
            const byJob =
                check.job !== undefined &&
                Array.isArray(key?.jobIds) &&
                key.jobIds.includes(check.job);

            if ((byName || byJob) && typeof key.key === "string") {
                found.add(key.key);
            }
        }
    }

    return [...found].sort();
}

const isRerunCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Q1's CI reruns per repository, from the newest flaky-test scan: 1 key for each repository of the scan and of Q1's
 * acceptance rows. A repository with no scan value is `null`, never 0. No findings.
 */
function q1CiReruns(data, acceptanceRepos) {
    const unavailable = q1Unavailable(data, "flakyScan", "flakyScan");

    if (unavailable) {
        return unavailable;
    }

    const scan = data.flakyScan;
    const names = new Set(Object.keys(acceptanceRepos));

    if (scan === null) {
        return {
            available: false,
            reason: "no flaky scan",
            repos: sortedKeys(Object.fromEntries([...names].map((repo) => [repo, null]))),
        };
    }

    const scanned = scan.repos ?? {};

    Object.keys(scanned).forEach((repo) => names.add(repo));

    return {
        available: true,
        file: scan.file ?? null,
        generatedAt: scan.generatedAt ?? null,
        window: scan.window ?? null,
        repos: sortedKeys(
            Object.fromEntries(
                [...names].map((repo) => [
                    repo,
                    isRerunCount(scanned[repo]) ? scanned[repo] : null,
                ]),
            ),
        ),
    };
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Q1's cross-review rounds per PR, from the session records (the session method; the PR-text method is elsewhere).
 * A round is a cross-review spawn, or a send to a name whose latest spawn in that session was one (as `rounds`). The
 * PR of a round is the first desk-owner ref its message names, else its bare PR number in its desk thread's
 * repository; a send with none takes the PR of the latest earlier call to that name. Per PR: `rounds`, `heads` (the
 * distinct reviewed heads), `first` and `last`. `totals.rounds` counts the rounds with a PR, `unattributed` those
 * without one. No findings.
 */
function q1PrRounds(data, ctx) {
    const unavailable = q1Unavailable(data, "reviews", "reviewCalls");

    if (unavailable) {
        return unavailable;
    }

    const byRef = new Map();
    let unattributed = 0;

    for (const round of reviewRounds(data, ctx)) {
        if (round.ref === null) {
            unattributed += 1;
            continue;
        }

        const row = byRef.get(round.ref) ?? {
            ref: round.ref,
            rounds: 0,
            heads: new Set(),
            first: round.at,
            last: round.at,
        };

        row.rounds += 1;
        row.first = Math.min(row.first, round.at);
        row.last = Math.max(row.last, round.at);

        if (round.head !== null) {
            row.heads.add(round.head);
        }

        byRef.set(round.ref, row);
    }

    const rows = [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
    const counts = rows.map((row) => row.rounds);
    const sum = counts.reduce((total, count) => total + count, 0);

    return {
        available: true,
        method: "sessions",
        windowDays: REVIEW_WINDOW_DAYS,
        totals: {
            prs: rows.length,
            rounds: sum,
            mean: rows.length === 0 ? null : round2(sum / rows.length),
            median: medianOrNull(counts),
            p90: p90(counts),
            atLeast3: counts.filter((count) => count >= 3).length,
            unattributed,
        },
        prs: rows.map((row) => ({
            ref: row.ref,
            rounds: row.rounds,
            heads: row.heads.size,
            first: iso(row.first),
            last: iso(row.last),
        })),
    };
}

/**
 * How this run's guard read went: `{ available, reason?, errors, calls, pending }`. `errors` names each kind of failed
 * GitHub call of `loadBlockerGuards`. A loader that failed, or GitHub turned off, is `available: false` with its
 * reason, and `calls` and `pending` are null (unknown, not 0).
 */
function guardsSource(data) {
    const loaded = data.blockerGuards;
    const reason = data.sourceErrors?.blockerGuards;

    if (reason || !loaded || typeof loaded !== "object") {
        return {
            available: false,
            reason: reason ?? "no data",
            errors: [],
            calls: null,
            pending: null,
        };
    }

    return {
        available: true,
        errors: Array.isArray(loaded.errors) ? [...loaded.errors] : [],
        calls: typeof loaded.calls === "number" ? loaded.calls : null,
        pending: typeof loaded.pending === "number" ? loaded.pending : null,
    };
}

/** The state of a PR for a blocking point: from this run's GitHub read, else from a cached guard. */
function pointState(ref, prs, guard) {
    if (ref === null) {
        return "unknown";
    }

    const state = prs[ref]?.state;

    if (state === "open" || state === "merged" || state === "closed") {
        return state;
    }

    if (guard?.state === "closed" || guard?.state === "merged") {
        return guard.state;
    }

    return "unknown";
}

/**
 * Q1's blocking points of cross-review answers ("Blocker to guard"): every blocking item of an answer, with the PR
 * and the reviewed head of the review call it answers, the PR's state, and its guard: whether, from the reviewed head
 * to the PR's final head, a test or an `AGENTS.md` file of the PR changed and `.memory/corrections.jsonl` got lines
 * (`loadBlockerGuards`, or a final result of an earlier day). `guards` says how this run's guard read went
 * (`guardsSource`). Without GitHub, or when the guard read fails, the points still show, with state `unknown` (a
 * cached guard still applies). No findings.
 */
function q1Blockers(data, ctx) {
    const unavailable =
        q1Unavailable(data, "reviews", "reviewCalls") ??
        q1Unavailable(data, "reviewAnswers", "reviewAnswers");

    if (unavailable) {
        return unavailable;
    }

    const found = reviewPoints(data, ctx);
    const guards = { ...(data.blockerCache ?? {}), ...(data.blockerGuards?.guards ?? {}) };
    const prs = data.blockerGuards?.prs ?? {};
    const totals = {
        answers: found.answers,
        points: found.points.length,
        attributed: 0,
        ambiguous: 0,
        noPr: 0,
        noHead: 0,
        open: 0,
        merged: 0,
        closed: 0,
        pending: 0,
        evaluated: 0,
        guarded: 0,
        test: 0,
        agentsRule: 0,
        corrections: 0,
        namesPr: 0,
        rate: null,
        unparsed: found.unparsed,
    };
    const points = found.points.map((point) => {
        const guard =
            point.ref !== null && point.head !== null
                ? (guards[`${point.ref}@${point.head}`] ?? null)
                : null;
        const state = pointState(point.ref, prs, guard);

        if (point.ref !== null) {
            totals.attributed += 1;
        } else if (point.ambiguous) {
            totals.ambiguous += 1;
        } else {
            totals.noPr += 1;
        }

        totals.noHead += point.head === null ? 1 : 0;

        if (state !== "unknown") {
            totals[state] += 1;
        }

        if (guard?.final === true && typeof guard.guarded === "boolean") {
            totals.evaluated += 1;
            totals.guarded += guard.guarded ? 1 : 0;
            totals.test += guard.test === true ? 1 : 0;
            totals.agentsRule += guard.agentsRule === true ? 1 : 0;
            totals.corrections += guard.corrections > 0 ? 1 : 0;
            totals.namesPr += guard.namesPr === true ? 1 : 0;
        } else if (state === "merged" && point.head !== null && guard?.final !== true) {
            totals.pending += 1;
        }

        return { ...point, at: iso(point.at), state, guard };
    });

    totals.rate = totals.evaluated === 0 ? null : round2(totals.guarded / totals.evaluated);

    return {
        available: true,
        windowDays: REVIEW_WINDOW_DAYS,
        guards: guardsSource(data),
        totals,
        points,
    };
}

/** Run 1 new Q1 part; a part that throws is unavailable, and the acceptance part still stands. */
const q1Part = (fn, fallback) => {
    try {
        return fn();
    } catch (error) {
        return fallback(`failed: ${String(error?.message ?? error).split("\n")[0]}`);
    }
};

/**
 * Q1: decided acceptance. Each run records the PRs it saw decided (merged, or closed unmerged); the last 30 complete
 * records are summed, 1 PR per ref, and acceptance is `(merged − reverted) / decided`, per repository and per agent.
 * A medium finding for a repository or an agent with 8 or more decided PRs, 25 or more covered days, and an
 * acceptance under 0.75. `unattributed` makes no finding.
 *
 * Beside it, in keys of their own: review rounds per desk thread (`rounds`), 3-failure stops of night-shift goals
 * (`stops`), CI reruns from the newest flaky-test scan (`ciReruns`), cross-review rounds per PR (`prRounds`) and the
 * blocking points of cross-review answers with their guards (`blockers`). A new part whose source failed is
 * `{ available: false, reason }` and makes no finding; the acceptance part runs all the same.
 */
export function checkQ1(data, ctx) {
    const date = ctx.date ?? newYorkDate(ctx.now);
    const first = shiftDate(date, -(Q1_DAYS - 1));
    const last = shiftDate(date, -1);
    const day = q1Day(data);
    const records = (ctx.earlier ?? [])
        .filter(
            (earlier) =>
                earlier.date >= first &&
                earlier.date <= last &&
                earlier.json?.metrics?.Q1?.day?.complete === true,
        )
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((earlier) => earlier.json.metrics.Q1.day);

    if (day.complete) {
        records.push(day);
    }

    // 1 PR per ref; the newest record wins.
    const byRef = new Map();

    for (const record of records) {
        for (const pr of Array.isArray(record.prs) ? record.prs : []) {
            if (typeof pr?.ref === "string") {
                byRef.set(pr.ref, pr);
            }
        }
    }

    const prs = [...byRef.values()];
    const reverted = revertedRefs(prs);
    const totals = zeroQ1Row();
    const repos = {};
    const agents = {};
    const casesOf = new Map();

    for (const pr of prs) {
        const repo = repoOfRef(pr.ref);
        const agent = typeof pr.agent === "string" ? pr.agent : "unattributed";
        const rows = [totals, (repos[repo] ??= zeroQ1Row()), (agents[agent] ??= zeroQ1Row())];
        const keys = [`repo:${repo}`, `agent:${agent}`];

        for (const row of rows) {
            row[pr.state === "merged" ? "merged" : "closedUnmerged"] += 1;
            row.decided += 1;
            row.reverted += reverted.has(pr.ref) ? 1 : 0;
        }

        if (pr.state !== "merged" || reverted.has(pr.ref)) {
            keys.forEach((key) => casesOf.set(key, [...(casesOf.get(key) ?? []), pr]));
        }
    }

    const sorted = (rows) =>
        Object.fromEntries(Object.entries(rows).sort((a, b) => a[0].localeCompare(b[0])));

    const round = (row) => {
        const rate = q1Rate(row);

        row.acceptance = rate === null ? null : Math.round(rate * 100) / 100;

        return row;
    };

    [totals, ...Object.values(repos), ...Object.values(agents)].forEach(round);

    const covered = records.length;
    const findings = [];

    const judge = (subject, label, row) => {
        const rate = q1Rate(row);

        if (
            row.decided < Q1_THRESHOLDS.minDecided ||
            covered < Q1_THRESHOLDS.minCovered ||
            rate === null ||
            rate >= Q1_THRESHOLDS.below
        ) {
            return;
        }

        const cases = (casesOf.get(subject) ?? []).sort((a, b) => a.ref.localeCompare(b.ref));
        const times = cases.map((pr) => Date.parse(pr.at)).filter((ms) => !Number.isNaN(ms));

        findings.push(
            makeFinding({
                check: "Q1",
                subject,
                severity: "medium",
                text: `Decided acceptance of ${label} is ${row.acceptance} over ${Q1_DAYS} days: merged ${row.merged}, closed unmerged ${row.closedUnmerged}, reverted ${row.reverted} (${covered} of ${Q1_DAYS} days covered)`,
                evidence: cases.map(
                    (pr) =>
                        `${prUrl(pr.ref)} ${pr.state === "merged" ? "reverted" : "closed unmerged"}`,
                ),
                lastSeen: times.length > 0 ? Math.max(...times) : undefined,
                cases: row.closedUnmerged + row.reverted,
            }),
        );
    };

    for (const [repo, row] of Object.entries(sorted(repos))) {
        judge(`repo:${repo}`, repo, row);
    }

    for (const [agent, row] of Object.entries(sorted(agents))) {
        if (agent !== "unattributed") {
            judge(`agent:${agent}`, `agent ${agent}`, row);
        }
    }

    const repoRows = sorted(repos);
    const agentRows = sorted(agents);
    const unavailable = (reason) => ({ available: false, reason });
    const rounds = q1Part(
        () => q1Rounds(data, ctx),
        (reason) => ({ metrics: unavailable(reason), items: [] }),
    );
    const roundsFound = q1Part(
        () => roundFindings(rounds, { repos: repoRows, agents: agentRows }, ctx),
        () => [],
    );
    const stops = q1Part(
        () => q1Stops(data, ctx),
        (reason) => ({ metrics: unavailable(reason), findings: [] }),
    );
    const ciReruns = q1Part(() => q1CiReruns(data, repoRows), unavailable);
    const prRounds = q1Part(() => q1PrRounds(data, ctx), unavailable);
    const blockers = q1Part(() => q1Blockers(data, ctx), unavailable);

    findings.push(...roundsFound, ...stops.findings);

    return {
        findings,
        metrics: {
            day,
            window: { from: first, to: date, days: Q1_DAYS, covered },
            thresholds: { ...Q1_THRESHOLDS },
            totals,
            repos: repoRows,
            agents: agentRows,
            rounds: rounds.metrics,
            stops: stops.metrics,
            ciReruns,
            prRounds,
            blockers,
        },
    };
}

// ---------- R2. Routed threads end to end ----------

/** R2's thresholds: an accepted rate shows from 10 decided threads, and a merge waits 14 days for a revert. */
export const R2_THRESHOLDS = { minDecided: 10, windowDays: 14 };

/** The bench repositories: a night shift that names only these can run on a routed worker (plan section Method). */
export const R2_BENCH_REPOS = [
    "bketelsen/pi-pocket-team",
    "frostyard/frostmail",
    "frostyard/lodge",
    "frostyard/porter",
    "frostyard/updex",
    "frostyard/core",
    "frostyard/nsl",
    "frostyard/chairlift",
    "bketelsen/fleet",
];

/** The Jev kinds of an eligible night shift. */
const R2_KINDS = ["implement", "debug", "refactor", "write"];

const nonEmpty = (value) => typeof value === "string" && value !== "";

/**
 * The PRs of R2: every complete Q1 day record of the earlier days (no 30-day limit) and today's, 1 PR per ref, the
 * newest record wins. Only the stored records: no GitHub call.
 */
function r2Records(ctx) {
    const records = (ctx.earlier ?? [])
        .filter((earlier) => earlier.json?.metrics?.Q1?.day?.complete === true)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((earlier) => earlier.json.metrics.Q1.day);
    const today = ctx.results?.Q1?.metrics?.day;

    if (today?.complete === true) {
        records.push(today);
    }

    const byRef = new Map();

    for (const record of records) {
        for (const pr of Array.isArray(record.prs) ? record.prs : []) {
            if (typeof pr?.ref === "string") {
                byRef.set(pr.ref, pr);
            }
        }
    }

    return byRef;
}

/** A time in ms from a number or an ISO text; null when it is neither. */
const msOf = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    const ms = typeof value === "string" ? Date.parse(value) : NaN;

    return Number.isNaN(ms) ? null : ms;
};

/**
 * The reasons of a thread that is not accepted. `r2Outcome` tests them in this order: `dropped`, `reopened`,
 * `closedPr` (any PR), then `reverted`; a thread counts in the first reason found only.
 */
const R2_WHY = ["dropped", "closedPr", "reverted", "reopened"];

/** The kinds of reopening that are rework: only these make a routed thread not accepted (reason `reopened`). */
export const R2_REWORK_KINDS = ["checks", "work", "busy"];

/** The exact texts of the reopen events that `desk.ts` writes with a fixed reason. */
const REOPEN_TEXTS = {
    "reopened: new work in its session": "work",
    "reopened: work in its folder after a supervisor message": "work",
    "reopened: its session is busy": "busy",
    "reopened: a PR it made is open": "sweep",
    "reopened: a report after a supervisor message": "report",
};

/**
 * The kind of a reopen event, from its key and text as `desk.ts` writes them. Rework (`R2_REWORK_KINDS`): `checks` (a
 * PR of the thread is conflicting or failing), `work` (new work in its session, or work in its folder after a
 * supervisor message), `busy` (its session ran again after the close). Not rework: `watch` (key `reopened:watch:`, a
 * watch that verifies the work), `ask` (key `reopened:reopen:`, a plan ask reopened, or key `ask:` with the text of an
 * ask that reopened the thread), `attached` (a PR attached by an actor), `sweep` (the sweep found a PR it made),
 * `report` (a report after a supervisor message; `reopenKindsOf` makes it `work` when the session worked after the
 * close), and `other` (any other text: an unknown text is not rework).
 */
function reopenKind(event) {
    const key = String(event.key);
    const text = String(event.text ?? "").trim();

    if (key.startsWith("reopened:watch:")) {
        return "watch";
    }

    if (key.startsWith("reopened:reopen:") || isAskReopen(event)) {
        return "ask";
    }

    if (/^reopened: \S+ is (conflicting|failing)$/.test(text)) {
        return "checks";
    }

    if (REOPEN_TEXTS[text] !== undefined) {
        return REOPEN_TEXTS[text];
    }

    if (/^reopened: \S+ attached by /.test(text)) {
        return "attached";
    }

    return "other";
}

/**
 * An ask that reopened a closed thread (`addAsk` in `desk.ts`): key `ask:<id>:<time>`, text `ask <id>[ from <name>]
 * reopened the thread: <text>`. An ordinary ask (`ask <id>[ from <name>]: <text>`) is no reopening.
 */
const isAskReopen = (event) =>
    String(event.key).startsWith("ask:") &&
    /^ask \S+(?: from [^:]*)? reopened the thread: /.test(String(event.text ?? ""));

/** An event that reopens a closed thread: a `reopened` key, or an ask that reopened it. */
const isReopen = (event) => String(event.key).startsWith("reopened") || isAskReopen(event);

/**
 * Whether the session did work in the interval (`from`, `to`]: an `edit` or `write` call of the session itself
 * (`editTimes`, null when unknown), a worker spawn (not a cross-review) of the session, or a send to a worker it spawned
 * before (`sendTimes`, see `workerSendTimes`).
 */
const workedBetween = (evidence, from, to) =>
    [...(evidence.editTimes ?? []), ...evidence.spawnTimes, ...(evidence.sendTimes ?? [])].some(
        (at) => at > from && at <= to,
    );

/** An event that closes a done thread in `desk.ts`: the sweep's `closed:<now>`, or a passed watch's `watch:pass:<key>`. */
const isDoneClose = (event) =>
    String(event.key).startsWith("closed:") || String(event.key).startsWith("watch:pass:");

/**
 * The times of a session's `subagent` sends to a worker: a send counts when the latest spawn of the same name in the
 * session, before it, is no cross-review spawn. A send with no earlier spawn of its name does not count. `calls` are
 * Q1's review calls (`loadReviewCalls`: every spawn and send, in order).
 */
function workerSendTimes(calls, session) {
    const lastSpawn = new Map();
    const times = [];
    const own = calls
        .filter((call) => call.c === session && typeof call.at === "number")
        .sort((a, b) => a.at - b.at);

    for (const call of own) {
        if (call.action === "spawn") {
            lastSpawn.set(call.name, call);
        } else if (call.action === "send") {
            const spawned = lastSpawn.get(call.name);

            if (spawned !== undefined && !isCrossReviewSpawn(spawned)) {
                times.push(call.at);
            }
        }
    }

    return times;
}

/**
 * The kinds of the reopenings of a thread, each kind once: `rework` and `notRework`. A `report` reopening is `work`
 * when the session worked (`evidence`, see `workedBetween`) after the latest close of the done thread before it
 * (`isDoneClose`): the desk names the report first, even when the worker also changed files. With no such close event,
 * or no evidence, it stays `report`.
 */
function reopenKindsOf(
    data,
    thread,
    evidence = { editTimes: null, spawnTimes: [], sendTimes: [] },
) {
    const events = eventsByThread(data).get(thread.id) ?? [];
    const kinds = new Set(
        events.filter(isReopen).map((event) => {
            const kind = reopenKind(event);

            if (kind !== "report") {
                return kind;
            }

            const close = events
                .filter((other) => isDoneClose(other) && other.at < event.at)
                .reduce(
                    (latest, other) =>
                        latest === undefined || other.at > latest.at ? other : latest,
                    undefined,
                );

            return close !== undefined && workedBetween(evidence, close.at, event.at)
                ? "work"
                : kind;
        }),
    );

    return {
        rework: [...kinds].filter((kind) => R2_REWORK_KINDS.includes(kind)),
        notRework: [...kinds].filter((kind) => !R2_REWORK_KINDS.includes(kind)),
    };
}

/**
 * How a routed thread ended for R2: `open`, `accepted`, `notAccepted`, `pending` or `unknown` (see `checkR2`),
 * whether a merge time came from the close, and for `notAccepted` the first reason found (`why`, 1 of `R2_WHY`) and,
 * for `reopened`, the rework kinds of its reopenings (`reopenedBy`). Only a rework reopening counts.
 */
function r2Outcome(data, thread, refs, prs, reverts, ctx, evidence) {
    const closed = thread.closed;
    const window = R2_THRESHOLDS.windowDays * DAY;

    if (closed === undefined) {
        return { outcome: "open" };
    }

    if (
        closed.why === "dropped" ||
        closed.why === "failed" ||
        closed.outcome === "abandoned" ||
        closed.outcome === "frozen"
    ) {
        return { outcome: "notAccepted", why: "dropped" };
    }

    if (
        closed.why !== "done" ||
        !(
            closed.outcome === undefined ||
            closed.outcome === "completed" ||
            closed.outcome === "verified"
        )
    ) {
        return { outcome: "unknown" };
    }

    // Only a rework reopening counts: an attach, a watch, a sweep, a report or a plan ask reopening is bookkeeping.
    const { rework } = reopenKindsOf(data, thread, evidence);

    if (rework.length > 0) {
        return { outcome: "notAccepted", why: "reopened", reopenedBy: rework };
    }

    let unknown = false;
    let fromClose = false;
    const merges = [];
    const mergedRefs = [];

    for (const ref of refs) {
        const desk = thread.prs[ref]?.state;
        const record = prs.get(ref);
        const state =
            desk === "MERGED" || desk === "CLOSED"
                ? desk
                : record?.state === "merged"
                  ? "MERGED"
                  : record?.state === "closed"
                    ? "CLOSED"
                    : undefined;

        if (state === "CLOSED") {
            return { outcome: "notAccepted", why: "closedPr" };
        }

        if (state !== "MERGED") {
            // OPEN on a thread closed as done, MISSING, FROZEN, or no state at all.
            unknown = true;
            continue;
        }

        let at = record?.state === "merged" ? msOf(record.at) : null;

        at ??= msOf(data.github?.prs?.[ref]?.mergedAt);

        if (at === null) {
            // A thread closes after its PRs merge: its close is a safe late bound.
            at = closed.at;
            fromClose = true;
        }

        merges.push(at);
        mergedRefs.push(ref);
    }

    // The window ends 14 days after the LAST merge of the thread (its close with no merge time). A revert of any merged
    // PR of the thread at or before that end, or at a time not known, makes it not accepted; a later revert does not count.
    const end = (merges.length > 0 ? Math.max(...merges) : closed.at) + window;
    // Only a PR known to be merged: an unknown PR state stays unknown, even when a stored revert names it.
    const reverted = mergedRefs.some((ref) =>
        (reverts.get(ref) ?? []).some((revert) => {
            const revertAt = msOf(revert.at);

            return revertAt === null || revertAt <= end;
        }),
    );

    if (reverted) {
        return { outcome: "notAccepted", why: "reverted", fromClose };
    }

    if (unknown) {
        return { outcome: "unknown", fromClose };
    }

    return { outcome: ctx.now < end ? "pending" : "accepted", fromClose };
}

/**
 * R2's reverts: Q1's (`revertsOf`), and also each explicit `reverts` target of a merged revert PR that has no record
 * of its own. R2 can know from the desk link alone that such a target merged. A title revert still needs the record,
 * for its title. Q1 does not use this: its output does not change.
 */
function r2Reverts(prs) {
    const reverted = revertsOf(prs);

    for (const revert of prs) {
        if (revert.state !== "merged" || !Array.isArray(revert.reverts)) {
            continue;
        }

        for (const ref of revert.reverts) {
            const list = reverted.get(ref) ?? [];

            if (ref !== revert.ref && !list.includes(revert)) {
                reverted.set(ref, [...list, revert]);
            }
        }
    }

    return reverted;
}

/** The R2 numbers of some thread records: 1 row without its keys, or the totals. */
function r2Numbers(list) {
    const count = (outcome) => list.filter((item) => item.outcome === outcome).length;
    const accepted = count("accepted");
    const notAccepted = count("notAccepted");
    const decided = accepted + notAccepted;
    const decidedCost = list
        .filter(
            (item) =>
                (item.outcome === "accepted" || item.outcome === "notAccepted") &&
                item.cost !== null,
        )
        .reduce((sum, item) => sum + item.cost, 0);
    const rounds = list.map((item) => item.rounds).filter((value) => value !== null);
    const blockers = list.map((item) => item.blockers).filter((value) => value !== null);
    const known = list.filter((item) => item.edits !== null);
    const workers = {};
    const thinking = {};
    const notAcceptedWhy = Object.fromEntries(R2_WHY.map((why) => [why, 0]));
    const reopenedBy = {};
    const reopenedNotRework = {};

    for (const item of list) {
        item.models.forEach((model) => bump(workers, model));
        item.thinking.forEach((level) => bump(thinking, level));

        if (item.why !== undefined) {
            notAcceptedWhy[item.why] += 1;
        }

        item.reopenedBy.forEach((kind) => bump(reopenedBy, kind));
        item.reopenedNotRework.forEach((kind) => bump(reopenedNotRework, kind));
    }

    return {
        count: list.length,
        open: count("open"),
        accepted,
        notAccepted,
        notAcceptedWhy,
        reopenedBy,
        reopenedNotRework,
        pending: count("pending"),
        unknown: count("unknown"),
        decided,
        acceptedRate:
            decided >= R2_THRESHOLDS.minDecided
                ? Math.round((accepted / decided) * 100) / 100
                : null,
        costPerAccepted: accepted === 0 ? null : dollars(decidedCost / accepted),
        medianRounds: rounds.length === 0 ? null : median(rounds),
        blockers: blockers.length === 0 ? null : blockers.reduce((sum, value) => sum + value, 0),
        handFixRate:
            known.length === 0
                ? null
                : Math.round((known.filter((item) => item.edits > 0).length / known.length) * 100) /
                  100,
        handFixKnown: known.length,
        deviations: list.filter((item) => item.deviation).length,
        closeAsMergeTime: list.filter((item) => item.fromClose).length,
        eligible: list.filter((item) => item.eligible).length,
        workers,
        thinking,
    };
}

/**
 * R2: every routed desk thread (any delegation with a `route`), end to end, by the arm it was ASSIGNED (intent to
 * treat): per (tier rule, predicted tier, arm, assigned worker), how many threads were accepted, at what cost, with how
 * many review rounds and parent hand fixes, and whether the worker that ran matched the assigned one. It makes no
 * finding.
 *
 * Accepted: closed as done (`completed`, `verified`, or no outcome), no rework reopening (`R2_REWORK_KINDS`), every
 * PR merged, and no revert of any of its PRs (Q1's revert detection, and an explicit
 * revert of a PR with no record of its own) within 14 days of the thread's last merge; it is `pending` until then (14
 * days after the close, with no PR). A PR state comes from the desk link, else from Q1's stored day records; an
 * unknown one makes the thread `unknown`. `notAcceptedWhy` counts each not accepted thread in its first reason
 * (`R2_WHY`), and `reopenedBy` the rework kinds of the `reopened` ones (`reopenKind`; a thread counts each kind once),
 * and `reopenedNotRework` the other kinds of every thread's reopenings. Rounds and blocking points come from Q1's `prRounds` and `blockers` (the last 30 days only), hand fixes from
 * `parentEdits`: each is null (unknown) when its source is missing, and rounds and blocking points are null for a
 * thread with no PR. No GitHub call: Q1's stored records only.
 *
 * `eligible` is the share of routed night shifts a routed worker could take: no named worker, a Jev kind of
 * `R2_KINDS`, a bench repository, and a route that says no risk path is named (`riskPathNamed: false`; `null` or no
 * `features` is unknown, not eligible).
 */
export function checkR2(data, ctx) {
    const prRecords = r2Records(ctx);
    const reverts = r2Reverts([...prRecords.values()]);
    const q1 = ctx.results?.Q1?.metrics;
    const roundsByRef =
        q1?.prRounds?.available === true && Array.isArray(q1.prRounds.prs)
            ? new Map(q1.prRounds.prs.map((row) => [row.ref, row.rounds]))
            : null;
    const points =
        q1?.blockers?.available === true && Array.isArray(q1.blockers.points)
            ? q1.blockers.points
            : null;
    const editsSource = !data.sourceErrors?.parentEdits && Array.isArray(data.parentEdits);
    const editsOf = new Map(editsSource ? data.parentEdits.map((row) => [row.c, row.edits]) : []);
    const callsBySession = new Map();

    for (const call of data.reviewCalls ?? []) {
        if (!callsBySession.has(call.c)) {
            callsBySession.set(call.c, []);
        }

        callsBySession.get(call.c).push(call);
    }

    const editTimesOf = new Map(
        editsSource
            ? data.parentEdits
                  .filter((row) => Array.isArray(row.editTimes))
                  .map((row) => [row.c, row.editTimes])
            : [],
    );
    const groups = new Map();
    const items = [];
    const eligible = { nightShifts: 0, eligible: 0, share: null };

    for (const thread of Object.values(data.threads ?? {})) {
        const route = thread.route;

        if (!route || typeof route !== "object") {
            continue;
        }

        const keys = {
            tierRule: nonEmpty(route.tierRule) ? route.tierRule : "-",
            tier: nonEmpty(route.tier) ? route.tier : "-",
            arm: nonEmpty(route.arm) ? route.arm : "-",
            assigned: nonEmpty(route.assigned)
                ? route.assigned
                : nonEmpty(route.worker)
                  ? route.worker
                  : "-",
        };
        const goal = goalOfThread(data, thread);
        const nightShift = goal !== undefined;
        const kind = nonEmpty(route.kind) ? route.kind : route.features?.kind;
        const isEligible =
            nightShift &&
            !nonEmpty(route.worker) &&
            R2_KINDS.includes(kind) &&
            R2_BENCH_REPOS.includes(thread.repo) &&
            // `null` (no risk-path list could be read) and no `features` (an older route) are unknown: not eligible.
            route.features?.riskPathNamed === false;

        if (nightShift) {
            eligible.nightShifts += 1;
            eligible.eligible += isEligible ? 1 : 0;
        }

        // The workers that ran: spawns that are not a cross-review. No model: the parent's model.
        const spawns = (data.routeSpawns ?? []).filter(
            (spawn) => spawn.c === thread.session && !isCrossReviewSpawn(spawn),
        );
        const parent = nonEmpty(route.profileModel) ? route.profileModel : "(parent)";
        const modelOf = (spawn) => (nonEmpty(spawn.model) ? spawn.model : parent);
        const assignedThinking = nonEmpty(route.assignedThinking)
            ? route.assignedThinking
            : nonEmpty(goal?.workerThinking)
              ? goal.workerThinking
              : null;
        const deviation =
            keys.assigned !== "-" &&
            spawns.some(
                (spawn) =>
                    modelOf(spawn) !== keys.assigned ||
                    (assignedThinking !== null &&
                        typeof spawn.thinking === "string" &&
                        spawn.thinking !== assignedThinking),
            );
        const refs = Object.entries(thread.prs ?? {})
            .filter(([, link]) => link?.via !== "window")
            .map(([ref]) => ref);
        const costRows = (data.routeCosts ?? []).filter((row) => row.c === thread.session);
        // The evidence of work after a close, for a `report` reopening: the session's own edits (unknown without the
        // `parentEdits` source), its worker spawns, and its sends to a worker (none without the `reviews` source).
        const evidence = {
            sendTimes:
                thread.session === undefined || data.sourceErrors?.reviews
                    ? []
                    : workerSendTimes(callsBySession.get(thread.session) ?? [], thread.session),
            editTimes:
                thread.session === undefined ? null : (editTimesOf.get(thread.session) ?? null),
            spawnTimes:
                thread.session === undefined
                    ? []
                    : spawns.map((spawn) => spawn.at).filter((at) => typeof at === "number"),
        };
        const {
            outcome,
            fromClose = false,
            why,
            reopenedBy = [],
        } = r2Outcome(data, thread, refs, prRecords, reverts, ctx, evidence);
        const item = {
            outcome,
            fromClose,
            why,
            reopenedBy,
            reopenedNotRework: reopenKindsOf(data, thread, evidence).notRework,
            nightShift,
            eligible: isEligible,
            deviation,
            models: [...new Set(spawns.map(modelOf))],
            thinking: [
                ...new Set(
                    spawns.map((spawn) =>
                        typeof spawn.thinking === "string" ? spawn.thinking : "-",
                    ),
                ),
            ],
            cost: costRows.length === 0 ? null : costRows.reduce((sum, row) => sum + row.cost, 0),
            // A thread with no PR has no rounds and no blocking points: unknown, not 0.
            rounds:
                roundsByRef === null || refs.length === 0
                    ? null
                    : refs.reduce((sum, ref) => sum + (roundsByRef.get(ref) ?? 0), 0),
            blockers:
                points === null || refs.length === 0
                    ? null
                    : points.filter((point) => refs.includes(point.ref)).length,
            edits: editsOf.has(thread.session) ? editsOf.get(thread.session) : null,
        };
        const key = [keys.tierRule, keys.tier, keys.arm, keys.assigned].join("\u0000");

        if (!groups.has(key)) {
            groups.set(key, { keys, list: [] });
        }

        groups.get(key).list.push(item);
        items.push(item);
    }

    eligible.share =
        eligible.nightShifts === 0
            ? null
            : Math.round((eligible.eligible / eligible.nightShifts) * 100) / 100;

    const rows = [...groups.values()]
        .map(({ keys, list }) => ({ ...keys, ...r2Numbers(list) }))
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.tierRule.localeCompare(b.tierRule) ||
                a.tier.localeCompare(b.tier) ||
                a.arm.localeCompare(b.arm) ||
                a.assigned.localeCompare(b.assigned),
        );

    return {
        findings: [],
        metrics: {
            routes: items.length,
            sources: { q1: ctx.results?.Q1 !== undefined, parentEdits: editsSource },
            windowDays: R2_THRESHOLDS.windowDays,
            rows,
            eligible,
            totals: r2Numbers(items),
        },
    };
}

// ---------- P. Planning sessions ----------

/**
 * The 6 refusal texts of the `plan` tool that the fixes of pi-pocket-team#119 target (its metric M1). Each one
 * names the refusal in `desk.ts` at 7ed9ab5.
 */
export const PLAN_TARGETED = [
    "belong to the desk",
    "is not a repository of",
    "read it: this session holds no",
    "may run at once",
    "tasks needs rev",
    "no draft graph for rev",
];

/** `part / whole`, 3 places; null when `whole` is 0. */
const rateOf = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000);

/** The P1 numbers of some `plan` results and source reads. */
function planNumbers(results, sourceReads) {
    const refusals = results.filter((result) => result.isError);
    const targetedBy = Object.fromEntries(PLAN_TARGETED.map((text) => [text, 0]));
    let targeted = 0;

    for (const refusal of refusals) {
        const text = PLAN_TARGETED.find((each) => refusal.text.includes(each));

        if (text !== undefined) {
            targeted += 1;
            targetedBy[text] += 1;
        }
    }

    return {
        calls: results.length,
        refused: refusals.length,
        rate: rateOf(refusals.length, results.length),
        targeted,
        targetedBy,
        sourceReads: sourceReads.length,
    };
}

/**
 * P1: plan tool friction (pi-pocket-team#119, metrics M1 to M3). For each planning session (the session of a desk
 * thread with `origin: "plan"`) with a `plan` call or a source read in the window: the `plan` calls, the refused
 * ones, the rate (null at 0 calls), the refusals with 1 of the 6 targeted texts, and the tool calls that name
 * `desk.ts` or `pi-pocket/src`; then the sum. A session that read the source is 1 low finding. The rate makes no
 * finding: the hypothesis review reads the numbers.
 */
export function checkP1(data, ctx) {
    const inWindow = windowOf(ctx);
    const findings = [];
    const sessions = [];
    const all = { results: [], sourceReads: [] };

    for (const item of data.planSessions) {
        const results = item.results.filter((result) => inWindow(result.at));
        const sourceReads = item.sourceReads.filter((read) => inWindow(read.at));

        if (results.length === 0 && sourceReads.length === 0) {
            continue;
        }

        all.results.push(...results);
        all.sourceReads.push(...sourceReads);
        sessions.push({
            thread: item.thread,
            session: item.session,
            agent: agentName(data, item.session),
            ...planNumbers(results, sourceReads),
        });

        if (sourceReads.length > 0) {
            findings.push(
                makeFinding({
                    check: "P1",
                    subject: item.thread,
                    severity: "low",
                    text: `${item.thread} (${agentName(data, item.session)}): its planning session read the source ${sourceReads.length} ${sourceReads.length === 1 ? "time" : "times"} (desk.ts or pi-pocket/src)`,
                    evidence: [
                        `desk/${item.thread}.md`,
                        ...sourceReads.map(
                            (read) => `${iso(read.at)} ${read.tool}, entry ${read.id}`,
                        ),
                    ],
                    lastSeen: Math.max(...sourceReads.map((read) => read.at)),
                    cases: sourceReads.length,
                }),
            );
        }
    }

    return {
        findings,
        metrics: {
            sessions,
            total: {
                sessions: sessions.length,
                ...planNumbers(all.results, all.sourceReads),
            },
        },
    };
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
    ["P1", checkP1, ["desk", "planSessions"]],
    ["Q1", checkQ1, ["desk"]],
    // R2 reads Q1's result (`ctx.results.Q1`): it runs after it.
    ["R2", checkR2, ["desk", "routes"]],
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
