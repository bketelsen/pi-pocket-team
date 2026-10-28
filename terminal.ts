/**
 * Terminal: an owner-only rail page that runs a login shell as the server's user, in a folder the owner picks, shown in
 * xterm.js in the browser.
 *
 * The shell runs on a pseudo-terminal, made by a small Python helper that this file carries and runs with `python3 -I`.
 * Its stdout is the pty's output; its stdin takes frames: "d" for input bytes, "r" for a resize. The browser gets the
 * output through one long poll for each tab, at 25 s at most, which carries every terminal that tab shows: a browser
 * gives a host 6 connections, and one poll for each terminal would take them all. Input and resize are small POSTs: no
 * websocket, and no token in an address. Every route is the owner's alone, and the app's own sign-in and `X-Pocket`
 * check come first.
 *
 * Memory holds the last 256 K characters of each shell's output, so a tab that reloads gets its screen back. Each tab
 * names itself in its poll, and a shell reads only as fast as its slowest tab: the output pauses when the oldest tab
 * that still watches is half a buffer behind. Nothing here writes a keystroke or output to the log. A shell ends on
 * `DELETE`, when the shell exits, 60 s after the last output poll, 60 minutes after the last input, or when this
 * module goes.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Web, WebRequest } from "./_pocket.d.ts";

export const pocketApi = 2;

/**
 * The pty helper, run as `python3 -I -c <this> <shell> <folder> <rows> <cols>`. It is a pty in front of one login
 * shell, framed input on stdin, and it carries the shell's exit code. When the pty gives EOF, the helper keeps reading
 * stdin, so a shell that closed its own fds and runs on is still ended by a closed stdin.
 */
const HELPER = `import errno, fcntl, os, pty, select, signal, struct, sys, termios, time

shell, cwd, rows, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
pid, master = pty.fork()
if pid == 0:
    for sig in (signal.SIGPIPE, signal.SIGXFSZ, signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, signal.SIG_DFL)
    try:
        os.chdir(cwd)
    except OSError:
        os.chdir(os.environ.get("HOME", "/"))
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.execv(shell, ["-" + os.path.basename(shell)])


status = None


def reaped():
    global status
    try:
        done, waited = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return True
    if done != 0:
        status = waited
        return True
    return False


def end(code):
    for sig, grace in ((signal.SIGHUP, 2.0), (signal.SIGKILL, 1.0)):
        try:
            os.killpg(pid, sig)
        except OSError:
            break
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and not reaped():
            time.sleep(0.05)
    os._exit(code)


signal.signal(signal.SIGTERM, lambda *_: end(143))
signal.signal(signal.SIGHUP, lambda *_: end(129))
os.set_blocking(master, False)
inbuf = b""
pending = b""
try:
    while True:
        writers = [master] if pending else []
        r, w, _ = select.select([master, 0], writers, [])
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            view = memoryview(data)
            while view:
                view = view[os.write(1, view):]
        if master in w:
            try:
                pending = pending[os.write(master, pending):]
            except BlockingIOError:
                pass
        if 0 in r:
            chunk = os.read(0, 65536)
            if not chunk:
                end(129)
            inbuf += chunk
            while len(inbuf) >= 5:
                size = struct.unpack(">I", inbuf[1:5])[0]
                if len(inbuf) < 5 + size:
                    break
                kind, body, inbuf = inbuf[0:1], inbuf[5 : 5 + size], inbuf[5 + size :]
                if kind == b"d":
                    pending += body
                elif kind == b"r" and size == 4:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", *struct.unpack(">HH", body), 0, 0))
except BaseException:
    end(1)
while not reaped():
    try:
        ready = select.select([0], [], [], 0.2)[0]
    except (OSError, ValueError):
        ready = []
    if ready:
        try:
            chunk = os.read(0, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            end(129)
sys.exit(0 if status is None else (os.waitstatus_to_exitcode(status) & 0xFF))
`;

