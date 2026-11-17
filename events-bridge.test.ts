/**
 * The events bridge's engine (events-bridge.ts), with a fake lodge, broker, inbox and clock: batches, the wake cap, the
 * digest, the store and its ack order, restarts, revokes, pauses and the standing events session. The tools in Pi
 * Pocket are in events-bridge.pocket.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
    Hider,
    hideTokenFiles,
    pendingAnswer,
    REPEAT_NOTE,
    TAKEN_KEEP,
    gatewayOf,
    type Lodge,
    type LodgeAnswer,
    type LodgeSub,
    nextDigestAt,
    PAYLOAD_BUDGET,
    type Pulled,
    RETRIES,
    RETRY_MS,
    type Sessions,
    type Slot,
    StateFile,
    stopSlot,
    takeSlot,
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
    /** Holds `put` until the test opens it. */
    putGate: Promise<void> | undefined;
    /** The `put` calls that wait on `putGate` now. */
    putting = 0;
    /** An answer to give instead of the real one, when set (after `putGate`). */
    putAnswer: (() => LodgeAnswer<LodgeSub>) | undefined;

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
        this.putting++;

        try {
            await this.putGate;
        } finally {
            this.putting--;
        }

        const answer = this.putAnswer?.();

        if (answer !== undefined) {
            return answer;
        }

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

    /** Holds `list` until the test opens it. */
    listGate: Promise<void> | undefined;
    listing = 0;

    async list(): Promise<LodgeAnswer<LodgeSub[]>> {
        this.listing++;
        await this.listGate;

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
    /** The sessions made, by start key: a start with a key seen before gives that session back, as Pocket does. */
    readonly byKey = new Map<string, number>();
    /** The next answers of `deliver`: an error to throw, or "crash" (it went, then the caller died). */
    readonly script: (Error | "crash")[] = [];
    /** Holds `start` until the test opens it. */
    gate: Promise<void> | undefined;
    #next = 100;

    async deliver(target: number, delivery: InboxDelivery): Promise<{ sent: boolean }> {
        const step = this.script.shift();

        if (step instanceof Error) {
            throw step;
        }

        if (!this.folders.has(target)) {
            throw status(410);
        }

        // Pocket's key counts in 1 session (inbox.ts: submissionByRequest of the target).
        const sent = !this.keys.has(`${String(target)}:${delivery.key}`);

        this.keys.add(`${String(target)}:${delivery.key}`);
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
        await this.gate;

        // Pocket's key counts for a session start: a start with the same key gives the session it made before.
        const known = this.byKey.get(key);

        if (known !== undefined) {
            return known;
        }

        this.started.push({ source, request, key });

        const id = this.#next++;

        this.byKey.set(key, id);
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

    get ended(): boolean {
        return this.#ended;
    }

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

/** The store, with a save that the test can hold open. */
class GatedFile extends StateFile {
    gate: Promise<void> | undefined;
    holding = 0;
    /** Saves that pass the gate before it holds one. */
    pass = 0;

    override async save(state: AgentState): Promise<void> {
        if (this.gate !== undefined) {
            if (this.pass > 0) {
                this.pass--;
            } else {
                const gate = this.gate;

                this.holding++;
                await gate;
            }
        }

        return super.save(state);
    }
}

type Rig = {
    bridge: AgentBridge;
    lodge: FakeLodge;
    sessions: FakeSessions;
    notices: string[];
    file: GatedFile;
    dir: string;
    clock: { now: number };
    connections: FakeConnection[];
    /** Holds the opening of a connection until the test opens it. */
    transportGate: Promise<void> | undefined;
    /** Connections that started to open. */
    opening: number;
    /** A new bridge on the same store, lodge and sessions: a restart. */
    restart: () => Promise<AgentBridge>;
};

const ORIGIN = { by: "brian", source: 7 };

const tokenState = (n: string) =>
    ({
        tokens: { access_token: `lgo_at_${n}`, refresh_token: `lgo_rt_${n}`, token_type: "Bearer" },
        clientInformation: { client_id: "lgc_AAECAwQFBgcICQoLDA0ODw" },
    }) as never;

async function rig(options: { running?: boolean; check?: boolean } = {}): Promise<Rig> {
    const dir = scratch();
    const lodge = new FakeLodge();
    const sessions = new FakeSessions();
    const notices: string[] = [];
    const clock = { now: T0 };
    const file = new GatedFile(dir, "moneo");
    const connections: FakeConnection[] = [];

    const gates: { rig?: Rig } = {};

    const transport: Transport = async () => {
        gates.rig!.opening++;
        await gates.rig!.transportGate;

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

        // The gates of a bridge that starts now: lodge has confirmed the client in this process (a test that needs a
        // bridge with no check yet passes `check: false`).
        if (options.check !== false) {
            await bridge.checkLodge();
        }

        // The check's own tick settles before the test goes on.
        await bridge.tick();

        return bridge;
    };

    const bridge = await make();

    gates.rig = {
        bridge,
        lodge,
        sessions,
        notices,
        file,
        dir,
        clock,
        connections,
        transportGate: undefined,
        opening: 0,
        restart: make,
    };

    return gates.rig;
}

/** The bridge stays idle: subscribe with the pulls stopped. */
async function subscribe(r: Rig, topic = "marks.bookmark", mode: "now" | "digest" = "now") {
    return (await r.bridge.subscribe(topic, mode, ORIGIN)).sub;
}

/**
 * The identity check that a bridge which just restarted needs: its recorded events session takes no wake until this
 * process verified who it is. A restart forgets the check (it is never in the store).
 */
async function verify(bridge: AgentBridge, agent = "moneo"): Promise<void> {
    const check = bridge.identityToCheck();

    assert.notEqual(check, undefined, "the recorded session waits for its identity check");
    await bridge.identity(check!.session, agent, check!.epoch);
    await bridge.tick();
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

    test("the token file is 0600, its tokens are hidden before the write and at load, and it is not the mcp module's oauth.json", async () => {
        const dir = scratch();
        const live = new Set<string>();
        const hider = new Hider((value) => {
            live.add(value);

            return () => live.delete(value);
        });
        const tokens = new TokenFile(dir, "moneo", hider);

        assert.equal(tokens.path, join(dir, "moneo.json"));
        assert.equal(await tokens.signedIn(), false);
        await tokens.save(tokenState("1"));
        assert.deepEqual([...live].sort(), ["lgo_at_1", "lgo_rt_1"]);
        assert.equal(statSync(tokens.path).mode & 0o777, 0o600);
        assert.equal(await tokens.signedIn(), true);
        assert.equal(await tokens.clientId(), "lgc_AAECAwQFBgcICQoLDA0ODw");
        assert.doesNotMatch(tokens.path, /oauth\.json$/);

        // A new load of the module hides them when it reads the file, before any refresh.
        const later = new Set<string>();

        await new TokenFile(
            dir,
            "moneo",
            new Hider((value) => {
                later.add(value);

                return () => later.delete(value);
            }),
        ).load();
        assert.deepEqual([...later].sort(), ["lgo_at_1", "lgo_rt_1"]);
    });

    test("rotated tokens are released: 500 refreshes keep 2 values hidden, and a refused hide writes nothing", async () => {
        const dir = scratch();
        const live = new Set<string>();
        let refuse = false;
        const hider = new Hider((value) => {
            if (refuse) {
                throw new Error("host.hide: 2000 values are hidden already");
            }

            live.add(value);

            return () => live.delete(value);
        });
        const tokens = new TokenFile(dir, "moneo", hider);

        for (let n = 0; n < 500; n++) {
            await tokens.save(tokenState(String(n)));
        }

        assert.deepEqual([...live].sort(), ["lgo_at_499", "lgo_rt_499"]);
        assert.equal(hider.size, 2);

        refuse = true;
        await assert.rejects(tokens.save(tokenState("next")), /2000 values/);
        assert.match(readFileSync(tokens.path, "utf8"), /lgo_at_499/);
        assert.doesNotMatch(readFileSync(tokens.path, "utf8"), /lgo_at_next/);
    });

    test("at load, every token file is hidden before the module counts as loaded; one that cannot be is deleted", async () => {
        const dir = scratch();
        const live = new Set<string>();
        const refused = new Set(["lgo_at_chani"]);
        const hiderFor = () =>
            new Hider((value) => {
                if (refused.has(value)) {
                    throw new Error("host.hide: 2000 values are hidden already");
                }

                live.add(value);

                return () => live.delete(value);
            });
        const quiet = new Hider(() => () => undefined);

        await new TokenFile(dir, "moneo", quiet).save(tokenState("moneo"));
        await new TokenFile(dir, "chani", quiet).save(tokenState("chani"));
        await writePrivate(join(dir, "moneo.events.json"), "{}");

        const notices: string[] = [];

        await hideTokenFiles(
            dir,
            (agent) => new TokenFile(dir, agent, hiderFor()),
            (_level, message) => notices.push(message),
        );

        assert.deepEqual([...live].sort(), ["lgo_at_moneo", "lgo_rt_moneo"]);
        assert.equal(existsSync(join(dir, "moneo.json")), true);
        assert.equal(existsSync(join(dir, "chani.json")), false);
        assert.match(notices.join("\n"), /chani.*deleted: sign it in to lodge again/);
    });

    test("a reload waits until the old bridge has stopped", async () => {
        const slots = new Map<string, Slot>();
        let release: () => void = () => undefined;
        const stopped = new Promise<void>((resolve) => (release = resolve));
        const old = { stop: () => stopped } as unknown as AgentBridge;
        let took = false;

        slots.set("moneo", { bridge: old });
        // The old load's dispose: the stop starts, and its slot stays.
        void stopSlot(slots, "moneo", old);

        const taking = takeSlot(slots, "moneo").then(() => (took = true));

        await until(() => slots.get("moneo")?.stopping !== undefined);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(took, false);
        release();
        await taking;
        assert.equal(slots.has("moneo"), false);
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

        // A restart forgets the session's identity check: it comes before the delivery.
        await verify(again);

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

        await verify(again);

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

        const taken = await r.bridge.takePending(3, "9:call-1");

        // A replay of the same call gets the same events, and takes no more.
        assert.deepEqual(await r.bridge.takePending(3, "9:call-1"), taken);

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

        // Team changed an identity: the session is unchecked until a check says whose it is.
        r.bridge.identityChanged(fourth);

        const check = r.bridge.identityToCheck()!;

        assert.equal(check.session, fourth);
        assert.equal(r.bridge.state.session?.gone, undefined);
        await r.bridge.identity(fourth, undefined, check.epoch);
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

        await verify(again);

        await receive(again, sub.name, event());
        r.clock.now += BATCH_MS;
        await again.tick();
        assert.equal(r.sessions.started.length, 1);
        assert.equal(r.sessions.sent().length, 1);
    });
});

describe("events bridge: the identity of the events session", () => {
    test("Team says the session is another agent: it takes no wake, and the batch goes to a new session", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        // Team changed an identity: the session is unchecked, and it is still in Moneo's home.
        r.bridge.identityChanged(first);

        const check = r.bridge.identityToCheck()!;

        assert.equal(check.session, first);

        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);

        // Now Team's answer: the session's identity is Duncan's, so it is gone, and the batch goes by itself.
        await r.bridge.identity(first, "duncan", check.epoch);
        await until(() => r.bridge.state.session?.gone === true);
        await until(() => r.sessions.sent().length === 1);

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.notEqual(sent[0]!.target, first);
        assert.equal(sent[0]!.target, r.bridge.state.session!.id);
        assert.equal(r.sessions.started.length, 2);
    });

    test("after a restart, a recorded session that no one checked takes no wake: the batch waits for its check", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        await r.bridge.stop();

        const again = await r.restart();

        r.clock.now += BATCH_MS;
        await again.tick();

        // No delivery, and no new session: the batch keeps its state and counts no try.
        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(r.sessions.started.length, 1);
        assert.equal(Object.values(again.state.batches)[0]?.tries, 0);
        assert.equal(Object.values(again.state.batches)[0]?.state, "open");
        assert.equal(Object.keys(again.state.pending).length, 1);

        await verify(again);
        await again.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.target, first);
        assert.equal(r.sessions.started.length, 1);
        assert.deepEqual(again.state.pending, {});
    });

    test("an identity change clears the check: no delivery until a new one, and the old check's answer is ignored", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        r.bridge.identityChanged(first);

        // A check that started before the next change answers for the old epoch: its answer proves nothing now.
        const stale = r.bridge.identityToCheck()!;

        assert.equal(stale.session, first);
        r.bridge.identityChanged(first);
        await r.bridge.identity(stale.session, "moneo", stale.epoch);
        assert.deepEqual(r.bridge.identityToCheck(), {
            session: first,
            epoch: stale.epoch + 1,
        });

        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(Object.values(r.bridge.state.batches)[0]?.tries, 0);

        const fresh = r.bridge.identityToCheck()!;

        await r.bridge.identity(fresh.session, "moneo", fresh.epoch);
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.target, first);
    });

    test("the pause notice waits for an unchecked events session", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await r.bridge.stop();

        const again = await r.restart();

        await again.pause("lodge refused the refresh");
        await again.tick();

        // The notice goes to the events session: an unchecked one holds it.
        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(again.state.paused?.sent, undefined);

        await verify(again);
        await again.tick();

        const notices = r.sessions.sent().filter((each) => each.delivery.key.includes("paused"));

        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.target, first);
        assert.equal(again.state.paused?.sent, true);
    });
});

