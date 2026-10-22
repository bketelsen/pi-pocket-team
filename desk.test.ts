// The desk's threads: the pure rules (open, bind, fail, seed, list, read), then a delegation that opens a thread, the
// `desk` tool in a supervisor session, and its refusal without one. Pi Pocket's helpers isolate all credentials,
// sessions, and model calls.
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
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    bindThread,
    DeskThreads,
    failThread,
    listText,
    openThread,
    parseSeed,
    readText,
    seedThreads,
    type DeskState,
    type SeedRow,
} from "./desk.ts";

// ─── The rules ───────────────────────────────────────────────────────────────

const empty = (): DeskState => ({ next: { T: 1, F: 1 }, threads: {}, grants: [], seen: {} });

const open = (state: DeskState, key: string, at = 1) =>
    openThread(state, {
        key,
        supervisor: 5,
        agents: ["duncan"],
        repo: "frostyard/test",
        cwd: "/work/test",
        title: "A task",
        at,
    });

/** A seed file with one row: T1, as the plan's example. */
const seedFile = (row: Record<string, unknown> = {}) =>
    JSON.stringify({
        threads: [
            {
                id: "T1",
                title: "frostmail fixes",
                agents: ["irulan"],
                repo: "frostyard/frostmail",
                prs: ["frostyard/frostmail#106"],
                session: "session-abc",
                asks: ["Keep the guard?"],
                mark: "keep",
                ...row,
            },
        ],
    });

const rows = (text = seedFile()): SeedRow[] => {
    const parsed = parseSeed(text);

    if ("error" in parsed) {
        throw new Error(parsed.error);
    }

    return parsed.threads;
};

const errorOf = (result: { error: string } | object): string => {
    assert("error" in result, "it is refused");

    return (result as { error: string }).error;
};

