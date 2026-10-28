// Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createHandler } from "./_pocket/src/server/http.ts";
// The module itself, for the 1 test of a start that is in flight when the module goes: it uses a fake `web`.
import createTerminal from "./terminal.ts";

/** A folder with nothing of the user's in it: the login shell reads no dotfile, and `pwd` is easy to see. */
const home = join(root, "terminal-home");
const fixture = join(root, "terminal-fixture");
const sessionFolder = join(root, "terminal-session");

mkdirSync(home, { recursive: true });
mkdirSync(fixture, { recursive: true });
mkdirSync(sessionFolder, { recursive: true });

// Before the module loads: its shell reads this home, and this module's shell is the one the test can replace.
process.env.HOME = home;
process.env.PI_POCKET_TERMINAL_SHELL = "/bin/bash";
// A variable of the test's own, which the shell must not see.
process.env.TERMINAL_TEST_SECRET = "hunter2";

const tokens: Record<string, string> = {};
/** The output each terminal has given a test so far, and the offset the next poll asks from. */
const outputs = new Map<string, { offset: number; text: string }>();

let app: Awaited<ReturnType<typeof openApp>>;
let server: ReturnType<typeof createServer>;
let origin = "";

after(cleanUp);

/** Every test starts with no shell of its own, whether it passed or not: the module's cap is 4. */
afterEach(async () => {
    try {
        const answer = await call("owner", "terminals");

        if (answer.status !== 200) {
            return;
        }

        for (const each of answer.data as { id: string }[]) {
            await call("owner", `terminals/${each.id}`, { method: "DELETE" }).catch(() => {});
        }
    } catch {
        // The module is off, or the app is going: nothing to end.
    }
});

before(async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "terminal.ts"), join(dropIns, "terminal.ts"));
    cpSync(join(import.meta.dirname, "terminal-web"), join(dropIns, "terminal-web"), {
        recursive: true,
    });

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    for (const [name, role] of [
        ["Gale", "guest"],
        ["Vic", "viewer"],
    ] as const) {
        tokens[name] = app.config.addUser(name, role).token;
    }

    tokens.Sid = app.config.addUser("Sid", "guest", ["1"]).token;
    tokens.owner = app.config.ownerToken;
    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
});