describe("events bridge: lodge confirms the client before any event goes", () => {
    test("a refused refresh pauses the bridge: the stored batch and digest wait, and events_pending gives none", async () => {
        const r = await rig();
        const nowSub = await subscribe(r, "marks.bookmark", "now");
        const digestSub = await subscribe(r, "marks.folder", "digest");

        await receive(r.bridge, nowSub.name, event());
        await receive(r.bridge, digestSub.name, event());
        await r.bridge.stop();

        const again = await r.restart();

        await verify(again);

        // lodge revokes the client while the bridge is down: only a refused refresh tells it, and that is a pause.
        r.lodge.tokenError = new AuthRequired("lodge refused the refresh");
        assert.equal(await again.checkLodge(), false);
        assert.equal(again.paused, "lodge refused the refresh");
        assert.equal(again.state.paused?.sent, undefined);

        // The batch's time, and then 08:00 the next morning: only the pause notice goes.
        r.clock.now = T0 + BATCH_MS;
        await again.tick();
        r.clock.now = digestTime("2026-11-17");
        await again.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.match(sent[0]!.delivery.key, /-paused-/);
        assert.equal(Object.keys(again.state.pending).length, 2);
        assert.equal(Object.keys(again.state.batches).length, 1);

        // events_pending gives no event, keeps no answer for the call, and takes none.
        const taken = await again.takePending(10, "9:call-held");

        assert.deepEqual(taken.events, []);
        assert.equal(taken.more, 1);
        assert.equal(taken.held, "paused: lodge refused the refresh");
        assert.match(
            pendingAnswer(taken, (line) => line),
            /The events bridge holds your events now \(paused: lodge refused the refresh\): none were given\./,
        );
        assert.equal(again.state.taken?.["9:call-held"], undefined);
        assert.equal(Object.keys(again.state.pending).length, 2);
        await again.stop();
    });

    test("a pause while the bridge runs: batches and the digest wait, and events_pending gives none", async () => {
        const r = await rig();
        const nowSub = await subscribe(r, "marks.bookmark", "now");
        const digestSub = await subscribe(r, "marks.folder", "digest");

        await receive(r.bridge, nowSub.name, event());
        await receive(r.bridge, digestSub.name, event());

        await r.bridge.pause("lodge refused the refresh");

        r.clock.now = digestTime("2026-11-17");
        await r.bridge.tick();

        assert.equal(r.bridge.paused, "lodge refused the refresh");

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.match(sent[0]!.delivery.key, /-paused-/);
        assert.equal(Object.keys(r.bridge.state.pending).length, 2);
        assert.equal(r.bridge.pendingCount(), 1);

        const taken = await r.bridge.takePending(10, "9:call-paused");

        assert.deepEqual(taken.events, []);
        assert.equal(taken.more, 1);
        assert.equal(taken.held, "paused: lodge refused the refresh");
        assert.equal(r.bridge.state.taken?.["9:call-paused"], undefined);
        assert.equal(Object.keys(r.bridge.state.pending).length, 2);
    });

    test("a restarted bridge delivers nothing before lodge has confirmed the client", async () => {
        const r = await rig({ check: false });
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        await r.bridge.stop();

        const again = await r.restart();

        // The session's check is done; lodge's answer is still missing.
        await again.identity(first, "moneo", again.identityToCheck()!.epoch);
        r.clock.now += BATCH_MS;
        await again.tick();

        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(Object.values(again.state.batches)[0]?.tries, 0);
        assert.equal(Object.keys(again.state.pending).length, 1);

        assert.equal(await again.checkLodge(), true);
        await again.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.target, first);
    });

    test("checkLodge subscribes again a subscription that lodge does not list, and its events never go", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());

        // lodge lost the subscription (a failed closed, or a revoke) in a way the bridge has not seen yet.
        r.lodge.subs.delete(sub.name);
        assert.equal(await r.bridge.checkLodge(), true);

        assert.deepEqual(r.bridge.state.pending, {});
        assert.deepEqual(r.bridge.state.batches, {});
        assert.notEqual(r.bridge.state.subs[sub.name]?.consumer, sub.consumer);
        assert.equal(r.lodge.puts, 2);

        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);
    });

    test("events_pending holds the digest while lodge has not confirmed the subscriptions", async () => {
        const r = await rig({ check: false });
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());

        // lodge cannot answer yet: nothing is confirmed, so no event goes, and the answer is kept for no call.
        r.lodge.listAnswer = () => ({ ok: false, status: 503, message: "lodge is busy" });

        const held = await r.bridge.takePending(10, "9:call-unconfirmed");

        assert.deepEqual(held.events, []);
        assert.equal(held.more, 1);
        assert.equal(held.held, "lodge has not confirmed the subscriptions yet");
        assert.equal(r.bridge.state.taken?.["9:call-unconfirmed"], undefined);
        assert.equal(r.bridge.pendingCount(), 1);

        // lodge answers, and confirms the subscription: the event comes.
        r.lodge.listAnswer = () => ({ ok: true, value: [...r.lodge.subs.values()] });
        assert.equal(await r.bridge.checkLodge(), true);

        const taken = await r.bridge.takePending(10, "9:call-confirmed");

        assert.equal(taken.events.length, 1);
        assert.equal(taken.held, undefined);
        assert.equal(r.bridge.pendingCount(), 0);
    });

    test("after a sign-in the bridge delivers only once lodge has confirmed the client again", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        await r.bridge.pause("lodge refused the refresh");
        await r.bridge.resume(ORIGIN);

        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);

        assert.equal(await r.bridge.checkLodge(), true);
        await r.bridge.tick();

        assert.equal(r.sessions.sent().length, 1);
        assert.deepEqual(r.bridge.state.pending, {});
    });

    test("a lodge check that started before a pause and a sign-in confirms nothing: a new check must come", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const again = await r.restart();

        await verify(again);
        await receive(again, sub.name, event());

        // The check waits on lodge's answer; meanwhile the bridge pauses and Brian signs it in again.
        let open: () => void = () => undefined;

        r.lodge.listGate = new Promise((resolve) => (open = resolve));

        const listing = r.lodge.listing;
        const old = again.checkLodge();

        await until(() => r.lodge.listing === listing + 1);
        await again.pause("lodge refused the refresh");
        await again.resume(ORIGIN);
        open();
        r.lodge.listGate = undefined;

        assert.equal(await old, false);
        r.clock.now += BATCH_MS;
        await again.tick();
        assert.equal(r.sessions.delivered.length, 0);

        // A check after the sign-in confirms the client: now the batch goes.
        assert.equal(await again.checkLodge(), true);
        await again.tick();
        assert.equal(r.sessions.sent().length, 1);
    });

    test("a subscription made while the recorded events session waits for its check stands, and its wakes wait", async () => {
        const r = await rig();

        await subscribe(r);

        const first = r.bridge.state.session!.id;
        const again = await r.restart();

        // After the restart, nobody checked the recorded session yet: the subscription still goes through.
        const made = await again.subscribe("marks.folder", "now", ORIGIN);

        assert.equal(made.session, first);
        assert.equal(r.sessions.started.length, 1);
        assert.notEqual(again.identityToCheck(), undefined);
    });
});

