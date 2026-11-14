// The github-hooks drop-in in Pi Pocket's test harness, with team.ts and the desk: the start command, a delivery end to
// end to the desk's `nudge`, 2 copies at once, hostile text in every document, 20 reloads, the module turned off and
// on, pending markers after a restart and after a desk reload, and the receiver missing. A fake `gh` answers every
// GitHub read of the desk; the listener is on a free loopback port; the secret is a test secret in a temporary folder.
//
// The plan's Test plan items here (the rest are in github-hooks.test.ts):
// - Life cycle: 20 reloads in a row leave exactly 1 listener and 1 receiver, and the port answers: "20 reloads".
// - Dedupe: 2 copies at the same time (1 passes), the set survives a reload and a restart: "2 copies at once",
//   "20 reloads", "a crash between the commit and nudge".
// - Pending markers: a crash between the commit and `nudge` is recovered at the next load; the desk API reappearing
//   hands them over; a second `nudge` of the same delivery does nothing: the "pending markers" tests.
// - Facts: hostile text leaves no trace in any `x.github-hooks.*` document: "hostile text".
// - Live deliveries (task t4): each file in test/fixtures/github-hooks/live/, with its headers and a test signature,
//   gets the status, outcome and fact the live module recorded; a redelivery (same id, same body) is a duplicate with
//   1 fact entry and 1 desk nudge; no free text of any payload is in any `x.github-hooks.*` document: "live
//   deliveries replay".
// - Nudge, the desk absent is no error: "the desk off".
// - The turn-off rule: the receiver waits in memory with no commit, and runs the new code when the module is on again.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DeskNudges } from "./desk.ts";
import {
    type DeliveryJob,
    type HookFact,
    type HooksProbe,
    AlarmsDoc,
    CoverageDoc,
    DeliveriesDoc,
    PendingDoc,
    ReceiverDoc,
    SeenDoc,
    liveListeners,
    receiverHandle,
    toNudgeFact,
} from "./github-hooks.ts";
import {
    type LiveDelivery,
    HOSTILE,
    LIVE_DIR,
    fixture,
    freeText,
    liveDeliveries,
    withHostileText,
} from "./github-hooks-fixture.ts";

const SECRET = "c".repeat(16) + "0123456789abcdef0123456789abcdef";
const dataDir = join(root, "data");
const definitions = join(root, "agents");
const secretDir = join(root, "hooks-secret");
const fakeGh = join(root, "fake-gh.sh");
const ghAnswer = join(root, "github.json");
const model = scriptedModel();
const shared = globalThis as unknown as Record<symbol, unknown>;
const TEST_FAIL = Symbol.for("pi-pocket-team.github-hooks.test-fail");
/** The module's test probe: receiver ticks, receiver commits, and phases parked in the turn-off wait. */
const probe: HooksProbe = { ticks: 0, commits: 0, parked: 0, parks: 0 };

shared[Symbol.for("pi-pocket-team.github-hooks.test")] = probe;

let app: App;
let port = 0;
let sessionId: ConversationId;

async function freePort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const found = (server.address() as { port: number }).port;

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return found;
}

type Answer = { status?: number; text: string };

/** 1 signed delivery over loopback; the status, or none when the socket closed with no answer. */
function post(event: string, payload: unknown, id = randomUUID()): Promise<Answer> {
    return send(
        { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": id },
        Buffer.from(JSON.stringify(payload)),
    );
}

/**
 * 1 live-delivery fixture over loopback, with its headers (not its length, host or connection) and a signature
 * made here with the test secret over the exact body bytes (`JSON.stringify(payload)`).
 */
function postLive(delivery: LiveDelivery): Promise<Answer> {
    const own = new Set(["host", "connection", "content-length", "transfer-encoding"]);

    return send(
        Object.fromEntries(
            Object.entries(delivery.headers).filter(([name]) => !own.has(name.toLowerCase())),
        ),
        Buffer.from(JSON.stringify(delivery.payload)),
    );
}

/** Send `body` with `headers`, its length and its signature with the test secret, on 1 connection. */
function send(headers: Record<string, string>, body: Buffer): Promise<Answer> {
    const head =
        "POST /github HTTP/1.1\r\nHost: hooks.test\r\nConnection: close\r\n" +
        Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("") +
        `Content-Length: ${String(body.length)}\r\n` +
        `X-Hub-Signature-256: sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}\r\n\r\n`;

    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];

        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", () => {});
        socket.on("close", () => {
            const text = Buffer.concat(chunks).toString("latin1");
            const match = /^HTTP\/1\.1 (\d{3})/.exec(text);

            resolve({ ...(match === null ? {} : { status: Number(match[1]) }), text });
        });
        socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    });
}