/** A request as someone, with the `X-Pocket` header the app's own routes always need. */
async function call(who: string, path: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch(`${origin}/api/x/terminal/${path}`, {
        method: options.method ?? "GET",
        headers: {
            authorization: `Bearer ${tokens[who]}`,
            "x-pocket": "1",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();

    try {
        return { status: response.status, data: JSON.parse(text) };
    } catch {
        return { status: response.status, data: text };
    }
}

/** The browser modules someone's tabs load, as `hello` says. */
async function modulesFor(who: string): Promise<string[]> {
    const response = await fetch(`${origin}/api/me`, {
        headers: { authorization: `Bearer ${tokens[who]}`, "x-pocket": "1" },
    });
    const body = (await response.json()) as { server: { ui: { module: string }[] } };

    return body.server.ui.map((each) => each.module);
}

async function start(body: Record<string, unknown> = { folder: "path", path: fixture }) {
    const answer = await call("owner", "terminals", { method: "POST", body });

    assert.equal(answer.status, 200, JSON.stringify(answer.data));

    return answer.data.id as string;
}

/** The last seq this test wrote to a terminal: each chunk of keys carries one, as the tab does. */
const sequences = new Map<string, number>();

async function type(id: string, data: string, tab = "tab-test") {
    const seq = (sequences.get(id) ?? 0) + 1;

    sequences.set(id, seq);

    const answer = await call("owner", `terminals/${id}/input`, {
        method: "POST",
        body: { data, tab, seq },
    });

    assert.equal(answer.status, 200, JSON.stringify(answer.data));
}

async function resize(id: string, rows: number, cols: number) {
    const answer = await call("owner", `terminals/${id}/resize`, {
        method: "POST",
        body: { rows, cols },
    });

    assert.equal(answer.status, 200, JSON.stringify(answer.data));
}

function collected(id: string) {
    const found = outputs.get(id) ?? { offset: 0, text: "" };

    outputs.set(id, found);

    return found;
}

/**
 * One multiplexed poll, as the route takes it: `t=id.from,id.from` for a tab. It gives up after a moment, so a test
 * never waits 25 s.
 */
async function pollList(
    entries: { id: string; from: number }[],
    wait = 3000,
    who = "owner",
    tab = "tab-test",
) {
    const query = entries.map((each) => `${each.id}.${each.from}`).join(",");
    let response;

    try {
        response = await fetch(`${origin}/api/x/terminal/poll?tab=${tab}&t=${query}`, {
            headers: { authorization: `Bearer ${tokens[who]}`, "x-pocket": "1" },
            signal: AbortSignal.timeout(wait),
        });
    } catch {
        return { status: 0, data: {} };
    }

    return { status: response.status, data: await response.json() };
}

/** One poll for a terminal, as one tab: what it wrote since the last one, or its exit or its end. */
async function poll(id: string, wait = 3000, tab = "tab-test") {
    const state = collected(id);
    const answer = await pollList([{ id, from: state.offset }], wait, "owner", tab);

    if (answer.status !== 200) {
        return { status: answer.status, data: {} };
    }

    const entry = answer.data.terminals?.[id] ?? {};

    if (!entry.gone) {
        state.offset = entry.to ?? state.offset;
        state.text += entry.data ?? "";
    }

    return { status: answer.status, data: entry };
}

/** Keys from one tab, with the seq that tab gives them. */
async function keys(id: string, data: string, tab: string, seq: number) {
    return await call("owner", `terminals/${id}/input`, {
        method: "POST",
        body: { data, tab, seq },
    });
}

/** Poll until the shell writes nothing for a moment: its prompt is out, and only a keystroke is news. */
async function quiet(id: string) {
    const state = collected(id);

    for (let tries = 0; tries < 40; tries++) {
        const answer = await pollList([{ id, from: state.offset }], 300);
        const entry = answer.data.terminals?.[id];

        if (!entry || entry.gone || entry.data === "") {
            return;
        }

        state.offset = entry.to;
        state.text += entry.data;
    }
}

/** Poll until the shell's output so far satisfies `match`. */
async function expectOutput(id: string, match: (text: string) => boolean, what: string) {
    const state = collected(id);

    await until(
        async () => {
            await poll(id);

            return match(state.text);
        },
        what,
        20_000,
    );

    return state.text;
}

/** The shell's own process id, from `echo pid=$$`, as its login shell writes it. */
async function expectPid(id: string) {
    const text = await expectOutput(id, (each) => /pid=\d+/.test(each), "the shell's pid");
    const pid = Number([...text.matchAll(/pid=(\d+)/g)].at(-1)?.[1]);

    assert.ok(pid > 1, `a pid, not ${String(pid)}`);

    return pid;
}

/** Read until the shell has exited: its code, or null when it was killed. */
async function expectExit(id: string) {
    let exitCode: number | null | undefined;

    await until(
        async () => {
            const answer = await poll(id);

            if (answer.data.gone) {
                exitCode = null;

                return true;
            }

            if (answer.status !== 200) {
                return false;
            }

            if (answer.data.exited) {
                exitCode = answer.data.exitCode;

                return true;
            }

            return false;
        },
        "the shell to exit",
        20_000,
    );

    return exitCode;
}

async function list() {
    const answer = await call("owner", "terminals");

    assert.equal(answer.status, 200);

    return answer.data as { id: string; cwd: string; exited?: boolean; exitCode?: number }[];
}

async function end(id: string) {
    const answer = await call("owner", `terminals/${id}`, { method: "DELETE" });

    assert.equal(answer.status, 200, JSON.stringify(answer.data));
}

/** A `web` that records what a module adds to it, and runs its cleanups on demand. */
function fakeWeb() {
    const handlers = new Map<string, (request: unknown) => unknown>();
    const sent: { event: string; data: unknown }[] = [];
    const cleanups: (() => unknown)[] = [];

    return {
        handlers,
        sent,
        route(method: string, path: string, handle: (request: unknown) => unknown) {
            handlers.set(`${method} ${path}`, handle);
        },
        client() {},
        error(status: number, message: string) {
            return Object.assign(new Error(message), { status });
        },
        send(event: string, data: unknown) {
            sent.push({ event, data });
        },
        onDispose(cleanup: () => unknown) {
            cleanups.push(cleanup);
        },
        /** What Pi Pocket runs when the module goes. */
        dispose: () => Promise.all(cleanups.map((cleanup) => cleanup())),
    };
}

/** The request of an owner who starts a shell in a folder. */
function startRequest(body: Record<string, unknown>) {
    return {
        method: "POST",
        params: {},
        query: new URLSearchParams(),
        body,
        user: { id: "owner", name: "Owner", role: "owner" },
        signal: new AbortController().signal,
        sessions: () => [],
    };
}

/** Whether the process is there: a signal 0 that throws says it is gone. */
function running(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

/** Turn the module off and on again, so its spans are read from the environment once more. */
async function reloadWith(environment: Record<string, string | undefined>) {
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }

    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
}

test("a terminal starts in a folder, takes input, and follows its size", async () => {
    const id = await start();
    const listed = await call("owner", "terminals");

    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.data[0]).sort(), ["cwd", "id", "startedAt", "title"]);
    assert.equal(listed.data[0].id, id);
    assert.equal(listed.data[0].cwd, fixture);
    assert.equal(typeof listed.data[0].startedAt, "number");

    // A shell in the fixture folder, as the login shell of the user the server runs as.
    await type(id, "printf 'ok-%s\\n' $((6*7))\n");
    assert.match(await expectOutput(id, (text) => text.includes("ok-42"), "ok-42"), /ok-42/);

    await type(id, "pwd\n");
    await expectOutput(id, (text) => text.includes(fixture), "the folder");

    // The size taken from the page reaches the pty too.
    await resize(id, 33, 101);
    await type(id, "stty size\n");
    await expectOutput(id, (text) => /33 101/.test(text), "the new size");

    // More input than one POST may carry: refused, and nothing reaches the shell.
    const tooMuch = await call("owner", `terminals/${id}/input`, {
        method: "POST",
        body: { data: "x".repeat(32 * 1024 + 1), tab: "tab-test", seq: 1 },
    });

    assert.equal(tooMuch.status, 413);

    await end(id);
    assert.equal((await list()).length, 0);

    // A terminal that is gone is an answer, not a wait: the poll says so at once.
    const gone = await pollList([{ id, from: 0 }], 5000);

    assert.equal(gone.status, 200);
    assert.deepEqual(gone.data.terminals[id], { gone: true });
});

test("1 poll carries every terminal of a tab, each with its own output", async () => {
    const first = await start();
    const second = await start({ folder: "path", path: sessionFolder });

    await type(first, "echo first-shell\n");
    await type(second, "echo second-shell\n");

    // First the 2 shells write their line, each through the tab's 1 poll, at its own offset.
    await until(
        async () => {
            const seen = await pollList([
                { id: first, from: collected(first).offset },
                { id: second, from: collected(second).offset },
            ]);

            if (seen.status !== 200) {
                return false;
            }

            for (const id of [first, second]) {
                const entry = seen.data.terminals[id];

                if (entry && !entry.gone) {
                    collected(id).offset = entry.to;
                    collected(id).text += entry.data;
                }
            }

            return (
                collected(first).text.includes("first-shell") &&
                collected(second).text.includes("second-shell")
            );
        },
        "both shells in one poll",
        20_000,
    );

    // Then 1 answer that holds both: an entry for each id, with its own data and offsets.
    const together = await pollList(
        [
            { id: first, from: 0 },
            { id: second, from: 0 },
        ],
        5000,
    );

    assert.equal(together.status, 200);
    assert.deepEqual(Object.keys(together.data.terminals).sort(), [first, second].sort());

    for (const id of [first, second]) {
        const entry = together.data.terminals[id];

        assert.equal(entry.from, 0);
        assert.ok(entry.data.length > 0);
        assert.equal(entry.to, entry.data.length);
        assert.equal(entry.exited, undefined);
    }

    // An id that no shell has is still an answer, at once.
    const unknown = await pollList([{ id: "00000000-0000-4000-8000-000000000000", from: 0 }], 5000);

    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.data.terminals["00000000-0000-4000-8000-000000000000"], {
        gone: true,
    });

    await end(first);
    await end(second);
});

