// The github-hooks drop-in, outside Pocket: the listener factory over loopback, the fact builder, the pure delivery
// commit, the coverage alarm and the secret source. Nothing goes to GitHub; the payloads are @octokit/webhooks-examples
// (test/fixtures/github-hooks/README.md), signed here with a test secret in a temporary folder.
//
// The plan's Test plan ("Unit tests"), item by item, and where each is (P: github-hooks-pocket.test.ts):
// - HMAC: valid, wrong secret, missing header, `sha1=`, wrong length, upper-case hex, a bad-signature non-JSON body is
//   401, both rotation secrets work: "HMAC" below.
// - Size: 1 MiB passes, 1 MiB + 1 byte is 413 before a body byte, a large Content-Length is 413, no Content-Length is
//   411, slow headers and a slow body are 408: "Size".
// - Admission: 17 sockets, 9 requests, 9 MiB of bodies in flight: "Admission".
// - Life cycle: a held port gives `bind-failed`, a dispose during a retry cancels it, `close` ends an idle socket at
//   once and an active one after the grace time: "Life cycle"; 20 reloads and 1 reload with an idle socket: P.
// - Route: "Route". Source: "Source". Events: "Events" and "Facts".
// - Dedupe: same id, same body under a new id, a full set: "The delivery commit"; a real failed commit (the module's
//   test hook), 2 copies at once, the set across a reload: P.
// - Installation events: "Facts" and "The delivery commit".
// - Pending markers (crash, desk reload, a second nudge): P. Facts with hostile text: "Facts", and every document: P.
// - Nudge (coalescing, 1 per minute, no match, the desk absent): the desk's own rules are desk-nudge.test.ts (task t1);
//   the desk absent: "The delivery commit" here and P.
// - Serialized syncs: desk-nudge.test.ts (task t1).
// - PR #138 cross-review, batch 2: a duplicate clears seen-full under the cap ("The delivery commit"); only a status
//   fact matches a CI change by sha alone ("The coverage alarm").
// - PR #138 cross-review, batch 1: the inbox bound and the cancel of a timed-out job, the nudge back-off for every
//   caller, and the maintenance under a busy inbox: "The receiver loop".
// - Alarm: silence raises nothing, 2 misses raise 1 repository and class only, another class or repository does not
//   clear it: "The coverage alarm".
// - Secret file: missing, short, changed mtime: "The secret source", and 503 in "Secret".
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
    type AlarmsState,
    type CoverageState,
    type DeliveryJob,
    type HookDocs,
    type HookFact,
    type ListenerEvent,
    type ListenerLimits,
    type ObservedState,
    type ReceiverAnswer,
    type ReceiverHandle,
    applyDelivery,
    buildFact,
    createHookListener,
    createSecretSource,
    evaluateCoverage,
    factClass,
    liveListeners,
    MAX_BODY,
    normalizePeer,
    parseAllowFrom,
    PENDING_MAX,
    SEEN_MAX,
    SEEN_MS,
    toNudgeFact,
    type ApplyResult,
    createInbox,
    createReceiverLoop,
    INBOX_MAX,
    NUDGE_RETRY_MS,
    COVERAGE_EVERY_MS,
    REFUSAL_FLUSH_MS,
} from "./github-hooks.ts";
import { HOSTILE, fixture, withHostileText } from "./github-hooks-fixture.ts";

const SECRET = "a".repeat(16) + "0123456789abcdef0123456789abcdef";
const NEXT = "b".repeat(16) + "fedcba9876543210fedcba9876543210";

const sign = (body: Buffer, secret = SECRET) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

type RawAnswer = { status?: number; text: string; closed: boolean };

/** Send raw bytes on 1 connection and read the answer until the server closes it. */
function raw(port: number, bytes: Buffer | string): Promise<RawAnswer> {
    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];

        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", () => {});
        socket.on("close", () => {
            const text = Buffer.concat(chunks).toString("latin1");
            const match = /^HTTP\/1\.1 (\d{3})/.exec(text);

            resolve({
                ...(match === null ? {} : { status: Number(match[1]) }),
                text,
                closed: true,
            });
        });
        socket.write(bytes);
    });
}

type RequestSpec = {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    length?: number | null;
};

function requestBytes(spec: RequestSpec): Buffer {
    const body = spec.body ?? Buffer.alloc(0);
    const headers: Record<string, string> = {
        Host: "hooks.test",
        Connection: "close",
        ...(spec.length === null ? {} : { "Content-Length": String(spec.length ?? body.length) }),
        ...spec.headers,
    };
    const head =
        `${spec.method ?? "POST"} ${spec.path ?? "/github"} HTTP/1.1\r\n` +
        Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("") +
        "\r\n";

    return Buffer.concat([Buffer.from(head, "latin1"), body]);
}

