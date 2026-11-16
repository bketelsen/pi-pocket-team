/**
 * The events bridge's engine (events-bridge.ts), with a fake lodge, broker, inbox and clock: batches, the wake cap, the
 * digest, the store and its ack order, restarts, revokes, pauses and the standing events session. The tools in Pi
 * Pocket are in events-bridge.pocket.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { InboxDelivery } from "./_pocket.d.ts";
import {
    AgentBridge,
    type AgentState,
    AuthRequired,
    BATCH_MS,
    type BrokerConnection,
    brokerName,
    DIGEST_CAP,
    digestDay,
    digestTime,
    eventLine,
    gatewayEntries,
    gatewayOf,
    type Lodge,
    type LodgeAnswer,
    type LodgeSub,
    nextDigestAt,
    type Pulled,
    RETRIES,
    RETRY_MS,
    type Sessions,
    StateFile,
    thinEvent,
    TokenFile,
    type Transport,
    WAKES_PER_HOUR,
    writePrivate,
} from "./events-bridge.ts";

/** The vendored client's bytes (scripts/vendor-nats.mjs, docs/adr/0004): a change to it changes this pin. */
const NATS_SHA256 = "63246117c14acea292e25a4676dc109861b9ae1b50d3ef20ce3c54e8ae40ece3";

const roots: string[] = [];

const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "events-bridge-test-"));

    roots.push(dir);

    return dir;
};

