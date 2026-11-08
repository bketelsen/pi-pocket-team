// The goal board in Pi Pocket, with the real Team, desk and shift modules and a scripted model: Team's `startShift`
// (its frozen result, a replay, the refusals, a thrown start, and the board's limit on the desk's open), then rows
// launched with `desk board_launch` from a supervisor's session, whose threads carry shift goals with the rows' task,
// stop condition, rounds and length; then the Desk page's board routes (`GET board`, `POST board/:conversation`) on a
// local HTTP server, with the owner's token and a guest's. No test reaches Brian's data or the network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import { createHandler } from "./_pocket/src/server/http.ts";
import { boardRows } from "./_desk-board.ts";
import { BoardReceipts, capView, DeskReports, DeskThreads, type DeskState } from "./desk.ts";
import { GoalDoc } from "./night-shift.ts";
import { RUN_END, turnTexts } from "./scripted-turn-fixture.ts";
import type { TeamApi, TeamStartShiftRequest } from "./team.ts";

/** The run-end switch is Pocket's `linkedSessions.reports`: a checkout whose types have none skips that case. */
const NO_SWITCH: string | false = /^\s*reports\(/m.test(
    readFileSync(join(import.meta.dirname, "_pocket", "types", "pocket.d.ts"), "utf8"),
)
    ? false
    : "needs linkedSessions.reports";

const dataDir = join(root, "data");
const definitions = join(root, "agents");
const tegHome = join(root, "teg-home");
const lucillaHome = join(root, "lucilla-home");
const configPath = join(root, "desk.json");
const fixturePath = join(root, "github.json");
const fakeGh = join(root, "fake-gh.sh");

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const toolCall = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Pi, scripted: `run-tool <name> <json>` calls a tool once; a shift round continues; anything else is done. */
const script: Parameters<typeof scriptedModel>[0] = (request) => {
    if (lastText(request as never).role === "toolResult") {
        return answer("ok");
    }

    for (const text of turnTexts(request as never)) {
        const run = /run-tool (\S+) (\{.*\})\s*$/s.exec(text);

        if (run !== null) {
            return toolCall(run[1] ?? "", JSON.parse(run[2] ?? "{}") as object);
        }

        if (text.startsWith("[shift] The shift has stopped")) {
            return answer("Summary: the rounds ran.\n\nASKS FOR BRIAN: none");
        }

        if (text.startsWith("[shift] Round")) {
            return answer("STATUS: CONTINUE: more to do");
        }
    }

    return answer("Done.");
};

const model = scriptedModel(script);

model.appendResponses(Array.from({ length: 1000 }, () => script));

let app: App;

const deskState = async (): Promise<DeskState> =>
    (await app.harness.snapshot(DeskThreads, context)) ?? {
        next: { T: 1, F: 1 },
        threads: {},
        grants: [],
        seen: {},
    };
const team = (): TeamApi =>
    (globalThis as unknown as Record<symbol, TeamApi | undefined>)[
        Symbol.for("pi-pocket-team.team")
    ] ?? assert.fail("Team is on");

function command(id: ConversationId, name: string, args: string) {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, owner(app), {
        commandId,
        args,
        requestId: crypto.randomUUID(),
    });
}

let folders = 0;

/** A new supervisor session: Odrade's identity, and Pi works for the owner there. */
async function supervisor(): Promise<ConversationId> {
    const folder = join(root, `odrade-${String((folders += 1))}`);

    mkdirSync(folder, { recursive: true });

    const id = await newSession(app, folder);

    await command(id, "team-agent", "odrade");
    await say(app, id, "hello");

    return id;
}

const runTool = (id: ConversationId, name: string, args: object) =>
    say(app, id, `run-tool ${name} ${JSON.stringify(args)}`);

/** Team's start as the desk calls it, on this app's harness: the row ends 90 minutes from now by default. */
const startShift = (patch: Partial<TeamStartShiftRequest> & { supervisor: number; key: string }) =>
    team().startShift!({
        read: app.harness,
        commit: <T>(change: (tx: Tx) => T | Promise<T>) => app.harness.commit(change, context),
        context,
        agent: "teg",
        title: "Board start",
        task: "BOARD-TASK tend the tests",
        shift: { stop_when: "the tests pass", max: 2, until_at: Date.now() + 90 * 60_000 },
        limit: { reserve: 0 },
        ...patch,
    });

type LinkedStart = (
    source: ConversationId,
    request: { title?: string; message: string; model?: string; cwd?: string },
    key: string,
) => Promise<{ session: ConversationId; address: string }>;

/** Pocket's start, wrapped for 1 test: `wrap` gets the real start. `restore` undoes it. */
function wrapStart(
    wrap: (real: LinkedStart, ...args: Parameters<LinkedStart>) => ReturnType<LinkedStart>,
) {
    const proto = Object.getPrototypeOf(app.linkedSessions) as { start: LinkedStart };
    const original = proto.start;

    proto.start = async function (this: unknown, source, request, key) {
        return wrap((s, r, k) => original.call(this, s, r, k), source, request, key);
    };

    return {
        restore: () => {
            proto.start = original;
        },
    };
}

/** The config: the cap, the board's limits, and no digest. */
function config(cap: number, board: object = {}): void {
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap, board }));
}

/** An until 2 hours from now in the shift module's zone (the server's), as HH:MM. */
function untilSoon(): string {
    return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(Date.now() + 2 * 3600_000);
}