/** A labeled PR delivery: each with its own body (a replay test sends 1 body twice on purpose). */
const pr = () => ({ ...fixture("pull_request.labeled"), test_body: randomUUID() });

const snap = async <T>(token: unknown): Promise<T | undefined> =>
    (await app.harness.snapshot(token as typeof SeenDoc, context)) as T | undefined;

async function receivers() {
    return (await app.harness.inspect(context)).tasks.filter(
        (task) => task.record.kind === "x.github-hooks.receiver",
    );
}

async function command(args: string) {
    const commandId = app.webs.commands().find((each) => each.name === "github-hooks")?.id;

    return (await app.extensionCommands.run(sessionId, owner(app), {
        commandId,
        args,
        requestId: randomUUID(),
    })) as { type: string; message?: string; output?: string; level?: string };
}

/** The listener answers: a bound server in the live set, and a request gets a status. */
async function listening(): Promise<void> {
    await until(
        () =>
            liveListeners().size === 1 && [...liveListeners()].every((server) => server.listening),
        "1 live listener",
        15_000,
    );
}

/** Let many turns of the event loop pass: a condition on turns, not a time. */
async function turns(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/**
 * The module is off: wait until the receiver phase is parked in its turn-off wait, let many event-loop turns pass, and
 * check that the receiver made no commit and its checkpoint did not change.
 */
async function assertParkedWithNoCommit(): Promise<string> {
    await until(() => probe.parked === 1, "the phase is parked in its turn-off wait");

    const commits = probe.commits;
    const state = JSON.stringify((await receivers())[0]?.record.state);

    await turns(500);
    assert.equal(probe.commits, commits, "no commit while parked");
    assert.equal(JSON.stringify((await receivers())[0]?.record.state), state);
    assert.equal(probe.parked, 1, "still parked");

    return state;
}

async function writeMarker(delivery: string): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(PendingDoc)).markers[delivery] = {
            fact: {
                delivery,
                at: Date.now(),
                event: "pull_request",
                action: "closed",
                repo: "frostyard/test",
                number: 7,
            },
            at: Date.now(),
        };
    }, context);
}

const markers = async () =>
    Object.keys((await snap<{ markers: Record<string, unknown> }>(PendingDoc))?.markers ?? {});