describe("threads", () => {
    test("the same key opens one thread, and a second open reuses it", () => {
        const state = empty();
        const first = open(state, "x.team.delegate:1:2");

        assert.equal(first.reused, false);
        assert.equal(first.thread.id, "T1");
        assert.equal(first.thread.state, "starting");

        const second = open(state, "x.team.delegate:1:2");

        assert.equal(second.reused, true);
        assert.equal(second.thread.id, "T1");
        assert.equal(Object.keys(state.threads).length, 1);
        assert.equal(first.thread.events[0]?.text, "opened by delegation");
    });

    test("thread ids go T1, T2", () => {
        const state = empty();

        assert.equal(open(state, "a").thread.id, "T1");
        assert.equal(open(state, "b").thread.id, "T2");
        assert.equal(state.next.T, 3);
    });

    test("bind opens a starting thread once", () => {
        const state = empty();

        open(state, "k");
        const bound = bindThread(state, "k", { session: 7, address: "session-abc", at: 2 });

        assert.equal(bound?.state, "open");
        assert.equal(bound?.session, 7);
        assert.equal(bound?.address, "session-abc");

        bindThread(state, "k", { session: 8, address: "session-other", at: 3 });

        assert.equal(state.threads.T1?.session, 7);
        assert.equal(state.threads.T1?.address, "session-abc");
        assert.equal(state.threads.T1?.events.filter((event) => event.key === "bound").length, 1);
        assert.equal(bindThread(state, "nobody", { session: 9, address: "s", at: 4 }), undefined);
    });

    test("fail closes a starting thread with the reason; an open thread stays open", () => {
        const state = empty();

        open(state, "k");
        const failed = failThread(state, "k", "no model was usable", 2);

        assert.equal(failed?.state, "closed");
        assert.deepEqual(failed?.closed, { at: 2, why: "failed", by: "desk" });
        assert.match(failed?.events.at(-1)?.text ?? "", /no model was usable/);

        open(state, "open");
        bindThread(state, "open", { session: 7, address: "session-abc", at: 3 });
        assert.equal(failThread(state, "open", "too late", 4), undefined);
        assert.equal(state.threads.T2?.state, "open");
    });

    test("the list hides closed threads and read gives the fields", () => {
        const state = empty();
        const seeded = seedThreads(state, rows(), { hash: "abc", supervisor: 9, at: 10 });

        assert.deepEqual(seeded, { added: ["T1"], reused: false });
        assert.equal(
            listText(state),
            "T1 · open · frostyard/frostmail · irulan · 1 PR · 1 ask · frostmail fixes",
        );

        const text = readText(state, "t1");

        assert(text);
        assert.match(text, /^T1 · open · frostmail fixes$/m);
        assert.match(text, /Session: not bound/);
        assert.match(text, /frostyard\/frostmail#106 · attached/);
        assert.match(text, /T1a · open · Keep the guard\?/);
        assert.match(text, /Events:/);
    });
});

describe("parseSeed", () => {
    test("accepts the example", () => {
        const parsed = parseSeed(seedFile());

        assert(!("error" in parsed));
        assert.deepEqual(parsed.threads[0], {
            id: "T1",
            title: "frostmail fixes",
            agents: ["irulan"],
            repo: "frostyard/frostmail",
            prs: ["frostyard/frostmail#106"],
            session: "session-abc",
            asks: ["Keep the guard?"],
            mark: "keep",
        });
    });

    test("cuts the title to one line of 120 characters", () => {
        const long = parseSeed(seedFile({ title: `  one\n${"x".repeat(200)}  ` }));

        assert(!("error" in long));
        assert.equal(long.threads[0]?.title.length, 120);
        assert(!long.threads[0]?.title.includes("\n"));
        assert(long.threads[0]?.title.startsWith("one x"));
    });

    test("refuses each bad row, naming the row and the field", () => {
        const cases: [string, Record<string, unknown>, RegExp][] = [
            ["a bad id", { id: "X1" }, /Row 1: "id"/],
            ["an empty title", { title: " " }, /Row T1: "title"/],
            ["no agents", { agents: [] }, /Row T1: "agents"/],
            ["agents that are not strings", { agents: [3] }, /Row T1: "agents"/],
            ["a bad repo", { repo: "frostmail" }, /Row T1: "repo"/],
            ["a bad PR ref", { prs: ["frostmail#1"] }, /Row T1: "prs"/],
            ["a session that is not a string", { session: 7 }, /Row T1: "session"/],
            ["an empty ask", { asks: [""] }, /Row T1: "asks"/],
            ["a bad mark", { mark: "close" }, /Row T1: "mark"/],
            ["an unknown field", { colour: "red" }, /Row T1: unknown field "colour"/],
        ];

        for (const [what, row, error] of cases) {
            assert.match(errorOf(parseSeed(seedFile(row))), error, what);
        }
    });

    test("refuses two rows with one id, and text that is not a seed file", () => {
        const twice = JSON.stringify({
            threads: [
                { id: "T1", title: "one", agents: ["duncan"], mark: "keep" },
                { id: "T1", title: "two", agents: ["duncan"], mark: "park" },
            ],
        });

        assert.match(errorOf(parseSeed(twice)), /Row T1: "id" is in the file twice/);
        assert.match(errorOf(parseSeed("nope")), /not valid JSON/);
        assert.match(errorOf(parseSeed(JSON.stringify({ rows: [] }))), /unknown field: "rows"/);
        assert.match(errorOf(parseSeed(JSON.stringify({ threads: "no" }))), /"threads" array/);
    });
});

describe("seedThreads", () => {
    test("the same file again is a replay: nothing changes", () => {
        const state = empty();

        assert.deepEqual(seedThreads(state, rows(), { hash: "abc", supervisor: 9, at: 10 }), {
            added: ["T1"],
            reused: false,
        });
        assert.deepEqual(seedThreads(state, rows(), { hash: "abc", supervisor: 9, at: 20 }), {
            added: [],
            reused: true,
        });
        assert.equal(Object.keys(state.threads).length, 1);
        assert.equal(state.threads.T1?.startedAt, 10);
    });

    test("another seed file is refused", () => {
        const state = empty();

        seedThreads(state, rows(), { hash: "abc", supervisor: 9, at: 10 });
        assert.equal(
            errorOf(seedThreads(state, rows(), { hash: "def", supervisor: 9, at: 20 })),
            "The desk is already seeded.",
        );
    });

    test("a taken id is refused with the id", () => {
        const state = empty();

        open(state, "k");
        assert.match(
            errorOf(seedThreads(state, rows(), { hash: "abc", supervisor: 9, at: 10 })),
            /These thread ids are taken: T1\./,
        );
    });

    test("the counter moves past the highest seeded id, park rows park, and asks get letters", () => {
        const state = empty();
        const text = JSON.stringify({
            threads: [
                { id: "T3", title: "three", agents: ["duncan"], mark: "keep" },
                {
                    id: "T7",
                    title: "seven",
                    agents: ["duncan", "irulan"],
                    mark: "park",
                    asks: ["first", "second"],
                },
            ],
        });

        seedThreads(state, rows(text), { hash: "abc", supervisor: 9, at: 10 });

        assert.equal(state.next.T, 8);
        assert.equal(state.threads.T3?.state, "open");
        assert.equal(state.threads.T3?.keptAt, 10);
        assert.equal(state.threads.T7?.state, "parked");
        assert.equal(state.threads.T7?.keptAt, undefined);
        assert.deepEqual(
            state.threads.T7?.asks.map((ask) => [ask.id, ask.text]),
            [
                ["T7a", "first"],
                ["T7b", "second"],
            ],
        );
        assert.equal(open(state, "later").thread.id, "T8");
    });
});

// ─── In a Pi Pocket ──────────────────────────────────────────────────────────

const TASK = "Tend the test repository";
/** The seed file the scripted model hands to the tool. */
let seedPath = "";
let app: App;

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Pi, scripted: the supervisor delegates, and the desk is used by the words of each test. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    const read = /desk read (T[0-9]+) test$/.exec(text);

    if (read) {
        return call("desk", { action: "read", thread: read[1] });
    }

    if (text.endsWith("desk list test")) {
        return call("desk", { action: "list" });
    }

    if (text.endsWith("desk seed test")) {
        return call("desk", { action: "seed", path: seedPath });
    }

    if (text.endsWith("desk failed delegate test")) {
        return call("team_delegate", {
            agent: "paul",
            repository: "frostyard/missing",
            task: TASK,
        });
    }

    if (text.endsWith("desk delegate test")) {
        return call("team_delegate", { agent: "duncan", repository: "frostyard/test", task: TASK });
    }

    return answer(`echo: ${text.slice(0, 40)}`);
});

