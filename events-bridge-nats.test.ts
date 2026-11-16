/**
 * The events bridge's broker transport (`natsTransport` in events-bridge.ts) with the vendored nats.js over a WebSocket:
 * a pull gets the event that JetStream delivers, its ack goes to the event's reply subject, an expired pull is a
 * timeout, and the end of the connection ends a pull that waits.
 *
 * A fake NATS server on 127.0.0.1 answers each pull as JetStream does. It delivers an event to the pull's reply inbox
 * under the event's own subject, not the inbox's (the MSG line names the inbox's subscription only by its sid). A
 * status (404, 408, 409) comes with the inbox as its subject. With `NATS_SERVER` set to a nats-server binary, 1 more
 * test runs the same pull against a real JetStream pull consumer over WebSocket.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { natsTransport, type BrokerConnection } from "./events-bridge.ts";
import { wsconnect } from "./_events-bridge-nats.mjs";

const PREFIX = "_INBOX.chani";
const EVENT_SUBJECT = "marks.bookmark.created";
const EVENT = JSON.stringify({
    specversion: "1.0",
    id: "ev-1",
    type: "org.frostyard.marks.bookmark.created",
    source: "marks",
    subject: "bm-1",
});
const ACK = "$JS.ACK.app_marks.chani-s1.1.5.5.1794858686000000000.0";

/** NATS subject match, with `*` and `>`. */
function matches(pattern: string, subject: string): boolean {
    const p = pattern.split(".");
    const s = subject.split(".");

    for (let i = 0; i < p.length; i++) {
        if (p[i] === ">") {
            return s.length > i;
        }

        if (i >= s.length || (p[i] !== "*" && p[i] !== s[i])) {
            return false;
        }
    }

    return p.length === s.length;
}

/** What the fake server does with 1 pull: deliver the event, answer a status, wait, or end the connection. */
type PullAnswer = "event" | "408" | "hold" | "close";