after(() => {
    for (const dir of roots) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const HOME = "/home/agents/moneo";
const GATEWAY = "https://lodge.example/gateway/mcp";
const T0 = Date.UTC(2026, 10, 16, 15, 0, 0); // 10:00 in New York, after the day's digest time.

/** A status error, as Pocket's inbox throws it. */
const status = (code: number) =>
    Object.assign(new Error(`status ${String(code)}`), { status: code });

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

let serial = 0;
const event = (fields: Record<string, unknown> = {}) => ({
    specversion: "1.0",
    id: `0197-${String(++serial).padStart(4, "0")}`,
    source: "/marks",
    type: "org.frostyard.marks.bookmark.created",
    subject: `bm-${String(serial)}`,
    time: "2026-11-16T15:00:00Z",
    author: "brian",
    selector: "/Reading",
    ...fields,
});

class FakeLodge implements Lodge {
    tokenError: Error | undefined;
    listAnswer: () => LodgeAnswer<LodgeSub[]> = () => ({
        ok: true,
        value: [...this.subs.values()],
    });
    readonly subs = new Map<string, LodgeSub>();
    puts = 0;

    async token(): Promise<string> {
        if (this.tokenError !== undefined) {
            throw this.tokenError;
        }

        return "lgo_at_test";
    }

    async inboxPrefix(): Promise<string> {
        return "_INBOX.otest";
    }

    async put(name: string, topic: string): Promise<LodgeAnswer<LodgeSub>> {
        this.puts++;

        const sub: LodgeSub = {
            name,
            app: topic.split(".")[0]!,
            topic,
            stream: "EVENTS_marks",
            consumer: `c_${name}_${String(this.puts)}`,
            filters: [`${topic.split(".")[0]!}.>`],
        };

        this.subs.set(name, sub);

        return { ok: true, value: sub };
    }

    async remove(name: string): Promise<LodgeAnswer<undefined>> {
        this.subs.delete(name);

        return { ok: true, value: undefined };
    }

    async list(): Promise<LodgeAnswer<LodgeSub[]>> {
        if (this.tokenError !== undefined) {
            throw this.tokenError;
        }

        return this.listAnswer();
    }
}

type Delivered = { target: number; delivery: InboxDelivery; sent: boolean };

/** Pocket's inbox and sessions: once for each key, as `host.inbox.deliver` and `host.sessions.start` are. */
class FakeSessions implements Sessions {
    readonly delivered: Delivered[] = [];
    readonly started: { source: number; request: { title: string; cwd: string }; key: string }[] =
        [];
    readonly folders = new Map<number, string>();
    readonly keys = new Set<string>();
    /** The next answers of `deliver`: an error to throw, or "crash" (it went, then the caller died). */
    readonly script: (Error | "crash")[] = [];
    #next = 100;

    async deliver(target: number, delivery: InboxDelivery): Promise<{ sent: boolean }> {
        const step = this.script.shift();

        if (step instanceof Error) {
            throw step;
        }

        if (!this.folders.has(target)) {
            throw status(410);
        }

        const sent = !this.keys.has(delivery.key);

        this.keys.add(delivery.key);
        this.delivered.push({ target, delivery, sent });

        if (step === "crash") {
            throw new Error("the process stopped after the delivery");
        }

        return { sent };
    }

    async start(
        source: number,
        request: { title: string; cwd: string },
        key: string,
    ): Promise<number> {
        this.started.push({ source, request, key });

        const id = this.#next++;

        this.folders.set(id, request.cwd);

        return id;
    }

    folder(session: number): string | undefined {
        return this.folders.get(session);
    }

    /** The deliveries that sent a message (not a repeat of a key). */
    sent(): Delivered[] {
        return this.delivered.filter((each) => each.sent);
    }
}

class FakeConnection implements BrokerConnection {
    readonly queues = new Map<string, Uint8Array[]>();
    readonly waiting = new Map<string, (pulled: Pulled) => void>();
    readonly acked: string[] = [];
    gone = new Set<string>();
    #close: () => void = () => undefined;
    readonly closed = new Promise<void>((resolve) => (this.#close = resolve));
    #ended = false;

    push(consumer: string, data: Uint8Array): void {
        const waiter = this.waiting.get(consumer);

        if (waiter !== undefined) {
            this.waiting.delete(consumer);
            waiter({
                kind: "message",
                data,
                reply: `ack.${consumer}.${String(this.acked.length)}`,
            });

            return;
        }

        this.queues.set(consumer, [...(this.queues.get(consumer) ?? []), data]);
    }

    async pull(_stream: string, consumer: string): Promise<Pulled> {
        if (this.#ended) {
            return { kind: "closed" };
        }

        if (this.gone.has(consumer)) {
            return { kind: "gone", reason: "404 Consumer Deleted" };
        }

        const queued = this.queues.get(consumer)?.shift();

        if (queued !== undefined) {
            return { kind: "message", data: queued, reply: `ack.${consumer}` };
        }

        return new Promise((resolve) => this.waiting.set(consumer, resolve));
    }

    /** lodge deletes a consumer: its waiting pull, and each pull after, finds it gone. */
    lose(consumer: string): void {
        this.gone.add(consumer);
        this.waiting.get(consumer)?.({ kind: "gone", reason: "409 Consumer Deleted" });
        this.waiting.delete(consumer);
    }

    async ack(reply: string): Promise<void> {
        this.acked.push(reply);
    }

    async close(): Promise<void> {
        this.#ended = true;

        for (const waiter of this.waiting.values()) {
            waiter({ kind: "closed" });
        }

        this.waiting.clear();
        this.#close();
    }
}

type Rig = {
    bridge: AgentBridge;
    lodge: FakeLodge;
    sessions: FakeSessions;
    notices: string[];
    file: StateFile;
    dir: string;
    clock: { now: number };
    connections: FakeConnection[];
    /** A new bridge on the same store, lodge and sessions: a restart. */
    restart: () => Promise<AgentBridge>;
};

const ORIGIN = { by: "brian", source: 7 };

async function rig(options: { running?: boolean } = {}): Promise<Rig> {
    const dir = scratch();
    const lodge = new FakeLodge();
    const sessions = new FakeSessions();
    const notices: string[] = [];
    const clock = { now: T0 };
    const file = new StateFile(dir, "moneo");
    const connections: FakeConnection[] = [];

    const transport: Transport = async () => {
        const connection = new FakeConnection();

        connections.push(connection);

        return connection;
    };

    sessions.folders.set(ORIGIN.source, join(HOME, "chat"));

    const make = async () => {
        const bridge = new AgentBridge({
            agent: { id: "moneo", name: "Moneo", home: HOME },
            file,
            lodge,
            transport,
            sessions,
            notice: (_level, message) => notices.push(message),
            now: () => clock.now,
            // The tests run the due work with tick(); only the pulls' waits use a real timer.
            timer:
                options.running === true
                    ? (run, ms) => {
                          const handle = setTimeout(run, Math.min(ms, 5));

                          return () => clearTimeout(handle);
                      }
                    : () => () => undefined,
            backoff: () => 1,
        });

        await bridge.open(GATEWAY);

        return bridge;
    };

    const bridge = await make();

    return {
        bridge,
        lodge,
        sessions,
        notices,
        file,
        dir,
        clock,
        connections,
        restart: make,
    };
}

/** The bridge stays idle: subscribe with the pulls stopped. */
async function subscribe(r: Rig, topic = "marks.bookmark", mode: "now" | "digest" = "now") {
    return (await r.bridge.subscribe(topic, mode, ORIGIN)).sub;
}

const receive = (bridge: AgentBridge, sub: string, value: unknown, acks: string[] = []) =>
    bridge.receive(sub, bytes(value), async () => {
        acks.push((value as { id: string }).id);
    });

describe("events bridge: pure parts", () => {
    test("the vendored nats.js is the pinned bundle", () => {
        const bundle = readFileSync(join(import.meta.dirname, "_events-bridge-nats.mjs"));

        assert.equal(createHash("sha256").update(bundle).digest("hex"), NATS_SHA256);
        assert.match(bundle.toString("utf8", 0, 2000), /@nats-io\/nats-core 3\.4\.0/);
    });

    test("a broker name is lodge's: o and the client ID's 16 bytes in lower-case base32", () => {
        assert.equal(brokerName("lgc_AAECAwQFBgcICQoLDA0ODw"), "oaaaqeayeaudaocajbifqydiob4");
        assert.equal(brokerName("lgc_8PHy8_T19vf4-fr7_P3-_w"), "o6dy7f47u6x3pp6hz7l57z7p674");
        assert.equal(brokerName("lgc_short"), undefined);
        assert.equal(brokerName("xyz_AAECAwQFBgcICQoLDA0ODw"), undefined);
    });

    test("a thin event keeps the envelope's fields, 1 line each, and refuses what is no event", () => {
        const thin = thinEvent(
            bytes(event({ subject: "a\nb", data: { secret: "no" }, author: "x".repeat(100) })),
        );

        assert.equal(thin?.subject, "a b");
        assert.equal(thin?.author?.length, 64);
        assert.equal("data" in (thin ?? {}), false);
        assert.equal(thinEvent(bytes({ type: "x" })), undefined);
        assert.equal(thinEvent(new TextEncoder().encode("not json")), undefined);
        assert.equal(thinEvent(bytes([1, 2])), undefined);
        assert.match(
            eventLine(thin!),
            /^2026-11-16T15:00:00Z org\.frostyard\.marks\.bookmark\.created subject=a b /,
        );
    });

    test("the digest is due at 08:00 America/New_York, in summer and winter time", () => {
        assert.equal(new Date(digestTime("2026-11-16")).toISOString(), "2026-11-16T13:00:00.000Z");
        assert.equal(new Date(digestTime("2026-07-01")).toISOString(), "2026-07-01T12:00:00.000Z");
        // The days the clock changes: 2026-03-08 (spring) and 2026-11-01 (fall), both before 08:00.
        assert.equal(new Date(digestTime("2026-03-08")).toISOString(), "2026-03-08T12:00:00.000Z");
        assert.equal(new Date(digestTime("2026-11-01")).toISOString(), "2026-11-01T13:00:00.000Z");
        // 03:00 UTC on the 17th is still the 16th in New York.
        assert.equal(digestDay(Date.UTC(2026, 10, 17, 3)), "2026-11-16");

        const before = Date.UTC(2026, 10, 16, 12, 59);

        assert.equal(nextDigestAt(before, "2026-11-15"), digestTime("2026-11-16"));
        assert.equal(nextDigestAt(T0, "2026-11-16"), digestTime("2026-11-17"));
    });

    test("a gateway is an mcp.json entry with the path /gateway/mcp, on https or loopback", async () => {
        const dir = scratch();
        const file = join(dir, "mcp.json");

        await writePrivate(
            file,
            JSON.stringify({
                mcpServers: {
                    "chani-lodge": { url: "https://lodge.example/gateway/mcp" },
                    frostnotes: { url: "https://lodge.example/mcp/notes" },
                    plain: { url: "http://lodge.example/gateway/mcp" },
                    local: { url: "http://127.0.0.1:8080/gateway/mcp" },
                    truenas: { command: "truenas-mcp" },
                },
            }),
        );

        const entries = await gatewayEntries(file);

        assert.deepEqual(entries, {
            "chani-lodge": "https://lodge.example/gateway/mcp",
            local: "http://127.0.0.1:8080/gateway/mcp",
        });
        assert.equal(gatewayOf(["frostnotes", "chani-lodge"], entries), entries["chani-lodge"]);
        assert.equal(gatewayOf(["frostnotes", "truenas"], entries), undefined);
        assert.deepEqual(await gatewayEntries(join(dir, "none.json")), {});
    });

    test("the token file is 0600, its tokens are hidden at load and save, and it is not the mcp module's oauth.json", async () => {
        const dir = scratch();
        const hidden: string[] = [];
        const tokens = new TokenFile(dir, "moneo", (value) => hidden.push(value));

        assert.equal(tokens.path, join(dir, "moneo.json"));
        assert.equal(await tokens.signedIn(), false);
        await tokens.save({
            tokens: {
                access_token: "lgo_at_secret",
                refresh_token: "lgo_rt_secret",
                token_type: "Bearer",
            },
            clientInformation: { client_id: "lgc_AAECAwQFBgcICQoLDA0ODw" },
        } as never);
        assert.deepEqual(hidden, ["lgo_at_secret", "lgo_rt_secret"]);
        assert.equal(statSync(tokens.path).mode & 0o777, 0o600);
        assert.equal(await tokens.signedIn(), true);
        assert.equal(await tokens.clientId(), "lgc_AAECAwQFBgcICQoLDA0ODw");

        // A new load of the module hides them again when it reads the file.
        const later: string[] = [];

        await new TokenFile(dir, "moneo", (value) => later.push(value)).load();
        assert.deepEqual(later, ["lgo_at_secret", "lgo_rt_secret"]);
        assert.doesNotMatch(tokens.path, /oauth\.json$/);
    });
});

describe("events bridge: now batches and the wake cap", () => {
    test("events of 60 s go in 1 wake to the events session, and the ack comes after the store write", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const acks: string[] = [];
        const first = event();

        // The ack sees the event on disk.
        await r.bridge.receive(sub.name, bytes(first), async () => {
            const stored = JSON.parse(readFileSync(r.file.path, "utf8")) as AgentState;

            assert.equal(stored.pending[first.id]?.state, "batched");
            acks.push(first.id);
        });
        r.clock.now += 10_000;
        await receive(r.bridge, sub.name, event(), acks);
        r.clock.now += 40_000;
        await receive(r.bridge, sub.name, event(), acks);
        assert.equal(acks.length, 3);
        assert.equal(statSync(r.file.path).mode & 0o777, 0o600);

        r.clock.now = T0 + BATCH_MS - 1;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);

        r.clock.now = T0 + BATCH_MS;
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.delivery.key, `eb-moneo-b-${first.id}`);
        assert.equal(sent[0]!.delivery.payload.split("\n").length, 4);
        assert.equal(sent[0]!.delivery.limit?.perHour, WAKES_PER_HOUR);
        assert.equal(sent[0]!.delivery.by, "brian");
        // The events session, made once, in the agent's home; never Brian's chat.
        assert.equal(r.sessions.started.length, 1);
        assert.equal(r.sessions.started[0]!.request.cwd, HOME);
        assert.equal(r.sessions.started[0]!.request.title, "Moneo events");
        assert.notEqual(sent[0]!.target, ORIGIN.source);
        assert.deepEqual(r.bridge.state.pending, {});
    });

    test(`at most ${String(WAKES_PER_HOUR)} wakes an hour for a subscription: the next batch goes to the digest`, async () => {
        const r = await rig();
        const sub = await subscribe(r);

        for (let wake = 0; wake < WAKES_PER_HOUR + 1; wake++) {
            await receive(r.bridge, sub.name, event());
            r.clock.now += BATCH_MS;
            await r.bridge.tick();
        }

        assert.equal(r.sessions.sent().length, WAKES_PER_HOUR);
        assert.equal(r.bridge.pendingCount(), 1);

        // An hour after the first wake, the next batch wakes again.
        r.clock.now = T0 + 3_600_000 + 1;
        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.sent().length, WAKES_PER_HOUR + 1);
    });

    test("a 429 moves the batch to the digest, with no retry", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        await receive(r.bridge, sub.name, event());
        r.sessions.script.push(status(429));
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        r.clock.now += 3_600_000;
        await r.bridge.tick();

        assert.equal(
            r.sessions.delivered.filter((each) => !each.delivery.key.includes("digest")).length,
            0,
        );
        assert.equal(Object.keys(r.bridge.state.batches).length, 0);
        assert.equal(r.bridge.pendingCount(), 2);
    });

    test(`a 409 is tried again with the same key, ${String(RETRIES)} times at most, then the digest`, async () => {
        const r = await rig();
        const sub = await subscribe(r);
        let calls = 0;
        const deliver = r.sessions.deliver.bind(r.sessions);

        r.sessions.deliver = async (target, delivery) => {
            calls++;
            assert.equal(delivery.key.startsWith("eb-moneo-b-"), true);

            return deliver(target, delivery);
        };

        await receive(r.bridge, sub.name, event());

        for (let attempt = 0; attempt <= RETRIES; attempt++) {
            r.sessions.script.push(status(409));
        }

        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        for (const wait of RETRY_MS) {
            r.clock.now += wait - 1;
            await r.bridge.tick();
            r.clock.now += 1;
            await r.bridge.tick();
        }

        assert.equal(calls, RETRIES + 1);
        assert.equal(Object.keys(r.bridge.state.batches).length, 0);
        assert.equal(r.bridge.pendingCount(), 1);

        // A 409 that clears in time delivers.
        const next = await rig();
        const nextSub = await subscribe(next);

        await receive(next.bridge, nextSub.name, event());
        next.sessions.script.push(status(409), status(409));
        next.clock.now += BATCH_MS;
        await next.bridge.tick();
        next.clock.now += RETRY_MS[0];
        await next.bridge.tick();
        next.clock.now += RETRY_MS[1];
        await next.bridge.tick();
        assert.equal(next.sessions.sent().length, 1);
    });

    test("a mode change to digest moves the open batch to the digest", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        await r.bridge.subscribe("marks.bookmark", "digest", ORIGIN);
        assert.equal(r.bridge.state.subs[sub.name]?.mode, "digest");
        assert.equal(r.bridge.pendingCount(), 1);
        assert.equal(r.lodge.puts, 2);
    });
});