describe("events bridge: deliveries keep their events, their key and their session", () => {
    test("a revoke while the events session is made: the batch does not go", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        // The standing session is gone, so the delivery makes a new one, and that start waits.
        r.bridge.archived(r.bridge.state.session!.id, true);
        await until(() => r.bridge.state.session?.gone === true);
        await receive(r.bridge, sub.name, event());

        let open: () => void = () => undefined;

        r.sessions.gate = new Promise((resolve) => (open = resolve));
        r.clock.now += BATCH_MS;

        const ticking = r.bridge.tick();

        await until(
            () =>
                r.bridge.state.batches[`b-${Object.keys(r.bridge.state.pending)[0] ?? ""}`]
                    ?.state === "delivering",
        );
        await r.bridge.revoke("all", "lodge refused the token");
        open();
        await ticking;

        assert.equal(r.sessions.delivered.length, 0);
        assert.deepEqual(r.bridge.state.pending, {});
        assert.deepEqual(r.bridge.state.batches, {});
    });

    test("a message holds only the lines that fit Pocket's 8,000 characters; the rest wait in the digest", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const long = {
            subject: "s".repeat(200),
            selector: `/${"p".repeat(299)}`,
            source: "x".repeat(200),
        };

        for (let n = 0; n < 30; n++) {
            await receive(r.bridge, sub.name, event(long));
        }

        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);

        const lines = sent[0]!.delivery.payload.split("\n").length - 1;

        assert.ok(sent[0]!.delivery.payload.length <= PAYLOAD_BUDGET + 200);
        assert.ok(lines > 0 && lines < 30, String(lines));
        // Each event: delivered in the message, or waiting in the digest.
        assert.equal(r.bridge.pendingCount(), 30 - lines);
    });

    test("an event whose write is under way when a batch starts its delivery is never lost", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = event();
        const late = event();

        await receive(r.bridge, sub.name, first);
        r.clock.now += BATCH_MS;

        // The late event's write is held open; the delivery starts meanwhile, then the write lands.
        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const receiving = receive(r.bridge, sub.name, late);

        await until(() => r.file.holding === 1);

        const ticking = r.bridge.tick();

        await new Promise((resolve) => setImmediate(resolve));
        r.file.gate = undefined;
        land();
        await Promise.all([receiving, ticking]);
        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        const shown = r.sessions
            .sent()
            .map((each) => each.delivery.payload)
            .join("\n");

        for (const each of [first, late]) {
            assert.ok(shown.includes(`id=${each.id}`), each.id);
        }

        assert.deepEqual(r.bridge.state.pending, {});
    });

    test("a digest that went before a crash is not sent again on another day, and keeps its events", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        for (let n = 0; n < 3; n++) {
            await receive(r.bridge, sub.name, event());
        }

        r.sessions.script.push("crash");
        r.clock.now = digestTime("2026-11-17");
        await r.bridge.tick();
        assert.equal(r.sessions.sent().length, 1);
        assert.equal(r.bridge.state.digest.attempt?.inflight, true);

        // events_pending meanwhile takes nothing of the message on its way.
        assert.equal((await r.bridge.takePending(10, "9:call-2")).events.length, 0);
        await receive(r.bridge, sub.name, event());
        await r.bridge.stop();

        // The restart is on the next day: the same message, with its key of the 17th, sends nothing again.
        const again = await r.restart();

        await verify(again);

        r.clock.now = digestTime("2026-11-18");
        await again.tick();
        await again.tick();

        const keys = r.sessions.delivered.map((each) => each.delivery.key);

        assert.deepEqual(keys.slice(0, 2), [
            "eb-moneo-digest-2026-11-17",
            "eb-moneo-digest-2026-11-17",
        ]);
        assert.equal(r.sessions.sent().length, 2);
        assert.equal(r.sessions.sent()[1]!.delivery.key, "eb-moneo-digest-2026-11-18");
        assert.equal(again.pendingCount(), 0);
    });

    test("a try cut off goes again to the same session while it can take wakes; else to a new one, marked repeat=maybe", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        r.sessions.script.push("crash");
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        await r.bridge.stop();
        // The session moves out of the agent's home (another agent's now) before the restart.
        r.sessions.folders.set(first, "/home/agents/duncan");

        const again = await r.restart();

        r.clock.now += RETRY_MS[0];
        await again.tick();

        const targets = r.sessions.delivered.map((each) => each.target);

        // Nothing new goes into the moved session: the events go to a new events session, and say they may repeat.
        assert.equal(targets[0], first);
        assert.equal(targets.length, 2);
        assert.notEqual(targets[1], first);
        assert.match(r.sessions.delivered[1]!.delivery.payload, /repeat=maybe/);
        assert.deepEqual(again.state.pending, {});
    });

    test("a try cut off before it reached Pocket, then its session gone: the events still come, never lost", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;
        const e = event();

        await receive(r.bridge, sub.name, e);
        // An error with no status, before Pocket took the message: the try is marked, nothing went.
        r.sessions.script.push(new Error("the process stopped before the call"));
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(Object.values(r.bridge.state.batches)[0]?.inflight, true);
        await r.bridge.stop();
        r.sessions.folders.delete(first);

        const again = await r.restart();

        r.clock.now += RETRY_MS[0];
        await again.tick();
        await again.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.match(sent[0]!.delivery.payload, new RegExp(`id=${e.id} repeat=maybe`));
        assert.deepEqual(again.state.pending, {});
    });

    test("a try cut off, then a 410 from that same session: the events go to a new session, never counted as sent", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;
        const e = event();

        await receive(r.bridge, sub.name, e);
        r.sessions.script.push(new Error("the process stopped before the call"), status(410));
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        r.clock.now += RETRY_MS[0];
        await r.bridge.tick();
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.notEqual(sent[0]!.target, first);
        assert.match(sent[0]!.delivery.payload, new RegExp(`id=${e.id} repeat=maybe`));
        assert.deepEqual(r.bridge.state.pending, {});
    });

    test("a batch whose tries all end with no answer goes to the digest marked repeat=maybe", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());

        for (let n = 0; n <= RETRIES; n++) {
            r.sessions.script.push("crash");
        }

        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        for (const wait of RETRY_MS) {
            r.clock.now += wait;
            await r.bridge.tick();
        }

        assert.equal(r.sessions.sent().length, 1);
        assert.deepEqual(r.bridge.state.batches, {});
        assert.equal(r.bridge.pendingCount(), 1);
        assert.equal(Object.values(r.bridge.state.pending)[0]?.again, true);

        // events_pending shows the mark and its note, as the inbox message does.
        const answer = pendingAnswer(await r.bridge.takePending(10, "9:call-1"), (line) => line);

        assert.match(answer, /repeat=maybe/);
        assert.ok(answer.includes(REPEAT_NOTE));
    });

    test("a batch that may have woken the agent keeps its wake in the hour, also after a restart", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        // The 1st batch went, but every answer was lost: it ends in the digest, and its wake still counts.
        await receive(r.bridge, sub.name, event());

        for (let n = 0; n <= RETRIES; n++) {
            r.sessions.script.push("crash");
        }

        r.clock.now += BATCH_MS;
        await r.bridge.tick();

        for (const wait of RETRY_MS) {
            r.clock.now += wait;
            await r.bridge.tick();
        }

        for (let wake = 1; wake < WAKES_PER_HOUR; wake++) {
            await receive(r.bridge, sub.name, event());
            r.clock.now += BATCH_MS;
            await r.bridge.tick();
        }

        await r.bridge.stop();

        const again = await r.restart();

        await verify(again);

        await receive(again, sub.name, event());
        r.clock.now += BATCH_MS;
        await again.tick();
        assert.equal(r.sessions.delivered.length - RETRIES, WAKES_PER_HOUR);
        assert.equal(r.sessions.sent().length, WAKES_PER_HOUR);
    });

    test("a try that may have woken a session that moved takes 1 more place in the hour: no 7th wake", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        for (let wake = 1; wake < WAKES_PER_HOUR; wake++) {
            await receive(r.bridge, sub.name, event());
            r.clock.now += BATCH_MS;
            await r.bridge.tick();
        }

        // The 6th wake went, but its answer was lost; then a restart, and the session moved.
        const e = event();

        await receive(r.bridge, sub.name, e);
        r.sessions.script.push("crash");
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        await r.bridge.stop();
        r.sessions.folders.set(first, "/home/agents/duncan");

        const again = await r.restart();

        r.clock.now += RETRY_MS[0];
        await again.tick();
        await again.tick();
        assert.equal(r.sessions.sent().length, WAKES_PER_HOUR);
        assert.ok(r.sessions.sent().every((each) => each.target === first));
        assert.equal(again.state.pending[e.id]?.state, "digest");
        assert.equal(again.state.pending[e.id]?.again, true);
    });

    test("a try that may have gone, then no new session, then a new one: the events say repeat=maybe", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;
        const e = event();

        await receive(r.bridge, sub.name, e);
        r.sessions.script.push("crash");
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        // The session moves out of the agent's home; the next session cannot be made yet.
        r.sessions.folders.set(first, "/home/agents/duncan");

        let open: () => void = () => undefined;

        r.sessions.gate = Promise.reject(new Error("Pocket refused the new session"));
        r.sessions.gate.catch(() => undefined);
        r.clock.now += RETRY_MS[0];
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 1);

        r.sessions.gate = new Promise((resolve) => (open = resolve));
        open();
        r.clock.now += RETRY_MS[1];
        await r.bridge.tick();
        await r.bridge.tick();

        // The refused start left its mark: the start that follows reuses its key, so its session waits for a check.
        await verify(r.bridge);
        await r.bridge.tick();

        const last = r.sessions.sent().at(-1)!;

        assert.notEqual(last.target, first);
        assert.match(last.delivery.payload, new RegExp(`id=${e.id} repeat=maybe`));
    });

    test("a digest that may have gone, then no new session, then a new one: the events say repeat=maybe", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");
        const first = r.bridge.state.session!.id;
        const e = event();

        // The day's digest time is past at T0: the first tick only marks today.
        await r.bridge.tick();
        await receive(r.bridge, sub.name, e);
        r.sessions.script.push("crash");
        r.clock.now = digestTime("2026-11-17");
        await r.bridge.tick();
        assert.equal(r.sessions.delivered.length, 1);
        r.sessions.folders.set(first, "/home/agents/duncan");
        r.sessions.gate = Promise.reject(new Error("Pocket refused the new session"));
        r.sessions.gate.catch(() => undefined);
        r.clock.now += 3_600_000;
        await r.bridge.tick();
        r.sessions.gate = undefined;
        r.clock.now += 3_600_000;
        await r.bridge.tick();
        await r.bridge.tick();

        // The refused start left its mark: the start that follows reuses its key, so its session waits for a check.
        await verify(r.bridge);
        await r.bridge.tick();

        const last = r.sessions.sent().at(-1)!;

        assert.notEqual(last.target, first);
        assert.match(last.delivery.payload, new RegExp(`id=${e.id} repeat=maybe`));
    });

    test("a wake that goes late counts in the hour from when it went", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        // 1 batch reserves at T0+60 s and goes after 2 retries, at T0+60 s+90 s.
        await receive(r.bridge, sub.name, event());
        r.sessions.script.push(status(409), status(409));
        r.clock.now += BATCH_MS;
        await r.bridge.tick();
        r.clock.now += RETRY_MS[0];
        await r.bridge.tick();
        r.clock.now += RETRY_MS[1];
        await r.bridge.tick();

        const went = r.clock.now;

        assert.deepEqual(r.bridge.state.wakes[sub.name], [went]);
    });

    test("an events_pending answer outlives a day and other changes while its call can replay", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());

        const taken = await r.bridge.takePending(10, "9:call-old");

        r.clock.now += 3 * 24 * 3_600_000;
        await receive(r.bridge, sub.name, event());
        assert.deepEqual(await r.bridge.takePending(10, "9:call-old"), taken);
    });

    test("events_pending keeps its newest answers always, and an older one for 8 days: the bound of a replay", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());
        await r.bridge.takePending(10, "9:call-old");

        for (let n = 0; n < TAKEN_KEEP; n++) {
            r.clock.now += 1_000;
            await r.bridge.takePending(10, `9:call-${String(n)}`);
        }

        // 100 newer answers, but within 8 days: the old one stays.
        await receive(r.bridge, sub.name, event());
        assert.ok(r.bridge.state.taken?.["9:call-old"] !== undefined);

        // After 8 days, with 100 newer answers: it goes; the newest 100 stay.
        r.clock.now += 8 * 24 * 3_600_000 + 1;
        await receive(r.bridge, sub.name, event());
        assert.equal(r.bridge.state.taken?.["9:call-old"], undefined);
        assert.equal(Object.keys(r.bridge.state.taken ?? {}).length, TAKEN_KEEP);
    });

    test(
        "a stop while a connection opens closes that connection, and the stop ends",
        { timeout: 10_000 },
        async () => {
            const r = await rig({ running: true });
            const sub = await subscribe(r);
            let opened: () => void = () => undefined;

            r.transportGate = new Promise((resolve) => (opened = resolve));
            r.bridge.start();
            await until(() => r.opening > 0);
            await r.bridge.unsubscribe(sub.name);

            let stopped = false;
            const stopping = r.bridge.stop().then(() => (stopped = true));

            opened();
            await stopping;
            assert.equal(stopped, true);
            assert.equal(r.connections.at(-1)?.ended, true);
        },
    );

    test("a stop waits for a worker that waits on lodge, and that worker writes nothing after it", async () => {
        const r = await rig({ running: true });
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());
        r.bridge.start();
        await until(() => r.connections.length > 0 && r.connections.at(-1)!.waiting.size > 0);

        // The consumer is gone; lodge's answer waits.
        let answer: () => void = () => undefined;

        r.lodge.listGate = new Promise((resolve) => (answer = resolve));
        r.lodge.subs.delete(sub.name);
        r.connections.at(-1)!.lose(sub.consumer);
        await until(() => r.lodge.listing > 0);

        let stopped = false;
        const stopping = r.bridge.stop().then(() => (stopped = true));

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(stopped, false);
        answer();
        await stopping;

        // The worker saw the stop: the store still has the event and the subscription.
        const stored = await r.file.load();

        assert.equal(Object.keys(stored!.pending).length, 1);
        assert.equal(stored!.subs[sub.name]?.consumer, sub.consumer);
        assert.equal(r.lodge.puts, 1);
    });

    test("a batch keeps its place in the hour across a restart: no 7th wake", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        for (let wake = 0; wake < WAKES_PER_HOUR - 1; wake++) {
            await receive(r.bridge, sub.name, event());
            r.clock.now += BATCH_MS;
            await r.bridge.tick();
        }

        // The 6th batch gets 409 twice: it waits for its retry, and holds its place in the hour.
        await receive(r.bridge, sub.name, event());
        r.sessions.script.push(status(409), status(409));
        r.clock.now += BATCH_MS;

        const sixth = r.clock.now;

        await r.bridge.tick();
        // A 7th batch opens; then a restart (Pocket's own count is in memory, and starts empty).
        await receive(r.bridge, sub.name, event());
        r.clock.now = sixth + RETRY_MS[0];
        await r.bridge.tick();
        await r.bridge.stop();

        const again = await r.restart();

        await verify(again);

        // The 7th closes while the 6th still waits: the hour is full.
        r.clock.now = sixth + BATCH_MS;
        await again.tick();
        r.clock.now = sixth + RETRY_MS[0] + RETRY_MS[1];
        await again.tick();
        assert.equal(r.sessions.sent().length, WAKES_PER_HOUR);
        assert.equal(again.pendingCount(), 1);
    });

    test("a pause notice that fails waits longer each time", async () => {
        const r = await rig();

        await subscribe(r);
        await r.bridge.pause("lodge refused the refresh");

        for (let n = 0; n < 4; n++) {
            r.sessions.script.push(status(409));
        }

        const tries = () => r.sessions.delivered.length + (4 - r.sessions.script.length);

        await r.bridge.tick();
        assert.equal(tries(), 1);
        // Due again only after its wait: 30 s, then 60 s.
        await r.bridge.tick();
        assert.equal(tries(), 1);
        r.clock.now += 30_000;
        await r.bridge.tick();
        assert.equal(tries(), 2);
        r.clock.now += 59_000;
        await r.bridge.tick();
        assert.equal(tries(), 2);
        r.clock.now += 1_000;
        await r.bridge.tick();
        assert.equal(tries(), 3);
        assert.equal(r.bridge.state.paused?.tries, 3);
    });
});