/** The texts of a session's user entries, oldest first. */
async function userTexts(id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages
        .filter((message) => message.role === "user")
        .map((message) =>
            typeof message.content === "string"
                ? message.content
                : (message.content as { type: string; text?: string }[])
                      .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
                      .join(""),
        );
}

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;

    for (const folder of [definitions, tegHome, lucillaHome]) {
        mkdirSync(folder, { recursive: true });
    }

    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
    );
    writeFileSync(
        join(definitions, "teg.md"),
        `---\nmodel: faux/faux-2\nhome: ${tegHome}\n---\n# Teg\nYou are Teg.`,
    );
    writeFileSync(
        join(definitions, "lucilla.md"),
        `---\nmodel: faux/faux-2\nhome: ${lucillaHome}\n---\n# Lucilla\nYou are Lucilla.`,
    );

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });

    for (const file of [
        "team.ts",
        "desk.ts",
        "night-shift.ts",
        "_desk-usage.ts",
        "_desk-dashboard.ts",
        "_desk-metrics.ts",
        "_desk-board.ts",
    ]) {
        cpSync(join(import.meta.dirname, file), join(dropIns, file));
    }

    for (const folder of ["team-web", "desk-web", "night-shift-web"]) {
        cpSync(join(import.meta.dirname, folder), join(dropIns, folder), { recursive: true });
    }

    writeFileSync(fixturePath, JSON.stringify({ data: { viewer: { login: "github-viewer" } } }));
    writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`, { mode: 0o755 });
    process.env.PI_POCKET_DESK_GH = fakeGh;
    process.env.PI_POCKET_DESK_CONFIG = configPath;
    config(100);

    app = await openApp(model, dataDir);
    await app.setSubagentModels(owner(app), ["faux/faux-2"]);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);
    await app.setExtensionEnabled(owner(app), "night-shift.ts", true);
});

let server: ReturnType<typeof createServer> | undefined;

after(async () => {
    if (server !== undefined) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

/** The desk's page routes on a local server, with the owner's token, or another person's. */
async function routes(): Promise<
    (path: string, body?: object, token?: string) => Promise<{ status: number; data: any }>
> {
    if (server === undefined) {
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    }

    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/desk/`;

    return async (path, body, token = app.config.ownerToken) => {
        const response = await fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        return { status: response.status, data: await response.json() };
    };
}

