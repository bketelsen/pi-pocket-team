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

const badgeOf = (next) =>
    next === null || next === undefined
        ? 0
        : next.threads.filter(
              (thread) =>
                  thread.state !== "parked" &&
                  thread.state !== "closed" &&
                  !thread.asleep &&
                  (thread.next === "brian" || thread.stale),
          ).length;

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

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    app = pocket;
    pocket.style("desk.css");

    const time = (at) => new Date(at).toLocaleString();

    /** One line about a thread's watch, for the detail view. */
    const watchLine = (watch) =>
        [
            watch.checkOn,
            watch.check,
            `set by ${watch.setBy}`,
            watch.due ? "due" : "",
            watch.result
                ? `${watch.result.pass ? "passed" : "failed"} by ${watch.result.by}: ${watch.result.text}`
                : "",
        ]
            .filter(Boolean)
            .join(" · ");

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
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [dropFor, setDropFor] = useState(null);
        const [reason, setReason] = useState("");
        const [into, setInto] = useState({});
        const [closedOpen, setClosedOpen] = useState(false);
        const [answers, setAnswers] = useState({});
        const [watchFor, setWatchFor] = useState(null);
        const [checkOn, setCheckOn] = useState("");
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
                setCheckText("");
                setResultFor(null);
                setResultText("");
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        const drop = (id) => act(`threads/${id}/drop`, { reason });

        const watchOn = (id) => act(`threads/${id}/watch`, { checkOn, check: checkText.trim() });

        const passCheck = (id) =>
            act(`threads/${id}/result`, { pass: true, text: "Passed on the Desk page." });

        const failCheck = (id) =>
            act(`threads/${id}/result`, { pass: false, text: resultText.trim() });

        const answer = async (id) => {
            const words = (answers[id] ?? "").trim();

            await act(`asks/${id}/answer`, words === "" ? {} : { words });
        };

        if (openId !== null) {
            return html`<${Detail} id=${openId} onBack=${() => setOpenId(null)} />`;
        }

        if (view === null && loadError === null) {
            return html`<div class="desk"><${Loader} label="Reading the desk" /></div>`;
        }

        const threads = view?.threads ?? [];
        const groups = {
            need: [],
            stale: [],
            found: [],
            watching: [],
            working: [],
            review: [],
            parked: [],
            closed: [],
        };

        for (const thread of threads) {
            if (thread.state === "closed") {
                groups.closed.push(thread);
            } else if (thread.state === "parked") {
                groups.parked.push(thread);
            } else if (thread.asleep) {
                groups.watching.push(thread);
            } else if (thread.origin === "found") {
                groups.found.push(thread);
            } else if (thread.next === "brian") {
                groups.need.push(thread);
            } else if (thread.stale) {
                groups.stale.push(thread);
            } else if (thread.next === "reviewer") {
                groups.review.push(thread);
            } else {
                groups.working.push(thread);
            }
        }

        // The soonest check first.
        groups.watching.sort(
            (a, b) =>
                (a.watch?.checkOn ?? "").localeCompare(b.watch?.checkOn ?? "") ||
                a.id.localeCompare(b.id, undefined, { numeric: true }),
        );

        const others = Object.values(view?.others ?? {}).reduce((sum, count) => sum + count, 0);
        const counts = view?.counts ?? {};
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
                      ? `check on ${thread.watch.checkOn}`
                      : "",
                thread.stale ? "stale" : "",
            ]
                .filter(Boolean)
                .join(" · ");

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
                        <p class="small">${ask.id} · ${ask.text}</p>
                        <div class="desk-actions">
                            <input
                                class="desk-reason"
                                type="text"
                                maxlength="1000"
                                placeholder="His words (optional)"
                                value=${answers[ask.id] ?? ""}
                                disabled=${busy}
                                onInput=${(event) =>
                                    setAnswers({ ...answers, [ask.id]: event.currentTarget.value })}
                            />
                            <button
                                class="button"
                                disabled=${busy}
                                aria-label=${`Answered ${ask.id}`}
                                onClick=${() => void answer(ask.id)}
                            >
                                Answered
                            </button>
                        </div>
                    </div>`,
                )}
                ${thread.prs
                    .filter((pr) => pr.next === "brian")
                    .map((pr) =>
                        pr.url
                            ? html`<a class="desk-link" href=${pr.url} target="_blank" rel="noopener"
                                  >${pr.ref} · ready to merge</a
                              >`
                            : html`<span class="small mono">${pr.ref} · ready to merge</span>`,
                    )}
            </div>`;

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
                    ${counts.brian ?? 0} need you · ${counts.open ?? 0} open · ${counts.stale ?? 0} stale · ${counts.watching ?? 0} watching · ${counts.parked ?? 0} parked · ${capInfo.counted} of ${capInfo.cap} count
                </p>
                ${
                    capInfo.full
                        ? html`<div class="desk-full" role="status">
                              <p>The desk is full. New delegations wait for your OK.</p>
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
                                            >${capInfo.grants} OK${capInfo.grants === 1 ? "" : "s"} waiting</span
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
                          ${others} other PR${others === 1 ? "" : "s"} (dependabot and others)
                      </p>`
                        : null
                }
            </header>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${loadError ? html`<div class="error-box" role="alert">${loadError}</div>` : null}
            ${section("Needs you", groups.need, (thread) => row(thread, withWatch(thread, needDetail(thread))))}
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