test("a poll refuses a bad list of terminals", async () => {
    const id = await start();

    for (const query of ["", "abc", `${id}.`, `${id}.-1`, `${id}.1.2`, `${id}.one`]) {
        const answer = await call("owner", `poll?t=${encodeURIComponent(query)}`);

        assert.equal(answer.status, 400, JSON.stringify(query));
    }

    // A tab id is 1 to 64 letters, digits, and dashes; none at all is the poll of a client that sends no tab.
    for (const tab of ["", "a b", "x".repeat(65), "a/b"]) {
        const answer = await call("owner", `poll?tab=${encodeURIComponent(tab)}&t=${id}.0`);

        assert.equal(answer.status, 400, JSON.stringify(tab));
    }

    assert.equal((await call("owner", `poll?t=${id}.0`)).status, 200);

    // 16 terminals in one poll: the 4 live ones at most, plus the ended ones that still need their last output.
    const sixteen = Array.from({ length: 16 }, (_, each) => `id${each}.0`).join(",");
    const seventeen = `${sixteen},id16.0`;

    assert.equal((await call("owner", `poll?t=${sixteen}`)).status, 200);
    assert.equal((await call("owner", `poll?t=${seventeen}`)).status, 400);

    await end(id);
});

test("keys are written once: a repeated seq and an older one write nothing", async () => {
    const id = await start();

    assert.equal((await keys(id, "echo once-42\n", "tab-retry", 1)).status, 200);
    await expectOutput(id, (text) => /once-42/.test(text), "the chunk to run");
    await quiet(id);

    const after = collected(id).offset;

    // The same chunk with the same seq, the way a POST that failed on the way goes again: an answer, no keys.
    assert.equal((await keys(id, "echo once-42\n", "tab-retry", 1)).status, 200);
    await quiet(id);
    assert.equal(collected(id).offset, after, "a repeated seq writes nothing");

    // An older seq: nothing either.
    assert.equal((await keys(id, "echo older-5\n", "tab-retry", 1)).status, 200);
    await quiet(id);
    assert.equal(collected(id).offset, after, "an older seq writes nothing");

    // A newer seq is written, and the shell runs it.
    assert.equal((await keys(id, "echo later-7\n", "tab-retry", 2)).status, 200);
    await expectOutput(id, (text) => /later-7/.test(text), "the newer chunk");

    // Another tab numbers its own chunks: its seq 1 is not this tab's seq 1.
    assert.equal((await keys(id, "echo other-tab-9\n", "tab-other", 1)).status, 200);
    await expectOutput(id, (text) => /other-tab-9/.test(text), "the other tab's chunk");

    await end(id);
});

