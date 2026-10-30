// The Desk page: Brian's inbox for the work the team runs in the background. Phone first, one column. Everything here
// is owner-only: the page, its routes, and the rail badge.

export const pocketApi = 1;

const LISTENERS = new Set();
let view = null;
let loadError = null;
/** Brian's last look, from the first GET, before the page posts `seen`: the "new" marks use it. */
let seenBefore = null;
let rail = null;
/** The running module's `pocket`: the shared loader is called from effects and events too. */
let app = null;

/** The groups of the page, in the order it shows them. */
/** `plans` holds plan threads with no open ask: the Plans section shows them, so no thread section does. */
const GROUPS = [
    "closed",
    "parked",
    "need",
    "plans",
    "watching",
    "found",
    "stale",
    "review",
    "working",
];

/**
 * The section a thread goes in. First match: closed with no open ask, parked, an open ask (it needs Brian, and neither
 * a watch nor a found origin hides it, nor does a close: an ask filed on a thread that closed in the same step still
 * shows), a plan thread (the Plans section shows it), asleep, found, Brian, stale, the reviewer.
 */
export const groupOf = (thread) => {
    if (thread.state === "closed") {
        return (thread.asks ?? []).length > 0 ? "need" : "closed";
    }

    if (thread.state === "parked") {
        return "parked";
    }

    if ((thread.asks ?? []).length > 0) {
        return "need";
    }

    if (thread.origin === "plan") {
        return "plans";
    }

    if (thread.asleep) {
        return "watching";
    }

    if (thread.origin === "found") {
        return "found";
    }

    if (thread.next === "brian") {
        return "need";
    }

    if (thread.stale) {
        return "stale";
    }

    if (thread.next === "reviewer") {
        return "review";
    }

    return "working";
};

/** Whether a view is still on the page: an answer that comes after it left changes nothing. */
export const stillMounted = (life) => life?.gone !== true;

/** The body of a page answer: the words, and the generation of a plan ask, which the desk checks. */
export const answerBody = (words, gen) => (typeof gen === "number" ? { words, gen } : { words });

/** A plan row's second line: its state with its asks and lead, or its approval. */
export const planRowLine = (plan) => {
    if (plan === undefined || plan === null) {
        return "";
    }

    if (plan.state === "review") {
        return `review · Approve ${String(plan.rev ?? "").slice(0, 7)}`;
    }

    const asks = plan.asks ?? 0;

    return `${plan.state} · ${asks} ask${asks === 1 ? "" : "s"} · lead ${plan.lead}`;
};

/** A plan view's state line: `drafting · rev 3f2a9c1 · lead lucilla · graph v2: 4 tasks`. */
export const planStateLine = (plan) => {
    const graph = plan.graph;
    const tasks = graph === undefined ? 0 : graph.tasks.length;

    return [
        plan.state,
        `rev ${String(plan.rev ?? "").slice(0, 7)}`,
        `lead ${plan.lead}`,
        graph === undefined
            ? "no graph"
            : `graph v${graph.version}: ${tasks} task${tasks === 1 ? "" : "s"}`,
    ].join(" · ");
};

/** The approve button's words: `Approve 3f2a9c1 + graph v2`. */
export const approveLabel = (plan) =>
    `Approve ${String(plan.rev ?? "").slice(0, 7)} + graph v${plan.graph?.version ?? 1}`;

/** 1 ask of a plan section, as the view lists it: its words, its answer, and whether the write came back. */
export const planAskLine = (ask) => {
    if (ask.open) {
        return `${ask.id}: ${ask.text} · open`;
    }

    // The desk ended it: Brian need not answer it, and no write-back waits.
    if (ask.resolved !== undefined) {
        const how = ask.resolved.by === undefined ? "resolved" : "withdrawn";

        return `${ask.id}: ${ask.text} · ${how}: ${ask.resolved.why}`;
    }

    const answer = ask.answer === undefined ? "" : ` → ${ask.answer.words} (${ask.answer.by})`;

    return `${ask.id}: ${ask.text}${answer}${ask.written ? "" : " · not written"}`;
};

/**
 * The rail badge: the threads that need Brian, and the PRs ready to merge. A thread that is not parked counts when it
 * has an open ask, also when it is asleep or closed; else it counts when it is not closed or asleep and it needs Brian or
 * is stale. Each PR in `ready` counts 1, so a thread that counts only because it needs Brian does not count again when it
 * holds 1 of those PRs: the same PR may be on 2 threads, and `ready` has 1 row for it. A missing `ready` is no PR: an
 * older view works as before.
 */
export const badgeOf = (next) => {
    if (next === null || next === undefined) {
        return 0;
    }

    const ready = next.ready ?? [];
    const refs = new Set(ready.map((pr) => pr.ref.toLowerCase()));

    /** Whether the thread holds 1 of the PRs in `ready`: that PR counts, so the thread does not count. */
    const holds = (thread) =>
        (thread.prs ?? []).some(
            (pr) =>
                pr.ready === true && pr.state === "OPEN" && refs.has(String(pr.ref).toLowerCase()),
        );

    return (
        ready.length +
        next.threads.filter((thread) => {
            if (thread.state === "parked") {
                return false;
            }

            if ((thread.asks ?? []).length > 0) {
                return true;
            }

            const needsBrian = thread.next === "brian";

            // Its PR is a row of Ready to merge: the PR counts, and the thread does not count again.
            if (needsBrian && !thread.stale && holds(thread)) {
                return false;
            }

            return thread.state !== "closed" && !thread.asleep && (needsBrian || thread.stale);
        }).length
    );
};

const publish = (next) => {
    view = next;
    loadError = null;

    if (rail !== null) {
        rail.update({ badge: badgeOf(next) || null });
    }

    for (const listener of LISTENERS) {
        listener();
    }
};