/** Terminals at once: a 5th start answers 429. */
const CAP = 4;
/** The output kept for a tab that reloads, and the most that one answer carries. */
const KEEP = 256 * 1024;
/** How long a poll waits for output before it answers with none. */
const POLL_MS = 25_000;
/** How often the timers are checked. */
const TICK_MS = 5_000;
/** How long an exited terminal stays in the list, so a poll can show how it ended. */
const GRACE_MS = 60_000;
/** The most input in one POST. */
const INPUT_MAX = 32 * 1024;
/** The most terminals in one poll: the 4 live ones at most, plus exited ones that wait for their last output. */
const POLL_MAX = 16;
/** How long a tab counts for back pressure after its last poll: a poll waits 25 s, and 5 s is the margin. */
const TAB_MS = 30_000;
/** Tabs that one terminal keeps for back pressure: the oldest goes. */
const TABS_MAX = 16;
/** A tab's id in a poll: 1 to 64 letters, digits, and dashes. */
const TAB_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A terminal with no output poll for this long has no tab: end it. Tests set the environment variable lower. */
const DETACH_MS = span(process.env.PI_POCKET_TERMINAL_DETACH_MS, 60_000);
/** A terminal with no input for this long is idle: end it. Tests set the environment variable lower. */
const IDLE_MS = span(process.env.PI_POCKET_TERMINAL_IDLE_MS, 60 * 60_000);
/** The user's own login shell, unless a test names another one. */
const SHELL = process.env.PI_POCKET_TERMINAL_SHELL || userInfo().shell || "/bin/bash";

/** The server's environment variables a shell may have: no key, token, or Pi Pocket variable goes through. */
const ALLOWED = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "TZ",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
]);

/** What one tab last said about one terminal: the offset it asked from, and when. */
interface Watcher {
    offset: number;
    seen: number;
}

/** The last input a tab had written: its sequence number, and when the tab last sent one. */
interface Written {
    seq: number;
    seen: number;
}

/** 1 terminal in a poll's answer: its output from an offset, or the news that it is gone. */
type Answer =
    | { gone: true }
    | { data: string; from: number; to: number; exited?: boolean; exitCode?: number | null };

interface Terminal {
    readonly id: string;
    readonly title: string;
    readonly cwd: string;
    readonly startedAt: number;
    readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
    readonly decoder: StringDecoder;
    /** The last KEEP characters of the output; `total` counts every character since the start. */
    output: string;
    total: number;
    /** The highest offset any poll has asked for: the output after it is not read from the helper. */
    asked: number;
    /** One entry for each tab that watches this terminal: the offset it asked from, and when it last polled. */
    tabs: Map<string, Watcher>;
    /** One entry for each tab that typed into this terminal: the last sequence number it wrote. */
    sequences: Map<string, Written>;
    lastPoll: number;
    lastInput: number;
    /** Output polls in progress now. */
    polls: number;
    /** Whether the helper's stdout is paused, because a tab is more than KEEP characters behind. */
    paused: boolean;
    exited: boolean;
    exitCode: number | null;
    exitedAt: number;
    /** Ended, and waiting for its helper: no route finds it, and no poll waits on it. */
    gone: boolean;
    waiters: Set<() => void>;
}

/** A span from an environment variable, in ms, or the default: a test lowers the detach and idle spans so. */
function span(value: string | undefined, fallback: number): number {
    const given = Number(value);

    return value !== undefined && Number.isFinite(given) && given >= 0 ? given : fallback;
}

/** Only the server's own variables that the allowlist names, and the 2 a terminal needs. */
function environment(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && (ALLOWED.has(name) || name.startsWith("LC_"))) {
            env[name] = value;
        }
    }

    env.HOME ??= homedir();
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";

    return env;
}

