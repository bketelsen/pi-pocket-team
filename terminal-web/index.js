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
/** How far xterm may draw past the ack of an open poll before that poll starts again: it would wait 25 s otherwise. */
const DRAWN_GAP = 64 * 1024;

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

/** Terminals in one poll: the 4 live ones at most, plus the ended ones that still need their last output. */
export const POLL_MAX = 16;

/** The wait before the next try of a request that failed with no answer: 0.5, 1, 2, 4 s, then every 4 s. */
export function backoffMs(attempt) {
    return Math.min(500 * 2 ** attempt, 4000);
}

/** Whether the shell must hear a size: the page's size is not the one the server has. */
export function sizeDue(sent, want) {
    return want !== null && (sent === null || sent.rows !== want.rows || sent.cols !== want.cols);
}

/**
 * The terminals one poll carries: the live ones first, then the ended ones that still need their last output, 16 at
 * most. A terminal that ended stays here until a poll has brought its buffer and its exit code together.
 */
export function pollRecords(records, max = POLL_MAX) {
    const wants = records.filter((each) => each.note === null && !each.closing && !each.final);

    return [
        ...wants.filter((each) => each.exited === null),
        ...wants.filter((each) => each.exited !== null),
    ].slice(0, max);
}

/** The longest a chunk of keys waits for the server before the tab gives up on it: 60 s, 6 times a retry's wait. */
export const GIVE_UP_MS = 60_000;

/** Whether a chunk that has gone unanswered since `startedAt` may be tried again at `now`. */
export function retryAllowed(startedAt, now) {
    return now - startedAt < GIVE_UP_MS;
}

/**
 * What a failed request means: a 404 is a terminal that is gone, a 409 is a shell that has exited (so its last output
 * still comes in a poll), and anything else is worth another try.
 */
export function afterFailure(status) {
    if (status === 404) {
        return "gone";
    }

    if (status === 409) {
        return "closed";
    }

    return "retry";
}

