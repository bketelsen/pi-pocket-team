// Terminal's browser module, the parts a Node test can reach: the tab's id, the wait before a retry, the size that
// the shell must hear, the terminals one poll carries, and the wait for xterm to draw. No app and no browser here.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import {
    backoffMs,
    drawn,
    newTabId,
    POLL_MAX,
    pollRecords,
    sizeDue,
} from "./terminal-web/index.js";

/** The server's rule for a tab id: 1 to 64 letters, digits, and dashes. */
const TAB_ID = /^[A-Za-z0-9-]{1,64}$/;

test("a tab's id works where randomUUID is there and where only getRandomValues is", () => {
    const modern = newTabId(webcrypto);
    const lan = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };

    assert.match(modern, TAB_ID);
    assert.match(modern, /^[0-9a-f-]{36}$/, "randomUUID's own shape");
    assert.equal(lan.randomUUID, undefined);

    const first = newTabId(lan);
    const second = newTabId(lan);

    assert.match(first, /^[a-f0-9]{32}$/);
    assert.match(first, TAB_ID);
    assert.notEqual(first, second);
});

test("the wait before a retry is bounded: 0.5, 1, 2, 4 s, then 4 s", () => {
    assert.deepEqual(
        [0, 1, 2, 3, 4, 9].map((attempt) => backoffMs(attempt)),
        [500, 1000, 2000, 4000, 4000, 4000],
    );
});

test("a size is due only when it is not the one the server has", () => {
    const size = { rows: 24, cols: 80 };

    assert.equal(sizeDue(null, size), true, "the shell has no size from this tab yet");
    assert.equal(sizeDue(size, size), false);
    assert.equal(sizeDue(size, { rows: 33, cols: 80 }), true);
    assert.equal(sizeDue(size, { rows: 24, cols: 101 }), true);
    assert.equal(sizeDue(size, null), false, "a page that has no size yet asks for none");
});

test("one poll carries the live terminals first, and an ended one until its last output", () => {
    const live = { id: "live", exited: null, final: false, note: null, closing: false };
    const ended = { id: "ended", exited: 7, final: false, note: null, closing: false };
    const fetched = { id: "fetched", exited: 0, final: true, note: null, closing: false };
    const lost = { id: "lost", exited: null, final: false, note: "gone", closing: false };
    const closing = { id: "closing", exited: null, final: false, note: null, closing: true };

    assert.deepEqual(
        pollRecords([ended, live, fetched, lost, closing]).map((each) => each.id),
        ["live", "ended"],
    );

    // 16 at most: the live ones are first, so the cap never drops one of them for an ended terminal.
    const many = [
        ...Array.from({ length: 20 }, (_, each) => ({
            id: `ended-${each}`,
            exited: 0,
            final: false,
            note: null,
            closing: false,
        })),
        ...Array.from({ length: 4 }, (_, each) => ({
            id: `live-${each}`,
            exited: null,
            final: false,
            note: null,
            closing: false,
        })),
    ];

    const carried = pollRecords(many);

    assert.equal(carried.length, POLL_MAX);
    assert.deepEqual(
        carried.slice(0, 4).map((each) => each.id),
        ["live-0", "live-1", "live-2", "live-3"],
    );
    assert.equal(pollRecords(many, 2).length, 2);
});

test("a write is acknowledged when xterm has drawn it, when the poll stops, or as a failure", async () => {
    const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve("late"), ms));

    // Drawn: the callback is what settles it.
    let called = null;
    const drawing = { write: (data, callback) => (called = callback) };
    let settled = false;
    const first = drawn(drawing, "hello", new AbortController().signal).then(() => {
        settled = true;
    });

    assert.equal(settled, false, "not before the callback");
    called();
    await first;
    assert.equal(settled, true);

    // Nothing to draw: no wait and no call.
    let writes = 0;

    await drawn({ write: () => (writes += 1) }, "", new AbortController().signal);
    assert.equal(writes, 0);

    // Aborted while xterm has not drawn it: the wait ends all the same.
    const stop = new AbortController();
    const never = { write: () => {} };
    const wait = drawn(never, "hello", stop.signal);

    stop.abort();
    assert.notEqual(
        await Promise.race([wait.then(() => "ended"), tick(50).then(() => "waiting")]),
        "waiting",
    );

    // A terminal that cannot write says so.
    await assert.rejects(
        drawn(
            {
                write: () => {
                    throw new Error("the screen is gone");
                },
            },
            "hello",
            new AbortController().signal,
        ),
        /the screen is gone/,
    );

    // A callback that comes after the wait ended settles nothing twice.
    let late = null;
    const stop2 = new AbortController();
    const second = drawn({ write: (_data, callback) => (late = callback) }, "hello", stop2.signal);

    stop2.abort();
    await second;
    late();
    assert.equal(await Promise.race([second, timeout(10)]), undefined);
});
