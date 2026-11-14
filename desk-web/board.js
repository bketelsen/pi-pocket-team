// The Desk's Board view: the goal board of 1 supervisor (`GET board`), and its acts (`POST board/<conversation>`).
// Owner-only, like the page. Pure helpers first (tested in desk-web.test.js), then the view's controller (no hooks, so
// a test drives it), the markup, and `makeBoard(pocket)`, which gives the component.

/** The acts of a row in each state; a state that is not here takes no act on the page. */
const STATE_ACTS = {
    proposed: ["pick", "edit", "drop"],
    picked: ["unpick", "edit", "drop"],
    waiting: ["drop"],
    failed: ["reopen"],
    unknown: ["resolve"],
};

/** The button words of each act. */
const ACT_LABELS = {
    pick: "Pick",
    unpick: "Unpick",
    edit: "Edit",
    drop: "Drop",
    reopen: "Reopen",
    resolve: "Resolve",
};

/**
 * A new key for 1 act: the page's time in ms first, then "-" and a random part (`<ms>-<random>`), in letters, digits and
 * "-", as the board's route takes it (8 to 100 characters). The route refuses a key whose time is 30 days old or more
 * than 10 minutes ahead (409), so an expired key never acts again.
 */
export const newBoardKey = (act, now = Date.now()) =>
    `${String(now)}-board-${String(act).replace(/[^A-Za-z0-9_-]/g, "-")}-${Math.random().toString(36).slice(2, 10)}`;

/** The read of 1 supervisor's board: the desk's default (`GET board`) when none is chosen. */
export const boardPath = (supervisor) =>
    supervisor === null || supervisor === undefined
        ? "board"
        : `board?supervisor=${encodeURIComponent(String(supervisor))}`;

/** The acts a row takes now, as `{ op, label }`, in the order of its buttons. */
export const rowActs = (row) =>
    (STATE_ACTS[row?.state] ?? []).map((op) => ({ op, label: ACT_LABELS[op] }));

/** The rows that are picked: Launch picks posts these, with the revs the page shows. */
export const pickedRows = (rows) => (rows ?? []).filter((row) => row.state === "picked");

/**
 * The body of 1 row act, without its key, with the rev the page shows. `extra` holds an edit's `max` and `until`, or a
 * resolve's `thread` (none fails the row).
 */
export const actBody = (row, op, extra = {}) => {
    if (op === "pick" || op === "unpick") {
        return { op, rows: [{ row: row.id, rev: row.rev }] };
    }

    if (op === "edit") {
        const max = String(extra.max ?? "").trim();

        return {
            op,
            row: row.id,
            rev: row.rev,
            // A whole number goes as a number; anything else goes as it is, and the route says what is wrong.
            fields: {
                max: /^[0-9]+$/.test(max) ? Number(max) : max,
                until: String(extra.until ?? "").trim(),
            },
        };
    }

    if (op === "resolve") {
        const thread = String(extra.thread ?? "").trim();

        return { op, row: row.id, rev: row.rev, ...(thread === "" ? {} : { thread }) };
    }

    return { op, row: row.id, rev: row.rev };
};

/** Launch picks: every picked row with its shown rev, or null when no row is picked. */
export const launchBody = (rows) => {
    const picked = pickedRows(rows);

    return picked.length === 0
        ? null
        : { op: "launch", rows: picked.map((row) => ({ row: row.id, rev: row.rev })) };
};

/**
 * The key of 1 act: made the first time, and the same at each tap after it while the act is not done, so the board acts
 * once. The act is its supervisor and its body: another rev or other values are another act, with a new key.
 */
export const boardKeyFor = (keys, supervisor, body, make = newBoardKey) => {
    const act = JSON.stringify([supervisor, body]);

    keys[act] ??= make(body.op);

    return keys[act];
};

/** The act is done: its next tap is a new act, with a new key. */
export const forgetBoardKey = (keys, supervisor, body) => {
    delete keys[JSON.stringify([supervisor, body])];
};

/** A row's facts on 1 line: agent, repo, kind, rounds, until, start and worker. */
export const rowFacts = (row) =>
    [
        row.agent + (row.repo ? ` ${row.repo}` : ""),
        row.kind,
        `max ${String(row.max)}`,
        `until ${row.until}`,
        ...(row.start ? [`start ${row.start}`] : []),
        ...(row.worker ? [`worker ${row.worker}`] : []),
    ].join(" · ");