const deskSeen = async () =>
    (await app.harness.snapshot(DeskNudges, context))?.seen ?? ({} as Record<string, number>);

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;
    mkdirSync(definitions, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade.",
    );
    writeFileSync(ghAnswer, JSON.stringify({ data: { viewer: { login: "github-viewer" } } }));
    writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(ghAnswer)}\n`, { mode: 0o755 });
    process.env.PI_POCKET_DESK_GH = fakeGh;
    process.env.PI_POCKET_DESK_CONFIG = join(root, "desk.json");
    writeFileSync(join(root, "desk.json"), JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));

    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "github-webhook.secret"), `${SECRET}\n`, { mode: 0o600 });
    port = await freePort();
    process.env.PI_POCKET_GITHUB_HOOKS_PORT = String(port);
    process.env.PI_POCKET_GITHUB_HOOKS_HOST = "127.0.0.1";
    process.env.PI_POCKET_GITHUB_HOOKS_ALLOW_FROM = "127.0.0.1";
    process.env.PI_POCKET_GITHUB_HOOKS_SECRET_DIR = secretDir;
    process.env.PI_POCKET_GITHUB_HOOKS_TICK_MS = "50";
    process.env.PI_POCKET_GITHUB_HOOKS_BIND_RETRY_MS = "20";

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });

    for (const each of [
        "team.ts",
        "desk.ts",
        "_desk-usage.ts",
        "_desk-dashboard.ts",
        "_desk-metrics.ts",
        "_desk-board.ts",
        "_desk-meter.ts",
        "github-hooks.ts",
    ]) {
        cpSync(join(import.meta.dirname, each), join(dropIns, each));
    }

    for (const each of ["team-web", "desk-web"]) {
        cpSync(join(import.meta.dirname, each), join(dropIns, each), { recursive: true });
    }

    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);
    await app.setExtensionEnabled(owner(app), "github-hooks.ts", true);
    sessionId = await newSession(app);
    await listening();
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("no receiver: a delivery gets 503 and raises receiver-missing", async () => {
    assert.equal(receiverHandle(), undefined);
    assert.equal((await post("pull_request", pr())).status, 503);
});

test("start: the owner starts 1 receiver; a second start is refused and names it", async () => {
    const first = await command("start");

    assert.equal(first.type, "toast");
    assert.equal(first.level, "info");
    await until(() => receiverHandle() !== undefined, "the receiver registers");

    const second = await command("start");

    assert.equal(second.level, "error");
    assert.match(second.message ?? "", /runs already: task \d+ in session/);
    assert.equal((await receivers()).length, 1);

    const record = await snap<{ task?: string; conversation?: string }>(ReceiverDoc);

    assert.equal(record?.task, receiverHandle()!.taskId);
    assert.equal(record?.conversation, String(sessionId));

    // The alarm the delivery before raised is written, and cleared now that a receiver runs.
    await until(async () => {
        const alarm = (await snap<{ system: Record<string, { cleared?: number }> }>(AlarmsDoc))
            ?.system["receiver-missing"];

        return alarm?.cleared !== undefined;
    }, "receiver-missing is recorded and cleared");
});

test("end to end: a signed delivery is accepted, the desk takes it by nudge, and the marker is cleared", async () => {
    const id = randomUUID();

    assert.equal((await post("pull_request", pr(), id)).status, 202);
    await until(async () => (await deskSeen())[id] !== undefined, "the desk took the delivery");
    assert.deepEqual(await markers(), []);

    const deliveries = await snap<{ log: { delivery?: string; outcome: string }[]; last?: number }>(
        DeliveriesDoc,
    );

    assert.ok(
        deliveries?.log.some((entry) => entry.delivery === id && entry.outcome === "accepted"),
    );
    assert.equal(typeof deliveries?.last, "number");
    assert.equal(
        (await snap<{ ids: Record<string, number> }>(SeenDoc))?.ids[id] !== undefined,
        true,
    );
});

test("live deliveries replay: the recorded status, outcome and fact; a redelivery is a duplicate; no free text kept", async () => {
    const live = liveDeliveries();

    assert.ok(
        live.length > 0,
        `no live delivery in ${LIVE_DIR}: add the files (test/fixtures/github-hooks/README.md, "Live deliveries")`,
    );

    type Entry = { delivery?: string; outcome: string; fact?: HookFact };

    const ofId = async (id: string) =>
        ((await snap<{ log: Entry[] }>(DeliveriesDoc))?.log ?? []).filter(
            (entry) => entry.delivery === id,
        );

    for (const delivery of live) {
        const { name, delivery: id, expect } = delivery;

        assert.equal((await postLive(delivery)).status, expect.status, name);

        if (expect.outcome === "ping") {
            assert.deepEqual(await ofId(id), [], `${name}: ping records only its log line`);
            assert.equal((await postLive(delivery)).status, 200, `${name}: a ping again`);
            continue;
        }

        // A refusal (422) reaches the log at the receiver's next refusal write: wait for it.
        await until(
            async () => (await ofId(id)).some((entry) => entry.outcome === expect.outcome),
            `${name}: the ${expect.outcome} entry`,
            15_000,
        );

        if (expect.outcome === "unprocessable") {
            assert.equal((await postLive(delivery)).status, 422, `${name}: refused again`);
            continue;
        }

        const entry = (await ofId(id)).find((each) => each.outcome === expect.outcome)!;

        if (expect.fact === undefined) {
            assert.equal(entry.fact, undefined, `${name}: no fact`);
        } else {
            const { at: _at, ...fact } = entry.fact!;

            assert.deepEqual(fact, expect.fact, `${name}: the fact`);
        }

        // Where the fact goes to the desk, the desk's nudge takes it.
        const toDesk = entry.fact !== undefined && toNudgeFact(entry.fact) !== undefined;

        if (toDesk) {
            await until(
                async () => (await deskSeen())[id] !== undefined,
                `${name}: the desk took it`,
            );
        }

        const took = (await deskSeen())[id];

        // GitHub's "Redeliver": the same id and the same body.
        assert.equal((await postLive(delivery)).status, 200, `${name}: redelivered`);

        const entries = await ofId(id);

        assert.equal(entries.filter((each) => each.outcome === "duplicate").length, 1, name);
        assert.equal(entries.filter((each) => each.outcome === expect.outcome).length, 1, name);
        assert.equal(
            entries.filter((each) => each.fact !== undefined).length,
            expect.fact === undefined ? 0 : 1,
            `${name}: 1 entry with a fact`,
        );
        assert.equal((await deskSeen())[id], took, `${name}: the desk took it once`);
    }

    await until(async () => (await markers()).length === 0, "the desk took every fact");

    const free = live.flatMap((delivery) => freeText(delivery.payload));

    for (const token of [SeenDoc, DeliveriesDoc, PendingDoc, AlarmsDoc, CoverageDoc, ReceiverDoc]) {
        const text = JSON.stringify(await snap(token));

        for (const each of free) {
            assert.ok(!text.includes(each), `${token.kind}: ${JSON.stringify(each)}`);
        }
    }
});

test("a real failed commit: 500, and no seen entry, accepted entry or marker persists; the same delivery then gets 202", async () => {
    const id = randomUUID();
    const payload = pr();
    const seenBefore = await snap<{ ids: Record<string, number>; digests: Record<string, number> }>(
        SeenDoc,
    );
    let thrown = 0;

    // The module's test hook: it runs inside the delivery commit, after the changes; a throw rolls them back.
    shared[TEST_FAIL] = (job: DeliveryJob) => {
        if (job.delivery === id && thrown === 0) {
            thrown += 1;

            throw new Error("test: the delivery commit fails");
        }
    };

    try {
        const failed = await post("pull_request", payload, id);

        assert.equal(failed.status, 500);
        assert.equal(thrown, 1);
        assert.match(failed.text, /\r\n\r\n7\r\nfailed\n\r\n0\r\n\r\n$/, "no detail");

        const seen = await snap<{ ids: Record<string, number>; digests: Record<string, number> }>(
            SeenDoc,
        );

        assert.equal(seen?.ids[id], undefined, "no seen id");
        assert.equal(
            Object.keys(seen?.digests ?? {}).length,
            Object.keys(seenBefore?.digests ?? {}).length,
            "no seen digest",
        );
        assert.ok(!(await markers()).includes(id), "no marker");

        const log =
            (await snap<{ log: { delivery?: string; outcome: string }[] }>(DeliveriesDoc))?.log ??
            [];

        assert.ok(!log.some((entry) => entry.delivery === id && entry.outcome === "accepted"));

        // The same delivery (id and body) goes through now.
        assert.equal((await post("pull_request", payload, id)).status, 202);
        await until(async () => (await deskSeen())[id] !== undefined, "the desk took it");
    } finally {
        delete shared[TEST_FAIL];
    }
});

test("the status card: the listener, the receiver, the secret state (never its value), counts and alarms", async () => {
    const card = await command("");

    assert.equal(card.type, "card");
    assert.match(card.output ?? "", new RegExp(`Listener: bound on port ${String(port)}`));
    assert.match(card.output ?? "", /Receiver: task \d+ in session \d+, running/);
    assert.match(card.output ?? "", /Secret: ok \(next: none\)/);
    assert.match(card.output ?? "", /Deliveries: accepted \d+/);
    assert.match(card.output ?? "", /Pending markers: 0/);
    assert.ok(!(card.output ?? "").includes(SECRET));
});

test("2 copies at once: 1 is accepted, the other is a duplicate", async () => {
    const id = randomUUID();
    const payload = pr();
    const answers = await Promise.all([
        post("pull_request", payload, id),
        post("pull_request", payload, id),
    ]);

    assert.deepEqual(answers.map((each) => each.status).sort(), [200, 202]);

    // The same body under a new id: a duplicate too.
    assert.equal((await post("pull_request", payload)).status, 200);
});

test("hostile text: no x.github-hooks document holds any of it", async () => {
    for (const [event, name] of [
        ["pull_request", "pull_request.opened"],
        ["pull_request", "pull_request.labeled"],
        ["pull_request_review", "pull_request_review.submitted"],
        ["check_suite", "check_suite.completed"],
        ["status", "status"],
        ["issues", "issues.labeled"],
    ] as const) {
        assert.equal((await post(event, withHostileText(fixture(name)))).status, 202, name);
    }

    await until(async () => (await markers()).length === 0, "the desk took them");

    for (const token of [SeenDoc, DeliveriesDoc, PendingDoc, AlarmsDoc, CoverageDoc, ReceiverDoc]) {
        const text = JSON.stringify(await snap(token));

        for (const hostile of HOSTILE) {
            assert.ok(!text.includes(hostile), `${token.kind}: ${hostile}`);
        }
    }
});

test("20 reloads: 1 live listener, 1 live receiver on the newest code, the port answers, the set survives", async () => {
    const known = randomUUID();

    assert.equal((await post("pull_request", pr(), known)).status, 202);

    const before = (await receivers())[0]!;

    for (let index = 0; index < 20; index += 1) {
        await app.loader.reload("github-hooks.ts");
    }

    await listening();
    await until(() => receiverHandle() !== undefined, "a receiver after the reloads", 15_000);

    const live = await receivers();

    assert.equal(live.length, 1);
    assert.equal(live[0]!.record.id, before.record.id, "the same task");
    assert.equal(liveListeners().size, 1);
    assert.equal((await post("pull_request", pr())).status, 202);
    assert.equal(
        (await post("pull_request", pr(), known)).status,
        200,
        "a duplicate after 20 reloads",
    );
});

test("1 real reload: an idle keep-alive socket closes at once, and the new listener accepts", async () => {
    await listening();

    const body = Buffer.from(JSON.stringify(pr()));
    const head =
        "POST /github HTTP/1.1\r\nHost: hooks.test\r\nConnection: keep-alive\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${String(body.length)}\r\nX-GitHub-Event: pull_request\r\nX-GitHub-Delivery: ${randomUUID()}\r\n` +
        `X-Hub-Signature-256: sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}\r\n\r\n`;
    let text = "";
    let closed = false;
    const socket = connect(port, "127.0.0.1");

    socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
        closed = true;
    });
    socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    await until(
        () => /^HTTP\/1\.1 202/.test(text) && text.endsWith("\r\n0\r\n\r\n"),
        "the answer, the socket kept",
    );
    assert.equal(closed, false, "a keep-alive socket stays open");

    await app.loader.reload("github-hooks.ts");
    await until(() => closed, "the idle socket closed at the reload");
    await listening();
    await until(() => receiverHandle() !== undefined, "the receiver after the reload");
    assert.equal((await post("pull_request", pr())).status, 202);
});