describe("events bridge: the gates hold right before a delivery", () => {
    test("a batch whose try's write is still in flight does not go when Team changes the identity", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;

        let land: () => void = () => undefined;

        // The delivery's start writes first; the try's own write is the one this holds.
        r.file.pass = 1;
        r.file.gate = new Promise((resolve) => (land = resolve));

        const ticking = r.bridge.tick();

        await until(() => r.file.holding === 1);

        // The store while that write waits: the batch, and its subscription's wakes.
        const batchBefore = structuredClone(Object.values(r.bridge.state.batches)[0]!);
        const wakesBefore = structuredClone(r.bridge.state.wakes[sub.name]);

        r.bridge.identityChanged(first);
        r.file.gate = undefined;
        land();
        await ticking;

        // No try went: the batch and its wakes are as they were, and nothing was delivered.
        assert.equal(r.sessions.delivered.length, 0);

        const batch = r.bridge.state.batches[batchBefore.id]!;

        assert.deepEqual(batch, batchBefore);
        assert.equal(batch.tries, 0);
        assert.equal(batch.target, undefined);
        assert.deepEqual(r.bridge.state.wakes[sub.name], wakesBefore);

        // A check: the batch goes once, to the verified session.
        await verify(r.bridge);
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.target, first);
        assert.equal(sent[0]!.delivery.key, `eb-moneo-b-${batchBefore.events[0]!}`);
        assert.deepEqual(r.bridge.state.batches, {});
    });

    test("a digest whose try's write is still in flight does not go when Team changes the identity", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");
        const first = r.bridge.state.session!.id;

        await receive(r.bridge, sub.name, event());
        r.clock.now = digestTime("2026-11-17");

        let land: () => void = () => undefined;

        // The message's own write passes; the try's write is the one this holds.
        r.file.pass = 1;
        r.file.gate = new Promise((resolve) => (land = resolve));

        const ticking = r.bridge.tick();

        await until(() => r.file.holding === 1);

        const attemptBefore = structuredClone(r.bridge.state.digest.attempt!);

        assert.equal(attemptBefore.inflight, undefined);

        r.bridge.identityChanged(first);
        r.file.gate = undefined;
        land();
        await ticking;

        assert.equal(r.sessions.delivered.length, 0);
        assert.deepEqual(r.bridge.state.digest.attempt, attemptBefore);
        assert.equal(r.bridge.state.digest.tries, 0);

        await verify(r.bridge);
        await r.bridge.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.target, first);
        assert.equal(r.bridge.state.digest.attempt, undefined);
    });

    test("a pause during a new session's start: the batch does not go", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        // The standing session is gone: the delivery makes a new one, and that start waits.
        r.bridge.archived(r.bridge.state.session!.id, true);
        await until(() => r.bridge.state.session?.gone === true);

        const e = event();

        await receive(r.bridge, sub.name, e);

        let open: () => void = () => undefined;

        r.sessions.gate = new Promise((resolve) => (open = resolve));
        r.clock.now += BATCH_MS;

        const ticking = r.bridge.tick();

        await until(() => Object.values(r.bridge.state.batches)[0]?.state === "delivering");
        await r.bridge.pause("lodge refused the refresh");
        r.sessions.gate = undefined;
        open();
        await ticking;

        // Only the pause notice may go: no event does, and no try counts.
        assert.deepEqual(
            r.sessions
                .sent()
                .map((each) => each.delivery.payload)
                .filter((each) => each.includes(`id=${e.id}`)),
            [],
        );
        assert.equal(Object.values(r.bridge.state.batches)[0]?.tries, 0);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
    });

    test("a start cut off before its session write: the same key gives that session back, which waits for a check", async () => {
        const r = await rig();
        const sub = await subscribe(r);
        const first = r.bridge.state.session!.id;

        // The session goes: the next delivery starts generation 2.
        r.bridge.archived(first, true);
        await until(() => r.bridge.state.session?.gone === true);

        await receive(r.bridge, sub.name, event());
        r.clock.now += BATCH_MS;

        let kill: (error: Error) => void = () => undefined;

        // The delivery's start and the start's mark are written; then the process stops on the session's write.
        r.file.pass = 2;
        r.file.gate = new Promise<void>((_resolve, reject) => (kill = reject));

        const ticking = r.bridge.tick();

        await until(() => r.file.holding === 1);
        r.file.gate = undefined;
        kill(new Error("the process stopped before the session write"));
        await ticking;

        // The store has the mark of the cut-off start, and no session for it.
        const stored = await r.file.load();

        assert.equal(stored?.starting, 2);
        assert.equal(stored?.generation, 1);
        await r.bridge.stop();

        const made = r.sessions.started.length;
        const again = await r.restart();

        r.clock.now += RETRY_MS[0];
        await again.tick();

        // The start of generation 2 began before this process: its session may be older, so no wake goes yet.
        const replay = again.state.session!.id;

        assert.equal(replay, r.sessions.byKey.get("x.events-bridge.session:moneo:2"));
        assert.equal(r.sessions.started.length, made);
        assert.equal(r.sessions.delivered.length, 0);
        assert.equal(again.state.starting, undefined);
        assert.equal(Object.values(again.state.batches)[0]?.tries, 1);

        // Team says that session is another agent's: the events go to a new session, never to it.
        await verify(again, "duncan");
        await again.tick();

        const sent = r.sessions.sent();

        assert.equal(sent.length, 1);
        assert.notEqual(sent[0]!.target, replay);
        assert.equal(sent[0]!.target, again.state.session!.id);
        assert.equal(r.sessions.started.length, made + 1);
    });
});