test("an input POST needs its tab and a positive seq", async () => {
    const id = await start();
    const good = { data: "x", tab: "tab-test", seq: 1 };

    for (const body of [
        { ...good, tab: undefined },
        { ...good, tab: "" },
        { ...good, tab: "a b" },
        { ...good, tab: "x".repeat(65) },
        { ...good, seq: undefined },
        { ...good, seq: 0 },
        { ...good, seq: -1 },
        { ...good, seq: 1.5 },
        { ...good, seq: "1" },
        { ...good, seq: 2 ** 53 },
    ]) {
        const answer = await call("owner", `terminals/${id}/input`, {
            method: "POST",
            body,
        });

        assert.equal(answer.status, 400, JSON.stringify(body));
    }

    await end(id);
});

test("the shell sees only the environment allowlist", async () => {
    const id = await start();

    await type(id, "echo secret=[$TERMINAL_TEST_SECRET] term=$TERM color=$COLORTERM\n");
    const text = await expectOutput(id, (each) => /secret=\[\]/.test(each), "the variables");

    assert.match(text, /secret=\[\]/);
    assert.match(text, /term=xterm-256color/);
    assert.match(text, /color=truecolor/);
    assert.ok(!text.includes("hunter2"));

    await end(id);
});

test("a session's folder, a missing path, and bad sizes", async () => {
    const conversation = await newSession(app, sessionFolder);
    const id = await start({ folder: "session", conversation });

    await type(id, "pwd\n");
    await expectOutput(id, (text) => text.includes(sessionFolder), "the session's folder");
    await end(id);

    // A session the owner cannot see, and a path that is not an absolute folder: a 400 or a 404, never a shell.
    assert.equal(
        (
            await call("owner", "terminals", {
                method: "POST",
                body: { folder: "session", conversation: 999_999 },
            })
        ).status,
        404,
    );
    assert.equal(
        (
            await call("owner", "terminals", {
                method: "POST",
                body: { folder: "path", path: "relative/one" },
            })
        ).status,
        400,
    );
    assert.equal(
        (
            await call("owner", "terminals", {
                method: "POST",
                body: { folder: "path", path: join(fixture, "missing") },
            })
        ).status,
        400,
    );
    assert.equal(
        (await call("owner", "terminals", { method: "POST", body: { folder: "elsewhere" } }))
            .status,
        400,
    );
    assert.equal(
        (await call("owner", "terminals", { method: "POST", body: { folder: "home", rows: 1 } }))
            .status,
        400,
    );
    assert.deepEqual(await list(), []);
});