/** The row states that have a status of the same name. */
const SAME_STATUS = new Set(["proposed", "picked", "waiting", "failed", "unknown", "dropped"]);

/**
 * A row's status, which gives its color (`board-status-<status>`): a starting row runs; a launched row runs while its
 * thread is open (or the board gives no thread facts), and is finished when its thread closed or its shift ended. Any
 * other state is neutral (`proposed`).
 */
export const rowStatus = (row) => {
    const state = row?.state;

    if (state === "starting") {
        return "running";
    }

    if (state === "launched") {
        return row.threadState === "closed" || row.shiftEnded === true ? "finished" : "running";
    }

    return SAME_STATUS.has(state) ? state : "proposed";
};

/** A row's time of its last change; a row with no number there counts as 0. */
const rowChangedAt = (row) => (Number.isFinite(row?.changedAt) ? row.changedAt : 0);

/**
 * The board's rows in 2 lists. `active` holds the rows that wait for an act or run, in the input order (launch order):
 * proposed, picked, waiting, starting, failed, unknown, and launched while it runs. `done` holds the dropped rows and the
 * launched rows whose thread closed or whose shift ended, newest `changedAt` first: a row with none counts as 0, and a tie
 * keeps the input order.
 */
export const boardSplit = (rows) => {
    const active = [];
    const done = [];

    for (const row of rows ?? []) {
        const finished = row?.state === "launched" && rowStatus(row) === "finished";

        (row?.state === "dropped" || finished ? done : active).push(row);
    }

    // `sort` is stable, so 2 rows of the same time stay in the order they came in.
    done.sort((a, b) => rowChangedAt(b) - rowChangedAt(a));

    return { active, done };
};

/**
 * A row's state on 1 line: its state and rev (a launched row says running or finished), the meter's hold of a waiting
 * row, then its thread and the next actor, or its error.
 */
export const rowStateText = (row) =>
    [
        `${row.state === "launched" ? `launched (${rowStatus(row)})` : row.state} · rev ${String(row.rev)}`,
        ...(row.state === "waiting" && typeof row.held?.reason === "string"
            ? [`held: ${row.held.reason}`]
            : []),
        ...(row.thread ? [`${row.thread}${row.next ? ` (next: ${row.next})` : ""}`] : []),
        ...((row.state === "failed" || row.state === "unknown") && row.error
            ? [`error: ${row.error}`]
            : []),
    ].join(" · ");

/** The label of 1 supervisor in the board's choice: its session title and id, else its conversation id. */
export const supervisorLabel = (id, titles) => {
    const title = titles?.[String(id)];

    return typeof title === "string" && title.trim() !== ""
        ? `${title} (${String(id)})`
        : `Supervisor conversation ${String(id)}`;
};

/** The header's line: the limits now, or why there is no board. */
export const limitsText = (board) =>
    board?.supervisor === null || board?.supervisor === undefined
        ? "The desk knows no supervisor yet: there is no board to show."
        : (board.limits?.line ?? "");

/** A row with the rev of its open form (`draft`), when the form is that row's: Save posts the rev the form opened on. */
export const draftRow = (row, draft) =>
    draft?.row === row.id && typeof draft.rev === "number" ? { ...row, rev: draft.rev } : row;

/** The pass's lines after a launch, as 1 notice, or "" when the pass touched no row. */
export const passText = (pass) =>
    (pass ?? []).length === 0 ? "" : `Launch pass: ${pass.join("; ")}`;

/**
 * 1 act of the Board view: the POST, and after a 409 (a stale rev or a wrong state) a GET of the board, so the page shows
 * the newer rows. The error comes back after the load, so it stays on the screen.
 */
export const boardAct = async (api, reload, conversation, body) => {
    try {
        return { ok: true, answer: await api(`board/${String(conversation)}`, body) };
    } catch (failure) {
        if (failure?.status === 409) {
            const reloaded = await Promise.resolve()
                .then(reload)
                .catch(() => undefined);

            // A 409 changed nothing and kept no receipt: the act's next tap takes a new key (`conflict`).
            return {
                ok: false,
                conflict: true,
                error: `${failure.message} The board is loaded again.`,
                ...(reloaded === undefined ? {} : { reloaded }),
            };
        }

        return { ok: false, error: failure?.message ?? String(failure) };
    }
};