describe("Team startShift", () => {
    test("the frozen result: thread, session, address and replay; the same key gives it back with replay", async () => {
        const source = await supervisor();
        const first = await startShift({ supervisor: Number(source), key: "x.desk.board:900:1" });

        assert(!("error" in first), JSON.stringify(first));
        assert.deepEqual(Object.keys(first).sort(), ["address", "replay", "session", "thread"]);
        assert.equal(first.replay, false);
        assert.match(first.thread, /^T\d+$/);
        assert.match(first.address, /^session-/);

        const thread = (await deskState()).threads[first.thread];

        assert.equal(thread?.key, "x.desk.board:900:1");
        assert.equal(thread?.session, first.session);
        assert.equal(app.cwdOf(first.session as unknown as ConversationId), tegHome);

        const goal = (
            await app.harness.snapshot(GoalDoc, first.session as unknown as ConversationId, context)
        )?.goal;

        assert.equal(goal?.objective, "BOARD-TASK tend the tests");
        assert.equal(goal?.stop, "the tests pass");
        assert.equal(goal?.maxRounds, 2);

        const sessions = app.sessions().length;
        const again = await startShift({ supervisor: Number(source), key: "x.desk.board:900:1" });

        assert.deepEqual(again, { ...first, replay: true });
        assert.equal(app.sessions().length, sessions, "nothing started again");
    });

    test("a refusal: a model not allowed, a bad pr_check, no such repository, a source that is no supervisor", async () => {
        const source = await supervisor();
        const sessions = app.sessions().length;
        const worker = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:901:1",
            shift: {
                stop_when: "x",
                max: 2,
                until_at: Date.now() + 90 * 60_000,
                worker: "faux/faux-1",
            },
        });

        assert.deepEqual(worker, {
            error: "faux/faux-1 is not in the owner's allowed list for subagents. Allowed: faux/faux-2.",
            unknown: false,
        });

        const check = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:902:1",
            shift: {
                stop_when: "x",
                max: 2,
                until_at: Date.now() + 90 * 60_000,
                pr_check: { label: "bad;label" },
            },
        });

        assert("error" in check && check.unknown === false, JSON.stringify(check));

        const repository = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:903:1",
            repository: "frostyard/none",
        });

        assert("error" in repository && repository.unknown === false);
        assert.match(repository.error, /Teg works in: home\./);

        const agentFolder = join(root, "teg-session");

        mkdirSync(agentFolder, { recursive: true });

        const notSupervisor = await newSession(app, agentFolder);

        await command(notSupervisor, "team-agent", "teg");

        const refused = await startShift({
            supervisor: Number(notSupervisor),
            key: "x.desk.board:904:1",
        });

        assert("error" in refused);
        assert.match(refused.error, /is not a supervisor's/);
        assert.equal(app.sessions().length, sessions + 1, "only the test's own session");
    });

    test("until_at is the goal's deadline exactly, also when the start comes long after the claim", async () => {
        const source = await supervisor();
        const desk = (globalThis as unknown as Record<symbol, DeskOpen | undefined>)[
            Symbol.for("pi-pocket-team.desk")
        ];

        assert(desk !== undefined, "the desk is on");

        // A late recovery: the key's thread opened before a restart, with no session bound yet. The row's end is not
        // a length from now: the deadline is that instant, whenever the start comes.
        const key = "x.desk.board:920:1";
        const untilAt = Date.now() + 37 * 60_000;

        await app.harness.commit(
            (tx) =>
                desk.open(tx, {
                    key,
                    supervisor: Number(source),
                    agents: ["teg"],
                    title: "Board start",
                    task: "BOARD-TASK tend the tests",
                    at: Date.now(),
                }),
            context,
        );

        const sessions = app.sessions().length;
        const late = await startShift({
            supervisor: Number(source),
            key,
            shift: { stop_when: "the tests pass", max: 2, until_at: untilAt },
        });

        assert(!("error" in late), JSON.stringify(late));
        assert.equal(app.sessions().length, sessions + 1, "1 session");
        assert.equal(
            Object.values((await deskState()).threads).filter((thread) => thread.key === key)
                .length,
            1,
            "the same thread",
        );

        const goal = (
            await app.harness.snapshot(GoalDoc, late.session as unknown as ConversationId, context)
        )?.goal;

        assert.equal(goal?.deadline, untilAt);

        // The same key again (a recovery after the bind): a replay, the same deadline, no new session.
        const again = await startShift({
            supervisor: Number(source),
            key,
            shift: { stop_when: "the tests pass", max: 2, until_at: untilAt + 3600_000 },
        });

        assert.deepEqual(again, { ...late, replay: true });
        assert.equal(app.sessions().length, sessions + 1);
        assert.equal(
            (
                await app.harness.snapshot(
                    GoalDoc,
                    late.session as unknown as ConversationId,
                    context,
                )
            )?.goal?.deadline,
            untilAt,
        );
    });

    test("an until_at in the past is a refusal, and no session starts", async () => {
        const source = await supervisor();
        const sessions = app.sessions().length;
        const past = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:921:1",
            shift: { stop_when: "x", max: 2, until_at: Date.now() - 60_000 },
        });

        assert("error" in past, JSON.stringify(past));
        assert.equal(past.unknown, false);
        assert.match(past.error, /shift\.until_at .* has passed\./);
        assert.equal(app.sessions().length, sessions, "no session");
    });

    test("a refusal after the key's thread opened (a recovery past until_at) is unknown: Pocket may have its session", async () => {
        const source = await supervisor();
        const desk = (globalThis as unknown as Record<symbol, DeskOpen | undefined>)[
            Symbol.for("pi-pocket-team.desk")
        ];

        assert(desk !== undefined, "the desk is on");

        // The first try opened the thread, and a restart came before its bind; the recovery comes after the row's end.
        const key = "x.desk.board:923:1";

        await app.harness.commit(
            (tx) =>
                desk.open(tx, {
                    key,
                    supervisor: Number(source),
                    agents: ["teg"],
                    title: "Board start",
                    task: "BOARD-TASK tend the tests",
                    at: Date.now(),
                }),
            context,
        );

        const late = await startShift({
            supervisor: Number(source),
            key,
            shift: { stop_when: "x", max: 2, until_at: Date.now() - 60_000 },
        });

        assert("error" in late, JSON.stringify(late));
        assert.equal(
            late.unknown,
            true,
            "not a plain refusal: the row must not fail as if nothing started",
        );
        assert.match(late.error, /shift\.until_at .* has passed\./);
    });

    test("an older desk's for still starts a shift, for 1 install window", async () => {
        const source = await supervisor();
        const before = Date.now();
        const old = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:922:1",
            shift: { stop_when: "x", max: 2, for: "90m" } as TeamStartShiftRequest["shift"],
        });

        assert(!("error" in old), JSON.stringify(old));

        const goal = (
            await app.harness.snapshot(GoalDoc, old.session as unknown as ConversationId, context)
        )?.goal;

        assert(goal?.deadline !== undefined);
        assert(goal.deadline >= before + 90 * 60_000 && goal.deadline <= Date.now() + 90 * 60_000);
    });

    test("team_delegate refuses shift.until_at: only the board sets it", async () => {
        const source = await supervisor();
        const sessions = app.sessions().length;

        for (const name of ["shift", "night_shift"]) {
            await runTool(source, "team_delegate", {
                agent: "teg",
                task: "UNTIL-AT from a model",
                [name]: { stop_when: "x", until_at: Date.now() + 3600_000 },
            });
        }

        const said = (await modelTexts(app, source)).join("\n");

        assert.equal(
            said.split("shift.until_at is not a team_delegate field.").length - 1,
            2,
            said.slice(-2000),
        );
        assert.equal(app.sessions().length, sessions, "no session");
    });

    test("a thrown start is unknown: Pocket may have admitted the session", async () => {
        const source = await supervisor();
        const wrapped = wrapStart(async () => {
            throw new Error("the start fell over");
        });

        try {
            const result = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:905:1",
            });

            assert.deepEqual(result, { error: "the start fell over", unknown: true });
        } finally {
            wrapped.restore();
        }
    });

    test("an error after Pocket admitted the session (the bind commit throws) is unknown", async () => {
        const source = await supervisor();
        let admitted = false;
        let thrown = false;
        const wrapped = wrapStart(async (real, ...args) => {
            const started = await real(...args);

            admitted = true;

            return started;
        });
        const sessions = app.sessions().length;

        try {
            const result = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:907:1",
                commit: async <T>(change: (tx: Tx) => T | Promise<T>): Promise<T> => {
                    // The first commit after the start is the bind: it fails once.
                    if (admitted && !thrown) {
                        thrown = true;

                        throw new Error("the bind commit fell over");
                    }

                    return app.harness.commit(change, context);
                },
            });

            assert.deepEqual(result, { error: "the bind commit fell over", unknown: true });
            assert.equal(thrown, true, "the bind commit threw");
            assert.equal(app.sessions().length, sessions + 1, "Pocket admitted 1 session");
        } finally {
            wrapped.restore();
        }
    });

    test("with no desk API nothing starts, and the result is a refusal", async () => {
        const source = await supervisor();
        const shared = globalThis as unknown as Record<symbol, unknown>;
        const desk = shared[Symbol.for("pi-pocket-team.desk")];
        const sessions = app.sessions().length;
        const threads = Object.keys((await deskState()).threads).length;

        delete shared[Symbol.for("pi-pocket-team.desk")];

        try {
            const result = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:908:1",
            });

            assert("error" in result, JSON.stringify(result));
            assert.equal(result.unknown, false);
            assert.match(result.error, /The desk module is off/);
        } finally {
            shared[Symbol.for("pi-pocket-team.desk")] = desk;
        }

        assert.equal(app.sessions().length, sessions, "no session");
        assert.equal(Object.keys((await deskState()).threads).length, threads, "no thread");
    });

    test("a start that admits a session and then throws null or undefined is unknown, with its thread failed", async () => {
        const source = await supervisor();

        for (const [index, value] of [null, undefined].entries()) {
            const key = `x.desk.board:910:${String(index + 1)}`;
            const wrapped = wrapStart(async (real, ...args) => {
                await real(...args);

                // Pocket admitted the session, then rejected with no Error.
                throw value;
            });
            const sessions = app.sessions().length;

            try {
                const result = await startShift({ supervisor: Number(source), key });

                assert("error" in result, JSON.stringify(result));
                assert.equal(result.unknown, true, `${String(value)}: unknown`);
                assert.equal(result.error, `the start failed with ${String(value)}`);
                assert.equal(app.sessions().length, sessions + 1, "1 session");
            } finally {
                wrapped.restore();
            }

            const thread = Object.values((await deskState()).threads).find(
                (each) => each.key === key,
            );

            assert.equal(thread?.state, "closed", "the desk failed the thread");
            assert.equal(typeof thread?.closed?.why, "string");
        }
    });

    test("a desk that unloads before delegate reads it: no session, no thread, a refusal", async () => {
        const source = await supervisor();
        const shared = globalThis as unknown as Record<symbol, unknown>;
        const desk = shared[Symbol.for("pi-pocket-team.desk")];
        const sessions = app.sessions().length;
        const threads = Object.keys((await deskState()).threads).length;
        let removed = false;

        try {
            const result = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:911:1",
                // The desk unloads during the identity read: after startShift's own check, before delegate's.
                read: {
                    snapshot: ((...args: unknown[]) => {
                        if (!removed) {
                            removed = true;
                            delete shared[Symbol.for("pi-pocket-team.desk")];
                        }

                        return Reflect.apply(app.harness.snapshot, app.harness, args);
                    }) as typeof app.harness.snapshot,
                },
            });

            assert.equal(removed, true, "the desk unloaded during the call");
            assert("error" in result, JSON.stringify(result));
            assert.equal(result.unknown, false);
            assert.match(result.error, /The desk module is off/);
        } finally {
            shared[Symbol.for("pi-pocket-team.desk")] = desk;
        }

        assert.equal(app.sessions().length, sessions, "no session");
        assert.equal(Object.keys((await deskState()).threads).length, threads, "no thread");
    });

    test("a dependency that rejects with null or undefined gives an error result, never a throw", async () => {
        const source = await supervisor();

        for (const [index, value] of [null, undefined].entries()) {
            const sessions = app.sessions().length;
            const result = await startShift({
                supervisor: Number(source),
                key: `x.desk.board:909:${String(index + 1)}`,
                commit: () => Promise.reject(value),
            });

            assert("error" in result, JSON.stringify(result));
            assert.equal(typeof result.error, "string");
            assert.match(result.error, new RegExp(`the start failed with ${String(value)}`));
            assert.equal(result.unknown, false, "it failed before any start");
            assert.equal(app.sessions().length, sessions, "no session");
        }
    });

    test("the board's limit: the open refuses at cap minus reserve, and an unused OK stays unused", async () => {
        const source = await supervisor();
        const counted = capView(await deskState(), 100, Date.now()).counted;

        config(counted + 2);
        await app.harness.commit(async (tx) => {
            (await tx.doc(DeskThreads)).grants.push({
                key: "grant:board",
                at: Date.now(),
                by: "brian",
                via: "tap",
                expires: Date.now() + 3600_000,
            });
        }, context);

        try {
            const sessions = app.sessions().length;
            const refusals = (await deskState()).refusals?.length ?? 0;
            const result = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:906:1",
                limit: { reserve: 2 },
            });

            assert("error" in result, JSON.stringify(result));
            assert.equal(result.deskFull, true);
            assert.equal(result.unknown, false);
            assert.match(result.error, /The desk has no room for a board start/);
            assert.equal(app.sessions().length, sessions, "no session");

            const state = await deskState();

            assert.equal(
                state.grants.find((grant) => grant.key === "grant:board")?.usedBy,
                undefined,
            );
            assert.equal(state.refusals?.length ?? 0, refusals, "no refusal waits for Allow 1");
            assert.equal(
                Object.values(state.threads).some((thread) => thread.key === "x.desk.board:906:1"),
                false,
            );

            // With reserve 1 there is room: the same start opens.
            const opened = await startShift({
                supervisor: Number(source),
                key: "x.desk.board:906:1",
                limit: { reserve: 1 },
            });

            assert(!("error" in opened), JSON.stringify(opened));
            assert.equal(
                (await deskState()).grants.find((grant) => grant.key === "grant:board")?.usedBy,
                undefined,
                "the board never uses an OK",
            );
        } finally {
            config(100);
        }
    });
});