test("4 terminals at once, and the 5th is refused", async () => {
    const ids = [];

    for (let each = 0; each < 4; each++) {
        ids.push(await start());
    }

    const refused = await call("owner", "terminals", {
        method: "POST",
        body: { folder: "path", path: fixture },
    });

    assert.equal(refused.status, 429);
    assert.equal((await list()).length, 4);

    for (const id of ids) {
        await end(id);
    }

    assert.equal((await list()).length, 0);
});

test("DELETE ends the shell itself", async () => {
    const id = await start();

    await type(id, "echo pid=$$\n");
    const pid = await expectPid(id);

    assert.ok(running(pid));

    await end(id);
    await until(() => !running(pid), "the shell to end", 10_000);
});

test("a shell that exits keeps its exit code for the next poll", async () => {
    const id = await start();

    await type(id, "exit 7\n");

    assert.equal(await expectExit(id), 7);
    // The record stays 60 s, so the page can show how it ended; it counts for nothing.
    const listed = await list();

    assert.equal(listed.length, 1);
    assert.equal(listed[0].exited, true);
    assert.equal(listed[0].exitCode, 7);

    await end(id);
});

test("6 starts at once: 4 shells run, and the other 2 are refused", async () => {
    // Each start reads its folder with an await, so all 6 pass the first cap check: the check again before the spawn,
    // with no await between it and the shell, is what keeps the server at 4.
    const answers = await Promise.all(
        Array.from({ length: 6 }, () =>
            call("owner", "terminals", {
                method: "POST",
                body: { folder: "path", path: fixture },
            }),
        ),
    );

    assert.deepEqual(answers.map((each) => each.status).sort(), [200, 200, 200, 200, 429, 429]);

    const ids = answers.filter((each) => each.status === 200).map((each) => each.data.id);

    assert.equal(new Set(ids).size, 4);
    assert.equal((await list()).length, 4);
});