const load = async () => {
    try {
        const next = await app.api("threads");

        if (seenBefore === null) {
            seenBefore = next.seen ?? 0;
        }

        publish(next);

        return next;
    } catch (failure) {
        loadError = failure.message;

        for (const listener of LISTENERS) {
            listener();
        }

        return null;
    }
};

/**
 * The queue's read status, for the page: its words, and whether it is a warning. A queue that is turned off is a short
 * muted line, not a failure. Null when a good read has nothing to say.
 */
export const queueStatus = (queue, clock) => {
    if (queue === null || queue === undefined) {
        return null;
    }

    if (queue.off) {
        return { text: "queue read is off", warn: false };
    }

    if (!queue.ok) {
        return {
            text: `queue read failed at ${clock(queue.at)}${queue.error ? `: ${queue.error}` : ""}`,
            warn: true,
        };
    }

    return (queue.incomplete ?? []).length > 0
        ? { text: `queue read incomplete: ${queue.incomplete.join(", ")}`, warn: true }
        : null;
};

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    app = pocket;
    pocket.style("desk.css");

    const time = (at) => new Date(at).toLocaleString();

    /** A clock time, as the queue's "read 19:02" shows it. */
    const clock = (at) =>
        new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    /** How long ago, in 1 short word group: "5 h ago". */
    const ago = (at) => {
        const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));

        if (minutes < 60) {
            return `${minutes} min ago`;
        }

        return minutes < 2880
            ? `${Math.round(minutes / 60)} h ago`
            : `${Math.round(minutes / 1440)} d ago`;
    };

    /** A GitHub link that is safe to open: http(s) only. */
    const webUrl = (url) => (/^https?:\/\/\S+$/.test(url ?? "") ? url : undefined);

    /** A watch's date as people read it: "2026-10-26", or "2026-10-26 09:00" when it has a time. */
    const watchWhen = (watch) =>
        watch.checkTime ? `${watch.checkOn} ${watch.checkTime}` : watch.checkOn;

    /** One line about a thread's watch, for the detail view. */
    const watchLine = (watch) =>
        [
            watchWhen(watch),
            watch.check,
            `set by ${watch.setBy}`,
            watch.due ? "due" : "",
            watch.result
                ? `${watch.result.pass ? "passed" : "failed"} by ${watch.result.by}: ${watch.result.text}`
                : "",
        ]
            .filter(Boolean)
            .join(" · ");

    /**
     * 1 plan: its sections with their asks, its graph, and Brian's approval. The approve key is made once, when the view
     * opens, so a second tap sends the same key and the desk acts once.
     */
    function PlanDetail({ id, onBack, onChanged }) {
        const [plan, setPlan] = useState(null);
        const [dropping, setDropping] = useState(false);
        const [why, setWhy] = useState("");
        const [error, setError] = useState("");
        const [busy, setBusy] = useState(false);
        const newKey = () =>
            `approve-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
        const [key, setKey] = useState(newKey);
        // The view's life: an answer that comes after Brian went back changes nothing, and closes no other page.
        const [life] = useState(() => ({ gone: false }));

        const openPlan = async () => {
            const answer = await pocket.api(`plans/${id}`);

            setPlan(answer);

            return answer;
        };

        useEffect(() => {
            const abort = new AbortController();

            pocket
                .api(`plans/${id}`, undefined, { signal: abort.signal })
                .then(setPlan, (failure) => {
                    if (!abort.signal.aborted) {
                        setError(failure.message);
                    }
                });

            return () => {
                abort.abort();
                life.gone = true;
            };
        }, [id]);

        const approve = async () => {
            setBusy(true);
            setError("");

            try {
                await pocket.api(`plans/${id}/approve`, {
                    rev: plan.rev,
                    graph: plan.graph?.version,
                    key,
                });

                if (!stillMounted(life)) {
                    return;
                }

                // The approval is done: a later approval of another revision is a new tap, with a new key.
                setKey(newKey());
                await onChanged();
            } catch (failure) {
                if (stillMounted(life)) {
                    setError(failure.message);
                }
            } finally {
                // The plan may have moved, and the desk's news may wait in the next view: load it again either way.
                if (stillMounted(life)) {
                    try {
                        await openPlan();
                    } catch {
                        // The error above stays, and the view that is there stays too.
                    }
                }

                if (stillMounted(life)) {
                    setBusy(false);
                }
            }
        };

        /** Drop the plan: the desk refuses it while an ask is open, and says so. */
        const drop = async () => {
            setBusy(true);
            setError("");

            try {
                await pocket.api(`threads/${id}/drop`, { reason: why.trim() });

                // Brian went back while the drop ran: the page he is on now must not close.
                if (!stillMounted(life)) {
                    return;
                }

                await onChanged();

                if (!stillMounted(life)) {
                    return;
                }

                onBack();
            } catch (failure) {
                if (stillMounted(life)) {
                    setError(failure.message);
                    setBusy(false);
                }
            }
        };

        return html`<div class="desk">
            <div class="desk-bar">
                <button class="button" aria-label="Back to the desk" onClick=${onBack}>Back</button>
                <span class="desk-id">${id}</span>
                ${
                    plan !== null && plan.session !== undefined
                        ? html`<button
                              class="button"
                              aria-label="Chat in the planning session"
                              onClick=${() => pocket.openConversation(plan.session)}
                          >
                              Chat
                          </button>`
                        : null
                }
            </div>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${
                plan === null
                    ? html`<${Loader} label="Opening the plan" />`
                    : html`<article class="desk-thread">
                          <h2>${plan.title}</h2>
                          <p class="small muted">${planStateLine(plan)}</p>
                          ${
                              plan.waiting.length > 0
                                  ? html`<p class="small">
                                        Waiting: ${plan.waiting.join(" · ")}
                                    </p>`
                                  : html`<p class="small muted">Settled.</p>`
                          }
                          ${
                              plan.preamble === undefined || plan.preamble === ""
                                  ? null
                                  : html`<pre class="desk-plan-text">${plan.preamble}</pre>`
                          }
                          ${plan.sections.map(
                              (section) => html`<details class="desk-plan-section">
                                  <summary>
                                      ${section.heading}
                                      ${
                                          section.asks.length === 0
                                              ? null
                                              : html`<span class="desk-count">${section.asks.length}</span>`
                                      }
                                  </summary>
                                  <pre class="desk-plan-text">${section.text}</pre>
                                  ${section.asks.map(
                                      (ask) => html`<div class="desk-plan-ask">
                                          <div class="small">${planAskLine(ask)}</div>
                                          ${
                                              (ask.options ?? []).length === 0
                                                  ? null
                                                  : html`<div class="small muted">
                                                        ${ask.options.join(" | ")}
                                                    </div>`
                                          }
                                      </div>`,
                                  )}
                              </details>`,
                          )}
                          ${
                              plan.graph === undefined
                                  ? null
                                  : html`<details class="desk-plan-section">
                                        <summary>
                                            ${`Task states (graph v${plan.graph.version}: ${plan.graph.tasks.length} task${plan.graph.tasks.length === 1 ? "" : "s"})`}
                                        </summary>
                                        <ul class="desk-list">
                                            ${plan.graph.tasks.map(
                                                (task) => html`<li>
                                                    <span class="desk-id">${task.id}</span> ${task.title}
                                                    <div class="small muted">
                                                        ${[
                                                            task.agent,
                                                            task.repo,
                                                            task.state,
                                                            `deps: ${(task.deps ?? []).join(", ") || "none"}`,
                                                        ]
                                                            .filter(Boolean)
                                                            .join(" · ")}
                                                    </div>
                                                </li>`,
                                            )}
                                        </ul>
                                    </details>`
                          }
                          ${
                              plan.state === "review" && plan.canApprove
                                  ? html`<div class="desk-plan-bar">
                                        <button
                                            class="button primary"
                                            disabled=${busy}
                                            aria-label=${approveLabel(plan)}
                                            onClick=${() => void approve()}
                                        >
                                            ${approveLabel(plan)}
                                        </button>
                                    </div>`
                                  : plan.approveOff
                                    ? html`<div class="desk-plan-bar">
                                          <span class="small muted">${plan.approveOff}</span>
                                      </div>`
                                    : null
                          }
                          ${
                              plan.state === "done" || plan.state === "dropped"
                                  ? null
                                  : dropping
                                    ? html`<div class="desk-drop">
                                          <input
                                              class="desk-reason"
                                              type="text"
                                              placeholder="Why drop this plan?"
                                              value=${why}
                                              maxlength="200"
                                              aria-label="Why drop this plan"
                                              onInput=${(event) => setWhy(event.currentTarget.value)}
                                          />
                                          <div class="desk-actions">
                                              <button
                                                  class="button"
                                                  disabled=${busy || why.trim() === ""}
                                                  onClick=${() => void drop()}
                                              >
                                                  Drop the plan
                                              </button>
                                              <button class="button" onClick=${() => setDropping(false)}>
                                                  Cancel
                                              </button>
                                          </div>
                                      </div>`
                                    : html`<div class="desk-actions">
                                          <button class="button" onClick=${() => setDropping(true)}>
                                              Drop
                                          </button>
                                      </div>`
                          }
                      </article>`
            }
        </div>`;
    }

    function Detail({ id, onBack }) {
        const [thread, setThread] = useState(null);
        const [reports, setReports] = useState([]);
        const [error, setError] = useState("");

        useEffect(() => {
            const abort = new AbortController();

            pocket.api(`threads/${id}`, undefined, { signal: abort.signal }).then(
                (answer) => {
                    setThread(answer.thread);
                    setReports(answer.reports);
                },
                (failure) => {
                    if (!abort.signal.aborted) {
                        setError(failure.message);
                    }
                },
            );

            return () => abort.abort();
        }, [id]);

        return html`<div class="desk">
            <div class="desk-bar">
                <button class="button" aria-label="Back to the desk" onClick=${onBack}>Back</button>
                <span class="desk-id">${id}</span>
            </div>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${
                thread === null
                    ? html`<${Loader} label="Opening the thread" />`
                    : html`<article class="desk-thread">
                          <h2>${thread.title}</h2>
                          ${
                              thread.open.length > 0
                                  ? html`<p class="small">Still open: ${thread.open.join("; ")}</p>`
                                  : null
                          }
                          <p class="small muted">
                              ${[
                                  thread.repo,
                                  thread.state,
                                  `next: ${thread.next}`,
                                  thread.asleep ? "asleep" : "",
                                  thread.stale ? "stale" : "",
                              ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </p>
                          ${thread.watch ? html`<p class="small">Watch: ${watchLine(thread.watch)}</p>` : null}
                          ${
                              (thread.issues ?? []).length > 0
                                  ? html`<p class="small">Issues: ${thread.issues.join(", ")}</p>`
                                  : null
                          }
                          <h3>PRs</h3>
                          ${
                              thread.prs.length === 0
                                  ? html`<p class="small muted">No PRs.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.prs.map(
                                            (pr) => html`<li>
                                                ${
                                                    pr.url
                                                        ? html`<a href=${pr.url} target="_blank" rel="noopener">${pr.ref}</a>`
                                                        : html`<span class="mono">${pr.ref}</span>`
                                                }
                                                <span class="small muted">
                                                    ${[
                                                        pr.state,
                                                        pr.ready ? "ready-for-human" : "",
                                                        pr.next ? `next: ${pr.next}` : "",
                                                        pr.via === "window" ? "guessed" : pr.via,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </span>
                                                ${pr.title ? html`<div class="small">${pr.title}</div>` : null}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          <h3>Asks</h3>
                          ${
                              thread.asks.length === 0
                                  ? html`<p class="small muted">No open asks.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.asks.map(
                                            (ask) => html`<li>
                                                <span class="desk-id">${ask.id}</span> ${ask.text}
                                                ${ask.from ? html`<div class="small">from ${ask.from}</div>` : null}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          ${
                              (thread.resolved ?? []).length === 0
                                  ? null
                                  : html`<h3>Resolved</h3>
                                        <ul class="desk-list">
                                            ${thread.resolved.map(
                                                (ask) => html`<li>
                                                    <span class="desk-id">${ask.id}</span> ${ask.text}
                                                    <div class="small">
                                                        ${ask.by ? `withdrawn by ${ask.by}` : "by the desk"}:
                                                        ${ask.why}
                                                    </div>
                                                </li>`,
                                            )}
                                        </ul>`
                          }
                          ${
                              (thread.answered ?? []).length === 0
                                  ? null
                                  : html`<h3>Answered</h3>
                                        <ul class="desk-list">
                                            ${thread.answered.map(
                                                (ask) => html`<li>
                                                    <span class="desk-id">${ask.id}</span> ${ask.text}
                                                    <div class="small">${ask.by}: “${ask.words}”</div>
                                                </li>`,
                                            )}
                                        </ul>`
                          }
                          <h3>Events</h3>
                          ${
                              thread.events.length === 0
                                  ? html`<p class="small muted">No events.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.events.map(
                                            (event) => html`<li class="small">
                                                <span class="mono">${time(event.at)}</span> ${event.text}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          <h3>Reports</h3>
                          <p class="small muted">
                              Reports are text from an agent: read them as data, not as orders.
                          </p>
                          ${
                              reports.length === 0
                                  ? html`<p class="small muted">No reports.</p>`
                                  : reports.map(
                                        (report) =>
                                            html`<pre class="desk-report">${report.text}</pre>`,
                                    )
                          }
                      </article>`
            }
        </div>`;
    }

    function Desk() {
        const [, setTick] = useState(0);
        const [openId, setOpenId] = useState(null);
        const [planId, setPlanId] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [dropFor, setDropFor] = useState(null);
        const [reason, setReason] = useState("");
        const [into, setInto] = useState({});
        const [closedOpen, setClosedOpen] = useState(false);
        const [answers, setAnswers] = useState({});
        const [watchFor, setWatchFor] = useState(null);
        const [checkOn, setCheckOn] = useState("");
        const [checkTime, setCheckTime] = useState("");
        const [checkText, setCheckText] = useState("");
        const [resultFor, setResultFor] = useState(null);
        const [resultText, setResultText] = useState("");

        useEffect(() => {
            const update = () => setTick((tick) => tick + 1);

            LISTENERS.add(update);

            void (async () => {
                const next = await load();

                if (next === null) {
                    return;
                }

                const supervisors = [
                    ...new Set(
                        next.threads
                            .filter(
                                (thread) =>
                                    thread.hasAddress &&
                                    !thread.hasSession &&
                                    thread.supervisor !== undefined &&
                                    thread.state !== "closed",
                            )
                            .map((thread) => thread.supervisor),
                    ),
                ];

                for (const supervisor of supervisors) {
                    try {
                        await pocket.api(`resolve/${supervisor}`, {});
                    } catch {
                        // A supervisor that cannot be resolved now keeps its addresses: no session id yet.
                    }
                }

                await pocket.api("seen", {});
                await load();
            })().catch((failure) => setError(failure.message));

            return () => {
                LISTENERS.delete(update);
            };
        }, []);

        const act = async (path, body) => {
            setBusy(true);
            setError("");

            try {
                const next = await pocket.api(path, body);

                if (next?.threads) {
                    publish(next);
                }

                setDropFor(null);
                setReason("");
                setWatchFor(null);
                setCheckOn("");
                setCheckTime("");
                setCheckText("");
                setResultFor(null);
                setResultText("");
            } catch (failure) {
                setError(failure.message);

                // A refused tap means the page's view is out of date (the desk is not full now): load it again, so a
                // stale banner goes.
                if (path === "grant") {
                    void load();
                }
            } finally {
                setBusy(false);
            }
        };

        const drop = (id) => act(`threads/${id}/drop`, { reason });

        // The date alone, or the date and the optional time, as 1 text: the desk parses it.
        const watchOn = (id) =>
            act(`threads/${id}/watch`, {
                checkOn: checkTime === "" ? checkOn : `${checkOn} ${checkTime}`,
                check: checkText.trim(),
            });

        const passCheck = (id) =>
            act(`threads/${id}/result`, { pass: true, text: "Passed on the Desk page." });

        const failCheck = (id) =>
            act(`threads/${id}/result`, { pass: false, text: resultText.trim() });

        const answer = async (id, gen) => {
            const words = (answers[id] ?? "").trim();

            // The page never sends an empty answer: the button waits for Brian's words.
            if (words !== "") {
                await act(`asks/${id}/answer`, answerBody(words, gen));
            }
        };

        /** A pick-one ask: the option itself is the answer. */
        const answerWith = async (id, words, gen) => {
            await act(`asks/${id}/answer`, answerBody(words, gen));
        };

        if (planId !== null) {
            return html`<${PlanDetail}
                id=${planId}
                onBack=${() => setPlanId(null)}
                onChanged=${load}
            />`;
        }

        if (openId !== null) {
            return html`<${Detail} id=${openId} onBack=${() => setOpenId(null)} />`;
        }

        if (view === null && loadError === null) {
            return html`<div class="desk"><${Loader} label="Reading the desk" /></div>`;
        }

        const threads = view?.threads ?? [];
        const groups = Object.fromEntries(GROUPS.map((group) => [group, []]));

        for (const thread of threads) {
            groups[groupOf(thread)].push(thread);
        }

        // The soonest check first.
        groups.watching.sort(
            (a, b) =>
                (a.watch ? watchWhen(a.watch) : "").localeCompare(
                    b.watch ? watchWhen(b.watch) : "",
                ) || a.id.localeCompare(b.id, undefined, { numeric: true }),
        );

        const others = Object.values(view?.others ?? {}).reduce((sum, count) => sum + count, 0);
        const counts = view?.counts ?? {};
        const ready = view?.ready ?? [];
        const plans = view?.plans ?? [];
        const capInfo = view?.cap ?? { counted: 0, cap: 0, full: false, grants: 0 };
        const fresh = (thread) => thread.lastEventAt > (seenBefore ?? 0);

        /** One line of a row's facts: its repository, its next actor, its check, and its age. */
        const factsOf = (thread) =>
            [
                thread.repo,
                `next: ${thread.next}`,
                thread.watch && thread.watch.due
                    ? `due: ${thread.watch.check}`
                    : thread.asleep && thread.watch
                      ? `check on ${watchWhen(thread.watch)}`
                      : "",
                thread.stale ? "stale" : "",
            ]
                .filter(Boolean)
                .join(" · ");

        /** How a closed thread ended, as a short label; an old record has no outcome, and shows nothing extra. */
        const outcomeOf = (thread) =>
            thread.state === "closed" && thread.closed?.outcome
                ? html`<span class="desk-outcome ${thread.closed.outcome}"
                      >${thread.closed.outcome}</span
                  >`
                : null;

        const row = (thread, actions) =>
            html`<li class="desk-row">
                <button
                    type="button"
                    class="desk-open"
                    aria-label=${`Open ${thread.id}: ${thread.title}`}
                    onClick=${() => setOpenId(thread.id)}
                >
                    <span class="desk-line">
                        <span class="desk-id">${thread.id}</span>
                        ${fresh(thread) ? html`<span class="desk-new">new</span>` : null}
                        <span class="desk-title">${thread.title}</span>
                        ${outcomeOf(thread)}
                    </span>
                    <span class="small muted"> ${factsOf(thread)} </span>
                    ${
                        thread.prs.length > 0
                            ? html`<span class="desk-chips">
                              ${thread.prs.map(
                                  (pr) =>
                                      html`<span class=${`desk-chip ${pr.state === "MERGED" ? "done" : ""}`}
                                          >${[
                                              pr.ref,
                                              pr.state,
                                              pr.ready ? "ready-for-human" : "",
                                              pr.next,
                                              pr.via === "window" ? "guessed" : "",
                                          ]
                                              .filter(Boolean)
                                              .join(" · ")}</span
                                      >`,
                              )}
                          </span>`
                            : null
                    }
                </button>
                ${actions}
            </li>`;

        /** One PR that Brian can merge now: its link, its head, the thread it belongs to, and its CI state. */
        const readyRow = (pr) =>
            html`<li class="desk-row">
                <span class="desk-line">
                    ${
                        pr.url
                            ? html`<a class="desk-link" href=${pr.url} target="_blank" rel="noopener"
                                  >${pr.ref}</a
                              >`
                            : html`<span class="desk-title">${pr.ref}</span>`
                    }
                    ${pr.title ? html`<span class="desk-title">${pr.title}</span>` : null}
                    ${pr.head ? html`<code class="desk-pr-head">${pr.head}</code>` : null}
                    <button
                        type="button"
                        class="desk-thread-link"
                        aria-label=${`Open ${pr.thread}`}
                        onClick=${() => setOpenId(pr.thread)}
                    >
                        ${pr.thread}
                    </button>
                </span>
                <span class="small muted">
                    ${(pr.agents ?? []).join(", ")} ·
                    ${pr.checks ? pr.checks.toLowerCase() : "no checks"}
                </span>
            </li>`;

        const dropField = (thread) =>
            dropFor === thread.id
                ? html`<div class="desk-drop">
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="Why drop it?"
                          value=${reason}
                          disabled=${busy}
                          onInput=${(event) => setReason(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || reason.trim() === ""}
                          aria-label=${`Drop ${thread.id}`}
                          onClick=${() => void drop(thread.id)}
                      >
                          Drop it
                      </button>
                  </div>`
                : null;

        const parkButton = (thread) =>
            html`<button
                class="button"
                disabled=${busy}
                aria-label=${`Park ${thread.id}`}
                onClick=${() => void act(`threads/${thread.id}/park`, {})}
            >
                Park
            </button>`;

        const dropButton = (thread) =>
            html`<button
                class="button"
                disabled=${busy}
                aria-label=${`Drop ${thread.id}`}
                onClick=${() => setDropFor(dropFor === thread.id ? null : thread.id)}
            >
                Drop
            </button>`;

        const parkActions = (thread) =>
            html`<div class="desk-actions">${parkButton(thread)} ${dropButton(thread)}</div>
            ${dropField(thread)}`;

        const staleActions = (thread) =>
            html`<div class="desk-actions">
                <button
                    class="button"
                    disabled=${busy}
                    aria-label=${`Keep ${thread.id}`}
                    onClick=${() => void act(`threads/${thread.id}/keep`, {})}
                >
                    Keep
                </button>
                ${parkButton(thread)} ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;

        const parkedActions = (thread) =>
            html`<div class="desk-actions">
                <button
                    class="button"
                    disabled=${busy}
                    aria-label=${`Wake ${thread.id}`}
                    onClick=${() => void act(`threads/${thread.id}/wake`, {})}
                >
                    Wake
                </button>
                ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;

        const foundActions = (thread) => {
            const targets = threads.filter(
                (other) => other.state !== "closed" && other.id !== thread.id,
            );

            return html`<div class="desk-actions">
                <select
                    class="desk-into"
                    value=${into[thread.id] ?? ""}
                    disabled=${busy}
                    onChange=${(event) => setInto({ ...into, [thread.id]: event.currentTarget.value })}
                >
                    <option value="">Attach to…</option>
                    ${targets.map(
                        (other) =>
                            html`<option value=${other.id}>${other.id} · ${other.title}</option>`,
                    )}
                </select>
                <button
                    class="button"
                    disabled=${busy || !into[thread.id]}
                    aria-label=${`Attach ${thread.id}`}
                    onClick=${() =>
                        void act(`threads/${thread.id}/attach`, { into: into[thread.id] })}
                >
                    Attach
                </button>
                ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;
        };

        /** A watch is set on an open thread: its date and its check. */
        const watchOpen = (thread) => thread.state === "open" || thread.state === "starting";

        const watchField = (thread) =>
            watchFor === thread.id
                ? html`<div class="desk-watch">
                      <input
                          class="desk-reason"
                          type="date"
                          aria-label=${`The check's date for ${thread.id}`}
                          value=${checkOn}
                          disabled=${busy}
                          onInput=${(event) => setCheckOn(event.currentTarget.value)}
                      />
                      <input
                          class="desk-reason"
                          type="time"
                          aria-label=${`The check's time for ${thread.id} (optional)`}
                          value=${checkTime}
                          disabled=${busy}
                          onInput=${(event) => setCheckTime(event.currentTarget.value)}
                      />
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="What to check"
                          aria-label=${`The check for ${thread.id}`}
                          value=${checkText}
                          disabled=${busy}
                          onInput=${(event) => setCheckText(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || checkOn === "" || checkText.trim() === ""}
                          aria-label=${`Set the watch on ${thread.id}`}
                          onClick=${() => void watchOn(thread.id)}
                      >
                          Set
                      </button>
                  </div>`
                : null;

        const resultField = (thread) =>
            resultFor === thread.id
                ? html`<div class="desk-watch">
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="What happened?"
                          aria-label=${`The failed check on ${thread.id}`}
                          value=${resultText}
                          disabled=${busy}
                          onInput=${(event) => setResultText(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || resultText.trim() === ""}
                          aria-label=${`Record the failed check on ${thread.id}`}
                          onClick=${() => void failCheck(thread.id)}
                      >
                          Record
                      </button>
                  </div>`
                : null;

        /** Watch, Clear, Pass and Fail: a watch is set on an open thread, the rest on a watched one. */
        const watchActions = (thread) => {
            if (!watchOpen(thread)) {
                return null;
            }

            // A failed watch is still a watch: Clear, and a later Pass that closes the thread.
            const watched = thread.watch !== undefined;

            return html`<div class="desk-actions">
                    <button
                        class="button"
                        disabled=${busy}
                        aria-label=${`Watch ${thread.id}`}
                        onClick=${() => setWatchFor(watchFor === thread.id ? null : thread.id)}
                    >
                        Watch
                    </button>
                    ${
                        watched
                            ? html`<button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Clear the watch on ${thread.id}`}
                                  onClick=${() => void act(`threads/${thread.id}/unwatch`, {})}
                              >
                                  Clear
                              </button>
                              <button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Pass the check on ${thread.id}`}
                                  onClick=${() => void passCheck(thread.id)}
                              >
                                  Pass
                              </button>
                              <button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Fail the check on ${thread.id}`}
                                  onClick=${() =>
                                      setResultFor(resultFor === thread.id ? null : thread.id)}
                              >
                                  Fail
                              </button>`
                            : null
                    }
                </div>
                ${watchField(thread)} ${resultField(thread)}`;
        };

        const withWatch = (thread, actions) => html`${actions}${watchActions(thread)}`;

        const needDetail = (thread) =>
            html`<div class="desk-need">
                ${thread.asks.map(
                    (ask) => html`<div class="desk-ask">
                        <p class="small">
                            ${ask.id}${ask.from ? ` · from ${ask.from}` : ""} · ${ask.text}${
                                ask.options && ask.options.length > 0
                                    ? ` [${ask.options.join(" | ")}]`
                                    : ""
                            }
                        </p>
                        ${
                            ask.options && ask.options.length > 0
                                ? html`<div class="desk-actions">
                                  ${ask.options.map(
                                      (option) =>
                                          html`<button
                                              class="button"
                                              disabled=${busy}
                                              aria-label=${`Answer ${ask.id}: ${option}`}
                                              onClick=${() => void answerWith(ask.id, option, ask.gen)}
                                          >
                                              ${option}
                                          </button>`,
                                  )}
                              </div>`
                                : null
                        }
                        <div class="desk-actions">
                            <input
                                class="desk-reason"
                                type="text"
                                maxlength="1000"
                                placeholder="Your answer"
                                value=${answers[ask.id] ?? ""}
                                disabled=${busy}
                                onInput=${(event) =>
                                    setAnswers({ ...answers, [ask.id]: event.currentTarget.value })}
                            />
                            <button
                                class="button"
                                disabled=${busy || (answers[ask.id] ?? "").trim() === ""}
                                aria-label=${`Answered ${ask.id}`}
                                onClick=${() => void answer(ask.id, ask.gen)}
                            >
                                Answered
                            </button>
                        </div>
                    </div>`,
                )}
                ${(thread.state === "closed" ? [] : thread.prs)
                    .filter((pr) => pr.next === "brian")
                    .map((pr) =>
                        pr.url
                            ? html`<a class="desk-link" href=${pr.url} target="_blank" rel="noopener"
                                  >${pr.ref} · ready to merge</a
                              >`
                            : html`<span class="small mono">${pr.ref} · ready to merge</span>`,
                    )}
            </div>`;

        const queue = view?.issues ?? null;

        /** One queued issue: its link, its owner, its threads, and what Brian did. Read only: Brian changes it on GitHub. */
        const issueRow = (item) => {
            const url = webUrl(item.url);
            const owner = item.agent
                ? item.owners && item.owners.length > 1
                    ? `${item.agent} (owned by ${item.owners.length} agents)`
                    : item.agent
                : "no owner";

            return html`<li class="desk-row desk-issue">
                <span class="desk-line">
                    ${item.urgent ? html`<span class="desk-urgent">URGENT</span>` : null}
                    ${
                        url
                            ? html`<a class="desk-link mono" href=${url} target="_blank" rel="noopener"
                                  >${item.ref}</a
                              >`
                            : html`<span class="mono">${item.ref}</span>`
                    }
                    <span class="desk-title">${item.title}</span>
                </span>
                <span class="small muted">
                    ${owner} · ${item.threads.length === 0 ? "not started" : null}
                    ${item.threads.map(
                        (thread) =>
                            html`<button
                                type="button"
                                class="desk-thread-link"
                                aria-label=${`Open ${thread.id}`}
                                onClick=${() => setOpenId(thread.id)}
                            >
                                ${thread.id} ${thread.word}</button
                            > `,
                    )}
                    · ${(item.names ?? [item.signal]).join(", ")} · ${item.by}, ${ago(item.at)}
                    ${item.fixedBy.length > 0 ? ` · PR ${item.fixedBy.join(", ")} fixes it` : ""}
                </span>
                ${
                    item.parts > 0 || item.unverified
                        ? html`<span class="desk-chips">
                              ${
                                  item.parts > 0
                                      ? html`<span class="desk-chip done"
                                            >${item.parts} part${item.parts === 1 ? "" : "s"} merged</span
                                        >`
                                      : null
                              }
                              ${
                                  item.unverified
                                      ? html`<span class="desk-chip" title="The last read could not prove it: it stays until a read does."
                                            >unverified</span
                                        >`
                                      : null
                              }
                          </span>`
                        : null
                }
            </li>`;
        };

        const status = queueStatus(queue, clock);
        const queueSection =
            queue !== null && (queue.items.length > 0 || queue.ignored.length > 0)
                ? html`<section class="desk-section desk-queue">
                      <h2>
                          Brian queued <span class="desk-count">${queue.items.length}</span>
                          <span class=${`desk-read ${status !== null && status.warn ? "desk-warn" : ""}`}>
                              ${queue.ok ? `read ${clock(queue.at)}` : queue.off ? "queue read is off" : `queue read failed at ${clock(queue.at)}`}
                          </span>
                      </h2>
                      ${
                          status !== null
                              ? html`<p class=${`small ${status.warn ? "desk-warn" : "muted"}`}>${status.text}</p>`
                              : null
                      }
                      <ul class="desk-rows">
                          ${queue.items.map(issueRow)}
                      </ul>
                      ${
                          queue.ignored.length > 0
                              ? html`<p class="small muted">
                                    Not counted:
                                    ${queue.ignored
                                        .map((one) => `${one.ref} ${one.signal} by ${one.actor}`)
                                        .join(", ")}
                                </p>`
                              : null
                      }
                  </section>`
                : status !== null
                  ? html`<p class=${`small ${status.warn ? "desk-warn" : "muted"}`}>${status.text}</p>`
                  : null;

        /** The top count's button: open the "Other PRs" section and bring it into view. */
        const showOthers = (event) => {
            const box = event.currentTarget.closest(".desk")?.querySelector(".desk-others");

            if (box) {
                box.open = true;
                box.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        };

        /** One other author's PR: a link to it, its author and age, and its draft and check marks. */
        const otherRow = (pr) => {
            const url = webUrl(pr.url);
            const label = html`<span class="mono">${pr.ref}</span> <span class="desk-title">${pr.title}</span>`;

            return html`<li class="desk-other">
                ${
                    url
                        ? html`<a class="desk-link" href=${url} target="_blank" rel="noopener">${label}</a>`
                        : label
                }
                <span class="small muted">
                    (${pr.author || "unknown"}${pr.createdAt > 0 ? `, ${ago(pr.createdAt)}` : ""})</span
                >
                ${pr.draft ? html`<span class="desk-chip">draft</span>` : null}
                ${
                    pr.checks === "FAILURE" || pr.checks === "ERROR"
                        ? html`<span class="desk-chip desk-chip-fail">checks fail</span>`
                        : null
                }
            </li>`;
        };

        const otherRepos = Object.keys(view?.others ?? {})
            .filter((repo) => (view.others[repo] ?? 0) > 0)
            .sort((a, b) => a.localeCompare(b));
        const othersSection =
            others === 0
                ? null
                : html`<details id="desk-others" class="desk-closed desk-others">
                      <summary>Other PRs (${others})</summary>
                      <p class="small muted">
                          Open PRs by other authors, from the last read of each repository. Your own PRs are not here.
                      </p>
                      ${otherRepos.map((repo) => {
                          const count = view.others[repo] ?? 0;
                          const list = view.otherPrs?.[repo] ?? [];
                          const more = count - list.length;

                          return html`<div class="desk-others-repo">
                              <h3>${repo} <span class="desk-count">${count}</span></h3>
                              <ul class="desk-others-list">
                                  ${list.map(otherRow)}
                              </ul>
                              ${
                                  more > 0
                                      ? html`<p class="small muted">
                                            ${
                                                list.length === 0
                                                    ? "The list comes with the next sweep."
                                                    : html`… and ${more} more:${" "}<a
                                                              class="desk-link"
                                                              href=${`https://github.com/${repo}/pulls`}
                                                              target="_blank"
                                                              rel="noopener"
                                                              >all open PRs</a
                                                          >`
                                            }
                                        </p>`
                                      : null
                              }
                          </div>`;
                      })}
                  </details>`;

        const section = (title, items, render, hint) =>
            items.length === 0
                ? null
                : html`<section class="desk-section">
                      <h2>${title} <span class="desk-count">${items.length}</span></h2>
                      ${hint ? html`<p class="small muted">${hint}</p>` : null}
                      <ul class="desk-rows">${items.map(render)}</ul>
                  </section>`;

        return html`<div class="desk">
            <header class="desk-head">
                <h1>Desk</h1>
                <p class="small muted">
                    ${counts.brian ?? 0} need you · ${counts.ready ?? 0} ready to merge · ${counts.open ?? 0} open · ${counts.stale ?? 0} stale · ${counts.watching ?? 0} watching · ${counts.parked ?? 0} parked · ${capInfo.counted} of ${capInfo.cap} count
                </p>
                ${
                    view.github && view.github.ok === false
                        ? html`<p class="small desk-warn">
                              GitHub: read failed at
                              ${new Date(view.github.at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                              })}: ${view.github.error ?? "unknown error"}
                          </p>`
                        : null
                }
                ${
                    view.github && (view.github.incomplete ?? []).length > 0
                        ? html`<p class="small desk-warn">
                              GitHub read incomplete: ${view.github.incomplete.join(", ")}
                          </p>`
                        : null
                }
                ${
                    capInfo.full
                        ? html`<div class="desk-full" role="status">
                              <p>
                                  The desk is full: ${capInfo.counted} of ${capInfo.cap} count. Allow 1
                                  lets Odrade open 1 more thread, and tells her to delegate the work
                                  that waited.
                              </p>
                              <div class="desk-actions">
                                  <button
                                      class="button primary"
                                      disabled=${busy}
                                      aria-label="Allow 1 delegation"
                                      onClick=${() => void act("grant", { count: 1 })}
                                  >
                                      Allow 1
                                  </button>
                                  ${
                                      capInfo.grants > 0
                                          ? html`<span class="small muted"
                                            >${capInfo.grants} extra allowed</span
                                        >`
                                          : null
                                  }
                              </div>
                          </div>`
                        : null
                }
                ${
                    others > 0
                        ? html`<p class="small muted">
                          <button
                              type="button"
                              class="desk-thread-link desk-others-link"
                              aria-controls="desk-others"
                              onClick=${showOthers}
                          >
                              ${others} other PR${others === 1 ? "" : "s"} (dependabot and others)
                          </button>
                      </p>`
                        : null
                }
            </header>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${loadError ? html`<div class="error-box" role="alert">${loadError}</div>` : null}
            ${queueSection}
            ${section(
                "Plans",
                plans,
                (plan) =>
                    html`<li class="desk-row">
                        <button
                            type="button"
                            class="desk-open"
                            aria-label=${`Open plan ${plan.id}: ${plan.title}`}
                            onClick=${() => setPlanId(plan.id)}
                        >
                            <span class="desk-line">
                                <span class="desk-id">${plan.id}</span>
                                <span class="desk-title">${plan.title}</span>
                            </span>
                            <span class="small muted">${planRowLine(plan)}</span>
                        </button>
                    </li>`,
                "A plan settles its decisions and its task graph before its tasks start. Brian approves 1 revision here.",
            )}
            ${section("Needs you", groups.need, (thread) =>
                row(
                    thread,
                    // A closed thread (it is here for its open ask) shows the ask and its answer controls only: the
                    // watch, Attach and Drop routes do nothing on it.
                    // A plan thread takes no watch: its plan view has its own actions.
                    thread.state === "closed" || thread.origin === "plan"
                        ? needDetail(thread)
                        : html`${withWatch(thread, needDetail(thread))}${thread.origin === "found" ? foundActions(thread) : null}`,
                ),
            )}
            ${section(
                "Ready to merge",
                ready,
                readyRow,
                "PRs with the label ready-for-human. A PR leaves the list when it merges, closes, or loses the label.",
            )}
            ${section(
                "Found",
                groups.found,
                (thread) => row(thread, withWatch(thread, foundActions(thread))),
                "Work with no thread of its own. Attach it to the thread that owns it.",
            )}
            ${section("Stale", groups.stale, (thread) => row(thread, withWatch(thread, staleActions(thread))))}
            ${section(
                "Watching",
                groups.watching,
                (thread) => row(thread, watchActions(thread)),
                "A check on its date. It does not count toward the cap, and it is not stale.",
            )}
            ${section("Working", groups.working, (thread) => row(thread, withWatch(thread, parkActions(thread))))}
            ${section("Waiting on review", groups.review, (thread) => row(thread, withWatch(thread, parkActions(thread))))}
            ${section("Parked", groups.parked, (thread) => row(thread, parkedActions(thread)))}
            ${othersSection}
            ${
                groups.closed.length === 0
                    ? null
                    : html`<details
                          class="desk-closed"
                          onToggle=${(event) => setClosedOpen(event.currentTarget.open)}
                      >
                          <summary>Closed in the last 7 days (${groups.closed.length})</summary>
                          ${
                              closedOpen
                                  ? html`<ul class="desk-rows">
                                        ${groups.closed.map((thread) => row(thread, null))}
                                    </ul>`
                                  : null
                          }
                      </details>`
            }
            ${
                threads.length === 0
                    ? html`<p class="muted">No threads yet. A delegation makes one.</p>`
                    : null
            }
        </div>`;
    }

    pocket.page({ id: "desk", title: "Desk", component: Desk });
    rail = pocket.rail({ id: "desk", title: "Desk", icon: "grid", page: "desk" });

    void load();
    pocket.onDispose(pocket.on("changed", () => void load()));
}
