// Terminal's browser module: a rail page with a tab strip of shells that run on the server, drawn by the vendored
// xterm.js. The xterm instances and the output polls belong to the module, not to the page, so closing the page to read
// a session keeps its shells, and the rail badge counts them. Keys go straight to the shell: no guard, and no Pi.

export const pocketApi = 1;

/** A `>_` in a box, as a 24×24 stroked path. */
const ICON = "M4 17l6-6-6-6M12 19h8";
const ESC = "\u001b";
/** The last folder typed, and the terminal the page showed, for the next time it opens. */
const LAST_PATH = "x.terminal.path";
const LAST_ACTIVE = "x.terminal.active";
/** At most this many characters of input in one POST: the server's own limit. */
const INPUT_MAX = 32 * 1024;
/** Terminals at once, as the server counts them. */
const CAP = 4;

/**
 * A tab's id, for the server's back pressure: 1 to 64 letters, digits, and dashes. `randomUUID` is missing on a
 * plain-HTTP LAN page, where `getRandomValues` still works.
 */
export function newTabId(random = globalThis.crypto) {
    if (typeof random?.randomUUID === "function") {
        return random.randomUUID();
    }

    const bytes = random.getRandomValues(new Uint8Array(16));

    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const GONE = "This terminal ended (the server restarted or the module reloaded)";

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;

    pocket.style("vendor/xterm.css");
    pocket.style("terminal.css");

    // From the module's own folder: the app's policy lets a tab load a script from nowhere else.
    const xterm = import(new URL("./vendor/xterm.mjs", import.meta.url).href);
    const fit = import(new URL("./vendor/addon-fit.mjs", import.meta.url).href);

    /** Each attached terminal: its xterm, its poll's offset, and whether it has ended. */
    const clients = new Map();
    /** The page's drawers: each change of the module's state calls them once. */
    const watchers = new Set();
    const stop = new AbortController();
    let list = [];
    let active = null;
    let notice = null;
    let conversation = null;
    let version = 0;
    let stopped = false;
    /** This tab's id for the server's back pressure, made once. */
    const tab = newTabId();
    /** The tab's 1 long poll, and the terminals it was asked for. */
    let polling = null;
    let asked = "";
    /** A paste that the browser would not give: the box that the person pastes into. */
    let pasteBox = null;

    const rail = pocket.rail({
        id: "terminal",
        title: "Terminal",
        iconPath: ICON,
        page: "terminal",
        badge: 0,
    });

    pocket.launcher({
        id: "terminal",
        label: "Terminal",
        detail: "A shell on the server",
        iconPath: ICON,
        keywords: ["terminal", "shell", "bash", "console"],
        page: "terminal",
    });

    function bump() {
        version++;

        for (const watch of [...watchers]) {
            watch();
        }

        sync();
    }

    function live() {
        return list.filter((each) => !each.exited).length;
    }

    function setList(next) {
        list = next;

        if (active !== null && !list.some((each) => each.id === active) && !clients.has(active)) {
            active = null;
        }

        rail.update({ badge: live() });
        bump();
    }

    /** A theme color from the app's own variables, when xterm can read that form; otherwise the fallback. */
    function color(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();

        return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(value) ? value : fallback;
    }

    function theme() {
        return {
            background: color("--bg", "#101014"),
            foreground: color("--text", "#e8e8ea"),
            cursor: color("--accent", "#8ab4f8"),
            selectionBackground: color("--line", "#3a3a44"),
        };
    }

    /** Control characters for a sticky Ctrl: `c` is 3, `[` is 27, `@` and the space are 0. */
    function controlChar(text) {
        const first = text[0] ?? "";

        if (first === "@" || first === " " || first === "2") {
            return "\u0000";
        }

        const code = first.toUpperCase().charCodeAt(0);

        return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : text;
    }

    /** The arrows, as an application that asks for them gets them (vim, less). */
    function arrow(record, letter) {
        return record.term.modes.applicationCursorKeysMode
            ? `${ESC}O${letter}`
            : `${ESC}[${letter}`;
    }

    /** The screen as plain text: what the phone's own selection and copy work on. */
    function screenText(term) {
        const buffer = term.buffer.active;
        const lines = [];

        for (let index = 0; index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
        }

        return lines.join("\n").replace(/\s+$/, "");
    }

    function mount(record, el) {
        if (record.host === el && record.term.element?.parentNode === el) {
            return;
        }

        if (record.term.element === undefined) {
            record.term.open(el);
        } else if (record.term.element.parentNode !== el) {
            el.append(record.term.element);
        }

        record.host = el;
        fill(record);

        if (record.observer === null) {
            record.observer = new ResizeObserver(() => fill(record));
        }

        record.observer.observe(el);
        record.term.focus();
    }

    function unmount(record) {
        record.observer?.disconnect();
        record.observer = null;
        record.term.element?.remove();
        record.host = null;
    }

    /** The page's size into the terminal, and the shell's too when its rows or columns changed. */
    function fill(record) {
        const el = record.host;

        if (
            !el ||
            el.clientWidth < 40 ||
            el.clientHeight < 40 ||
            record.term.element === undefined
        ) {
            return;
        }

        try {
            record.addon.fit();
        } catch {
            // A page that hides the terminal for a frame: the next look tries again.
            return;
        }

        if (record.rows !== record.term.rows || record.cols !== record.term.cols) {
            record.rows = record.term.rows;
            record.cols = record.term.cols;
            void resize(record);
        }
    }

    async function resize(record) {
        if (record.exited !== null || record.note !== null) {
            return;
        }

        try {
            await pocket.api(
                `terminals/${record.id}/resize`,
                { rows: record.rows, cols: record.cols },
                { signal: record.abort.signal },
            );
        } catch {
            // The poll says so, if the terminal ended.
        }
    }

    /** Keys typed here: batched into the next POST, one POST at a time, in the order typed. */
    function send(record, data) {
        if (!data || record.exited !== null || record.note !== null) {
            return;
        }

        if (record.ctrl) {
            record.ctrl = false;
            data = data.length === 1 ? controlChar(data) : data;
            bump();
        }

        record.pending += data;
        void flush(record);
    }

    async function flush(record) {
        if (record.sending) {
            return;
        }

        record.sending = true;

        try {
            while (
                record.pending !== "" &&
                record.exited === null &&
                record.note === null &&
                !record.closing &&
                !stopped
            ) {
                let size = Math.min(record.pending.length, INPUT_MAX);
                const last = record.pending.charCodeAt(size - 1);

                // Never cut a character in two: a surrogate pair that straddles 2 POSTs arrives as 2 broken halves.
                if (size < record.pending.length && last >= 0xd800 && last <= 0xdbff) {
                    size--;
                }

                const chunk = record.pending.slice(0, size);

                record.pending = record.pending.slice(size);
                await pocket.api(
                    `terminals/${record.id}/input`,
                    { data: chunk },
                    { signal: record.abort.signal },
                );
            }
        } catch (failure) {
            if (failure?.status === 404 || failure?.status === 409) {
                ended(record, GONE);
            }
        } finally {
            record.sending = false;
        }

        if (
            record.pending !== "" &&
            record.exited === null &&
            record.note === null &&
            !record.closing &&
            !stopped
        ) {
            void flush(record);
        }
    }

    /** The terminal is gone on the server: keep its screen, say why, and stop asking. */
    function ended(record, why) {
        record.note = why;
        record.pending = "";
        record.ctrl = false;
        bump();
    }

    /** The terminals the poll carries: each attached one that has not ended, and is not closing. */
    function watchable() {
        return [...clients.values()].filter(
            (each) => each.exited === null && each.note === null && !each.closing,
        );
    }

    /**
     * 1 long poll for this tab, which carries every terminal it shows. A browser gives a host 6 connections, and all
     * tabs share them, so 1 poll for each terminal would take them all: 4 shells in 2 tabs would stop the app. It
     * starts again, carrying the new set, when a terminal is attached, ended, or closed; with none, it does not poll.
     */
    function sync() {
        const records = watchable();
        const key = records
            .map((each) => each.id)
            .sort()
            .join(",");

        if (key === asked) {
            return;
        }

        asked = key;
        polling?.abort();
        polling = null;

        if (records.length > 0 && !stopped) {
            void loop();
        }
    }

    async function loop() {
        const mine = new AbortController();

        polling = mine;

        try {
            while (!stopped && !mine.signal.aborted) {
                const records = watchable();

                if (records.length === 0) {
                    return;
                }

                const query = records.map((each) => `${each.id}.${each.offset}`).join(",");
                let answer;

                try {
                    answer = await pocket.api(`poll?tab=${tab}&t=${query}`, undefined, {
                        signal: mine.signal,
                    });
                } catch {
                    if (stopped || mine.signal.aborted) {
                        return;
                    }

                    // A dropped network, or a server that restarts: ask again in a moment.
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }

                if (stopped || mine.signal.aborted) {
                    return;
                }

                // Every offset moves before anything draws: a poll that starts now must not ask again for old output.
                let changed = false;

                for (const each of records) {
                    const entry = answer?.terminals?.[each.id];

                    if (!entry) {
                        continue;
                    }

                    if (entry.gone) {
                        each.note = GONE;
                        each.pending = "";
                        each.ctrl = false;
                        changed = true;
                        continue;
                    }

                    each.offset = entry.to;

                    if (entry.data) {
                        each.term.write(entry.data);
                    }

                    if (entry.exited) {
                        each.exited = entry.exitCode ?? 0;
                        each.term.write(`\r\n[ended with exit code ${each.exited}]\r\n`);
                        changed = true;
                    }
                }

                if (changed) {
                    bump();
                }
            }
        } finally {
            if (polling === mine) {
                polling = null;
            }
        }
    }

    /** A terminal the server lists, attached here: its screen, its poll, and its frames. */
    async function attach(info) {
        const existing = clients.get(info.id);

        if (existing !== undefined || stopped) {
            return existing ?? null;
        }

        const [core, sized] = await Promise.all([xterm, fit]);

        if (stopped || clients.has(info.id)) {
            return clients.get(info.id) ?? null;
        }

        const term = new core.Terminal({
            cursorBlink: true,
            fontSize: 13,
            scrollback: 2000,
            fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
            theme: theme(),
        });
        const addon = new sized.FitAddon();

        term.loadAddon(addon);

        const record = {
            id: info.id,
            title: info.title ?? "Terminal",
            cwd: info.cwd ?? "",
            term,
            addon,
            offset: 0,
            pending: "",
            sending: false,
            exited: info.exited === true ? (info.exitCode ?? 0) : null,
            note: null,
            ctrl: false,
            host: null,
            observer: null,
            rows: term.rows,
            cols: term.cols,
            /** This terminal's own calls, so a close stops its poll at once. */
            abort: new AbortController(),
            closing: false,
        };

        term.onData((data) => send(record, data));
        clients.set(info.id, record);
        bump();

        return record;
    }

    /** The list as it is now, with every live terminal attached, and one of them showing. */
    async function refresh() {
        const answer = await pocket.api("terminals", undefined, { signal: stop.signal });

        setList(answer);

        for (const each of answer) {
            if (!each.exited) {
                await attach(each);
            }
        }

        if (active === null) {
            const remembered = localStorage.getItem(LAST_ACTIVE);
            const ids = answer.filter((each) => !each.exited).map((each) => each.id);

            active = ids.includes(remembered) ? remembered : (ids[0] ?? null);
        }

        bump();

        return answer;
    }

    async function start(body) {
        try {
            const answer = await pocket.api("terminals", { ...body, rows: 24, cols: 80 });

            notice = null;
            await refresh();
            active = answer.id;
            localStorage.setItem(LAST_ACTIVE, answer.id);
        } catch (failure) {
            notice = failure?.message ?? String(failure);
        }

        bump();
    }

    /** End a terminal on the server, and forget it here: the shell gets SIGHUP. */
    async function close(record) {
        // Its poll stops first, so no request of its asks about a terminal that is gone.
        record.closing = true;
        record.pending = "";
        record.abort.abort();
        bump();

        try {
            await pocket.api(`terminals/${record.id}`, undefined, {
                method: "DELETE",
                signal: stop.signal,
            });
        } catch {
            // Gone already: the tab goes all the same.
        }

        drop(record.id);
    }

    function drop(id) {
        const record = clients.get(id);

        if (record !== undefined) {
            unmount(record);
            record.term.dispose();
            clients.delete(id);
        }

        list = list.filter((each) => each.id !== id);

        if (active === id) {
            active = [...clients.keys()][0] ?? null;
            localStorage.setItem(LAST_ACTIVE, active ?? "");
        }

        rail.update({ badge: live() });
        bump();
    }

    /** The terminals to show as tabs: the server's list, and each one this tab attached. */
    function tabs() {
        const seen = new Set();
        const rows = [];

        for (const each of list) {
            seen.add(each.id);
            rows.push({
                id: each.id,
                title: each.title,
                exited: each.exited === true ? (each.exitCode ?? 0) : null,
                note: null,
            });
        }

        for (const record of clients.values()) {
            if (!seen.has(record.id)) {
                rows.push(record);
            }
        }

        return rows;
    }

    async function choose(id) {
        const record =
            clients.get(id) ?? (await attach(list.find((each) => each.id === id) ?? { id }));

        if (record === null) {
            return;
        }

        active = id;
        localStorage.setItem(LAST_ACTIVE, id);
        bump();
    }

    async function closeTab(id) {
        const record =
            clients.get(id) ?? (await attach(list.find((each) => each.id === id) ?? { id }));

        if (record !== null) {
            await close(record);
        }
    }

    async function fromClipboard(record) {
        try {
            const text = await navigator.clipboard.readText();

            send(record, text);
        } catch {
            // The browser says no: the person pastes into a box, and Send writes it.
            pasteBox = "";
            bump();
        }
    }

    const offEvents = pocket.on("terminals", (next) => {
        if (!Array.isArray(next)) {
            return;
        }

        setList(next);

        for (const record of [...clients.values()]) {
            const found = next.find((each) => each.id === record.id);

            // An exited terminal stays a tab until the person closes it; one that vanished has ended.
            if (found === undefined && record.exited === null) {
                ended(record, GONE);
            }
        }

        for (const each of next) {
            if (!each.exited && !clients.has(each.id)) {
                void attach(each);
            }
        }
    });

    const offConversation =
        typeof pocket.onConversation === "function"
            ? pocket.onConversation((id) => {
                  conversation = id;
                  bump();
              })
            : () => {};

    function useShared() {
        const [, setVersion] = useState(0);

        useEffect(() => {
            const watch = () => setVersion(version);

            watchers.add(watch);

            return () => {
                watchers.delete(watch);
            };
        }, []);
    }

    function Terminal() {
        useShared();

        const host = useRef(null);
        const [form, setForm] = useState(null);
        const [path, setPath] = useState(() => localStorage.getItem(LAST_PATH) ?? "");
        const [selecting, setSelecting] = useState(null);
        const record = active === null ? null : (clients.get(active) ?? null);
        const mounted = useRef(null);

        // The active terminal's screen goes in the page while it shows; its shell, its poll, and its scrollback stay
        // when the page goes.
        useEffect(() => {
            const el = host.current;
            const wanted = active === null ? null : (clients.get(active) ?? null);

            if (mounted.current !== null && mounted.current !== wanted) {
                unmount(mounted.current);
                mounted.current = null;
            }

            if (el !== null && wanted !== null) {
                mount(wanted, el);
                mounted.current = wanted;
            }
        });

        useEffect(
            () => () => {
                if (mounted.current !== null) {
                    unmount(mounted.current);
                    mounted.current = null;
                }
            },
            [],
        );

        const tabRow = tabs().map(
            (tab) => html`<span class=${`terminal-tab ${tab.id === active ? "on" : ""}`}>
                <button class="terminal-tab-name" onClick=${() => void choose(tab.id)}>
                    ${tab.title}${tab.exited === null && !tab.note ? "" : " (ended)"}
                </button>
                <button
                    class="terminal-tab-x"
                    title="End this terminal"
                    onClick=${() => void closeTab(tab.id)}
                >
                    ×
                </button>
            </span>`,
        );

        const keys =
            record === null
                ? null
                : html`<div class="terminal-keys">
                      <button class="terminal-key" onClick=${() => send(record, ESC)}>Esc</button>
                      <button class="terminal-key" onClick=${() => send(record, "\t")}>Tab</button>
                      <button
                          class=${`terminal-key ${record.ctrl ? "on" : ""}`}
                          title="The next key is sent as a control character"
                          onClick=${() => {
                              record.ctrl = !record.ctrl;
                              // The next key comes from the phone's keyboard, so the terminal must hold it again.
                              record.term.focus();
                              bump();
                          }}
                      >
                          Ctrl
                      </button>
                      <button class="terminal-key" onClick=${() => send(record, arrow(record, "D"))}>
                          ←
                      </button>
                      <button class="terminal-key" onClick=${() => send(record, arrow(record, "A"))}>
                          ↑
                      </button>
                      <button class="terminal-key" onClick=${() => send(record, arrow(record, "B"))}>
                          ↓
                      </button>
                      <button class="terminal-key" onClick=${() => send(record, arrow(record, "C"))}>
                          →
                      </button>
                      <button class="terminal-key" onClick=${() => void fromClipboard(record)}>
                          Paste
                      </button>
                      <button
                          class="terminal-key"
                          title="The screen as text, to select and copy"
                          onClick=${() => setSelecting(screenText(record.term))}
                      >
                          Select
                      </button>
                  </div>`;

        return html`<div class="terminal-page">
            <p class="terminal-warn small">
                Keys typed here go straight to a shell as the server's user. Lancet Guard and Pi do not see them.
            </p>
            <div class="terminal-tabs">
                ${tabRow}
                <span class="grow"></span>
                <button
                    class="button"
                    disabled=${live() >= CAP}
                    onClick=${() => setForm(form === null ? "new" : null)}
                >
                    New
                </button>
                <button
                    class="button"
                    disabled=${record === null}
                    onClick=${() => record && void close(record)}
                >
                    Close
                </button>
            </div>
            ${
                form === null
                    ? null
                    : html`<div class="terminal-form">
                      <button
                          class="button"
                          onClick=${() => {
                              setForm(null);
                              void start({ folder: "home" });
                          }}
                      >
                          Home
                      </button>
                      ${
                          conversation === null
                              ? null
                              : html`<button
                                class="button"
                                onClick=${() => {
                                    setForm(null);
                                    void start({ folder: "session", conversation });
                                }}
                            >
                                This session's folder
                            </button>`
                      }
                      <input
                          class="terminal-path mono"
                          placeholder="Absolute path"
                          value=${path}
                          onInput=${(event) => setPath(event.currentTarget.value)}
                      />
                      <button
                          class="button primary"
                          disabled=${!path.startsWith("/")}
                          onClick=${() => {
                              localStorage.setItem(LAST_PATH, path);
                              void start({ folder: "path", path });
                              setForm(null);
                          }}
                      >
                          Start
                      </button>
                  </div>`
            }
            ${notice === null ? null : html`<div class="error-box">${notice}</div>`}
            ${record?.note ? html`<div class="error-box">${record.note}</div>` : null}
            ${
                record !== null && record.exited !== null
                    ? html`<p class="terminal-note small muted">
                      Ended with exit code ${record.exited}.
                  </p>`
                    : null
            }
            <div class="terminal-host" ref=${host}></div>
            ${
                record === null
                    ? html`<p class="terminal-note small muted">
                      No terminal yet. Press New, and pick a folder.
                  </p>`
                    : null
            }
            ${keys}
            ${
                selecting === null
                    ? null
                    : html`<div class="terminal-select">
                      <textarea class="terminal-select-text mono" readonly rows="6" value=${selecting}
                      ></textarea>
                      <div class="terminal-keys">
                          <button class="button" onClick=${() => setSelecting(null)}>Done</button>
                      </div>
                  </div>`
            }
            ${
                pasteBox === null || record === null
                    ? null
                    : html`<div class="terminal-select">
                      <textarea
                          class="terminal-select-text mono"
                          rows="3"
                          placeholder="Paste here, then Send"
                          value=${pasteBox}
                          onInput=${(event) => {
                              pasteBox = event.currentTarget.value;
                          }}
                      ></textarea>
                      <div class="terminal-keys">
                          <button
                              class="button primary"
                              onClick=${() => {
                                  if (pasteBox) {
                                      send(record, pasteBox);
                                  }

                                  pasteBox = null;
                                  bump();
                              }}
                          >
                              Send
                          </button>
                          <button
                              class="button"
                              onClick=${() => {
                                  pasteBox = null;
                                  bump();
                              }}
                          >
                              Cancel
                          </button>
                      </div>
                  </div>`
            }
        </div>`;
    }

    pocket.page({
        id: "terminal",
        title: "Terminal",
        component: Terminal,
        escape: false,
        swipe: false,
    });

    // The badge is right before the page opens, and a terminal that another tab started attaches here too.
    void refresh().catch((failure) => {
        notice = failure?.message ?? String(failure);
        bump();
    });

    pocket.onDispose(() => {
        stopped = true;
        polling?.abort();
        polling = null;
        stop.abort();
        offEvents();
        offConversation();

        for (const record of clients.values()) {
            record.closing = true;
            record.abort.abort();
            unmount(record);
            record.term.dispose();
        }

        clients.clear();
        watchers.clear();
    });
}