describe("events bridge: restarts give 1 delivery", () => {
    test("a crash before the delivery: the restarted bridge delivers the stored batch once", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const e = event();

        await receive(r.bridge, sub.name, e);
        await r.bridge.stop();

        const again = await r.restart();

        r.clock.now += BATCH_MS;
        await again.tick();
        await again.tick();
        assert.equal(r.sessions.sent().length, 1);
        // The broker brings the event again (its ack was lost): it is acked and dropped.
        const acks: string[] = [];

        await receive(again, sub.name, e, acks);
        assert.deepEqual(acks, [e.id]);
        assert.equal(Object.keys(again.state.pending).length, 0);
        r.clock.now += BATCH_MS;
        await again.tick();
        assert.equal(r.sessions.sent().length, 1);
    });

    test("a crash after the delivery, before the store write: the same key sends nothing again", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        r.sessions.script.push("crash");
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(Object.keys(r.bridge.state.batches).length, 1);
        await r.bridge.stop();

        const again = await r.restart();

        r.clock.now += RETRY_MS[0];
        await again.tick();
        assert.equal(r.sessions.delivered.length, 2);
        assert.equal(r.sessions.sent().length, 1);
        assert.equal(Object.keys(again.state.batches).length, 0);
        assert.equal(Object.keys(again.state.pending).length, 0);
    });

    test("an event seen before is dropped, also while it waits in the store", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const e = event();
        const acks: string[] = [];

        await receive(r.bridge, sub.name, e, acks);
        await receive(r.bridge, sub.name, e, acks);
        assert.deepEqual(acks, [e.id, e.id]);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
    });
});