const dataDir = join(root, "data");
const definitions = join(root, "agents");
const repo = join(root, "repo");

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;
    mkdirSync(definitions, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
    );
    writeFileSync(
        join(definitions, "duncan.md"),
        `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/test: ${repo}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repository.`,
    );
    writeFileSync(
        join(definitions, "paul.md"),
        `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/missing: ${join(root, "missing")}\n---\n# Paul Atreides\nYou are Paul Atreides. Own a folder that is not there.`,
    );

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    cpSync(join(import.meta.dirname, "desk.ts"), join(dropIns, "desk.ts"));
    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Run one of a module's commands in a session, as the owner. */
function command(
    id: ConversationId,
    name: string,
    args: string,
): ReturnType<typeof app.extensionCommands.run> {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, owner(app), {
        commandId,
        args,
        requestId: crypto.randomUUID(),
    });
}

/** A new session that carries Odrade's identity. */
async function supervisor(name: string): Promise<ConversationId> {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });
    const id = await newSession(app, folder);

    await command(id, "team-agent", "odrade");

    return id;
}

const deskState = () => app.harness.snapshot(DeskThreads, context);

describe("the desk in a Pi Pocket", () => {
    test("a delegation opens and binds a thread, and the desk lists it", async () => {
        const source = await supervisor("source");

        await say(app, source, "desk delegate test");

        const thread = (await deskState())?.threads.T1;

        assert(thread, "the delegation opened T1");
        assert.equal(thread.state, "open");
        assert.equal(thread.origin, "delegate");
        assert.equal(thread.repo, "frostyard/test");
        assert.deepEqual(thread.agents, ["duncan"]);
        assert.equal(thread.supervisor, Number(source));
        assert.equal(typeof thread.session, "number");
        assert.match(thread.address ?? "", /^session-/);
        assert(app.sessions().some((session) => session.linkedFrom?.id === Number(source)));

        const texts = (await modelTexts(app, source)).join("\n");

        assert.match(texts, /Thread T1\./);
        assert.match(texts, /Assigned to Duncan Idaho at session-/);

        await say(app, source, "desk list test");
        assert.match(
            (await modelTexts(app, source)).join("\n"),
            /T1 · open · frostyard\/test · duncan · Tend the test repository/,
        );
    });

    test("read gives one thread in full", async () => {
        const source = await supervisor("reader");

        await say(app, source, "desk delegate test");
        const state = await deskState();
        const newest = Object.values(state?.threads ?? {})
            .filter((thread) => thread.supervisor === Number(source))
            .at(-1);

        assert(newest);
        await say(app, source, `desk read ${newest.id} test`);
        const texts = (await modelTexts(app, source)).join("\n");

        assert.match(texts, new RegExp(`${newest.id} · open · Tend the test repository`));
        assert.match(texts, /Agents: duncan/);
        assert.match(texts, /Session: [0-9]+/);
        assert.match(texts, /Events:/);
    });

    test("a session without a supervisor identity is refused", async () => {
        const folder = join(root, "plain");

        mkdirSync(folder, { recursive: true });
        const plain = await newSession(app, folder);

        await say(app, plain, "desk list test");
        assert.match(
            (await modelTexts(app, plain)).join("\n"),
            /Only a session assigned a supervisor identity can use the desk\./,
        );
    });

    test("a linked session that does not start closes its thread as failed", async () => {
        const source = await supervisor("failed");
        const before = app.sessions().length;

        await say(app, source, "desk failed delegate test");
        assert.match(
            (await modelTexts(app, source)).join("\n"),
            /Do not delegate on another model/,
        );
        assert.equal(app.sessions().length, before, "no linked session started");

        const failed = Object.values((await deskState())?.threads ?? {}).find((thread) =>
            thread.agents.includes("paul"),
        );

        assert(failed, "the thread was opened before the start");
        assert.equal(failed.state, "closed");
        assert.deepEqual(failed.closed && { why: failed.closed.why, by: failed.closed.by }, {
            why: "failed",
            by: "desk",
        });
        assert.match(failed.events.at(-1)?.text ?? "", /failed: /);
    });

    test("seed refuses an unknown agent, then imports once and replays", async () => {
        const source = await supervisor("seeder");

        seedPath = join(root, "seed.json");
        writeFileSync(
            seedPath,
            JSON.stringify({
                threads: [{ id: "T20", title: "seeded work", agents: ["nobody"], mark: "keep" }],
            }),
        );
        await say(app, source, "desk seed test");
        assert.match((await modelTexts(app, source)).join("\n"), /Unknown agent ids: T20: nobody/);
        assert.equal((await deskState())?.threads.T20, undefined);

        writeFileSync(seedPath, seedFile({ id: "T20", title: "seeded work", agents: ["duncan"] }));
        await say(app, source, "desk seed test");
        assert.match((await modelTexts(app, source)).join("\n"), /Seeded T20\./);

        const thread = (await deskState())?.threads.T20;

        assert.equal(thread?.origin, "seed");
        assert.equal(thread?.state, "open");
        assert.deepEqual(Object.keys(thread.prs), ["frostyard/frostmail#106"]);
        assert.equal(thread.prs["frostyard/frostmail#106"]?.via, "attached");
        assert.equal(thread.asks[0]?.id, "T20a");

        await say(app, source, "desk seed test");
        assert.match(
            (await modelTexts(app, source)).join("\n"),
            /This seed is in the desk already: nothing changed\./,
        );
        assert.equal(
            Object.values((await deskState())?.threads ?? {}).filter(
                (each) => each.origin === "seed",
            ).length,
            1,
        );
    });
});
