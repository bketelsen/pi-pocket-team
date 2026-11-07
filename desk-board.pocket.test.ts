// The goal board in Pi Pocket, with the real Team, desk and shift modules and a scripted model: Team's `startShift`
// (its frozen result, a replay, the refusals, a thrown start, and the board's limit on the desk's open), then rows
// launched with `desk board_launch` from a supervisor's session, whose threads carry shift goals with the rows' task,
// stop condition, rounds and length. No test reaches Brian's data or the network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import { boardRows } from "./_desk-board.ts";
import { capView, DeskReports, DeskThreads, type DeskState } from "./desk.ts";
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

/** Team's start as the desk calls it, on this app's harness. */
const startShift = (patch: Partial<TeamStartShiftRequest> & { supervisor: number; key: string }) =>
    team().startShift!({
        read: app.harness,
        commit: <T>(change: (tx: Tx) => T | Promise<T>) => app.harness.commit(change, context),
        context,
        agent: "teg",
        title: "Board start",
        task: "BOARD-TASK tend the tests",
        shift: { stop_when: "the tests pass", max: 2, for: "90m" },
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

after(async () => {
    await app?.close();
    cleanUp();
});

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
            shift: { stop_when: "x", max: 2, for: "90m", worker: "faux/faux-1" },
        });

        assert.deepEqual(worker, {
            error: "faux/faux-1 is not in the owner's allowed list for subagents. Allowed: faux/faux-2.",
            unknown: false,
        });

        const check = await startShift({
            supervisor: Number(source),
            key: "x.desk.board:902:1",
            shift: { stop_when: "x", max: 2, for: "90m", pr_check: { label: "bad;label" } },
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
        const until = untilSoon();

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
                    until,
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
            // `for` is untilAt minus the launch time, in whole minutes: the deadline is within 1 minute of untilAt.
            assert(goal?.deadline !== undefined && row.untilAt !== undefined);
            assert(
                Math.abs(goal.deadline - row.untilAt) <= 60_000,
                `${String(goal.deadline)} ${String(row.untilAt)}`,
            );
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