// ─── The controller: the view's state and acts, with no hooks ───────────────

/**
 * The Board view's state and its acts. `api` is `pocket.api`; `onChange` runs after each change. An act runs once at a
 * time: a tap while one runs does nothing. A choice of another supervisor starts a new selection (`selection`): an
 * answer, GET or POST, that comes for an earlier selection is dropped, so it never lands on another supervisor's board.
 * While the new board loads (`loading`), the acts are off. An Edit or Resolve form keeps the rev it opened on, and its
 * Save posts that rev: a row that changed since is refused (409), never overwritten.
 */
export function boardController(api, { onChange = () => {}, make = newBoardKey } = {}) {
    const keys = {};
    let stopped = false;
    let reads = 0;
    /** The selection: 1 more at each choice of a supervisor. */
    let selection = 0;
    let view = {
        board: null,
        chosen: null,
        loading: false,
        error: "",
        notice: "",
        busy: false,
        open: null,
        editing: null,
        resolving: null,
    };

    const set = (patch) => {
        view = { ...view, ...patch };

        if (!stopped) {
            onChange(view);
        }
    };

    /** Read the board again: the newest read wins. Gives the answer, or undefined after a failure. */
    const load = async () => {
        reads += 1;

        const mine = reads;
        const chosen = selection;
        /** Whether this read is still the newest one of the selection shown now. */
        const current = () => mine === reads && chosen === selection;

        try {
            const board = await api(boardPath(view.chosen));

            // A chosen selection follows the board the route gave (none chosen stays none: the route's first): the select and
            // the acts name 1 supervisor.
            if (current()) {
                set({
                    board,
                    chosen: view.chosen === null ? null : (board?.supervisor ?? null),
                    loading: false,
                });
            }

            return board;
        } catch (failure) {
            // A failed read keeps the board on the screen, so the selection goes back to it: the select never names
            // a supervisor whose board the acts do not post to.
            if (current()) {
                set({
                    error: failure?.message ?? String(failure),
                    loading: false,
                    chosen: view.board?.supervisor ?? view.chosen,
                });
            }

            return undefined;
        }
    };

    /** Post 1 act with its key; a done act takes the answer's rows, and its next tap gets a new key. */
    const act = async (body) => {
        const supervisor = view.board?.supervisor;

        if (
            view.busy ||
            view.loading ||
            body === null ||
            supervisor === null ||
            supervisor === undefined ||
            // The select names another supervisor than the board on the screen: no act until they match.
            (view.chosen !== null && view.chosen !== supervisor)
        ) {
            return;
        }

        const key = boardKeyFor(keys, supervisor, body, make);
        const chosen = selection;

        set({ busy: true, error: "", notice: "" });

        const done = await boardAct(api, load, supervisor, { ...body, key });

        // The answer of an earlier selection, or of another supervisor's board: it changes no row on the screen.
        if (chosen !== selection || view.board?.supervisor !== supervisor) {
            set({ busy: false });

            return;
        }

        if (done.ok) {
            forgetBoardKey(keys, supervisor, body);
            set({
                busy: false,
                board: { ...view.board, rows: done.answer.rows, limits: done.answer.limits },
                editing: null,
                resolving: null,
                notice: passText(done.answer.pass),
            });
        } else {
            // A refusal of a 409 (a stale rev, a wrong state, a key too old to replay) acted on nothing: the next tap is
            // a new act with a new key, so a key the route refuses as too old is never sent again.
            if (done.conflict === true) {
                forgetBoardKey(keys, supervisor, body);
            }

            set({ busy: false, error: done.error });
        }
    };

    return {
        view: () => view,
        load,
        act,
        launch: () => act(launchBody(view.board?.rows)),
        choose: (supervisor) => {
            selection += 1;
            set({
                chosen: supervisor,
                loading: true,
                open: null,
                editing: null,
                resolving: null,
                error: "",
                notice: "",
            });

            return load();
        },
        toggle: (id) => set({ open: view.open === id ? null : id }),
        edit: (row) =>
            set({
                editing: { row: row.id, rev: row.rev, max: String(row.max), until: row.until },
                resolving: null,
            }),
        editField: (name, value) => set({ editing: { ...view.editing, [name]: value } }),
        // The rev the form opened on, not the one on the screen now: a change since is a 409.
        saveEdit: (row) => act(actBody(draftRow(row, view.editing), "edit", view.editing ?? {})),
        resolve: (row) =>
            set({ resolving: { row: row.id, rev: row.rev, thread: "" }, editing: null }),
        resolveField: (value) => set({ resolving: { ...view.resolving, thread: value } }),
        sendResolve: (row) =>
            act(
                actBody(draftRow(row, view.resolving), "resolve", {
                    thread: view.resolving?.thread,
                }),
            ),
        failRow: (row) => act(actBody(draftRow(row, view.resolving), "resolve")),
        cancel: () => set({ editing: null, resolving: null }),
        stop: () => {
            stopped = true;
        },
    };
}

