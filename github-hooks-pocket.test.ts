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
    AlarmsDoc,
    CoverageDoc,
    DeliveriesDoc,
    PendingDoc,
    ReceiverDoc,
    SeenDoc,
    liveListeners,
    receiverHandle,
} from "./github-hooks.ts";
import { HOSTILE, fixture, withHostileText } from "./github-hooks-fixture.ts";

const SECRET = "c".repeat(16) + "0123456789abcdef0123456789abcdef";
const dataDir = join(root, "data");
const definitions = join(root, "agents");
const secretDir = join(root, "hooks-secret");
const fakeGh = join(root, "fake-gh.sh");
const ghAnswer = join(root, "github.json");
const model = scriptedModel();

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
    const body = Buffer.from(JSON.stringify(payload));
    const head =
        "POST /github HTTP/1.1\r\nHost: hooks.test\r\nConnection: close\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${String(body.length)}\r\nX-GitHub-Event: ${event}\r\nX-GitHub-Delivery: ${id}\r\n` +
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
    await until(() => liveListeners().size === 1, "1 live listener", 15_000);
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

test("the status card: the listener, the receiver, the secret state (never its value), counts and alarms", async () => {
    const card = await command("");

    assert.equal(card.type, "card");
    assert.match(card.output ?? "", new RegExp(`Listener: bound on port ${String(port)}`));
    assert.match(card.output ?? "", /Receiver: task \d+ in session \d+, running/);
    assert.match(card.output ?? "", /Secret: ok \(next: none\)/);
    assert.match(card.output ?? "", /accepted 1/);
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

    const off = await checkpoint();

    // No commit loop: the state stays the same over many ticks (the tick is 50 ms here).
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await checkpoint(), off);

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

    const state = async () => JSON.stringify((await receivers())[0]?.record.state);
    const first = await state();

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await state(), first, "no commit loop");

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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