/** A wait that a close or a stop need not cut short: the caller looks at its own flags after it. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    /** Whether a restart of the poll waits for the current answer to be taken in. */
    let restartQueued = false;
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

        const want = record.want;

        if (want === null || want.rows !== record.term.rows || want.cols !== record.term.cols) {
            record.want = serverSize(record.term.rows, record.term.cols);
            void pushSize(record);
        }
    }

    /** A size the server takes: rows of 2 to 500 and columns of 2 to 1000, as its route asks for. */
    function serverSize(rows, cols) {
        return {
            rows: Math.min(Math.max(rows, 2), 500),
            cols: Math.min(Math.max(cols, 2), 1000),
        };
    }

    /**
     * Whether this terminal can still hear anything: it has not ended, this tab still shows it, its shell has not said
     * that it went (a 409), and the module is on.
     */
    function usable(record) {
        return (
            !stopped &&
            !record.closing &&
            record.exited === null &&
            record.note === null &&
            !record.inputClosed
        );
    }

    /** Whether keys can go now: the terminal is there, and no chunk waits for a Discard. */
    function typable(record) {
        return usable(record) && record.lost === null;
    }

    /**
     * 1 resize POST at a time. A failed POST is tried again with a bounded wait, and a size that changed while one was
     * in flight goes right after it: the shell always ends at the size the page shows.
     */
    async function pushSize(record) {
        const want = record.want;

        if (record.resizing || !usable(record) || !sizeDue(record.sent, want)) {
            return;
        }

        record.resizing = true;

        try {
            for (let attempt = 0; ; attempt++) {
                if (!usable(record)) {
                    return;
                }

                try {
                    await pocket.api(
                        `terminals/${record.id}/resize`,
                        { rows: want.rows, cols: want.cols },
                        { signal: record.abort.signal },
                    );
                    record.sent = want;
                    break;
                } catch (failure) {
                    const what = afterFailure(failure?.status);

                    if (what === "gone") {
                        ended(record, GONE);

                        return;
                    }

                    if (what === "closed") {
                        // The shell exited: its last output comes in a poll, and a size means nothing to it now.
                        record.inputClosed = true;
                        bump();

                        return;
                    }

                    if (!usable(record)) {
                        return;
                    }

                    await delay(backoffMs(attempt));
                }
            }
        } finally {
            record.resizing = false;
        }

        void pushSize(record);
    }

    /** Keys typed here: batched into the next POST, one at a time and in the order typed. */
    function send(record, data) {
        if (!data || !typable(record)) {
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

    /**
     * 1 POST at a time, in the order typed. A chunk leaves `pending` before the POST but stays in hand until the server
     * has it: a POST that fails goes again with the same chunk and the same seq, which the server writes once.
     */
    async function flush(record) {
        if (record.sending || !typable(record)) {
            return;
        }

        record.sending = true;

        try {
            while (record.pending !== "" && typable(record)) {
                let size = Math.min(record.pending.length, INPUT_MAX);
                const last = record.pending.charCodeAt(size - 1);

                // Never cut a character in two: a surrogate pair that straddles 2 POSTs arrives as 2 broken halves.
                if (size < record.pending.length && last >= 0xd800 && last <= 0xdbff) {
                    size--;
                }

                const chunk = record.pending.slice(0, size);
                const seq = record.seq + 1;
                const startedAt = Date.now();

                record.pending = record.pending.slice(size);

                for (let attempt = 0; ; attempt++) {
                    // 60 s with no answer: the text stays for a Discard, and this chunk never goes again by itself.
                    if (!retryAllowed(startedAt, Date.now())) {
                        record.lost = { text: chunk, seq };
                        record.waiting = false;
                        bump();

                        return;
                    }

                    try {
                        await pocket.api(
                            `terminals/${record.id}/input`,
                            { data: chunk, tab, seq },
                            { signal: record.abort.signal },
                        );
                        record.seq = seq;
                        break;
                    } catch (failure) {
                        const what = afterFailure(failure?.status);

                        if (what === "gone") {
                            ended(record, GONE);

                            return;
                        }

                        if (what === "closed") {
                            // The shell exited: its last output still comes in a poll, and no key can reach it.
                            record.inputClosed = true;
                            record.waiting = false;
                            bump();

                            return;
                        }

                        if (!typable(record)) {
                            return;
                        }

                        // No answer: the text waits here, and the same seq goes again, which the server writes once.
                        if (!record.waiting) {
                            record.waiting = true;
                            bump();
                        }

                        await delay(backoffMs(attempt));

                        if (!typable(record)) {
                            return;
                        }
                    }
                }
            }
        } finally {
            record.sending = false;

            if (record.waiting) {
                record.waiting = false;
                bump();
            }
        }

        if (record.pending !== "" && typable(record)) {
            void flush(record);
        }
    }

    /** Drops the text that could not be delivered: the next keys go out with a seq past it. */
    function discard(record) {
        if (record.lost === null) {
            return;
        }

        record.seq = Math.max(record.seq, record.lost.seq);
        record.lost = null;
        bump();
        void flush(record);
    }

    /** The terminal is gone on the server: keep its screen, say why, and stop asking. */
    function ended(record, why) {
        record.note = why;
        record.pending = "";
        record.ctrl = false;
        bump();
    }

    /**
     * The terminals the poll carries: each attached one that has not ended, and each that ended but has not had its
     * last output yet, 16 at most and the live ones first.
     */
    function watchable() {
        return pollRecords([...clients.values()]);
    }

    /** Starts this tab's poll again, with the ack that xterm has drawn now: a paused shell goes on at once. */
    function restartPoll() {
        asked = "";
        sync();
    }

    /**
     * xterm has drawn up to `to`. An open poll that carries an older ack would wait for output that only a newer ack
     * unlocks: past 64 K of that, the poll starts again. It starts in a task, so this answer's offsets are all in
     * first.
     */
    function markDrawn(record, to) {
        record.drawn = to;

        if (record.drawn - record.ackSent <= DRAWN_GAP || stopped || polling === null) {
            return;
        }

        if (restartQueued) {
            return;
        }

        restartQueued = true;
        setTimeout(() => {
            restartQueued = false;
            restartPoll();
        }, 0);
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

                // The ack each poll carries, for the restart that a fast screen asks for.
                for (const each of records) {
                    each.ackSent = each.drawn;
                }

                // `from` is what this tab has received; `drawn` is what its screen has drawn.
                const query = records
                    .map((each) => `${each.id}.${each.received}.${each.drawn}`)
                    .join(",");
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
                    await delay(2000);
                    continue;
                }

                if (stopped || mine.signal.aborted) {
                    return;
                }

                let changed = false;
                let failed = false;

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

                    // The text is received at once, and drawn a moment later: `drawn` moves in xterm's callback, and
                    // the server's back pressure follows it, so what waits undrawn stays small.
                    if (entry.data) {
                        try {
                            each.term.write(entry.data, () => markDrawn(each, entry.to));
                        } catch (failure) {
                            each.note = `This tab could not draw the screen: ${failure?.message ?? "it gave no reason"}.`;
                            changed = true;
                            failed = true;
                            break;
                        }
                    }

                    each.received = entry.to;

                    if (entry.exited) {
                        each.exited = entry.exitCode ?? 0;
                        each.final = true;
                        changed = true;

                        try {
                            each.term.write(`\r\n[ended with exit code ${each.exited}]\r\n`);
                        } catch {
                            // A screen that already went: the tab's own line says how the shell ended.
                        }
                    }
                }

                if (changed) {
                    bump();
                }

                // A screen that cannot draw: this terminal stops polling, and sync() starts the tab's poll again
                // for the rest.
                if (failed) {
                    return;
                }
            }
        } finally {
            // Every way out of the loop leaves it able to start again: an empty set, a stop, or a screen that failed.
            if (polling === mine) {
                polling = null;
                asked = "";
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
            /** The offset this tab has received, and the offset xterm has drawn (the poll's `ack`). */
            received: 0,
            drawn: 0,
            ackSent: 0,
            /** The last seq this tab had written to the shell, and the keys that wait for it. */
            seq: 0,
            pending: "",
            sending: false,
            waiting: false,
            /** Set when the shell says it exited (a 409): no key and no size goes out again, and the poll goes on. */
            inputClosed: false,
            /** A chunk that went unanswered for 60 s: its text waits for a Discard, and its seq is spent. */
            lost: null,
            exited: info.exited === true ? (info.exitCode ?? 0) : null,
            /** Whether this tab has its last output: an answer with `exited` came, so the poll is done with it. */
            final: false,
            note: null,
            ctrl: false,
            host: null,
            observer: null,
            /** The size the page wants, and the size the server has. */
            want: null,
            sent: null,
            resizing: false,
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

        // Every terminal the server lists, ended ones too: an ended one fetches its last output once, then stops.
        for (const each of answer) {
            await attach(each);
        }

        if (active === null) {
            const remembered = localStorage.getItem(LAST_ACTIVE);
            const ids = answer.filter((each) => !each.exited).map((each) => each.id);

            active = ids.includes(remembered) ? remembered : (ids[0] ?? answer[0]?.id ?? null);
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

            // Through xterm, so a shell that asked for bracketed paste gets it, and the keys stay in order.
            record.term.paste(text);
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

        let changed = false;

        for (const record of [...clients.values()]) {
            const found = next.find((each) => each.id === record.id);

            if (found === undefined) {
                if (record.exited === null && !record.final) {
                    // It vanished from the list: the server forgot it, and no poll will say more.
                    ended(record, GONE);
                } else {
                    record.final = true;
                }

                continue;
            }

            // It ended: its last output and its exit code come together in the next poll, so it stays watchable.
            if (found.exited === true && record.exited === null) {
                record.exited = found.exitCode ?? 0;
                changed = true;
            }
        }

        for (const each of next) {
            if (!clients.has(each.id)) {
                void attach(each);
            }
        }

        if (changed) {
            bump();
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
            ${
                record?.waiting
                    ? html`<p class="terminal-note small muted">
                          Input waits for the server…
                      </p>`
                    : null
            }
            ${
                record?.lost
                    ? html`<p class="terminal-note small">
                          ${record.lost.text.length} characters may not have reached the shell.
                          <button class="button" onClick=${() => discard(record)}>Discard</button>
                      </p>`
                    : null
            }
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
                                      record.term.paste(pasteBox);
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
        asked = "";
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