test("turned off: the receiver waits in memory with no commit; turned on: the new code runs and accepts", async () => {
    const before = (await receivers())[0]!;
    const checkpoint = () => receivers().then((tasks) => JSON.stringify(tasks[0]?.record.state));
    const generation = (state: string) =>
        (JSON.parse(state) as { checkpoint: { generation: number } }).checkpoint.generation;

    await app.setExtensionEnabled(owner(app), "github-hooks.ts", false);

    // The event loop is free: a timer fires.
    let fired = false;

    await new Promise<void>((resolve) =>
        setTimeout(() => {
            fired = true;
            resolve();
        }, 0),
    );
    assert.equal(fired, true);

    // No commit loop: parked, and no commit over many turns of the event loop.
    const off = await assertParkedWithNoCommit();

    const tasks = await receivers();

    assert.equal(tasks.length, 1, "the task stays live");
    assert.notEqual(tasks[0]!.record.state.status, "terminal");
    assert.equal(receiverHandle(), undefined, "no receiver takes jobs while the module is off");
    await until(() => liveListeners().size === 0, "the listener closed");

    await app.setExtensionEnabled(owner(app), "github-hooks.ts", true);
    await listening();
    await until(() => receiverHandle() !== undefined, "the receiver of the new code");
    assert.equal(generation(await checkpoint()), generation(off) + 1, "1 commit: the handover");
    assert.equal((await receivers())[0]!.record.id, before.record.id);
    assert.equal((await post("pull_request", pr())).status, 202);
});