describe("events bridge: lodges answers that a pause or a sign-in overtook", () => {
    test("a lodge check that a sign-in overtook changes nothing", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());

        // A check whose list waits.
        let answer: () => void = () => undefined;

        r.lodge.listGate = new Promise((resolve) => (answer = resolve));

        const checking = r.bridge.checkLodge();

        await until(() => r.lodge.listing > 0);

        await r.bridge.pause("lodge refused the refresh");
        await r.bridge.resume(ORIGIN);

        // The old list answers now, with a 401: it is no revoke of the client this bridge has now.
        r.lodge.tokenError = new AuthRequired("lodge refused the token", true);
        answer();

        assert.equal(await checking, false);
        assert.equal(r.bridge.paused, undefined);
        assert.equal(r.bridge.state.paused, undefined);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
        assert.equal(Object.keys(r.bridge.state.subs).length, 1);
    });

    test("events_pending holds the digest while the events session waits for Team's check", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());
        await r.bridge.stop();

        // lodge is confirmed in this process; the recorded session is not checked yet.
        const again = await r.restart();
        const held = await again.takePending(10, "9:call-session-wait");

        assert.deepEqual(held.events, []);
        assert.equal(held.more, 1);
        assert.equal(held.held, "your events session waits for Team's identity check");
        assert.equal(again.state.taken?.["9:call-session-wait"], undefined);
        assert.equal(Object.keys(again.state.pending).length, 1);
    });

    test("a sign-in while an events_pending change waits: a held answer, and nothing stored", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        // The event's write holds the queue: the events_pending change waits behind it.
        const receiving = receive(r.bridge, sub.name, event());

        await until(() => r.file.holding === 1);

        const taking = r.bridge.takePending(10, "9:call-resumed");
        const resuming = r.bridge.resume(ORIGIN);

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await receiving;
        await resuming;

        assert.deepEqual(taken.events, []);
        assert.equal(taken.more, 1);
        assert.equal(taken.held, "lodge has not confirmed the subscriptions yet");
        assert.equal(r.bridge.state.taken?.["9:call-resumed"], undefined);
        assert.equal(Object.keys(r.bridge.state.pending).length, 1);
    });
});