describe("the board in Pi Pocket", () => {
    test("2 picked rows launched with board_launch give 2 threads whose goals hold the rows' task, stop, max and for", async () => {
        const source = await supervisor();
        const untilTime = untilSoon();

        for (const [agent, task] of [
            ["teg", "BOARD-ONE fix the flaky test"],
            ["lucilla", "BOARD-TWO update the docs"],
        ] as const) {
            await runTool(source, "desk", {
                action: "board_add",
                fields: {
                    agent,
                    title: task.slice(0, 20),
                    task,
                    stopWhen: `${agent} is done`,
                    max: 2,
                    until: untilTime,
                },
            });
        }

        const rows = boardRows((await deskState()).board, Number(source));

        assert.equal(rows.length, 2);
        await runTool(source, "desk", {
            action: "board_pick",
            rows: rows.map((row) => ({ row: row.id, rev: row.rev })),
        });
        await runTool(source, "desk", { action: "board_launch" });

        await until(
            async () => {
                const rows = boardRows((await deskState()).board, Number(source));

                return rows.length === 2 && rows.every((row) => row.state === "launched");
            },
            "both board rows launched",
            20_000,
        );

        const launched = boardRows((await deskState()).board, Number(source));

        assert.deepEqual(
            launched.map((row) => row.state),
            ["launched", "launched"],
        );

        for (const row of launched) {
            const thread = (await deskState()).threads[row.thread ?? ""];

            assert(thread?.session !== undefined, "the thread has its session");

            const goal = (
                await app.harness.snapshot(
                    GoalDoc,
                    thread.session as unknown as ConversationId,
                    context,
                )
            )?.goal;

            assert.equal(goal?.objective, row.task);
            assert.equal(goal?.stop, row.stopWhen);
            assert.equal(goal?.maxRounds, row.max);
            // The start sends untilAt as the absolute stop until_at: the deadline is untilAt exactly.
            assert(row.untilAt !== undefined);
            assert.equal(goal?.deadline, row.untilAt);
            assert.equal(thread.key, `x.desk.board:${String(row.id)}:1`);
        }
    });

    test("a row with a worker not on the allowed list fails with team_delegate's words", async () => {
        const source = await supervisor();

        await app.setSubagentModels(owner(app), ["faux/faux-2", "faux/faux-1"]);

        try {
            await runTool(source, "desk", {
                action: "board_add",
                fields: {
                    agent: "teg",
                    title: "worker row",
                    task: "BOARD-WORKER",
                    stopWhen: "done",
                    max: 2,
                    until: untilSoon(),
                    worker: "faux/faux-1",
                },
            });
        } finally {
            await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        }

        const row = boardRows((await deskState()).board, Number(source))[0]!;

        await runTool(source, "desk", {
            action: "board_pick",
            rows: [{ row: row.id, rev: row.rev }],
        });
        await runTool(source, "desk", { action: "board_launch" });

        const failed = boardRows((await deskState()).board, Number(source))[0]!;

        assert.equal(failed.state, "failed");
        assert.equal(
            failed.error,
            "faux/faux-1 is not in the owner's allowed list for subagents. Allowed: faux/faux-2.",
        );
        assert.equal(failed.attempts[0]?.outcome, "refused");
    });

    test(
        "with the run-end switch, the supervisor gets 0 run-end answers while the runs do 3 rounds",
        { skip: NO_SWITCH },
        async () => {
            const source = await supervisor();

            await runTool(source, "desk", {
                action: "board_add",
                fields: {
                    agent: "teg",
                    title: "three rounds",
                    task: "BOARD-ROUNDS",
                    stopWhen: "never",
                    max: 3,
                    until: untilSoon(),
                },
            });

            const row = boardRows((await deskState()).board, Number(source))[0]!;

            await runTool(source, "desk", {
                action: "board_pick",
                rows: [{ row: row.id, rev: row.rev }],
            });
            await runTool(source, "desk", { action: "board_launch" });

            const thread = (await deskState()).threads[
                boardRows((await deskState()).board, Number(source))[0]?.thread ?? ""
            ];

            assert(thread?.session !== undefined);

            const child = thread.session as unknown as ConversationId;
            const goalOf = async () => (await app.harness.snapshot(GoalDoc, child, context))?.goal;

            // `round` moves before a round is sent: wait for 3 completed rounds, the shift's end, its report on the
            // desk, and the child and the supervisor at rest. Only then count.
            await until(
                async () => {
                    const goal = await goalOf();

                    return goal?.status === "ended" && goal.rounds.length >= 3;
                },
                "3 completed rounds and the shift's end",
                120_000,
            );
            await until(
                async () =>
                    ((await app.harness.snapshot(DeskReports, child, context))?.reports ?? []).some(
                        (report) => report.from === "night-shift",
                    ),
                "the shift's report on the desk",
                60_000,
            );
            await until(() => !app.isBusy(child), "the child at rest", 60_000);
            await until(() => !app.isBusy(source), "the supervisor at rest", 60_000);

            const goal = await goalOf();

            assert.equal(goal?.rounds.length, 3, "3 completed rounds");
            assert.equal(goal?.round, 3);
            assert.equal((await userTexts(source)).filter((text) => RUN_END.test(text)).length, 0);
        },
    );
});