test("DELETE ends a shell that closed its own fds and runs on", async () => {
    const id = await start();

    await type(id, "echo pid=$$\n");
    const pid = await expectPid(id);

    // The shell becomes a python process with its terminal fds closed: the pty gives EOF, and the helper waits.
    await type(id, "exec python3 -c 'import os,time; os.closerange(0,1024); time.sleep(600)'\n");

    const command = () => {
        try {
            return readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch {
            return "";
        }
    };

    await until(() => command().includes("python3"), "the shell to become python3", 10_000);
    // The process is alive, and it holds no fd on the terminal: nothing but a closed stdin can end it.
    assert.ok(running(pid));

    await end(id);
    await until(() => !running(pid), "the process with closed fds to end", 15_000);
});

test("a start that is in flight when the module goes starts no shell", async () => {
    const web = fakeWeb();

    createTerminal(undefined, web);

    const start = web.handlers.get("POST terminals");

    assert.equal(typeof start, "function");

    const pending = start!(startRequest({ folder: "path", path: fixture })).then(
        () => ({ started: true }),
        (error: { status?: number }) => ({ status: error.status }),
    );

    // The module goes while the start waits for its folder check: the check after that await refuses the start.
    await web.dispose();

    assert.equal((await pending).status, 503);
    assert.deepEqual(web.sent, []);
});

test("2 tabs: the slow one holds the shell back and loses no character", async () => {
    const id = await start();
    const fast = { tab: "tab-fast", offset: 0, text: "" };
    const slow = { tab: "tab-slow", offset: 0, text: "" };
    let lagged = false;

    /** One poll of 1 tab: false when nothing came. Its answer must start at the offset that tab asked from. */
    const stream = async (view: typeof fast) => {
        // A short wait: a pause in the shell means a poll waits for output that the other tab must unlock first.
        const answer = await pollList([{ id, from: view.offset }], 500, "owner", view.tab);

        if (answer.status !== 200) {
            return false;
        }

        const entry = answer.data.terminals[id];

        assert.equal(entry.gone, undefined);
        assert.equal(entry.from, view.offset, `${view.tab} lost output`);
        assert.ok(entry.data.length <= 256 * 1024, "an answer of 256 K characters at most");
        view.offset = entry.to;
        view.text += entry.data;

        return entry.data.length > 0;
    };

    // More output than the 256 K buffer, and more than 1 answer carries.
    await type(id, "seq 1 300000\n");

    await until(
        async () => {
            await stream(fast);
            lagged ||= fast.offset > slow.offset;
            await stream(slow);

            // The last line of seq, and not the typed command line, which is echoed as "seq 1 300000".
            return slow.text.includes("\r\n300000\r\n") && fast.text.includes("\r\n300000\r\n");
        },
        "both tabs to read the whole output",
        30_000,
    );

    // The fast tab ran ahead, and the pause kept the slow tab inside the buffer: it lost nothing.
    assert.ok(lagged);
    assert.ok(slow.text.length > 256 * 1024, "more output than the buffer holds");
    assert.equal(slow.text.length, fast.text.length);
    assert.equal(slow.text, fast.text);

    await end(id);
});

test("only the owner gets anything: the routes and the browser module are the owner's", async () => {
    const id = await start();
    const others = ["Gale", "Vic", "Sid"];

    assert.ok((await modulesFor("owner")).includes("terminal"));

    for (const who of others) {
        assert.equal((await call(who, "terminals")).status, 404, who);
        assert.equal(
            (await call(who, "terminals", { method: "POST", body: { folder: "home" } })).status,
            404,
            who,
        );
        assert.equal((await pollList([{ id, from: 0 }], 3000, who)).status, 404, who);
        assert.equal(
            (await call(who, `terminals/${id}/input`, { method: "POST", body: { data: "x" } }))
                .status,
            404,
            who,
        );
        assert.equal(
            (
                await call(who, `terminals/${id}/resize`, {
                    method: "POST",
                    body: { rows: 24, cols: 80 },
                })
            ).status,
            404,
            who,
        );
        assert.equal((await call(who, `terminals/${id}`, { method: "DELETE" })).status, 404, who);
        assert.ok(!(await modulesFor(who)).includes("terminal"), who);
    }

    // The owner's own shell is untouched by all of that.
    assert.equal((await list()).length, 1);
    await end(id);
});

test("turning the module off ends every shell", async () => {
    const id = await start();

    await type(id, "echo pid=$$\n");
    const pid = await expectPid(id);

    assert.ok(running(pid));

    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    await until(() => !running(pid), "the shell to end with the module", 10_000);
    assert.equal((await call("owner", "terminals")).status, 404);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    assert.deepEqual(await list(), []);
});

test("a shell with no poll for the detach span ends, and so does an idle one", async () => {
    // A tick is 5 s: the spans are short, so the test is, too.
    await reloadWith({
        PI_POCKET_TERMINAL_DETACH_MS: "100",
        PI_POCKET_TERMINAL_IDLE_MS: "600000",
    });

    await start();
    await until(async () => (await list()).length === 0, "the detached shell to end", 15_000);

    // Now the other way: no keystroke, but a poll all the time, so only the idle span can end it.
    await reloadWith({
        PI_POCKET_TERMINAL_DETACH_MS: "600000",
        PI_POCKET_TERMINAL_IDLE_MS: "100",
    });

    const id = await start();

    await until(
        async () => {
            await poll(id);

            return (await list()).length === 0;
        },
        "the idle shell to end",
        15_000,
    );

    await reloadWith({
        PI_POCKET_TERMINAL_DETACH_MS: undefined,
        PI_POCKET_TERMINAL_IDLE_MS: undefined,
    });
});