describe("events bridge: a lodge answer that arrives after its check", () => {
    test("an obsolete put that fails to sign in pauses nothing and deletes no other subscription's events", async () => {
        const r = await rig();
        const a = await subscribe(r, "marks.bookmark", "now");
        const b = await subscribe(r, "marks.folder", "now");

        const kept = event();

        await receive(r.bridge, b.name, kept);

        // lodge lost A's consumer: the check must subscribe it again, and that put waits.
        r.lodge.subs.delete(a.name);

        let refuse: (error: Error) => void = () => undefined;

        r.lodge.putGate = new Promise<void>((_resolve, reject) => (refuse = reject));

        const checking = r.bridge.checkLodge();

        await until(() => r.lodge.putting > 0);

        // A pause and a sign-in while that put waits: its answer is old.
        await r.bridge.pause("lodge refused the refresh");
        await r.bridge.resume(ORIGIN);

        r.lodge.putGate = undefined;
        refuse(new AuthRequired("lodge refused the token", true));

        assert.equal(await checking, false);
        assert.equal(r.bridge.paused, undefined);
        // B's event never went, and the old 401 is no revoke of the client this bridge has now.
        assert.notEqual(r.bridge.state.pending[kept.id], undefined);
    });

    test("an obsolete put that lodge refuses ends no subscription", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        r.lodge.subs.delete(sub.name);

        let open: () => void = () => undefined;

        r.lodge.putGate = new Promise((resolve) => (open = resolve));
        r.lodge.putAnswer = () => ({ ok: false, status: 403, message: "the grant gives nothing" });

        const checking = r.bridge.checkLodge();

        await until(() => r.lodge.putting > 0);

        await r.bridge.pause("lodge refused the refresh");
        await r.bridge.resume(ORIGIN);

        r.lodge.putGate = undefined;
        open();

        assert.equal(await checking, false);
        // An answer of the old client ends nothing.
        assert.notEqual(r.bridge.state.subs[sub.name], undefined);
        assert.deepEqual(r.bridge.state.ended, []);
    });
});