async function isFolder(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

export default function createTerminal(_host: unknown, web: Web) {
    const terminals = new Map<string, Terminal>();
    /** Set when the module goes: a start that was in flight then never spawns a helper. */
    let disposed = false;

    type Handler = (request: WebRequest) => unknown;

    /** A route that only the owner may use: everyone else gets the 404 of a route that is not there. */
    const only =
        (handle: Handler): Handler =>
        (request) => {
            if (request.user.role !== "owner") {
                throw web.error(404, "No such terminal");
            }

            return handle(request);
        };

    function list(): unknown[] {
        return [...terminals.values()]
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((record) => ({
                id: record.id,
                title: record.title,
                cwd: record.cwd,
                startedAt: record.startedAt,
                ...(record.exited ? { exited: true, exitCode: record.exitCode } : {}),
            }));
    }

    /** After every change of the list: the rail badge in each tab counts the live ones. */
    function announce(): void {
        web.send("terminals", list());
    }

    function wake(record: Terminal): void {
        for (const resolve of [...record.waiters]) {
            resolve();
        }

        record.waiters.clear();
    }

    /**
     * Wait until any of these terminals changes, the browser stops waiting, or `timeoutMs` passes. One poll carries
     * several terminals, so one waiter goes in each of their sets and any of them wakes the poll.
     */
    function waitAny(
        records: readonly Terminal[],
        signal: AbortSignal,
        timeoutMs: number,
    ): Promise<void> {
        return new Promise((resolve) => {
            let timer: NodeJS.Timeout | undefined;

            const done = () => {
                clearTimeout(timer);

                for (const record of records) {
                    record.waiters.delete(done);
                }

                signal.removeEventListener("abort", done);
                resolve();
            };

            timer = setTimeout(done, Math.max(0, timeoutMs));

            for (const record of records) {
                record.waiters.add(done);
            }

            signal.addEventListener("abort", done, { once: true });

            if (signal.aborted) {
                done();
            }
        });
    }

    /**
     * Drops the tabs that stopped being seen, and all but the 16 seen most recently. A poll's tabs and a terminal's
     * input sequences are bounded the same way.
     */
    function bounded<T extends { seen: number }>(map: Map<string, T>, now: number): void {
        for (const [id, entry] of map) {
            if (now - entry.seen >= TAB_MS) {
                map.delete(id);
            }
        }

        while (map.size > TABS_MAX) {
            let oldest: string | undefined;
            let seen = Infinity;

            for (const [id, entry] of map) {
                if (entry.seen < seen) {
                    seen = entry.seen;
                    oldest = id;
                }
            }

            map.delete(oldest!);
        }
    }

    /**
     * The offset that back pressure measures the output against: the oldest tab that still watches. A tab that is gone,
     * or a terminal that no tab has polled, leaves the highest offset asked for.
     */
    function watched(record: Terminal): number {
        let oldest: number | undefined;

        for (const tab of record.tabs.values()) {
            oldest = oldest === undefined ? tab.offset : Math.min(oldest, tab.offset);
        }

        return oldest ?? record.asked;
    }

    /**
     * A tab that is more than KEEP / 2 characters behind stops the helper's output, as a full pipe does on a real one:
     * with the tabs seen, the shell writes only as fast as the slowest one reads. With no tab that watches, the last
     * offset asked for is the measure, until the detach timer ends the terminal.
     */
    function pressure(record: Terminal): void {
        if (record.exited || record.gone) {
            return;
        }

        const behind = record.total - watched(record);

        // Half the buffer, so a pipe read that comes in after the line (64 KB at most) still leaves a tab's offset in it.
        if (!record.paused && behind > KEEP / 2) {
            record.child.stdout.pause();
            record.paused = true;
        } else if (record.paused && behind <= KEEP / 2) {
            record.child.stdout.resume();
            record.paused = false;
        }
    }

    /**
     * A poll's offset: the tab that sent it, and the highest offset any request has sent. A tab's offset is all that
     * counts against it: an answer that the server builds acknowledges nothing.
     */
    function claim(record: Terminal, tab: string | undefined, offset: number): void {
        record.asked = Math.max(record.asked, offset);

        if (tab !== undefined) {
            record.tabs.set(tab, { offset, seen: Date.now() });
            bounded(record.tabs, Date.now());
        }

        pressure(record);
    }

    function append(record: Terminal, text: string): void {
        if (text === "") {
            return;
        }

        record.total += text.length;
        record.output =
            record.output.length + text.length > KEEP
                ? (record.output + text).slice(-KEEP)
                : record.output + text;
        wake(record);
        pressure(record);
    }

    /** One frame for the helper: 1 byte kind, a 4-byte length, then the body. */
    function frame(record: Terminal, kind: "d" | "r", body: Buffer): void {
        const head = Buffer.alloc(5);

        head[0] = kind.charCodeAt(0);
        head.writeUInt32BE(body.length, 1);
        record.child.stdin.write(Buffer.concat([head, body]));
    }

    function markExited(record: Terminal, code: number | null): void {
        if (record.exited) {
            return;
        }

        record.exited = true;
        record.exitCode = code;
        record.exitedAt = Date.now();

        if (record.gone) {
            return;
        }

        wake(record);
        announce();
    }

    /** End a terminal now: it leaves the list, and a poll that waits on it gets a 404. */
    function stop(record: Terminal): void {
        if (record.gone) {
            return;
        }

        terminals.delete(record.id);
        record.gone = true;
        wake(record);

        if (!record.exited) {
            // A paused helper is stuck in a write to its stdout and never reads its stdin: let its output drain.
            record.child.stdout.resume();
            record.paused = false;

            try {
                // A closed stdin is how the helper hears that the terminal is over: SIGHUP, then SIGKILL after 2 s.
                record.child.stdin.end();
            } catch {
                // Already closed: nothing to end.
            }

            // A helper that is still there after 5 s is killed: its pty closes, and the kernel hangs up the shell.
            const limit = setTimeout(() => {
                if (!record.exited) {
                    record.child.kill("SIGKILL");
                }
            }, 5_000);

            limit.unref();
        }

        announce();
    }

    /** Close a terminal, and resolve when its helper has exited: never longer than 3 s. */
    function close(record: Terminal): Promise<void> {
        const done = record.exited
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                  const limit = setTimeout(resolve, 3_000);

                  limit.unref();
                  record.child.once("close", () => {
                      clearTimeout(limit);
                      resolve();
                  });
              });

        stop(record);

        return done;
    }

    function find(request: WebRequest): Terminal {
        const record = terminals.get(request.params.id ?? "");

        if (record === undefined || record.gone) {
            throw web.error(404, "No such terminal");
        }

        return record;
    }

    /** Rows 2 to 500, columns 2 to 1000; a number that is not one, or a missing one a caller needs, is a 400. */
    function dimension(value: unknown, fallback: number | undefined, max: number): number {
        if (value === undefined) {
            if (fallback === undefined) {
                throw web.error(400, "Give rows and cols.");
            }

            return fallback;
        }

        if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value > max) {
            throw web.error(
                400,
                `Give rows of 2 to 500 and cols of 2 to 1000, not ${String(value)}.`,
            );
        }

        return value;
    }

    /** The folder a shell starts in: the user's home, a session's, or an absolute path that exists. */
    async function folder(request: WebRequest): Promise<string> {
        const kind = request.body.folder ?? "home";

        if (kind === "home") {
            return homedir();
        }

        if (kind === "session") {
            const id = Number(request.body.conversation);
            const session = request.sessions().find((each) => each.id === id);

            if (session === undefined) {
                throw web.error(404, "No such session");
            }

            return session.cwd;
        }

        if (kind === "path") {
            const path = typeof request.body.path === "string" ? request.body.path : "";

            if (!isAbsolute(path) || !(await isFolder(path))) {
                throw web.error(400, "Give an absolute path to a folder that exists.");
            }

            return path;
        }

        throw web.error(400, 'Give folder as "home", "session", or "path".');
    }

    /** The terminals that are running now: the live ones count against the cap. */
    function live(): number {
        return [...terminals.values()].filter((each) => !each.exited).length;
    }

    /** The answers of a start that must not begin: the module is going, or the server is full. */
    function refuse(): void {
        if (disposed) {
            throw web.error(503, "This module is going: try again in a moment.");
        }

        if (live() >= CAP) {
            throw web.error(429, `A server runs ${CAP} terminals at once: close one first.`);
        }
    }

    async function start(request: WebRequest): Promise<unknown> {
        refuse();

        // The folder is checked with an await: the module can go, or other shells can start, in the meantime.
        const cwd = await folder(request);
        const rows = dimension(request.body.rows, 24, 500);
        const cols = dimension(request.body.cols, 80, 1000);

        // The last await was the folder: this check and the spawn have no await between them, so no shell of this
        // module starts after it went, and the cap cannot be passed by 2 starts at once.
        refuse();

        const child = spawn(
            "python3",
            ["-I", "-c", HELPER, SHELL, cwd, String(rows), String(cols)],
            { cwd, env: environment(), stdio: ["pipe", "pipe", "pipe"] },
        );
        const record: Terminal = {
            id: randomUUID(),
            title: basename(cwd) || cwd,
            cwd,
            startedAt: Date.now(),
            child,
            decoder: new StringDecoder("utf8"),
            output: "",
            total: 0,
            asked: 0,
            tabs: new Map(),
            sequences: new Map(),
            lastPoll: Date.now(),
            lastInput: Date.now(),
            polls: 0,
            paused: false,
            exited: false,
            exitCode: null,
            exitedAt: 0,
            gone: false,
            waiters: new Set(),
        };

        child.stdout.on("data", (chunk: Buffer) => append(record, record.decoder.write(chunk)));
        // The helper's own words are its failure and not the shell's output: read, and never logged.
        child.stderr.resume();
        // A shell that ends takes the last write with it, and a dying helper can end in the middle of a frame.
        child.stdin.on("error", () => {});
        // "close", not "exit": the output that the helper wrote before it exited is all read first.
        child.on("close", (code) => {
            append(record, record.decoder.end());
            markExited(record, code);
        });
        child.on("error", (error) => {
            // The one thing this module says in the server's log: no shell started.
            console.error(`Terminal: could not start ${SHELL}: ${error.message}`);
            markExited(record, null);
        });

        terminals.set(record.id, record);
        announce();

        return { id: record.id };
    }

    /** The `t` query of a poll: `id.from` entries, POLL_MAX at most. */
    function entries(request: WebRequest): { id: string; from: number }[] {
        const text = request.query.get("t") ?? "";

        if (text === "") {
            throw web.error(400, 'Give t as "id.from,id.from".');
        }

        const asked = text.split(",").map((entry) => {
            const parts = entry.split(".");
            const digits = parts[1] ?? "";

            if (parts.length !== 2 || parts[0] === "" || !/^\d+$/.test(digits)) {
                throw web.error(400, `A poll entry is "id.from", not ${JSON.stringify(entry)}.`);
            }

            return { id: parts[0]!, from: Number(digits) };
        });

        if (asked.length > POLL_MAX) {
            throw web.error(400, `A poll carries ${POLL_MAX} terminals at most.`);
        }

        return asked;
    }

    /** Where a tab's offset is in a terminal's buffer: never before its start, and never past its end. */
    function offsetOf(record: Terminal, from: number): number {
        return Math.min(Math.max(from, record.total - record.output.length), record.total);
    }

    /**
     * What one terminal has for a poll, or nothing when it has nothing new. A terminal that ended, or that is gone, is
     * always an answer: the tab must hear it without waiting 25 s.
     */
    function progress(record: Terminal, from: number): Answer | undefined {
        if (record.gone) {
            return { gone: true };
        }

        // A tab that is older than the buffer gets it from its start: it lost what came before.
        const offset = offsetOf(record, from);

        if (record.total > offset || record.exited) {
            const data = record.output.slice(offset - (record.total - record.output.length));

            return {
                data,
                from: offset,
                to: offset + data.length,
                ...(record.exited ? { exited: true, exitCode: record.exitCode } : {}),
            };
        }

        return undefined;
    }

    /** The `tab` query: the id of the tab that polls, which back pressure follows. It is optional, and checked. */
    function tabId(request: WebRequest): string | undefined {
        const tab = request.query.get("tab") ?? undefined;

        if (tab !== undefined && !TAB_ID.test(tab)) {
            throw web.error(400, "Give tab as 1 to 64 letters, digits, and dashes.");
        }

        return tab;
    }

    /** The `tab` of an input POST: the same id, and there it is needed, because each tab numbers its own chunks. */
    function inputTab(request: WebRequest): string {
        const tab = request.body.tab;

        if (typeof tab !== "string" || !TAB_ID.test(tab)) {
            throw web.error(400, "Give tab as 1 to 64 letters, digits, and dashes.");
        }

        return tab;
    }

    /**
     * One long poll for a tab: the output of every terminal that it names, by id. A tab keeps 1 connection for the tab
     * and not 1 for each terminal, which would take all 6 that a browser gives a host.
     *
     * It answers at once when any named terminal has output past its offset, has exited, or is gone (a nameless id
     * counts as gone). Else it waits up to 25 s, and then answers with an empty entry for each terminal it named.
     */
    async function poll(request: WebRequest): Promise<unknown> {
        const deadline = Date.now() + POLL_MS;
        const tab = tabId(request);
        const now = Date.now();
        const listed = entries(request).map((each) => {
            const record = terminals.get(each.id);

            if (record === undefined || record.gone) {
                return { id: each.id, record: undefined, from: each.from };
            }

            // A poll is what keeps a terminal from the detach timer: each one a poll names counts, and is claimed.
            record.polls++;
            record.lastPoll = now;
            claim(record, tab, each.from);

            return { id: each.id, record, from: each.from };
        });
        const live = listed.flatMap((each) => (each.record === undefined ? [] : [each.record]));

        try {
            for (;;) {
                const answer: Record<string, Answer> = {};
                let ready = false;

                for (const each of listed) {
                    const state: Answer | undefined =
                        each.record === undefined
                            ? { gone: true }
                            : progress(each.record, each.from);

                    if (state !== undefined) {
                        answer[each.id] = state;
                        ready = true;
                    }
                }

                if (ready) {
                    return { terminals: answer };
                }

                const left = deadline - Date.now();

                if (request.signal.aborted || left <= 0) {
                    // Nothing new, or nobody is waiting: an empty entry for each terminal, so a tab keeps its offsets.
                    for (const each of listed) {
                        const offset =
                            each.record === undefined ? 0 : offsetOf(each.record, each.from);

                        answer[each.id] ??=
                            each.record === undefined
                                ? { gone: true }
                                : { data: "", from: offset, to: offset };
                    }

                    return { terminals: answer };
                }

                await waitAny(live, request.signal, left);
            }
        } finally {
            for (const record of live) {
                record.polls--;
            }
        }
    }

    /**
     * Keys from one tab. The tab numbers its chunks, so a POST that fails on the way keeps its text: the tab sends the
     * same chunk again with the same sequence number, and this route writes it once. A number that is not newer than
     * the last one a tab wrote is an answer with nothing written, because the tab already sent it.
     */
    function input(request: WebRequest): unknown {
        const record = find(request);
        const data = request.body.data;
        const tab = inputTab(request);
        const seq = request.body.seq;

        if (typeof data !== "string") {
            throw web.error(400, "Give data as text.");
        }

        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
            throw web.error(400, "Give seq as a positive whole number.");
        }

        if (data.length > INPUT_MAX) {
            throw web.error(413, `Send at most ${INPUT_MAX} characters at a time.`);
        }

        if (record.exited) {
            throw web.error(409, "This terminal has ended.");
        }

        const now = Date.now();
        const last = record.sequences.get(tab)?.seq ?? 0;

        record.sequences.set(tab, { seq: Math.max(last, seq), seen: now });
        bounded(record.sequences, now);

        // The same chunk again, or an older one: the shell already has it.
        if (seq <= last) {
            return {};
        }

        if (data !== "") {
            record.lastInput = now;
            frame(record, "d", Buffer.from(data, "utf8"));
        }

        return {};
    }

    function resize(request: WebRequest): unknown {
        const record = find(request);
        const rows = dimension(request.body.rows, undefined, 500);
        const cols = dimension(request.body.cols, undefined, 1000);

        if (record.exited) {
            throw web.error(409, "This terminal has ended.");
        }

        const body = Buffer.alloc(4);

        body.writeUInt16BE(rows, 0);
        body.writeUInt16BE(cols, 2);
        frame(record, "r", body);

        return {};
    }

    function remove(request: WebRequest): unknown {
        stop(find(request));

        return {};
    }

    /** The one timer: a detached shell or an idle one ends, and an exited one leaves the list after 60 s. */
    function check(): void {
        const now = Date.now();

        for (const record of [...terminals.values()]) {
            // A tab that stopped polling no longer holds the output back.
            bounded(record.tabs, now);

            if (record.exited) {
                if (now - record.exitedAt >= GRACE_MS) {
                    terminals.delete(record.id);
                    announce();
                }
            } else if (record.polls === 0 && now - record.lastPoll >= DETACH_MS) {
                stop(record);
            } else if (now - record.lastInput >= IDLE_MS) {
                stop(record);
            } else {
                pressure(record);
            }
        }
    }

    web.route(
        "GET",
        "terminals",
        only(() => list()),
    );
    web.route("POST", "terminals", only(start));
    web.route("GET", "poll", only(poll));
    web.route("POST", "terminals/:id/input", only(input));
    web.route("POST", "terminals/:id/resize", only(resize));
    web.route("DELETE", "terminals/:id", only(remove));
    web.client("terminal-web");

    const timer = setInterval(check, TICK_MS);

    timer.unref();

    web.onDispose(async () => {
        disposed = true;
        clearInterval(timer);

        const exits = [...terminals.values()].map((record) => close(record));

        await Promise.race([
            Promise.allSettled(exits),
            new Promise((resolve) => {
                const limit = setTimeout(resolve, 3_000);

                limit.unref();
            }),
        ]);
    });
}