/** A signed delivery's bytes. */
function deliveryBytes(
    event: string,
    payload: unknown,
    options: { secret?: string; id?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Buffer {
    const body = options.body ?? Buffer.from(JSON.stringify(payload));

    return requestBytes({
        body,
        headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": options.id ?? randomUUID(),
            "X-Hub-Signature-256": sign(body, options.secret),
            ...options.headers,
        },
    });
}

let secretDir: string;

before(() => {
    secretDir = mkdtempSync(join(tmpdir(), "github-hooks-secret-"));
    writeFileSync(join(secretDir, "github-webhook.secret"), `${SECRET}\n`, { mode: 0o600 });
});

after(() => rmSync(secretDir, { recursive: true, force: true }));

/** A listener on a free loopback port, with a fake receiver that accepts every job. */
async function listen(
    options: {
        limits?: Partial<ListenerLimits>;
        allow?: string[];
        dir?: string;
        receiver?: ReceiverHandle | null;
        port?: number;
    } = {},
) {
    const jobs: DeliveryJob[] = [];
    const events: ListenerEvent[] = [];
    const lines: string[] = [];
    const source = createSecretSource(options.dir ?? secretDir, {
        hide: () => () => {},
        warn: () => {},
    });
    const receiver: ReceiverHandle | undefined =
        options.receiver === null
            ? undefined
            : (options.receiver ?? {
                  taskId: "1",
                  submit: async (job): Promise<ReceiverAnswer> => {
                      jobs.push(job);

                      return { outcome: "accepted" };
                  },
              });
    const listener = createHookListener({
        port: options.port ?? 0,
        host: "127.0.0.1",
        allowFrom: () => new Set(options.allow ?? ["127.0.0.1"]),
        secrets: () => source.read(),
        receiver: () => receiver,
        now: Date.now,
        log: (line) => lines.push(line),
        onEvent: (event) => events.push(event),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
    });

    listener.start();
    await waitFor(() => listener.status().state === "bound", "the listener binds");

    return {
        port: listener.status().port!,
        listener,
        jobs,
        events,
        lines,
        close: () => listener.close(),
    };
}

/** Wait until `check` holds, by turns of the event loop (a condition, not a time). */
async function waitFor(check: () => boolean, what: string, limit = 10_000): Promise<void> {
    const started = Date.now();

    while (!check()) {
        if (Date.now() - started > limit) {
            throw new Error(`Timed out: ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const pr = () => fixture("pull_request.labeled");

describe("HMAC", () => {
    test("a valid signature is accepted; every bad one is 401 and reaches no receiver", async () => {
        const hooks = await listen();

        try {
            assert.equal((await raw(hooks.port, deliveryBytes("pull_request", pr()))).status, 202);
            assert.equal(hooks.jobs.length, 1);

            const body = Buffer.from(JSON.stringify(pr()));
            const bad = (signature: string | undefined) =>
                requestBytes({
                    body,
                    headers: {
                        "Content-Type": "application/json",
                        "X-GitHub-Event": "pull_request",
                        "X-GitHub-Delivery": randomUUID(),
                        ...(signature === undefined ? {} : { "X-Hub-Signature-256": signature }),
                    },
                });
            const hex = createHmac("sha256", SECRET).update(body).digest("hex");

            for (const [what, signature] of [
                ["wrong secret", sign(body, "z".repeat(40))],
                ["missing header", undefined],
                ["sha1= prefix", `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`],
                ["wrong length", `sha256=${hex.slice(2)}`],
                ["upper-case hex", `sha256=${hex.toUpperCase()}`],
            ] as const) {
                assert.equal((await raw(hooks.port, bad(signature))).status, 401, what);
            }

            assert.equal(hooks.jobs.length, 1);
        } finally {
            hooks.close();
        }
    });

    test("a bad-signature body that is not JSON is 401, not 400: the compare runs before the parse", async () => {
        const hooks = await listen();

        try {
            const body = Buffer.from("this is { not json");
            const answer = await raw(
                hooks.port,
                deliveryBytes("pull_request", undefined, { body, secret: "y".repeat(40) }),
            );

            assert.equal(answer.status, 401);

            // The same body with a good signature reaches the parse: 400.
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", undefined, { body }))).status,
                400,
            );
        } finally {
            hooks.close();
        }
    });

    test("both rotation secrets work: the current one and github-webhook.secret.next", async () => {
        const dir = mkdtempSync(join(tmpdir(), "github-hooks-rotate-"));

        writeFileSync(join(dir, "github-webhook.secret"), SECRET, { mode: 0o600 });
        writeFileSync(join(dir, "github-webhook.secret.next"), NEXT, { mode: 0o600 });

        const hooks = await listen({ dir });

        try {
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { secret: SECRET })))
                    .status,
                202,
            );
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { secret: NEXT })))
                    .status,
                202,
            );
        } finally {
            hooks.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("Size", () => {
    test("exactly 1 MiB passes the size checks", async () => {
        const hooks = await listen();

        try {
            const json = JSON.stringify(pr());
            const body = Buffer.from(json + " ".repeat(MAX_BODY - Buffer.byteLength(json)));

            assert.equal(body.length, MAX_BODY);
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", undefined, { body }))).status,
                202,
            );
        } finally {
            hooks.close();
        }
    });

    test("1 MiB + 1 byte and a large Content-Length are 413 before any body byte is sent", async () => {
        const hooks = await listen();

        try {
            for (const length of [MAX_BODY + 1, 100 * MAX_BODY]) {
                // Headers only: the answer comes with no body byte sent, so the handler read none.
                const answer = await raw(
                    hooks.port,
                    requestBytes({ length, headers: { "Content-Type": "application/json" } }),
                );

                assert.equal(answer.status, 413, String(length));
            }
        } finally {
            hooks.close();
        }
    });

    test("no Content-Length is 411, also with Transfer-Encoding", async () => {
        const hooks = await listen();

        try {
            const chunked = await raw(
                hooks.port,
                requestBytes({
                    length: null,
                    headers: {
                        "Content-Type": "application/json",
                        "Transfer-Encoding": "chunked",
                    },
                    body: Buffer.from("2\r\n{}\r\n0\r\n\r\n"),
                }),
            );

            assert.equal(chunked.status, 411);
            assert.equal(
                (
                    await raw(
                        hooks.port,
                        requestBytes({
                            length: null,
                            headers: { "Content-Type": "application/json" },
                        }),
                    )
                ).status,
                411,
            );
        } finally {
            hooks.close();
        }
    });

    test("slow headers and a slow body are closed with 408", async () => {
        const hooks = await listen({ limits: { headersTimeoutMs: 150, bodyTimeoutMs: 150 } });

        try {
            const headers = await raw(hooks.port, "POST /github HTTP/1.1\r\nHost: x\r\n");

            assert.equal(headers.status, 408);

            const body = await raw(
                hooks.port,
                requestBytes({
                    length: 100,
                    headers: { "Content-Type": "application/json" },
                    body: Buffer.from("{"),
                }),
            );

            assert.equal(body.status, 408);
        } finally {
            hooks.close();
        }
    });
});

/** Open a socket and keep it, until the test ends it. */
function hold(
    port: number,
): Promise<{ socket: Socket; closed: () => boolean; closedAt: () => number; text: () => string }> {
    return new Promise((resolve) => {
        let closed = 0;
        let text = "";
        const socket = connect(port, "127.0.0.1", () =>
            resolve({
                socket,
                closed: () => closed !== 0,
                closedAt: () => closed,
                text: () => text,
            }),
        );

        socket.on("data", (chunk: Buffer) => {
            text += chunk.toString("latin1");
        });
        socket.on("error", () => {});
        socket.on("close", () => {
            closed = Date.now();
        });
    });
}

describe("Admission", () => {
    test("17 sockets at once: 1 is closed, the others still work", async () => {
        const hooks = await listen();
        const held: Awaited<ReturnType<typeof hold>>[] = [];

        try {
            for (let index = 0; index < 17; index += 1) {
                held.push(await hold(hooks.port));
            }

            await waitFor(() => held.some((each) => each.closed()), "1 socket is closed");
            assert.equal(held.filter((each) => each.closed()).length, 1);
            assert.equal(held.at(-1)!.closed(), true, "the 17th is the one closed");

            const first = held[0]!;
            const answer = new Promise<string>((resolve) => {
                const chunks: Buffer[] = [];

                first.socket.on("data", (chunk) => chunks.push(chunk));
                first.socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
            });

            first.socket.write(deliveryBytes("pull_request", pr()));
            assert.match(await answer, /^HTTP\/1\.1 202/);
        } finally {
            for (const each of held) {
                each.socket.destroy();
            }

            hooks.close();
        }
    });

    test("9 requests at once: the 9th is closed with no answer", async () => {
        const hooks = await listen();
        const held: Awaited<ReturnType<typeof hold>>[] = [];

        try {
            // 8 requests in progress: headers sent, the body never comes.
            for (let index = 0; index < 8; index += 1) {
                const each = await hold(hooks.port);

                each.socket.write(
                    requestBytes({ length: 100, headers: { "Content-Type": "application/json" } }),
                );
                held.push(each);
            }

            await waitFor(() => hooks.listener.load().requests === 8, "8 requests in progress");

            const answer = await raw(hooks.port, deliveryBytes("pull_request", pr()));

            assert.equal(answer.status, undefined, "closed with no answer");
            assert.equal(hooks.jobs.length, 0);
            assert.ok(hooks.lines.some((line) => /reason=too-many-requests status=0/.test(line)));
        } finally {
            for (const each of held) {
                each.socket.destroy();
            }

            hooks.close();
        }
    });

    test("9 MiB of bodies in flight: the 9th MiB is 503 before its body is read", async () => {
        const hooks = await listen({ limits: { maxRequests: 16 } });
        const held: Awaited<ReturnType<typeof hold>>[] = [];

        try {
            for (let index = 0; index < 8; index += 1) {
                const each = await hold(hooks.port);

                each.socket.write(
                    requestBytes({
                        length: MAX_BODY,
                        headers: { "Content-Type": "application/json" },
                    }),
                );
                held.push(each);
            }

            await waitFor(() => hooks.listener.load().reserved === 8 * MAX_BODY, "8 MiB reserved");

            // Headers only: the 503 comes before any body byte is sent.
            const answer = await raw(
                hooks.port,
                requestBytes({ length: MAX_BODY, headers: { "Content-Type": "application/json" } }),
            );

            assert.equal(answer.status, 503);
            assert.match(answer.text, /busy/);
        } finally {
            for (const each of held) {
                each.socket.destroy();
            }

            hooks.close();
        }
    });
});

describe("Life cycle", () => {
    let holder: Server;
    let port: number;

    before(async () => {
        holder = createServer();
        await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
        port = (holder.address() as { port: number }).port;
    });

    after(() => holder.close());

    test("a held port gives bind-failed after the retry limit; nothing binds", async () => {
        const events: ListenerEvent[] = [];
        const listener = createHookListener({
            port,
            host: "127.0.0.1",
            allowFrom: () => new Set(["127.0.0.1"]),
            secrets: async () => ({ status: "ok", values: [SECRET], next: false }),
            receiver: () => undefined,
            now: Date.now,
            log: () => {},
            onEvent: (event) => events.push(event),
            limits: { bindRetryMs: 10, bindLimitMs: 60 },
        });

        listener.start();
        await waitFor(() => listener.status().state === "failed", "the bind fails");
        assert.deepEqual(
            events
                .filter((event) => event.type === "raise")
                .map((event) => event.type === "raise" && event.name),
            ["bind-failed"],
        );
        listener.close();
    });

    test("a dispose during a retry cancels it: the timer is cleared and nothing runs after", async () => {
        const scheduled = new Map<number, () => void>();
        let next = 0;
        const listener = createHookListener({
            port,
            host: "127.0.0.1",
            allowFrom: () => new Set(["127.0.0.1"]),
            secrets: async () => ({ status: "ok", values: [SECRET], next: false }),
            receiver: () => undefined,
            now: Date.now,
            log: () => {},
            onEvent: () => {},
            timers: {
                set: (run) => {
                    next += 1;
                    scheduled.set(next, run);

                    return next;
                },
                clear: (handle) => scheduled.delete(handle as number),
            },
        });

        listener.start();
        assert.equal(scheduled.size, 1, "the bind waits for a timer: the load binds nothing");

        const [first, bind] = [...scheduled.entries()][0]!;

        scheduled.delete(first);
        bind();
        await waitFor(() => listener.status().state === "retrying", "EADDRINUSE: a retry waits");
        assert.equal(scheduled.size, 1);
        listener.close();
        assert.equal(scheduled.size, 0, "the retry is cancelled");
        assert.equal(listener.status().state, "closed");
    });

    test("close: an idle keep-alive socket ends at once, an active request after the grace time and not before; a new listener accepts", async () => {
        const grace = 300;
        const hooks = await listen({ limits: { socketGraceMs: grace } });
        const idle = await hold(hooks.port);

        idle.socket.write(
            deliveryBytes("pull_request", pr(), { headers: { Connection: "keep-alive" } }),
        );
        await waitFor(
            () => /^HTTP\/1\.1 202/.test(idle.text()) && idle.text().endsWith("\r\n0\r\n\r\n"),
            "the idle socket got its answer and stays open",
        );
        assert.equal(idle.closed(), false);

        // An active request: its body never completes.
        const active = await hold(hooks.port);

        active.socket.write(
            requestBytes({
                length: 100,
                headers: { "Content-Type": "application/json" },
                body: Buffer.from("{"),
            }),
        );
        await waitFor(() => hooks.listener.load().requests === 1, "1 request in progress");

        const closedAt = Date.now();

        hooks.close();
        await waitFor(() => idle.closed(), "the idle socket closed");
        assert.ok(idle.closedAt() - closedAt < grace, "the idle socket closed at once");
        assert.equal(active.closed(), false, "the active socket is still open");
        await waitFor(() => active.closed(), "the active socket is destroyed");
        // Timers can fire up to 1 ms early on some platforms.
        assert.ok(
            active.closedAt() - closedAt >= grace - 2,
            `the active socket closed ${String(active.closedAt() - closedAt)} ms after close, before the grace time`,
        );
        assert.equal(active.text(), "", "no answer for the cut request");

        const next = await listen({ port: hooks.port });

        try {
            assert.equal((await raw(next.port, deliveryBytes("pull_request", pr()))).status, 202);
        } finally {
            next.close();
        }
    });

    test("close stops the server: it leaves the live set, and its port is free", async () => {
        const hooks = await listen();
        const before = liveListeners().size;

        hooks.close();
        await waitFor(() => liveListeners().size === before - 1, "the server leaves the set");

        const again = createServer();

        await new Promise<void>((resolve) => again.listen(hooks.port, "127.0.0.1", resolve));
        again.close();
    });
});

describe("Route", () => {
    test("GET /github, POST /other, /github/, a query and an encoding are 404; another content type is 415", async () => {
        const hooks = await listen();

        try {
            const json = { "Content-Type": "application/json" };

            for (const [method, path] of [
                ["GET", "/github"],
                ["POST", "/other"],
                ["POST", "/github/"],
                ["POST", "/github?x=1"],
                ["POST", "/%67ithub"],
            ] as const) {
                assert.equal(
                    (await raw(hooks.port, requestBytes({ method, path, headers: json }))).status,
                    404,
                    `${method} ${path}`,
                );
            }

            assert.equal(
                (await raw(hooks.port, requestBytes({ headers: { "Content-Type": "text/plain" } })))
                    .status,
                415,
            );
            assert.equal(
                (
                    await raw(
                        hooks.port,
                        deliveryBytes("pull_request", pr(), {
                            headers: { "Content-Type": "application/json; charset=utf-8" },
                        }),
                    )
                ).status,
                202,
                "a charset parameter is fine",
            );
        } finally {
            hooks.close();
        }
    });
});

describe("Source", () => {
    test("a peer outside allowFrom gets the socket closed with no answer; the log has the peer and the reason only", async () => {
        const hooks = await listen({ allow: ["10.0.1.234"] });

        try {
            const answer = await raw(hooks.port, deliveryBytes("pull_request", pr()));

            assert.equal(answer.status, undefined);
            assert.equal(answer.text, "");
            assert.equal(hooks.jobs.length, 0);
            assert.equal(hooks.lines.length, 1);
            assert.match(
                hooks.lines[0]!,
                /^github-hooks: \S+ refused peer=127\.0\.0\.1 reason=peer-refused status=0$/,
            );
        } finally {
            hooks.close();
        }
    });

    test("allowFrom: IP addresses only, the ::ffff: prefix removed; an empty list admits nobody", () => {
        assert.deepEqual(
            [...parseAllowFrom(" 10.0.1.234, ::ffff:10.0.0.1, nonsense, 300.1.1.1, ::1 ")],
            ["10.0.1.234", "10.0.0.1", "::1"],
        );
        assert.equal(parseAllowFrom("").size, 0);
        assert.equal(normalizePeer("::ffff:127.0.0.1"), "127.0.0.1");
    });
});

describe("Events", () => {
    test("an unknown event is 400; ping is 200 and reaches no receiver; a bad delivery id is 400", async () => {
        const hooks = await listen();

        try {
            assert.equal((await raw(hooks.port, deliveryBytes("push", pr()))).status, 400);

            // A name an object inherits is not in the event list.
            for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
                assert.equal(
                    (await raw(hooks.port, deliveryBytes(inherited, pr()))).status,
                    400,
                    inherited,
                );
            }

            assert.equal(
                (await raw(hooks.port, deliveryBytes("ping", fixture("ping")))).status,
                200,
            );
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { id: "nope" }))).status,
                400,
            );
            assert.equal(hooks.jobs.length, 0);
        } finally {
            hooks.close();
        }
    });

    test("another owner is 422; an action outside the set goes to the receiver as ignored", async () => {
        const hooks = await listen();

        try {
            assert.equal(
                (
                    await raw(
                        hooks.port,
                        deliveryBytes("pull_request", fixture("pull_request.labeled", "evil/test")),
                    )
                ).status,
                422,
            );

            const edited = { ...pr(), action: "edited" };

            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", edited))).status,
                202,
            );
            assert.equal(hooks.jobs.at(-1)!.ignored, true);
            assert.equal(hooks.jobs.at(-1)!.fact.action, undefined);
        } finally {
            hooks.close();
        }
    });

    test("no receiver: 503 and receiver-missing; a receiver that never answers: 503", async () => {
        const none = await listen({ receiver: null });

        try {
            assert.equal((await raw(none.port, deliveryBytes("pull_request", pr()))).status, 503);
            assert.ok(
                none.events.some(
                    (event) => event.type === "raise" && event.name === "receiver-missing",
                ),
            );
        } finally {
            none.close();
        }

        const slow = await listen({
            limits: { jobTimeoutMs: 50 },
            receiver: { taskId: "1", submit: () => new Promise(() => {}) },
        });

        try {
            assert.equal((await raw(slow.port, deliveryBytes("pull_request", pr()))).status, 503);
        } finally {
            slow.close();
        }

        for (const [outcome, status] of [
            ["duplicate", 200],
            ["ignored", 200],
            ["seen-full", 503],
            ["pending-full", 503],
            ["receiver-gone", 503],
            ["receiver-busy", 503],
            ["failed", 500],
        ] as const) {
            const hooks = await listen({
                receiver: { taskId: "1", submit: async () => ({ outcome }) },
            });

            try {
                const answer = await raw(hooks.port, deliveryBytes("pull_request", pr()));

                assert.equal(answer.status, status, outcome);

                if (outcome === "receiver-busy") {
                    assert.match(hooks.lines.at(-1)!, /outcome=receiver-busy status=503$/);
                    assert.ok(
                        hooks.events.some(
                            (event) =>
                                event.type === "refusal" && event.entry.outcome === "receiver-busy",
                        ),
                        "the refusal goes to the delivery log",
                    );
                }

                if (outcome === "failed") {
                    assert.match(
                        answer.text,
                        /\r\n\r\n7\r\nfailed\n\r\n0\r\n\r\n$/,
                        "no detail: the outcome word only",
                    );
                }
            } finally {
                hooks.close();
            }
        }
    });

    test("the delivery log line has the checked fields only, never the signature or the secret", async () => {
        const hooks = await listen();

        try {
            const id = randomUUID();

            await raw(hooks.port, deliveryBytes("pull_request", withHostileText(pr()), { id }));
            assert.equal(hooks.lines.length, 1);
            assert.match(
                hooks.lines[0]!,
                new RegExp(
                    `^github-hooks: \\S+ delivery=${id} event=pull_request action=labeled repo=frostyard/test outcome=accepted status=202$`,
                ),
            );
            assert.ok(!hooks.lines[0]!.includes(SECRET));
            assert.ok(!hooks.lines[0]!.includes("sha256="));
        } finally {
            hooks.close();
        }
    });
});

describe("Secret", () => {
    test("missing or short: every delivery is 503 and secret-missing is raised; a good file clears it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "github-hooks-missing-"));
        const hooks = await listen({ dir });

        try {
            assert.equal((await raw(hooks.port, deliveryBytes("pull_request", pr()))).status, 503);
            writeFileSync(join(dir, "github-webhook.secret"), "short", { mode: 0o600 });
            assert.equal((await raw(hooks.port, deliveryBytes("pull_request", pr()))).status, 503);
            assert.ok(
                hooks.events.some(
                    (event) => event.type === "raise" && event.name === "secret-missing",
                ),
            );
            writeFileSync(join(dir, "github-webhook.secret"), SECRET, { mode: 0o600 });
            assert.equal((await raw(hooks.port, deliveryBytes("pull_request", pr()))).status, 202);
            assert.ok(
                hooks.events.some(
                    (event) => event.type === "clear" && event.name === "secret-missing",
                ),
            );
            assert.equal(hooks.jobs.length, 1);
        } finally {
            hooks.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("The secret source and the listener", () => {
    test("a secret changed in place (same length, same inode, later mtime): the new one is accepted, the old one refused", async () => {
        const dir = mkdtempSync(join(tmpdir(), "github-hooks-inplace-"));
        const file = join(dir, "github-webhook.secret");

        writeFileSync(file, SECRET, { mode: 0o600 });

        const hooks = await listen({ dir });

        try {
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { secret: SECRET })))
                    .status,
                202,
            );

            const before = statSync(file);

            writeFileSync(file, NEXT);
            utimesSync(file, before.atime, new Date(before.mtimeMs + 5_000));
            assert.equal(statSync(file).ino, before.ino);
            assert.equal(statSync(file).size, before.size);
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { secret: NEXT })))
                    .status,
                202,
            );
            assert.equal(
                (await raw(hooks.port, deliveryBytes("pull_request", pr(), { secret: SECRET })))
                    .status,
                401,
            );
        } finally {
            hooks.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("The secret source", () => {
    test("missing, short, a changed file, .next, hidden and unhidden, a warning for loose permissions", async () => {
        const dir = mkdtempSync(join(tmpdir(), "github-hooks-source-"));
        const hidden: string[] = [];
        const unhidden: string[] = [];
        const warnings: string[] = [];
        const source = createSecretSource(dir, {
            hide: (value) => {
                hidden.push(value);

                return () => unhidden.push(value);
            },
            warn: (message) => warnings.push(message),
        });
        const file = join(dir, "github-webhook.secret");

        try {
            assert.deepEqual(await source.read(), { status: "missing", values: [], next: false });

            writeFileSync(file, "x".repeat(31), { mode: 0o600 });
            assert.equal((await source.read()).status, "short");

            writeFileSync(file, `  ${SECRET}\n`, { mode: 0o600 });
            assert.deepEqual(await source.read(), { status: "ok", values: [SECRET], next: false });
            assert.deepEqual(hidden, [SECRET]);

            // The same file again: no new read, no new hide.
            await source.read();
            assert.deepEqual(hidden, [SECRET]);

            // The same length, written in place (the same inode), with a later mtime: the new value is read and
            // hidden, and the old one's hide ends.
            const before = statSync(file);

            assert.equal(NEXT.length, SECRET.length);
            writeFileSync(file, NEXT);
            utimesSync(file, before.atime, new Date(before.mtimeMs + 5_000));
            assert.equal(statSync(file).ino, before.ino, "the same inode");
            assert.equal(
                statSync(file).size,
                before.size - 3,
                "the same length (the old file had 2 spaces and a newline)",
            );
            assert.deepEqual((await source.read()).values, [NEXT]);
            assert.deepEqual(hidden, [SECRET, NEXT]);
            assert.deepEqual(unhidden, [SECRET]);

            // The same length and inode once more, with only the mtime to tell.
            const same = statSync(file);
            const third = "d".repeat(16) + "0123456789abcdef0123456789abcdef";

            writeFileSync(file, third);
            utimesSync(file, same.atime, new Date(same.mtimeMs + 5_000));
            assert.equal(statSync(file).size, same.size);
            assert.equal(statSync(file).ino, same.ino);
            assert.deepEqual((await source.read()).values, [third]);
            assert.deepEqual(unhidden, [SECRET, NEXT]);

            writeFileSync(file, "y".repeat(4097), { mode: 0o600 });
            assert.equal((await source.read()).status, "missing", "too long counts as missing");

            writeFileSync(file, SECRET, { mode: 0o600 });
            writeFileSync(join(dir, "github-webhook.secret.next"), NEXT, { mode: 0o644 });
            chmodSync(join(dir, "github-webhook.secret.next"), 0o644);
            assert.deepEqual(await source.read(), {
                status: "ok",
                values: [SECRET, NEXT],
                next: true,
            });
            assert.equal(warnings.length, 1);
            assert.match(warnings[0]!, /github-webhook\.secret\.next can be read by others/);
            assert.ok(warnings.every((warning) => !warning.includes(NEXT)));

            source.dispose();
            assert.ok(unhidden.includes(NEXT));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── Facts ───────────────────────────────────────────────────────────────────

const ID = "6f1b7c2e-0a1b-4c2d-8e3f-123456789abc";

describe("Facts", () => {
    const kept: [string, string, Partial<HookFact>][] = [
        ["pull_request", "pull_request.opened", { action: "opened", state: "open" }],
        ["pull_request", "pull_request.closed", { action: "closed", state: "closed" }],
        ["pull_request", "pull_request.reopened", { action: "reopened", state: "open" }],
        ["pull_request", "pull_request.labeled", { action: "labeled", label: "other" }],
        ["pull_request", "pull_request.unlabeled", { action: "unlabeled", label: "other" }],
        ["pull_request", "pull_request.synchronize", { action: "synchronize" }],
        ["pull_request", "pull_request.ready_for_review", { action: "ready_for_review" }],
        [
            "pull_request",
            "pull_request.converted_to_draft",
            { action: "converted_to_draft", draft: true },
        ],
        [
            "pull_request_review",
            "pull_request_review.submitted",
            { action: "submitted", review: "commented" },
        ],
        ["pull_request_review", "pull_request_review.dismissed", { action: "dismissed" }],
        [
            "check_suite",
            "check_suite.completed",
            { action: "completed", check: { status: "completed", conclusion: "success" } },
        ],
        ["status", "status", { state: "success", sha: "6113728f27ae82c7b1a177c8d03f9e96e0adf246" }],
        ["issues", "issues.opened", { action: "opened", state: "open" }],
        ["issues", "issues.reopened", { action: "reopened" }],
        ["issues", "issues.labeled", { action: "labeled", label: "other" }],
        ["issues", "issues.unlabeled", { action: "unlabeled" }],
    ];

    for (const [event, name, expected] of kept) {
        test(`${name}: the action is kept, with its checked fields`, () => {
            const built = buildFact(event, ID, 1000, fixture(name));

            assert.equal(built.kind, "fact");
            assert.ok(built.kind === "fact");
            assert.equal(built.fact.repo, "frostyard/test");
            assert.equal(built.fact.delivery, ID);

            for (const [key, value] of Object.entries(expected)) {
                assert.deepEqual(built.fact[key as keyof HookFact], value, key);
            }

            if (event !== "status") {
                assert.equal(typeof built.fact.number, "number");
            }
        });
    }

    test("issues closed (no example in the package: made from reopened)", () => {
        const payload = fixture("issues.reopened") as { action: string; issue: { state: string } };

        payload.action = "closed";
        payload.issue.state = "closed";

        const built = buildFact("issues", ID, 1000, payload);

        assert.ok(built.kind === "fact");
        assert.equal(built.fact.state, "closed");
        assert.equal(factClass(built.fact), "state");
    });

    test("any other action is dropped: ignored, with no action in the fact", () => {
        for (const [event, action] of [
            ["pull_request", "edited"],
            ["pull_request", "assigned"],
            ["pull_request_review", "edited"],
            ["check_suite", "requested"],
            ["issues", "edited"],
            ["installation_repositories", "renamed"],
        ] as const) {
            const payload = {
                ...fixture(
                    event === "installation_repositories"
                        ? "installation_repositories.added"
                        : event === "pull_request_review"
                          ? "pull_request_review.submitted"
                          : event === "check_suite"
                            ? "check_suite.completed"
                            : event === "issues"
                              ? "issues.opened"
                              : "pull_request.opened",
                ),
                action,
            };
            const built = buildFact(event, ID, 1000, payload);

            assert.equal(built.kind, "ignored", `${event} ${action}`);
            assert.equal(built.kind === "ignored" ? built.fact.action : "x", undefined);
        }
    });

    test("team labels are kept by name; others are 'other'; a bot sender is 'bot'", () => {
        const payload = pr() as {
            label: { name: string };
            sender: { login: string; type: string };
        };

        payload.label.name = "ready-for-human";
        payload.sender.login = "dependabot[bot]";
        payload.sender.type = "Bot";

        const built = buildFact("pull_request", ID, 1000, payload);

        assert.ok(built.kind === "fact");
        assert.equal(built.fact.label, "ready-for-human");
        assert.equal(built.fact.sender, "bot");
    });

    test("check_suite: every PR number (at most 20), the head sha, and main or master only as the branch", () => {
        const payload = fixture("check_suite.completed") as {
            check_suite: { pull_requests: { number: number }[]; head_branch: string };
        };

        payload.check_suite.pull_requests = Array.from({ length: 25 }, (_, index) => ({
            number: index + 1,
        }));
        payload.check_suite.head_branch = "main";

        let built = buildFact("check_suite", ID, 1000, payload);

        assert.ok(built.kind === "fact");
        assert.equal(built.fact.number, 1);
        assert.equal(built.fact.numbers?.length, 20);
        assert.equal(built.fact.branch, "main");
        assert.match(built.fact.sha ?? "", /^[0-9a-f]{40}$/);

        payload.check_suite.head_branch = "feature/x";
        built = buildFact("check_suite", ID, 1000, payload);
        assert.ok(built.kind === "fact");
        assert.equal(built.fact.branch, undefined);
    });

    test("installation events: their own schema; another account is unprocessable (422)", () => {
        const created = buildFact("installation", ID, 1000, fixture("installation.created"));

        assert.ok(created.kind === "fact");
        assert.equal(created.fact.repo, undefined);
        assert.equal(created.fact.installation?.account, "frostyard");
        assert.equal(created.fact.installation?.selection, "selected");
        assert.ok(
            (created.fact.installation?.repositories ?? []).every((repo) =>
                repo.startsWith("frostyard/"),
            ),
        );
        assert.equal(toNudgeFact(created.fact), undefined, "no nudge for an installation");

        const added = buildFact(
            "installation_repositories",
            ID,
            1000,
            fixture("installation_repositories.added"),
        );

        assert.ok(added.kind === "fact");
        assert.deepEqual(added.fact.installation?.added, ["frostyard/Space"]);

        const other = fixture("installation.created") as {
            installation: { account: { login: string } };
        };

        other.installation.account.login = "stranger";
        assert.equal(buildFact("installation", ID, 1000, other).kind, "unprocessable");
    });

    test("no valid repository, or another owner, is unprocessable", () => {
        assert.equal(
            buildFact("pull_request", ID, 1, fixture("pull_request.opened", "evil/x")).kind,
            "unprocessable",
        );
        assert.equal(
            buildFact("pull_request", ID, 1, fixture("pull_request.opened", "frostyard/<script>"))
                .kind,
            "unprocessable",
        );
        assert.equal(buildFact("pull_request", ID, 1, [1, 2]).kind, "unprocessable");
    });

    test("hostile text in every free-text field: no fact holds any of it", () => {
        const names = [
            "pull_request.opened",
            "pull_request.labeled",
            "pull_request.synchronize",
            "pull_request_review.submitted",
            "check_suite.completed",
            "status",
            "issues.opened",
            "issues.labeled",
        ];

        for (const name of names) {
            const event = name.split(".")[0]!;
            const built = buildFact(event, ID, 1000, withHostileText(fixture(name)));

            assert.ok(built.kind === "fact", name);

            const text = JSON.stringify(built.fact);

            for (const hostile of HOSTILE) {
                assert.ok(!text.includes(hostile), `${name}: ${hostile}`);
            }

            assert.equal(built.fact.sender, undefined, "a hostile login is dropped");
        }
    });
});

// ─── The delivery commit ─────────────────────────────────────────────────────

const docs = (): HookDocs => ({
    seen: { ids: {}, digests: {} },
    deliveries: { log: [], counts: {}, dropped: 0 },
    pending: { markers: {} },
    alarms: { system: {}, coverage: {}, misses: {}, evaluated: {} },
    coverage: { recent: [], installations: {}, repos: {} },
});

let counter = 0;

function job(overrides: Partial<DeliveryJob> = {}, fact: Partial<HookFact> = {}): DeliveryJob {
    counter += 1;

    const delivery =
        overrides.delivery ?? `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;

    return {
        delivery,
        digest: overrides.digest ?? `digest-${String(counter)}`,
        at: overrides.at ?? 1_000_000,
        ignored: false,
        ...overrides,
        fact: {
            delivery,
            at: overrides.at ?? 1_000_000,
            event: "pull_request",
            action: "labeled",
            repo: "frostyard/test",
            number: 7,
            label: "other",
            ...fact,
        },
    };
}

describe("The delivery commit", () => {
    test("the same id twice, and the same body under a new id: duplicate, recorded once each", () => {
        const state = docs();
        const first = job();

        assert.equal(applyDelivery(state, first, 1_000_000, { nudge: true }).outcome, "accepted");
        assert.equal(applyDelivery(state, first, 1_000_001, { nudge: true }).outcome, "duplicate");
        assert.equal(
            applyDelivery(state, job({ digest: first.digest }), 1_000_002, { nudge: true }).outcome,
            "duplicate",
        );
        assert.deepEqual(state.deliveries.counts, { accepted: 1, duplicate: 2 });
        assert.equal(Object.keys(state.pending.markers).length, 1);
        assert.equal(state.deliveries.log.filter((entry) => entry.fact !== undefined).length, 1);
    });

    test("a full set gives seen-full (503) and the alarm, and never drops an entry early; age frees it", () => {
        const state = docs();

        for (let index = 0; index < SEEN_MAX; index += 1) {
            state.seen.ids[`id-${String(index)}`] = 1_000_000;
            state.seen.digests[`d-${String(index)}`] = 1_000_000;
        }

        const full = applyDelivery(state, job(), 1_000_000 + 1000, { nudge: true });

        assert.equal(full.outcome, "seen-full");
        assert.equal(full.status, 503);
        assert.deepEqual(full.raised, ["seen-full"]);
        assert.equal(Object.keys(state.seen.ids).length, SEEN_MAX, "no entry dropped");
        assert.equal(state.alarms.system["seen-full"]?.cleared, undefined);

        const later = applyDelivery(state, job(), 1_000_000 + SEEN_MS + 1, { nudge: true });

        assert.equal(later.outcome, "accepted");
        assert.deepEqual(later.cleared, ["seen-full"]);
        assert.equal(Object.keys(state.seen.ids).length, 1);
    });

    test("a duplicate clears seen-full once the set is under its cap; a duplicate while it is full stays a duplicate", () => {
        const state = docs();
        const start = 1_000_000;

        // A full set: 1 entry old, the rest new; the alarm raised.
        state.seen.ids["old-id"] = start;
        state.seen.digests["old-digest"] = start;

        for (let index = 1; index < SEEN_MAX; index += 1) {
            state.seen.ids[`id-${String(index)}`] = start + SEEN_MS / 2;
            state.seen.digests[`d-${String(index)}`] = start + SEEN_MS / 2;
        }

        const redelivery = job({ delivery: "id-7", digest: "d-7" });

        assert.equal(
            applyDelivery(state, job(), start + SEEN_MS / 2, { nudge: true }).outcome,
            "seen-full",
        );

        // Still full: a redelivery is a duplicate, and the alarm stays.
        const whileFull = applyDelivery(state, redelivery, start + SEEN_MS / 2 + 1, {
            nudge: true,
        });

        assert.equal(whileFull.outcome, "duplicate");
        assert.deepEqual(whileFull.cleared, []);
        assert.equal(state.alarms.system["seen-full"]?.cleared, undefined);

        // The old entry expires: the next commit is a duplicate of an entry that did not expire, and clears the alarm.
        const after = start + SEEN_MS + 1;
        const result = applyDelivery(state, redelivery, after, { nudge: true });

        assert.equal(result.outcome, "duplicate");
        assert.deepEqual(result.cleared, ["seen-full"]);
        assert.equal(state.alarms.system["seen-full"]?.cleared, after);
        assert.equal(Object.keys(state.seen.ids).length, SEEN_MAX - 1);
    });

    test("200 pending markers: pending-full (503), only the refusal is recorded, the id is not seen", () => {
        const state = docs();

        for (let index = 0; index < PENDING_MAX; index += 1) {
            state.pending.markers[`m-${String(index)}`] = {
                fact: { delivery: `m-${String(index)}`, event: "issues", repo: "frostyard/x" },
                at: 1,
            };
        }

        const delivery = job();
        const result = applyDelivery(state, delivery, 1_000_000, { nudge: true });

        assert.equal(result.outcome, "pending-full");
        assert.equal(result.status, 503);
        assert.equal(state.seen.ids[delivery.delivery], undefined);
        assert.deepEqual(state.deliveries.counts, { "pending-full": 1 });

        // The desk off: no marker is needed, so the delivery goes through.
        assert.equal(
            applyDelivery(state, delivery, 1_000_000, { nudge: false }).outcome,
            "accepted",
        );
    });

    test("the desk off or old: the fact is recorded with no marker", () => {
        const state = docs();
        const result = applyDelivery(state, job(), 1_000_000, { nudge: false });

        assert.equal(result.outcome, "accepted");
        assert.equal(result.marker, false);
        assert.deepEqual(state.pending.markers, {});
        assert.equal(state.deliveries.last, 1_000_000);
    });

    test("an ignored action is seen (a replay is a duplicate), with no fact, no marker and no coverage", () => {
        const state = docs();
        const ignored = job({ ignored: true }, { action: undefined });

        assert.equal(applyDelivery(state, ignored, 1_000_000, { nudge: true }).outcome, "ignored");
        assert.deepEqual(state.pending.markers, {});
        assert.deepEqual(state.coverage.recent, []);
        assert.equal(state.deliveries.log[0]!.fact, undefined);
        assert.equal(
            applyDelivery(state, ignored, 1_000_000, { nudge: true }).outcome,
            "duplicate",
        );
    });

    test("an installation updates the coverage list only; installation_repositories adds and removes", () => {
        const state = docs();
        const install = (event: string, action: string, installation: HookFact["installation"]) =>
            applyDelivery(
                state,
                job(
                    {},
                    {
                        event,
                        action,
                        repo: undefined,
                        number: undefined,
                        label: undefined,
                        installation,
                    },
                ),
                1_000_000,
                { nudge: true },
            );

        install("installation", "created", {
            id: 5,
            account: "bketelsen",
            selection: "selected",
            repositories: ["bketelsen/a", "bketelsen/b"],
        });
        install("installation_repositories", "added", {
            id: 5,
            account: "bketelsen",
            added: ["bketelsen/C"],
            removed: ["bketelsen/a"],
        });
        assert.deepEqual(state.coverage.installations["5"], {
            account: "bketelsen",
            selection: "selected",
            repos: ["bketelsen/b", "bketelsen/c"],
        });
        assert.deepEqual(state.pending.markers, {});
        assert.deepEqual(state.coverage.recent, []);
        install("installation", "deleted", { id: 5, account: "bketelsen" });
        assert.equal(state.coverage.installations["5"], undefined);
    });

    test("the marker holds the desk's fact: the first number, no numbers", () => {
        const state = docs();
        const delivery = job(
            {},
            {
                event: "check_suite",
                action: "completed",
                number: 3,
                numbers: [3, 4],
                label: undefined,
                sha: "a".repeat(40),
            },
        );

        applyDelivery(state, delivery, 1_000_000, { nudge: true });
        assert.deepEqual(state.pending.markers[delivery.delivery]!.fact, {
            delivery: delivery.delivery,
            at: 1_000_000,
            event: "check_suite",
            action: "completed",
            repo: "frostyard/test",
            number: 3,
            sha: "a".repeat(40),
        });
    });
});

// ─── The coverage alarm ──────────────────────────────────────────────────────

describe("The coverage alarm", () => {
    const H = 3600_000;
    const NOW = 100 * H;
    const covered = (): CoverageState => ({
        recent: [],
        installations: { "1": { account: "frostyard", selection: "all", repos: [] } },
        repos: { "bketelsen/b": NOW - H },
    });
    const alarms = (): AlarmsState => ({ system: {}, coverage: {}, misses: {}, evaluated: {} });
    const change = (repo: string, number: number, cls: string, seen: number, at = 0) => ({
        repo,
        number,
        kind: "pr",
        class: cls,
        at,
        seen,
    });

    test("24 hours of silence raise nothing", () => {
        const state = alarms();
        const observed: ObservedState = { last: {}, changes: [] };

        for (let hour = 0; hour <= 24; hour += 1) {
            assert.deepEqual(evaluateCoverage(observed, covered(), state, NOW + hour * H), []);
        }

        assert.deepEqual(state.coverage, {});
    });

    test("2 misses of 1 class raise the alarm for that repository and class only", () => {
        const state = alarms();
        const observed: ObservedState = {
            last: {},
            changes: [
                change("frostyard/A", 1, "labels", NOW - 2 * H),
                change("frostyard/A", 2, "labels", NOW - 3 * H),
                change("bketelsen/b", 3, "state", NOW - 2 * H),
                change("someone/else", 4, "labels", NOW - 2 * H),
                change("someone/else", 5, "labels", NOW - 2 * H),
            ],
        };

        assert.deepEqual(evaluateCoverage(observed, covered(), state, NOW), ["frostyard/a|labels"]);
        assert.deepEqual(Object.keys(state.coverage), ["frostyard/a|labels"]);
        assert.equal(state.misses["bketelsen/b|state"]?.length, 1, "1 miss raises nothing");
        assert.equal(state.misses["someone/else|labels"], undefined, "not covered");

        // Each change is checked once.
        assert.deepEqual(evaluateCoverage(observed, covered(), state, NOW + 5 * 60_000), []);
        assert.equal(state.misses["frostyard/a|labels"]?.length, 2);
    });

    test("a change younger than 30 minutes, or older than 24 hours, is not checked", () => {
        const state = alarms();
        const observed: ObservedState = {
            last: {},
            changes: [
                change("frostyard/A", 1, "labels", NOW - 10 * 60_000),
                change("frostyard/A", 2, "labels", NOW - 25 * H),
            ],
        };

        assert.deepEqual(evaluateCoverage(observed, covered(), state, NOW), []);
        assert.deepEqual(state.misses, {});
    });

    test("a matching fact in the window is no miss: same number, numbers, a status sha, a head fact for ci", () => {
        const state = alarms();
        const coverage = covered();
        const head = "c".repeat(40);

        coverage.recent = [
            { repo: "frostyard/a", number: 1, class: "labels", at: NOW - 2 * H },
            { repo: "frostyard/a", numbers: [9, 2], number: 9, class: "ci", at: NOW - 2 * H },
            { repo: "frostyard/a", sha: head, class: "ci", at: NOW - 2 * H, event: "status" },
            { repo: "frostyard/a", number: 4, class: "head", at: NOW - 2 * H },
        ];

        const observed: ObservedState = {
            last: { "frostyard/a#3": { head } },
            changes: [
                change("frostyard/A", 1, "labels", NOW - 2 * H, NOW - 2 * H),
                change("frostyard/A", 2, "ci", NOW - 2 * H),
                change("frostyard/A", 3, "ci", NOW - 2 * H),
                change("frostyard/A", 4, "ci", NOW - 2 * H),
            ],
        };

        assert.deepEqual(evaluateCoverage(observed, coverage, state, NOW), []);
        assert.deepEqual(state.misses, {});

        // A fact outside the window does not match.
        coverage.recent = [{ repo: "frostyard/a", number: 5, class: "state", at: NOW - 20 * H }];
        observed.changes = [change("frostyard/A", 5, "state", NOW - H, NOW - 2 * H)];
        evaluateCoverage(observed, coverage, state, NOW);
        assert.equal(state.misses["frostyard/a|state"]?.length, 1);
    });

    test("by the observed head sha, a status fact matches a CI change", () => {
        const state = alarms();
        const coverage = covered();
        const head = "d".repeat(40);

        coverage.recent = [
            { repo: "frostyard/a", sha: head, class: "ci", at: NOW - 2 * H, event: "status" },
        ];
        evaluateCoverage(
            {
                last: { "frostyard/a#3": { head } },
                changes: [change("frostyard/A", 3, "ci", NOW - 2 * H)],
            },
            coverage,
            state,
            NOW,
        );
        assert.deepEqual(state.misses, {});
    });

    test("by the observed head sha, a check_suite fact of another number does not match: it matches by number only", () => {
        const state = alarms();
        const coverage = covered();
        const head = "d".repeat(40);

        // The same head sha, but the suite belongs to PR 8, not PR 3; an entry with no event is not a status fact.
        coverage.recent = [
            {
                repo: "frostyard/a",
                number: 8,
                numbers: [8],
                sha: head,
                class: "ci",
                at: NOW - 2 * H,
            },
            { repo: "frostyard/a", sha: head, class: "ci", at: NOW - 2 * H },
        ];
        evaluateCoverage(
            {
                last: { "frostyard/a#3": { head } },
                changes: [change("frostyard/A", 3, "ci", NOW - 2 * H)],
            },
            coverage,
            state,
            NOW,
        );
        assert.equal(state.misses["frostyard/a|ci"]?.length, 1, "a miss");
    });

    test("the delivery commit stores event status for a status fact, and none for a check_suite fact", () => {
        const state = docs();

        applyDelivery(
            state,
            job(
                {},
                {
                    event: "status",
                    action: undefined,
                    number: undefined,
                    label: undefined,
                    sha: "e".repeat(40),
                },
            ),
            1_000_000,
            { nudge: false },
        );
        applyDelivery(
            state,
            job(
                {},
                {
                    event: "check_suite",
                    action: "completed",
                    number: 4,
                    numbers: [4],
                    label: undefined,
                    sha: "e".repeat(40),
                },
            ),
            1_000_000,
            { nudge: false },
        );
        assert.deepEqual(
            state.coverage.recent.map((each) => each.event),
            ["status", undefined],
        );
    });

    test("only a fact of that repository and class clears it; another class or repository does not", () => {
        const state = docs();

        state.alarms.coverage["frostyard/test|labels"] = { raised: 1, misses: [1, 2] };

        applyDelivery(state, job({}, { action: "closed", label: undefined }), 1_000_000, {
            nudge: false,
        });
        applyDelivery(state, job({}, { repo: "frostyard/other" }), 1_000_000, { nudge: false });
        assert.equal(state.alarms.coverage["frostyard/test|labels"]?.cleared, undefined);

        const cleared = applyDelivery(state, job(), 1_000_000, { nudge: false });

        assert.deepEqual(cleared.coverageCleared, ["frostyard/test|labels"]);
        assert.equal(state.alarms.coverage["frostyard/test|labels"]?.cleared, 1_000_000);
    });
});

// ─── The receiver loop ───────────────────────────────────────────────────────

const applied = (marker: boolean): ApplyResult => ({
    outcome: "accepted",
    status: 202,
    marker,
    raised: [],
    cleared: [],
    coverageCleared: [],
});

describe("The receiver loop", () => {
    test("the inbox holds at most 16 jobs; a job that timed out at the listener leaves it and never commits", async () => {
        const inbox = createInbox();
        const committed: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let stop = false;
        const loop = createReceiverLoop({
            inbox,
            now: Date.now,
            tickMs: 5,
            stopped: () => stop,
            wait: (ms) =>
                new Promise<void>((resolve) => {
                    const timer = setTimeout(done, ms);

                    function done() {
                        clearTimeout(timer);
                        inbox.onWake(undefined);
                        resolve();
                    }

                    inbox.onWake(done);
                }),
            // The commit is held: the first job stays active until the test lets it go.
            deliver: async (job) => {
                committed.push(job.delivery);
                await held;

                return applied(false);
            },
            desk: () => undefined,
            hasNudge: () => false,
            handOver: async () => 0,
            flushMemory: async () => {},
            evaluate: async () => {},
        });
        const running = loop.run();
        const hooks = await listen({
            limits: { jobTimeoutMs: 20 },
            receiver: { taskId: "1", submit: (job, options) => inbox.submit(job, options) },
        });
        const sizes: number[] = [];

        try {
            // The listener gives up on each job again and again while the commit is held.
            const expired: string[] = [];

            for (let index = 0; index < 30; index += 1) {
                const id = randomUUID();

                expired.push(id);
                assert.equal(
                    (await raw(hooks.port, deliveryBytes("pull_request", pr(), { id }))).status,
                    503,
                );
                sizes.push(inbox.size());
            }

            assert.ok(
                Math.max(...sizes) <= INBOX_MAX,
                `the inbox held ${String(Math.max(...sizes))}`,
            );
            assert.equal(inbox.size(), 1, "only the active job: every expired job left the inbox");

            // Jobs that nobody cancels: the bound holds, and the rest get receiver-busy at once.
            const direct = Array.from({ length: 20 }, () => {
                const job = {
                    delivery: randomUUID(),
                    digest: randomUUID(),
                    at: 1,
                    ignored: false,
                    fact: { delivery: "x", at: 1, event: "issues" },
                };

                return { job, answer: inbox.submit(job) };
            });

            assert.equal(inbox.size(), INBOX_MAX);

            const busy = await Promise.race([
                Promise.all(direct.slice(INBOX_MAX - 1).map((each) => each.answer)),
                new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
            ]);

            assert.deepEqual(
                busy?.map((each) => each.outcome),
                Array.from({ length: 20 - (INBOX_MAX - 1) }, () => "receiver-busy"),
            );

            release();
            await Promise.all(direct.slice(0, INBOX_MAX - 1).map((each) => each.answer));

            const first = committed[0]!;

            assert.ok(expired.includes(first), "the first expired job was active: its commit ran");
            assert.deepEqual(
                committed.filter((id) => expired.includes(id)),
                [first],
                "no cancelled job committed",
            );
            assert.equal(committed.length, 1 + INBOX_MAX - 1);
        } finally {
            release();
            stop = true;
            hooks.close();
            inbox.close();
            await running;
        }
    });

    test("the nudge back-off holds for every caller: deliveries before the retry time call no nudge", async () => {
        let now = 1_000_000;
        const inbox = createInbox();
        const calls: number[] = [];
        let callsAfterJobs = -1;
        let jobs = 0;
        let stop = false;

        for (let index = 0; index < 10; index += 1) {
            void inbox.submit(job());
        }

        const loop = createReceiverLoop({
            inbox,
            now: () => now,
            tickMs: 2_000,
            stopped: () => stop,
            // Time moves on only while the inbox is empty; the loop stops after the retry time.
            wait: async () => {
                now += 25_000;

                if (now > 1_000_000 + 2 * NUDGE_RETRY_MS) {
                    stop = true;
                }
            },
            deliver: async () => {
                now += 1_000;

                return applied(true);
            },
            afterDelivery: () => {
                jobs += 1;

                if (jobs === 10) {
                    callsAfterJobs = calls.length;
                }
            },
            desk: () => "desk",
            hasNudge: () => true,
            handOver: async () => {
                calls.push(now);

                throw new Error("nudge failed");
            },
            flushMemory: async () => {},
            evaluate: async () => {},
        });

        await loop.run();
        assert.equal(
            callsAfterJobs,
            1,
            "10 deliveries with markers before the retry time: no new nudge",
        );
        assert.ok(calls.length >= 2, "a try after the retry time");
        assert.equal(calls[0], 1_000_000);

        for (let index = 1; index < calls.length; index += 1) {
            assert.ok(
                calls[index]! - calls[index - 1]! >= NUDGE_RETRY_MS,
                `try ${String(index)} came ${String(calls[index]! - calls[index - 1]!)} ms after the one before`,
            );
        }
    });

    test("a busy inbox does not starve the maintenance: refusals, the coverage alarm and the desk change run", async () => {
        let now = 0;
        const inbox = createInbox();
        let desk = { version: 1 };
        let flushes = 0;
        let evaluations = 0;
        let handOvers = 0;
        let waits = 0;
        let stop = false;

        for (let index = 0; index < INBOX_MAX; index += 1) {
            void inbox.submit(job());
        }

        const loop = createReceiverLoop({
            inbox,
            now: () => now,
            tickMs: 2_000,
            stopped: () => stop,
            wait: async () => {
                waits += 1;
                stop = true;
            },
            // Each job takes 1 s, and a new job comes for each one done: the inbox never empties.
            deliver: async () => {
                now += 1_000;

                return applied(false);
            },
            afterDelivery: () => {
                void inbox.submit(job());

                if (now === 3 * 60_000) {
                    desk = { version: 2 };
                }

                if (now >= COVERAGE_EVERY_MS + 60_000) {
                    stop = true;
                }
            },
            desk: () => desk,
            hasNudge: () => true,
            handOver: async () => {
                handOvers += 1;

                return 0;
            },
            flushMemory: async () => {
                flushes += 1;
            },
            evaluate: async () => {
                evaluations += 1;
            },
        });

        await loop.run();
        assert.equal(waits, 0, "the inbox never emptied");
        // 1 flush at the start, then 1 every 10 s over 6 minutes.
        assert.ok(
            flushes >= (COVERAGE_EVERY_MS + 60_000) / REFUSAL_FLUSH_MS,
            `${String(flushes)} refusal flushes`,
        );
        assert.equal(evaluations, 1, "the coverage alarm ran after 5 minutes");
        assert.equal(handOvers, 2, "the start, and the desk that changed at 3 minutes");
        inbox.close();
    });
});