describe("events bridge: a hold during the events_pending write", () => {
    test("an identity change during the answer's write takes the events back", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-take");

        await until(() => r.file.holding === 1);

        r.bridge.identityChanged(r.bridge.state.session!.id);
        r.file.gate = undefined;
        land();

        const taken = await taking;

        assert.deepEqual(taken.events, []);
        assert.equal(taken.held, "your events session waits for Team's identity check");
        assert.equal(taken.more, 1);
        assert.equal(r.bridge.state.taken?.["9:call-take"], undefined);
        assert.equal(r.bridge.pendingCount(), 1);

        // A check: the event comes once.
        await verify(r.bridge);

        const after = await r.bridge.takePending(10, "9:call-after");

        assert.equal(after.events.length, 1);
        assert.equal(after.held, undefined);
        assert.equal(r.bridge.pendingCount(), 0);
    });

    test("a pause during the answer's write takes the events back", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");

        await receive(r.bridge, sub.name, event());

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-pause");

        await until(() => r.file.holding === 1);

        const pausing = r.bridge.pause("lodge refused the refresh");

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await pausing;

        assert.deepEqual(taken.events, []);
        assert.equal(taken.held, "paused: lodge refused the refresh");
        assert.equal(r.bridge.state.taken?.["9:call-pause"], undefined);
        assert.equal(r.bridge.pendingCount(), 1);
    });

    test("a revoke during the answer's write keeps the events deleted", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");
        const e = event();

        await receive(r.bridge, sub.name, e);

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-revoked");

        await until(() => r.file.holding === 1);

        r.bridge.identityChanged(r.bridge.state.session!.id);
        const revoking = r.bridge.revoke("all", "lodge refused the token");

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await revoking;

        assert.deepEqual(taken.events, []);
        assert.notEqual(taken.held, undefined);
        assert.equal(r.bridge.state.taken?.["9:call-revoked"], undefined);
        // A revoke's deletion holds: the answer puts nothing back.
        assert.equal(r.bridge.state.pending[e.id], undefined);
        assert.equal(r.bridge.pendingCount(), 0);
    });

    test("a revoke of another subscription during the answer's write loses none of this one's events", async () => {
        const r = await rig();
        const kept = await subscribe(r, "marks", "digest");
        const other = await subscribe(r, "notes", "digest");
        const mine = event();

        await receive(r.bridge, kept.name, mine);

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-other");

        await until(() => r.file.holding === 1);

        r.bridge.identityChanged(r.bridge.state.session!.id);
        const revoking = r.bridge.revoke([other.name], "the consumer is gone");

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await revoking;

        assert.deepEqual(taken.events, []);
        assert.notEqual(taken.held, undefined);
        // Only the other subscription was revoked: this event comes back, and waits for the next answer.
        assert.equal(r.bridge.state.pending[mine.id]?.sub, kept.name);
        assert.equal(r.bridge.pendingCount(), 1);
    });

    test("a revoke alone during the answer's write: the answer gives none of the revoked events", async () => {
        const r = await rig();
        const sub = await subscribe(r, "marks", "digest");
        const e = event();

        await receive(r.bridge, sub.name, e);

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-revoke-alone");

        await until(() => r.file.holding === 1);

        // No other hold: only the revoke.
        const revoking = r.bridge.revoke("all", "lodge refused the token");

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await revoking;

        assert.deepEqual(taken.events, []);
        assert.deepEqual(r.bridge.state.taken?.["9:call-revoke-alone"]?.events ?? [], []);
        assert.equal(r.bridge.state.pending[e.id], undefined);
    });

    test("an unsubscribe during a held answer's write: none of its events come back", async () => {
        const r = await rig();
        const kept = await subscribe(r, "marks", "digest");
        const other = await subscribe(r, "notes", "digest");
        const mine = event();
        const theirs = event();

        await receive(r.bridge, kept.name, mine);
        await receive(r.bridge, other.name, theirs);

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const taking = r.bridge.takePending(10, "9:call-unsubscribed");

        await until(() => r.file.holding === 1);

        r.bridge.identityChanged(r.bridge.state.session!.id);

        const unsubscribing = r.bridge.unsubscribe(other.name);

        await until(() => !r.lodge.subs.has(other.name));
        // 1 turn of the event loop: the unsubscribe goes on after lodge's answer, before the write lands.
        await new Promise((resolve) => setImmediate(resolve));

        r.file.gate = undefined;
        land();

        const taken = await taking;

        await unsubscribing;

        assert.deepEqual(taken.events, []);
        assert.notEqual(taken.held, undefined);
        assert.equal(r.bridge.state.pending[mine.id]?.sub, kept.name);
        assert.equal(r.bridge.state.pending[theirs.id], undefined);
    });

    test("a sign-in during the revoke of a refused check: the check pauses nothing", async () => {
        const r = await rig();
        const sub = await subscribe(r);

        await receive(r.bridge, sub.name, event());

        // The check's list finds a refused token (a 401): its revoke's write waits.
        r.lodge.tokenError = new AuthRequired("lodge refused the token", true);

        let land: () => void = () => undefined;

        r.file.gate = new Promise((resolve) => (land = resolve));

        const checking = r.bridge.checkLodge();

        await until(() => r.file.holding === 1);

        // Brian signs the bridge in again while that write waits.
        r.lodge.tokenError = undefined;

        const resuming = r.bridge.resume(ORIGIN);

        r.file.gate = undefined;
        land();

        assert.equal(await checking, false);
        await resuming;
        assert.equal(r.bridge.paused, undefined);
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