test("a load that fails after it set its version id: a later turn-off still waits with no commit loop", async () => {
    const file = join(dataDir, "extensions", "github-hooks.ts");
    const good = readFileSync(file, "utf8");
    const failing = good.replace(
        'return defineExtension({ name: "github-hooks", tasks: [Receiver] });',
        'throw new Error("test: a load that fails late");',
    );

    assert.notEqual(failing, good);
    writeFileSync(file, failing);
    await assert.rejects(app.loader.reload("github-hooks.ts"), /fails late/);
    writeFileSync(file, good);
    await listening();
    assert.notEqual(receiverHandle(), undefined, "the version before stays");

    await app.setExtensionEnabled(owner(app), "github-hooks.ts", false);

    await assertParkedWithNoCommit();

    await app.setExtensionEnabled(owner(app), "github-hooks.ts", true);
    await listening();
    await until(() => receiverHandle() !== undefined, "the receiver after the turn-on");
    assert.equal((await post("pull_request", pr())).status, 202);
});

test("the desk off: a delivery is accepted with no marker; a written marker waits; the desk on hands it over", async () => {
    await app.setExtensionEnabled(owner(app), "desk.ts", false);

    const id = randomUUID();

    assert.equal((await post("pull_request", pr(), id)).status, 202);
    assert.deepEqual(await markers(), [], "no marker with the desk off");

    const marker = randomUUID();

    await writeMarker(marker);

    const ticks = probe.ticks;

    await until(() => probe.ticks >= ticks + 3, "3 receiver ticks");
    assert.deepEqual(await markers(), [marker], "the marker waits for the desk");

    await app.setExtensionEnabled(owner(app), "desk.ts", true);
    await until(async () => (await markers()).length === 0, "the desk API reappeared: handed over");
    assert.notEqual((await deskSeen())[marker], undefined);
});

