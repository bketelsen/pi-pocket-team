// Terminal's browser module, the parts a Node test can reach: the tab's id, the wait before a retry, the size that
// the shell must hear, the terminals one poll carries, and the wait for xterm to draw. No app and no browser here.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import {
    afterFailure,
    backoffMs,
    deliver,
    GIVE_UP_MS,
    newTabId,
    POLL_MAX,
    pollRecords,
    retryAllowed,
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

test("a chunk that goes unanswered is given up after 60 s, and no sooner", () => {
    const startedAt = 1_000_000;

    assert.equal(GIVE_UP_MS, 60_000);
    assert.equal(retryAllowed(startedAt, startedAt), true);
    assert.equal(retryAllowed(startedAt, startedAt + 59_999), true);
    assert.equal(retryAllowed(startedAt, startedAt + 60_000), false);
    assert.equal(retryAllowed(startedAt, startedAt + 120_000), false);
});

test("a failed request says which it is: gone, a shell that closed, or a retry", () => {
    assert.equal(afterFailure(404), "gone");
    assert.equal(afterFailure(409), "closed");
    assert.equal(afterFailure(400), "retry");
    assert.equal(afterFailure(500), "retry");
    assert.equal(afterFailure(429), "retry");
    assert.equal(afterFailure(undefined), "retry");
    assert.equal(afterFailure(0), "retry");
});

/** A request that never settles until its signal aborts, as a server that took the POST and never answered. */
const hanging = (calls) => (signal) =>
    new Promise((_resolve, reject) => {
        calls.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

test("a chunk whose request never settles is lost at the deadline, and its request is aborted", async () => {
    const calls = [];
    const outcome = await deliver({
        send: hanging(calls),
        signal: new AbortController().signal,
        giveUpMs: 50,
    });

    assert.equal(outcome, "lost");
    assert.equal(calls.length, 1, "no second send of the same chunk after the deadline");
    assert.equal(calls[0].aborted, true, "the request in flight was aborted");
});

test("a chunk is retried with no answer, and the deadline ends the wait between tries too", async () => {
    let sends = 0;
    let waits = 0;
    const started = Date.now();
    const outcome = await deliver({
        send: async () => {
            sends++;

            throw new TypeError("network");
        },
        signal: new AbortController().signal,
        giveUpMs: 700,
        onWait: () => waits++,
    });

    assert.equal(outcome, "lost");
    assert.equal(
        sends,
        2,
        "the first try, and 1 after the 0.5 s wait; the 1 s wait ends at the deadline",
    );
    assert.equal(waits, 2);
    assert.ok(Date.now() - started < 1_200, "the deadline cut the second wait short");
});

test("a delivered chunk, a 404, a 409, and a close each end delivery as they should", async () => {
    const open = () => new AbortController().signal;

    const failing = (status) => async () => {
        throw Object.assign(new Error("no"), { status });
    };

    assert.equal(await deliver({ send: async () => ({}), signal: open() }), "sent");
    assert.equal(await deliver({ send: failing(404), signal: open() }), "gone");
    assert.equal(await deliver({ send: failing(409), signal: open() }), "closed");

    const closing = new AbortController();
    const calls = [];
    const pending = deliver({ send: hanging(calls), signal: closing.signal, giveUpMs: 10_000 });

    closing.abort();
    assert.equal(await pending, "stopped");
    assert.equal(calls[0].aborted, true);
});