describe("events bridge: the digest, own events, revokes and pauses", () => {
    test("digest events go out once at 08:00 America/New_York, and events_pending takes the rest", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        // The day's digest time is past at T0: the first tick only marks today.
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);

        for (let n = 0; n < 45; n++) {
            await receive(r.bridge, sub.name, event());
        }

        const eight = digestTime("2026-11-17");

        r.clock.now = eight - 1;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);

        r.clock.now = eight;
        await r.bridge.tick();
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.delivery.key, "eb-moneo-digest-2026-11-17");
        assert.match(sent[0]!.delivery.payload, /^Daily digest: 45 events\./);
        assert.match(
            sent[0]!.delivery.payload,
            /5 more events wait in the digest: call events_pending/,
        );
        assert.equal(r.bridge.pendingCount(), 5);

        const taken = await r.bridge.takePending(3);

        assert.equal(taken.events.length, 3);
        assert.equal(taken.more, 2);
        assert.equal(r.bridge.pendingCount(), 2);

        // The next morning: the 2 that wait.
        r.clock.now = digestTime("2026-11-18");
        await r.bridge.tick();
        assert.equal(r.sessions.sent().length, 2);
        assert.equal(r.bridge.pendingCount(), 0);
    });

    test(`the digest keeps ${String(DIGEST_CAP)} events and counts the ones it dropped`, async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        for (let n = 0; n < DIGEST_CAP + 3; n++) {
            await receive(r.bridge, sub.name, event());
        }

        assert.equal(r.bridge.pendingCount(), DIGEST_CAP);
        assert.equal(r.bridge.state.digest.dropped, 3);
    });

    test("the agent's own events are acked and dropped", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const acks: string[] = [];
        const own = event({ author: "moneo" });

        await receive(r.bridge, sub.name, own, acks);
        assert.deepEqual(acks, [own.id]);
        assert.deepEqual(r.bridge.state.pending, {});
    });

    test("a revoke (a 401 from lodge) deletes the undelivered events, pauses, and posts 1 notice", async () => {
        const r = await rig({ running: true });
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        await r.bridge.subscribe("marks.folder", "digest", ORIGIN);
        await receive(
            r.bridge,
            Object.keys(r.bridge.state.subs).find((name) => name !== sub.name)!,
            event(),
        );
        assert.equal(Object.keys(r.bridge.state.pending).length, 2);

        // The pulls run; then lodge revokes the client: the consumer goes, and lodge answers 401.
        r.bridge.start();
        await until(() => r.connections.length > 0);
        r.lodge.tokenError = new AuthRequired("lodge refused the events bridge's token", true);
        r.connections.at(-1)!.gone.add(sub.consumer);
        await r.connections.at(-1)!.close();
        await until(() => r.bridge.paused !== undefined && r.bridge.state.paused?.sent === true);

        assert.deepEqual(r.bridge.state.pending, {});
        assert.deepEqual(r.bridge.state.batches, {});

        const notices = r.sessions.sent().filter((each) => each.delivery.key.includes("paused"));

        assert.equal(notices.length, 1);
        assert.match(notices[0]!.delivery.payload, /^Paused: lodge refused/);
        await r.bridge.stop();
    });

    test("a refresh that fails pauses the bridge and posts 1 notice, however often it fails", async () => {
        const r = await rig({ running: true });
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        r.lodge.tokenError = new AuthRequired("lodge refused the refresh: invalid_grant");
        r.bridge.start();
        await until(() => r.bridge.state.paused?.sent === true);
        await r.bridge.pause("lodge refused the refresh again");
        await r.bridge.tick();

        const notices = r.sessions.sent().filter((each) => each.delivery.key.includes("paused"));

        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.delivery.key, "eb-moneo-paused-1");
        assert.notEqual(notices[0]!.target, ORIGIN.source);
        // A refresh that fails is no revoke: the batch stays.
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
        // The owner signs in again: the pause ends.
        r.lodge.tokenError = undefined;
        await r.bridge.resume(ORIGIN);
        assert.equal(r.bridge.paused, undefined);
        await r.bridge.stop();
        assert.equal(r.notices.filter((text) => /paused/.test(text)).length, 1);
    });

    test("a consumer that lodge lost: its events go, and the bridge subscribes again", async () => {
        const r = await rig({ running: true });
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        r.bridge.start();
        await until(() => r.connections.length > 0);
        await until(() => r.connections.at(-1)!.waiting.size > 0);
        r.lodge.subs.delete(sub.name);
        r.connections.at(-1)!.lose(sub.consumer);
        await until(() => r.bridge.state.subs[sub.name]?.consumer !== sub.consumer);

        assert.deepEqual(r.bridge.state.pending, {});
        assert.equal(r.bridge.paused, undefined);
        await r.bridge.stop();
    });

    test("pulled events reach the store and are acked", async () => {
        const r = await rig({ running: true });
        const sub = await subscribe(r);

        r.bridge.start();
        await until(() => r.connections.length > 0 && r.connections.at(-1)!.waiting.size > 0);
        r.connections.at(-1)!.push(sub.consumer, bytes(event()));
        await until(() => r.connections.at(-1)!.acked.length === 1);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
        await r.bridge.stop();
    });

    test("unsubscribe deletes the subscription at lodge and its waiting events", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        assert.equal(await r.bridge.unsubscribe(sub.name), true);
        assert.equal(r.lodge.subs.size, 0);
        assert.deepEqual(r.bridge.state.pending, {});
        assert.deepEqual(r.bridge.state.subs, {});
        assert.equal(await r.bridge.unsubscribe(sub.name), false);
    });
});