test("a second nudge of the same delivery does nothing", async () => {
    const id = randomUUID();

    assert.equal((await post("pull_request", pr(), id)).status, 202);
    await until(async () => (await deskSeen())[id] !== undefined, "the desk took it");

    const took = (await deskSeen())[id];
    const unmatched = (await app.harness.snapshot(DeskNudges, context))?.unmatched;

    await writeMarker(id);
    // The desk API object changes at a desk reload: the receiver hands the marker over again.
    await app.loader.reload("desk.ts");
    await until(async () => (await markers()).length === 0, "the marker is handed over");
    assert.equal((await deskSeen())[id], took);
    assert.equal((await app.harness.snapshot(DeskNudges, context))?.unmatched, unmatched);
});

test("a crash between the commit and nudge: the marker reaches the desk after a restart", async () => {
    const accepted = randomUUID();

    assert.equal((await post("pull_request", pr(), accepted)).status, 202);
    await until(async () => (await markers()).length === 0, "nothing pending");

    const marker = randomUUID();

    // As if the process died after the delivery commit, before the nudge commit.
    await writeMarker(marker);
    await app.close();
    app = await openApp(model, dataDir);
    await listening();
    await until(() => receiverHandle() !== undefined, "the receiver after the restart", 15_000);
    await until(async () => (await markers()).length === 0, "the marker is recovered");
    assert.notEqual((await deskSeen())[marker], undefined);
    assert.equal((await receivers()).length, 1);
    assert.equal(
        (await post("pull_request", pr(), accepted)).status,
        200,
        "the set survives a restart",
    );
});