/** The desk API's thread open, as the routes' tests use it. */
type DeskOpen = { open: (tx: Tx, request: object) => Promise<unknown> };

describe("the Desk page's board routes", () => {
    let keys = 0;
    /** A new page key, as the Board view makes it: the page's time in ms, then a random part (8 to 100 characters). */
    const key = (at = Date.now()) =>
        `${String(at)}-page-key-${String((keys += 1)).padStart(4, "0")}`;

    /** A supervisor the desk knows: Odrade's session, with 1 open thread of its own, opened through the desk's API. */
    async function knownSupervisor(): Promise<ConversationId> {
        const source = await supervisor();
        const desk = (globalThis as unknown as Record<symbol, DeskOpen | undefined>)[
            Symbol.for("pi-pocket-team.desk")
        ];

        assert(desk !== undefined, "the desk is on");
        await app.harness.commit(
            (tx) =>
                desk.open(tx, {
                    key: `board-page-thread:${String(source)}`,
                    supervisor: Number(source),
                    agents: ["teg"],
                    title: "Board page test",
                    task: "A thread that makes the supervisor known.",
                    at: Date.now(),
                }),
            context,
        );
        assert(
            Object.values((await deskState()).threads).some(
                (thread) => thread.supervisor === Number(source),
            ),
            "the supervisor has a thread",
        );

        return source;
    }

    /** Add 1 row with the tool, as the supervisor, and give its id. */
    async function addRow(source: ConversationId, fields: object = {}): Promise<number> {
        await runTool(source, "desk", {
            action: "board_add",
            fields: {
                agent: "teg",
                title: "page row",
                task: "BOARD-PAGE tend the tests",
                stopWhen: "the tests pass",
                max: 2,
                until: untilSoon(),
                ...fields,
            },
        });

        return Math.max(
            ...boardRows((await deskState()).board, Number(source)).map((row) => row.id),
        );
    }

    /** A row of the stored board. */
    const stored = async (id: number) =>
        (await deskState()).board?.rows.find((row) => row.id === id) ??
        assert.fail(`row ${String(id)}`);

    /** Set a row's state in the store: the states that only a pass gives (failed, unknown). */
    const setState = (id: number, state: "failed" | "unknown") =>
        app.harness.commit(async (tx) => {
            const row = (await tx.doc(DeskThreads)).board?.rows.find((each) => each.id === id);

            assert(row !== undefined);
            row.state = state;
            row.error = `a ${state} start`;
        }, context);

    test("GET board: the supervisors, the chosen one, its rows in launch order with their fields, and the limits", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const late = await addRow(source, { title: "late row", order: 50 });
        const early = await addRow(source, { title: "early row", order: 5, note: "first" });
        const got = await call(`board?supervisor=${String(source)}`);

        assert.equal(got.status, 200, JSON.stringify(got.data));
        assert(got.data.supervisors.includes(Number(source)));
        assert.deepEqual(
            got.data.supervisors,
            [...got.data.supervisors].sort((a: number, b: number) => a - b),
        );
        assert.equal(got.data.supervisor, Number(source));
        assert.deepEqual(
            got.data.rows.map((row: { id: number }) => row.id),
            [early, late],
        );

        const row = await stored(early);

        assert.deepEqual(got.data.rows[0], {
            id: early,
            rev: 1,
            state: "proposed",
            agent: "teg",
            title: "early row",
            task: "BOARD-PAGE tend the tests",
            stopWhen: "the tests pass",
            max: 2,
            until: row.until,
            kind: "goal",
            note: "first",
            order: 5,
            by: "odrade",
            attempts: [],
        });
        assert.match(
            got.data.limits.line,
            /^8 at once, 0 running · cap 100, \d+ count, 2 kept free · 0 of 250 rounds today$/,
        );
        assert.deepEqual(
            { ...got.data.limits, line: undefined, counted: undefined },
            {
                line: undefined,
                atOnce: 8,
                running: 0,
                cap: 100,
                counted: undefined,
                reserve: 2,
                rounds: 0,
                roundsMax: 250,
            },
        );

        // A supervisor the desk does not know: the first one.
        const first = await call("board?supervisor=999999");

        assert.equal(first.data.supervisor, first.data.supervisors[0]);
    });

    test("GET board: only live supervisors, the one with a sweeper by default, and their session titles", async () => {
        const call = await routes();
        const retired = Number(await knownSupervisor());
        const live = Number(await knownSupervisor());
        const swept = Number(await knownSupervisor());

        assert(retired < live && live < swept, "the ids rise in the order the sessions start");
        await app.commands.updateSession(retired as ConversationId, owner(app), {
            title: "Retired supervisor",
        });
        await app.commands.updateSession(swept as ConversationId, owner(app), {
            title: "Odrade live",
        });

        const saved = structuredClone(await deskState());

        // 1 commit: the retired supervisor's threads and every other thread close, no row stays open, and only the
        // last supervisor has a sweeper.
        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            for (const thread of Object.values(state.threads)) {
                if (
                    thread.state !== "closed" &&
                    thread.supervisor !== live &&
                    thread.supervisor !== swept
                ) {
                    thread.state = "closed";
                    thread.closed = { at: Date.now(), why: "dropped", by: "desk" };
                }
            }

            for (const row of state.board?.rows ?? []) {
                if (row.state !== "launched" && row.state !== "failed" && row.state !== "dropped") {
                    row.state = "dropped";
                }
            }

            state.sweepers = { [String(swept)]: "task-test" };
            state.clerks = {};
        }, context);

        try {
            const got = await call("board");

            assert.equal(got.status, 200, JSON.stringify(got.data));
            assert.deepEqual(
                got.data.supervisors,
                [live, swept],
                "the retired supervisor is not listed",
            );
            assert.equal(
                got.data.supervisor,
                swept,
                "the default is the supervisor with a sweeper",
            );
            assert.equal(got.data.titles[String(swept)], "Odrade live");
            assert.equal(got.data.titles[String(retired)], undefined);
            assert.equal(
                (await call(`board?supervisor=${String(retired)}`)).data.supervisor,
                swept,
                "a retired supervisor asked for gives the default",
            );
            assert.equal((await call(`board?supervisor=${String(live)}`)).data.supervisor, live);
        } finally {
            await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);

                for (const thread of Object.values(state.threads)) {
                    const before = saved.threads[thread.id];

                    if (before !== undefined) {
                        thread.state = before.state;

                        if (before.closed === undefined) {
                            delete thread.closed;
                        } else {
                            thread.closed = before.closed;
                        }
                    }
                }

                for (const row of state.board?.rows ?? []) {
                    const before = saved.board?.rows.find((each) => each.id === row.id);

                    if (before !== undefined) {
                        row.state = before.state;
                    }
                }

                if (saved.sweepers === undefined) {
                    delete state.sweepers;
                } else {
                    state.sweepers = saved.sweepers;
                }

                if (saved.clerks === undefined) {
                    delete state.clerks;
                } else {
                    state.clerks = saved.clerks;
                }
            }, context);
        }
    });

    test("POST board: pick, unpick, edit, drop, reopen and resolve each answer 200 with the rows", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const one = await addRow(source, { title: "row one" });
        const two = await addRow(source, { title: "row two" });
        const post = (body: object) => call(`board/${String(source)}`, { key: key(), ...body });
        const stateOf = (
            answer: { data: { rows: { id: number; state: string; rev: number }[] } },
            id: number,
        ) => answer.data.rows.find((row) => row.id === id);

        const pick = await post({ op: "pick", rows: [{ row: one, rev: 1 }] });

        assert.equal(pick.status, 200, JSON.stringify(pick.data));
        assert.equal(stateOf(pick, one)?.state, "picked");
        assert.equal(pick.data.replay, false);
        assert.deepEqual(pick.data.pass, []);
        assert.match(pick.data.text, /^Picked:/);
        assert.match(pick.data.limits.line, /at once/);

        const unpick = await post({ op: "unpick", rows: [{ row: one, rev: 1 }] });

        assert.equal(unpick.status, 200, JSON.stringify(unpick.data));
        assert.equal(stateOf(unpick, one)?.state, "proposed");

        const edit = await post({
            op: "edit",
            row: one,
            rev: 1,
            fields: { max: 3, until: "07:15" },
        });

        assert.equal(edit.status, 200, JSON.stringify(edit.data));
        assert.deepEqual(
            {
                rev: (await stored(one)).rev,
                max: (await stored(one)).max,
                until: (await stored(one)).until,
            },
            { rev: 2, max: 3, until: "07:15" },
        );

        const drop = await post({ op: "drop", row: two, rev: 1 });

        assert.equal(drop.status, 200, JSON.stringify(drop.data));
        assert.equal(stateOf(drop, two)?.state, "dropped");

        await setState(one, "failed");

        const reopen = await post({ op: "reopen", row: one, rev: 2 });

        assert.equal(reopen.status, 200, JSON.stringify(reopen.data));
        assert.equal(stateOf(reopen, one)?.state, "proposed");

        await setState(one, "unknown");

        const resolve = await post({ op: "resolve", row: one, rev: (await stored(one)).rev });

        assert.equal(resolve.status, 200, JSON.stringify(resolve.data));
        assert.equal(stateOf(resolve, one)?.state, "failed");
        assert.equal((await stored(one)).by, "odrade", "the page does not change who added it");
    });

    test("POST board: resolve with a thread of the same supervisor launches the unknown row with that thread", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const thread =
            Object.values((await deskState()).threads).find(
                (each) => each.supervisor === Number(source),
            )?.id ?? assert.fail("the supervisor's thread");
        const row = await addRow(source, { title: "resolve row" });

        await setState(row, "unknown");

        const resolve = await call(`board/${String(source)}`, {
            op: "resolve",
            row,
            rev: (await stored(row)).rev,
            thread,
            key: key(),
        });

        assert.equal(resolve.status, 200, JSON.stringify(resolve.data));

        const shown = resolve.data.rows.find((each: { id: number }) => each.id === row);

        assert.equal(shown?.state, "launched");
        assert.equal(shown?.thread, thread);
        assert.equal(typeof shown?.next, "string", "the thread's next actor");
        assert.equal((await stored(row)).state, "launched");
        assert.equal((await stored(row)).thread, thread);
        assert.equal((await stored(row)).error, undefined);
    });

    test("POST board: 400 for a bad op, a bad key, a missing rev and a bad field; nothing changes", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const path = `board/${String(source)}`;

        for (const op of ["add", "frobnicate", undefined]) {
            const bad = await call(path, { op, key: key(), fields: {} });

            assert.equal(bad.status, 400, JSON.stringify(bad.data));
            assert.match(
                JSON.stringify(bad.data),
                /op must be 1 of pick, unpick, edit, drop, launch, reopen, resolve/,
            );
        }

        for (const badKey of [undefined, "short", "has space in it", "x".repeat(101)]) {
            const bad = await call(path, { op: "drop", row, rev: 1, key: badKey });

            assert.equal(bad.status, 400, JSON.stringify(bad.data));
            assert.match(JSON.stringify(bad.data), /Board needs key/);
        }

        const noRev = await call(path, { op: "drop", row, key: key() });

        assert.equal(noRev.status, 400, JSON.stringify(noRev.data));

        const noRows = await call(path, { op: "launch", key: key() });

        assert.equal(noRows.status, 400, JSON.stringify(noRows.data));

        const field = await call(path, {
            op: "edit",
            row,
            rev: 1,
            key: key(),
            fields: { max: 0, until: "07:00" },
        });

        assert.equal(field.status, 400, JSON.stringify(field.data));
        assert.deepEqual(
            {
                state: (await stored(row)).state,
                rev: (await stored(row)).rev,
                max: (await stored(row)).max,
            },
            { state: "proposed", rev: 1, max: 2 },
        );
    });

    test("POST board: 403 for a conversation that is no supervisor's, and for another supervisor's row", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const folder = join(root, "no-supervisor");

        mkdirSync(folder, { recursive: true });

        const plain = await newSession(app, folder);
        const none = await call(`board/${String(plain)}`, { op: "drop", row, rev: 1, key: key() });

        assert.equal(none.status, 403, JSON.stringify(none.data));
        assert.match(
            JSON.stringify(none.data),
            new RegExp(`Conversation ${String(plain)} is not a supervisor's`),
        );

        const other = await knownSupervisor();
        const theirs = await call(`board/${String(other)}`, {
            op: "drop",
            row,
            rev: 1,
            key: key(),
        });

        assert.equal(theirs.status, 403, JSON.stringify(theirs.data));
        assert.match(JSON.stringify(theirs.data), /There is no row/);
        assert.equal((await stored(row)).state, "proposed");
    });

    test("POST board: a supervisor live only by its last row replays its drop after it is no longer live; a new change gets 403", async () => {
        const call = await routes();
        const source = await supervisor();
        const id = Number(source);
        const row = await addRow(source);
        const sweeper = (await deskState()).sweepers?.[String(id)];

        // R is live only by its row: no sweeper record (removed here, put back after), no Clerk, no open thread.
        if (sweeper !== undefined) {
            await app.harness.commit(async (tx) => {
                delete (await tx.doc(DeskThreads)).sweepers?.[String(id)];
            }, context);
        }

        try {
            const state = await deskState();

            assert.equal(state.sweepers?.[String(id)], undefined, "no sweeper record");
            assert.equal(state.clerks?.[String(id)], undefined, "no Clerk");
            assert(
                !Object.values(state.threads).some(
                    (thread) => thread.supervisor === id && thread.state !== "closed",
                ),
                "no open thread",
            );
            assert((await call("board")).data.supervisors.includes(id), "live by its row");

            const k = key();
            const body = { op: "drop", row, rev: 1, key: k };
            const first = await call(`board/${String(id)}`, body);

            assert.equal(first.status, 200, JSON.stringify(first.data));
            assert(!(await call("board")).data.supervisors.includes(id), "no longer live");

            const again = await call(`board/${String(id)}`, body);

            assert.equal(again.status, 200, JSON.stringify(again.data));
            assert.equal(again.data.replay, true);
            assert.equal((await stored(row)).state, "dropped");

            const fresh = await call(`board/${String(id)}`, { ...body, key: key() });

            assert.equal(fresh.status, 403, JSON.stringify(fresh.data));
            assert.match(
                JSON.stringify(fresh.data),
                new RegExp(`Conversation ${String(id)} is not a supervisor's`),
            );
        } finally {
            if (sweeper !== undefined) {
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);

                    state.sweepers = { ...state.sweepers, [String(id)]: sweeper };
                }, context);
            }
        }
    });

    test("POST board: 409 for a stale rev and for a wrong state", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const path = `board/${String(source)}`;
        const stale = await call(path, { op: "pick", rows: [{ row, rev: 9 }], key: key() });

        assert.equal(stale.status, 409, JSON.stringify(stale.data));
        assert.match(
            JSON.stringify(stale.data),
            new RegExp(`Row ${String(row)} changed \\(rev 1 now\\)`),
        );

        const staleDrop = await call(path, { op: "drop", row, rev: 2, key: key() });

        assert.equal(staleDrop.status, 409, JSON.stringify(staleDrop.data));

        const wrong = await call(path, { op: "reopen", row, rev: 1, key: key() });

        assert.equal(wrong.status, 409, JSON.stringify(wrong.data));
        assert.match(JSON.stringify(wrong.data), /is proposed/);
        assert.equal((await stored(row)).state, "proposed");
    });

    test("POST board: a repeated POST with the same key changes nothing, and answers the rows with replay", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const body = { op: "edit", row, rev: 1, fields: { max: 4, until: "07:00" }, key: key() };
        const first = await call(`board/${String(source)}`, body);

        assert.equal(first.status, 200, JSON.stringify(first.data));
        assert.equal(first.data.replay, false);

        const again = await call(`board/${String(source)}`, body);

        assert.equal(again.status, 200, JSON.stringify(again.data));
        assert.equal(again.data.replay, true);
        assert.equal(again.data.text, first.data.text);
        assert.deepEqual(again.data.rows, first.data.rows);
        assert.equal((await stored(row)).rev, 2, "1 edit, not 2");
    });

    test("POST board: a POST replayed after 250 other calls answers replay and changes nothing; the receipt is in x.desk.board-receipts", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const other = await addRow(source, { title: "other row" });
        const path = `board/${String(source)}`;
        const body = { op: "drop", row, rev: 1, key: key() };
        const first = await call(path, body);

        assert.equal(first.status, 200, JSON.stringify(first.data));
        assert.equal(first.data.replay, false);

        for (let rev = 1; rev <= 250; rev += 1) {
            const edit = await call(path, {
                op: "edit",
                row: other,
                rev,
                fields: { title: `other ${String(rev)}` },
                key: key(),
            });

            assert.equal(edit.status, 200, JSON.stringify(edit.data));
        }

        const before = await stored(row);
        const again = await call(path, body);

        assert.equal(again.status, 200, JSON.stringify(again.data));
        assert.equal(again.data.replay, true);
        assert.equal(again.data.text, first.data.text);
        assert.deepEqual(await stored(row), before, "nothing changed");
        assert.equal((await stored(other)).rev, 251);

        const receipts =
            (await app.harness.snapshot(BoardReceipts, context))?.supervisors[String(source)]
                ?.receipts ?? [];

        assert(
            receipts.some((each) => each.key === `x.desk.board:page:${String(source)}:${body.key}`),
        );
        assert.equal(
            (await deskState()).board?.keys?.some((each) => each.key.endsWith(body.key)) ?? false,
            false,
            "no new key in board.keys",
        );
    });

    test("POST board: a key time 31 days old or 11 minutes ahead gets 409; a key in the old board.keys still replays", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const path = `board/${String(source)}`;

        for (const at of [Date.now() - 31 * 24 * 3600_000, Date.now() + 11 * 60_000]) {
            const refused = await call(path, { op: "drop", row, rev: 1, key: key(at) });

            assert.equal(refused.status, 409, JSON.stringify(refused.data));
            assert.match(
                JSON.stringify(refused.data),
                /This request is too old to replay: load the board again\./,
            );
        }

        assert.equal((await stored(row)).state, "proposed", "nothing changed");

        // A page key from before x.desk.board-receipts, in the old form, kept in board.keys: its replay still answers.
        const legacy = "board-drop-abc12345-legacy";

        await app.harness.commit(async (tx) => {
            const board = (await tx.doc(DeskThreads)).board!;

            board.keys = [
                ...(board.keys ?? []),
                {
                    key: `x.desk.board:page:${String(source)}:${legacy}`,
                    at: Date.now(),
                    text: "the legacy text",
                },
            ];
        }, context);

        const replayed = await call(path, { op: "drop", row, rev: 1, key: legacy });

        assert.equal(replayed.status, 200, JSON.stringify(replayed.data));
        assert.equal(replayed.data.replay, true);
        assert.equal(replayed.data.text, "the legacy text");
        assert.equal((await stored(row)).state, "proposed", "nothing changed");

        // The same old form with no stored key is refused: it cannot carry the page's time.
        const unknown = await call(path, {
            op: "drop",
            row,
            rev: 1,
            key: "board-drop-abc12345-new",
        });

        assert.equal(unknown.status, 409, JSON.stringify(unknown.data));
    });

    test("a guest gets 403 on GET board and on POST board/:conversation", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const row = await addRow(source);
        const guest = app.config.addUser("Board guest", "guest");
        const read = await call("board", undefined, guest.token);

        assert.equal(read.status, 403, JSON.stringify(read.data));
        assert.match(JSON.stringify(read.data), /Only the owner can use the goal board/);

        const act = await call(
            `board/${String(source)}`,
            { op: "drop", row, rev: 1, key: key() },
            guest.token,
        );

        assert.equal(act.status, 403, JSON.stringify(act.data));
        assert.match(JSON.stringify(act.data), /Only the owner can use the goal board/);
        assert.equal((await stored(row)).state, "proposed");
    });

    test("2 picked rows launched by the page route give 2 threads whose goals hold the rows' task, stop, max and for", async () => {
        const call = await routes();
        const source = await knownSupervisor();
        const path = `board/${String(source)}`;
        const ids = [
            await addRow(source, {
                agent: "teg",
                title: "page one",
                task: "PAGE-ONE fix the flaky test",
                stopWhen: "teg is done",
            }),
            await addRow(source, {
                agent: "lucilla",
                title: "page two",
                task: "PAGE-TWO update the docs",
                stopWhen: "lucilla is done",
            }),
        ];
        const pick = await call(path, {
            op: "pick",
            rows: ids.map((row) => ({ row, rev: 1 })),
            key: key(),
        });

        assert.equal(pick.status, 200, JSON.stringify(pick.data));

        const launch = await call(path, {
            op: "launch",
            rows: ids.map((row) => ({ row, rev: 1 })),
            key: key(),
        });

        assert.equal(launch.status, 200, JSON.stringify(launch.data));
        assert.equal(launch.data.pass.length, 2, JSON.stringify(launch.data.pass));

        const shown = launch.data.rows.filter((row: { id: number }) => ids.includes(row.id));

        assert.deepEqual(
            shown.map((row: { state: string }) => row.state),
            ["launched", "launched"],
        );

        for (const view of shown) {
            assert.match(view.thread, /^T\d+$/);
            assert.equal(typeof view.next, "string", "the thread's next actor");

            const row = await stored(view.id);
            const thread = (await deskState()).threads[row.thread ?? ""];

            assert(thread?.session !== undefined, "the thread has its session");

            const goal = (
                await app.harness.snapshot(
                    GoalDoc,
                    thread.session as unknown as ConversationId,
                    context,
                )
            )?.goal;

            assert.equal(goal?.objective, row.task);
            assert.equal(goal?.stop, row.stopWhen);
            assert.equal(goal?.maxRounds, row.max);
            assert(row.untilAt !== undefined);
            assert.equal(goal?.deadline, row.untilAt, "the deadline is untilAt exactly");
            assert.equal(thread.key, `x.desk.board:${String(row.id)}:1`);
        }
    });
});