describe("events bridge: the standing events session", () => {
    test("it is made once, checked at each delivery, and made again when it is gone", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        assert.equal(r.sessions.started.length, 1);

        const first = r.bridge.state.session!.id;

        for (let n = 0; n < 3; n++) {
            await receive(r.bridge, sub.name, event());
            r.clock.now += BATCH_MS;
            await r.bridge.tick();
        }

        assert.equal(r.sessions.started.length, 1);
        assert.deepEqual(
            r.sessions.sent().map((each) => each.target),
            [first, first, first],
        );

        // Deleted: Pocket's inbox answers 410, and the batch goes to a new session at once.
        r.sessions.folders.delete(first);
        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        const second = r.bridge.state.session!.id;

        assert.notEqual(second, first);
        assert.equal(r.sessions.started.length, 2);
        assert.equal(r.sessions.started[1]!.key, "x.events-bridge.session:moneo:2");
        assert.equal(r.sessions.sent().at(-1)!.target, second);

        // Moved out of the agent's home: no longer the agent's, so a new one before the delivery.
        r.sessions.folders.set(second, "/somewhere/else");
        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.started.length, 3);

        // Archived, or another identity by Team: a new one at the next delivery.
        const third = r.bridge.state.session!.id;

        r.bridge.archived(third, true);
        await until(() => r.bridge.state.session?.gone === true);
        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.started.length, 4);

        const fourth = r.bridge.state.session!.id;

        r.bridge.identity(fourth, "moneo");
        assert.equal(r.bridge.state.session?.gone, undefined);
        r.bridge.identity(fourth, undefined);
        await until(() => r.bridge.state.session?.gone === true);

        // Brian's chat never got a wake.
        assert.equal(
            r.sessions.delivered.some((each) => each.target === ORIGIN.source),
            false,
        );
    });

    test("a restart keeps the session: no second one", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await r.bridge.stop();

        const again = await r.restart();

        await receive(again, sub.name, event());
        r.clock.now += BATCH_MS;
        await again.tick();
        assert.equal(r.sessions.started.length, 1);
        assert.equal(r.sessions.sent().length, 1);
    });
});

/** Wait for a condition of the bridge's own async work (its pulls and timers), by turns of the event loop. */
async function until(check: () => boolean, turns = 200_000): Promise<void> {
    for (let turn = 0; !check(); turn++) {
        if (turn > turns) {
            throw new Error("the condition did not come");
        }

        await new Promise((resolve) => setImmediate(resolve));
    }
}