// ─── The markup ─────────────────────────────────────────────────────────────

/** The view's markup for its state, with the controller's acts. `html` is Pocket's. */
export function boardMarkup(html, view, ctl) {
    const board = view.board;
    const rows = board?.rows ?? [];
    const supervisors = board?.supervisors ?? [];
    const picked = pickedRows(rows);
    const { active, done } = boardSplit(rows);

    const rowButtons = (row) =>
        rowActs(row).map(({ op, label }) =>
            op === "edit"
                ? html`<button
                      type="button"
                      class="button"
                      data-act=${`edit:${String(row.id)}`}
                      disabled=${view.busy || view.loading}
                      onClick=${() => ctl.edit(row)}
                  >
                      ${label}
                  </button>`
                : op === "resolve"
                  ? html`<button
                        type="button"
                        class="button"
                        data-act=${`resolve:${String(row.id)}`}
                        disabled=${view.busy || view.loading}
                        onClick=${() => ctl.resolve(row)}
                    >
                        ${label}
                    </button>`
                  : html`<button
                        type="button"
                        class="button"
                        data-act=${`${op}:${String(row.id)}`}
                        disabled=${view.busy || view.loading}
                        onClick=${() => ctl.act(actBody(row, op))}
                    >
                        ${label}
                    </button>`,
        );

    const editForm = (row) =>
        html`<div class="board-form">
            <label class="board-field">
                <span class="small muted">Rounds (max)</span>
                <input
                    class="desk-reason"
                    type="number"
                    min="1"
                    max="100"
                    inputmode="numeric"
                    value=${view.editing.max}
                    onInput=${(event) => ctl.editField("max", event.currentTarget.value)}
                />
            </label>
            <label class="board-field">
                <span class="small muted">Until (HH:MM)</span>
                <input
                    class="desk-reason"
                    type="text"
                    placeholder="06:45"
                    value=${view.editing.until}
                    onInput=${(event) => ctl.editField("until", event.currentTarget.value)}
                />
            </label>
            <div class="desk-actions">
                <button
                    type="button"
                    class="button primary"
                    data-act=${`save:${String(row.id)}`}
                    disabled=${view.busy || view.loading}
                    onClick=${() => ctl.saveEdit(row)}
                >
                    Save
                </button>
                <button type="button" class="button" onClick=${() => ctl.cancel()}>Cancel</button>
            </div>
        </div>`;

    const resolveForm = (row) =>
        html`<div class="board-form">
            <label class="board-field">
                <span class="small muted">The thread its session started, such as T12</span>
                <input
                    class="desk-reason"
                    type="text"
                    value=${view.resolving.thread}
                    onInput=${(event) => ctl.resolveField(event.currentTarget.value)}
                />
            </label>
            <div class="desk-actions">
                <button
                    type="button"
                    class="button primary"
                    data-act=${`bind:${String(row.id)}`}
                    disabled=${view.busy || view.loading || view.resolving.thread.trim() === ""}
                    onClick=${() => ctl.sendResolve(row)}
                >
                    Launched with this thread
                </button>
                <button
                    type="button"
                    class="button"
                    data-act=${`fail:${String(row.id)}`}
                    disabled=${view.busy || view.loading}
                    onClick=${() => ctl.failRow(row)}
                >
                    Fail it
                </button>
                <button type="button" class="button" onClick=${() => ctl.cancel()}>Cancel</button>
            </div>
        </div>`;

    const rowItem = (row) =>
        html`<li class=${`board-row board-${row.state} board-status-${rowStatus(row)}`}>
            <button
                type="button"
                class="board-row-head"
                aria-expanded=${view.open === row.id ? "true" : "false"}
                data-act=${`open:${String(row.id)}`}
                onClick=${() => ctl.toggle(row.id)}
            >
                <span class="board-title">#${String(row.id)} ${row.title}</span>
                <span class="small muted board-facts">${rowFacts(row)}</span>
                ${row.note ? html`<span class="small board-note">Note: ${row.note}</span>` : null}
                <span class="small board-state">${rowStateText(row)}</span>
            </button>
            ${
                view.open === row.id
                    ? html`<dl class="board-detail">
                          <dt>Task</dt>
                          <dd>${row.task}</dd>
                          ${row.objective ? html`<dt>Objective</dt><dd>${row.objective}</dd>` : null}
                          <dt>Stop when</dt>
                          <dd>${row.stopWhen}</dd>
                      </dl>`
                    : null
            }
            ${view.editing?.row === row.id ? editForm(row) : null}
            ${view.resolving?.row === row.id ? resolveForm(row) : null}
            <div class="desk-actions">${rowButtons(row)}</div>
        </li>`;

    return html`<section class="board" aria-label="Goal board">
        <header class="desk-head board-head">
            <h1>Board</h1>
            <p class="small muted board-limits">${board === null ? "Loading the board…" : limitsText(board)}</p>
            ${
                supervisors.length > 1
                    ? html`<select
                          class="desk-reason board-supervisor"
                          aria-label="The supervisor's board"
                          value=${String(view.chosen ?? board.supervisor)}
                          disabled=${view.busy || view.loading}
                          onChange=${(event) => void ctl.choose(Number(event.currentTarget.value))}
                      >
                          ${supervisors.map(
                              (id) =>
                                  html`<option value=${String(id)}>${supervisorLabel(id, board?.titles ?? {})}</option>`,
                          )}
                      </select>`
                    : null
            }
            <div class="desk-actions">
                <button
                    type="button"
                    class="button primary"
                    data-act="launch"
                    disabled=${view.busy || view.loading || picked.length === 0}
                    onClick=${() => ctl.launch()}
                >
                    Launch picks${picked.length === 0 ? "" : ` (${String(picked.length)})`}
                </button>
            </div>
        </header>
        ${view.error ? html`<div class="error-box" role="alert">${view.error}</div>` : null}
        ${view.notice ? html`<p class="small muted board-notice">${view.notice}</p>` : null}
        ${
            board !== null && board.supervisor !== null && rows.length === 0
                ? html`<p class="small muted">The board has no rows.</p>`
                : html`${
                      active.length === 0 && done.length > 0
                          ? html`<p class="small muted">No row waits or runs.</p>`
                          : html`<ol class="board-rows">
                                ${active.map(rowItem)}
                            </ol>`
                  }
                  ${
                      done.length === 0
                          ? null
                          : html`<details class="board-done">
                                <summary class="board-done-summary">Done (${String(done.length)})</summary>
                                <ol class="board-rows">
                                    ${done.map(rowItem)}
                                </ol>
                            </details>`
                  }`
        }
    </section>`;
}

/**
 * The Board component for this module's `pocket`. A mounted view reads at once, and again on the page's `changed`
 * event; it stops listening when it unmounts, and when the module goes.
 */
export function makeBoard(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    /** The stop functions of the mounted views: the module's dispose runs them. */
    const mounted = new Set();

    pocket.onDispose(() => {
        for (const stop of [...mounted]) {
            stop();
        }
    });

    return function Board() {
        const [, setTick] = useState(0);
        const controller = useRef(null);

        controller.current ??= boardController(pocket.api, {
            onChange: () => setTick((tick) => tick + 1),
        });

        const ctl = controller.current;

        useEffect(() => {
            void ctl.load();

            const off = pocket.on("changed", () => void ctl.load());

            const stop = () => {
                mounted.delete(stop);
                ctl.stop();

                if (typeof off === "function") {
                    off();
                }
            };

            mounted.add(stop);

            return stop;
        }, []);

        return boardMarkup(html, ctl.view(), ctl);
    };
}