/** 1 server frame: binary, final, unmasked. */
function frame(data: Buffer): Buffer {
    const length = data.length;
    const head =
        length < 126
            ? Buffer.from([0x82, length])
            : length < 65_536
              ? Buffer.from([0x82, 126, length >> 8, length & 0xff])
              : Buffer.concat([Buffer.from([0x82, 127]), Buffer.alloc(8)]);

    if (length >= 65_536) {
        head.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([head, data]);
}

/** A NATS server over WebSocket, enough for nats.js and JetStream's pull: SUB, UNSUB, PUB, HPUB, PING. */
class FakeNats {
    readonly pulls: string[] = [];
    readonly acks: { subject: string; body: string }[] = [];
    readonly sockets = new Set<Socket>();
    answer: PullAnswer = "event";
    readonly #server = createServer();
    #pullSeen: (() => void)[] = [];

    constructor() {
        this.#server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
            this.#accept(request, socket);
        });
    }

    async listen(): Promise<string> {
        await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));

        return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}/gateway/mcp`;
    }

    /** Resolves at the next pull that the server gets. */
    nextPull(): Promise<void> {
        return new Promise((resolve) => this.#pullSeen.push(resolve));
    }

    dropAll(): void {
        for (const socket of this.sockets) {
            socket.destroy();
        }
    }

    async close(): Promise<void> {
        this.dropAll();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    #accept(request: IncomingMessage, socket: Socket): void {
        const key = request.headers["sec-websocket-key"] ?? "";
        const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");

        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );

        const subs = new Map<string, string>();
        const left = new Map<string, number>();
        const send = (text: string | Buffer) =>
            socket.write(frame(typeof text === "string" ? Buffer.from(text) : text));
        let frames = Buffer.alloc(0);
        let input = Buffer.alloc(0);

        send(
            `INFO ${JSON.stringify({ server_id: "fake", version: "2.10.0", proto: 1, headers: true, max_payload: 1_048_576, auth_required: true })}\r\n`,
        );

        const deliver = (
            subject: string,
            reply: string | undefined,
            head: string,
            body: string,
        ) => {
            for (const [sid, pattern] of subs) {
                if (matches(pattern, reply === undefined ? subject : reply)) {
                    const rest = left.get(sid);

                    if (rest !== undefined) {
                        if (rest <= 1) {
                            subs.delete(sid);
                            left.delete(sid);
                        } else {
                            left.set(sid, rest - 1);
                        }
                    }

                    // The delivery goes to the inbox's subscription (its sid), under `subject`.
                    const replyPart = reply === undefined ? "" : ` ${ACK}`;

                    if (head === "") {
                        send(
                            `MSG ${subject} ${sid}${replyPart} ${String(Buffer.byteLength(body))}\r\n${body}\r\n`,
                        );
                    } else {
                        const total = Buffer.byteLength(head) + Buffer.byteLength(body);

                        send(
                            `HMSG ${subject} ${sid}${replyPart} ${String(Buffer.byteLength(head))} ${String(total)}\r\n${head}${body}\r\n`,
                        );
                    }

                    return;
                }
            }
        };

        const pull = (reply: string) => {
            this.pulls.push(reply);

            for (const seen of this.#pullSeen.splice(0)) {
                seen();
            }

            if (this.answer === "event") {
                // JetStream: the event's own subject, to the inbox's sid, with the ack subject as its reply.
                deliver(EVENT_SUBJECT, reply, "", EVENT);
            } else if (this.answer === "408") {
                deliver(reply, undefined, "NATS/1.0 408 Request Timeout\r\n\r\n", "");
            } else if (this.answer === "close") {
                socket.destroy();
            }
        };

        const command = (line: string, payload: Buffer | undefined) => {
            const [verb, ...args] = line.split(" ");

            switch (verb) {
                case "CONNECT":
                    return;
                case "PING":
                    send("PONG\r\n");

                    return;
                case "SUB":
                    subs.set(args[args.length - 1]!, args[0]!);

                    return;
                case "UNSUB":
                    // `UNSUB <sid> <max>`: the subscription ends after <max> more messages.
                    if (args[1] === undefined) {
                        subs.delete(args[0]!);
                        left.delete(args[0]!);
                    } else {
                        left.set(args[0]!, Number(args[1]));
                    }

                    return;
                case "PUB":

                case "HPUB": {
                    const subject = args[0]!;
                    const reply = (verb === "PUB" ? args.length === 3 : args.length === 4)
                        ? args[1]
                        : undefined;

                    if (subject.startsWith("$JS.API.CONSUMER.MSG.NEXT.") && reply !== undefined) {
                        pull(reply);
                    } else if (subject.startsWith("$JS.ACK.")) {
                        this.acks.push({ subject, body: payload?.toString() ?? "" });
                    }

                    return;
                }

                default:
                    return;
            }
        };

        const parse = () => {
            for (;;) {
                const end = input.indexOf("\r\n");

                if (end < 0) {
                    return;
                }

                const line = input.subarray(0, end).toString();
                const [verb, ...args] = line.split(" ");
                const size =
                    verb === "PUB" || verb === "HPUB" ? Number(args[args.length - 1]) : undefined;

                if (size === undefined) {
                    input = input.subarray(end + 2);
                    command(line, undefined);
                    continue;
                }

                if (input.length < end + 2 + size + 2) {
                    return;
                }

                const payload = input.subarray(end + 2, end + 2 + size);

                input = input.subarray(end + 2 + size + 2);
                command(line, payload);
            }
        };

        socket.on("data", (chunk: Buffer) => {
            frames = Buffer.concat([frames, chunk]);

            for (;;) {
                if (frames.length < 2) {
                    return;
                }

                const opcode = frames[0]! & 0x0f;
                let length = frames[1]! & 0x7f;
                let at = 2;

                if (length === 126) {
                    if (frames.length < 4) {
                        return;
                    }

                    length = frames.readUInt16BE(2);
                    at = 4;
                } else if (length === 127) {
                    if (frames.length < 10) {
                        return;
                    }

                    length = Number(frames.readBigUInt64BE(2));
                    at = 10;
                }

                const masked = (frames[1]! & 0x80) !== 0;
                const mask = masked ? frames.subarray(at, at + 4) : undefined;

                at += masked ? 4 : 0;

                if (frames.length < at + length) {
                    return;
                }

                const data = Buffer.from(frames.subarray(at, at + length));

                frames = frames.subarray(at + length);

                if (mask !== undefined) {
                    for (let i = 0; i < data.length; i++) {
                        data[i]! ^= mask[i % 4]!;
                    }
                }

                if (opcode === 8) {
                    socket.end();

                    return;
                }

                if (opcode === 1 || opcode === 2 || opcode === 0) {
                    input = Buffer.concat([input, data]);
                    parse();
                }
            }
        });
    }
}

describe("events bridge: the broker transport over a WebSocket", () => {
    const server = new FakeNats();
    const opened: BrokerConnection[] = [];
    let gateway = "";

    const connect = async (): Promise<BrokerConnection> => {
        if (gateway === "") {
            gateway = await server.listen();
        }

        const connection = await natsTransport(gateway)({ token: "t", inboxPrefix: PREFIX });

        opened.push(connection);

        return connection;
    };

    after(async () => {
        await Promise.all(opened.map((each) => each.close().catch(() => undefined)));
        await server.close();
    });

    // The pilot of 2026-11-16: lodge delivered the event 17 times, the bridge never saw it nor acked it.
    test("a pull gets the event that JetStream sends under its own subject, and acks it", async () => {
        server.answer = "event";

        const connection = await connect();
        const pulled = await connection.pull("app_marks", "chani-s1", 1_000);

        assert.equal(pulled.kind, "message");
        assert.equal(pulled.kind === "message" && new TextDecoder().decode(pulled.data), EVENT);
        assert.equal(pulled.kind === "message" && pulled.reply, ACK);

        // Each pull has an inbox under the prefix that lodge allows the client.
        assert.ok(server.pulls.at(-1)!.startsWith(`${PREFIX}.`));

        if (pulled.kind === "message") {
            await connection.ack(pulled.reply);
        }

        assert.deepEqual(server.acks.at(-1), { subject: ACK, body: "+ACK" });
    });

    test("2 pulls in a row each get their event", async () => {
        server.answer = "event";

        const connection = await connect();

        for (let i = 0; i < 2; i++) {
            assert.equal((await connection.pull("app_marks", "chani-s1", 1_000)).kind, "message");
        }
    });

    test("an expired pull (408) is a timeout", async () => {
        server.answer = "408";

        const connection = await connect();

        assert.equal((await connection.pull("app_marks", "chani-s1", 1_000)).kind, "timeout");
    });

    test("the end of the connection ends a pull that waits", { timeout: 10_000 }, async () => {
        server.answer = "hold";

        const connection = await connect();
        const seen = server.nextPull();
        // A long wait: only the end of the connection can end this pull within the test's time.
        const pulling = connection.pull("app_marks", "chani-s1", 60_000);

        await seen;
        server.dropAll();

        assert.equal((await pulling).kind, "closed");
        await connection.closed;
    });
});

/** A real nats-server with JetStream and a WebSocket listener, when `NATS_SERVER` names its binary. */
const NATS_SERVER = process.env.NATS_SERVER;

describe("events bridge: the broker transport on a real JetStream", () => {
    test(
        "a pull consumer over WebSocket gives its event to the bridge, and the ack takes it",
        {
            skip: NATS_SERVER === undefined ? "set NATS_SERVER to a nats-server binary" : false,
            timeout: 30_000,
        },
        async () => {
            const dir = mkdtempSync(join(tmpdir(), "events-bridge-nats-"));
            const config = join(dir, "server.conf");

            writeFileSync(
                config,
                `listen: "127.0.0.1:-1"\njetstream { store_dir: "${join(dir, "js")}" }\n` +
                    `websocket { listen: "127.0.0.1:-1", no_tls: true }\n`,
            );

            const server = spawn(NATS_SERVER!, ["-c", config], {
                stdio: ["ignore", "ignore", "pipe"],
            });
            let log = "";
            const port = await new Promise<string>((resolve, reject) => {
                server.stderr.on("data", (chunk: Buffer) => {
                    log += chunk.toString();

                    const found = /websocket clients on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log);

                    if (found !== null && log.includes("Server is ready")) {
                        resolve(found[1]!);
                    }
                });
                server.on("exit", () => reject(new Error(`nats-server ended:\n${log}`)));
            });
            const admin = await wsconnect({ servers: `ws://127.0.0.1:${port}` });
            const connection = await natsTransport(`http://127.0.0.1:${port}/gateway/mcp`)({
                token: "",
                inboxPrefix: PREFIX,
            });

            try {
                const api = async (subject: string, body: unknown) =>
                    JSON.parse(
                        new TextDecoder().decode(
                            (await admin.request(subject, JSON.stringify(body), { timeout: 5_000 }))
                                .data,
                        ),
                    ) as Record<string, unknown>;

                assert.equal(
                    (
                        await api("$JS.API.STREAM.CREATE.app_marks", {
                            name: "app_marks",
                            subjects: ["marks.>"],
                        })
                    ).error,
                    undefined,
                );
                assert.equal(
                    (
                        await api("$JS.API.CONSUMER.CREATE.app_marks.chani-s1", {
                            stream_name: "app_marks",
                            config: {
                                durable_name: "chani-s1",
                                ack_policy: "explicit",
                                deliver_policy: "new",
                                ack_wait: 30_000_000_000,
                            },
                        })
                    ).error,
                    undefined,
                );

                admin.publish(EVENT_SUBJECT, EVENT);
                await admin.flush();

                const pulled = await connection.pull("app_marks", "chani-s1", 2_000);

                assert.equal(pulled.kind, "message");
                assert.equal(
                    pulled.kind === "message" && new TextDecoder().decode(pulled.data),
                    EVENT,
                );

                if (pulled.kind === "message") {
                    await connection.ack(pulled.reply);
                }

                const info = (await api("$JS.API.CONSUMER.INFO.app_marks.chani-s1", {})) as {
                    ack_floor: { stream_seq: number };
                    num_ack_pending: number;
                };

                assert.equal(info.ack_floor.stream_seq, 1);
                assert.equal(info.num_ack_pending, 0);
                assert.equal((await connection.pull("app_marks", "chani-s1", 500)).kind, "timeout");
            } finally {
                await connection.close().catch(() => undefined);
                await admin.close().catch(() => undefined);
                server.kill();
                rmSync(dir, { recursive: true, force: true });
            }
        },
    );
});
