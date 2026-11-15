// A private agent (`private: true` in the profile) is Brian's own: his session with it is linked to no other session,
// nobody delegates to it, and its session sends nothing to another session or the desk. Every other agent keeps the team
// behavior. Pi Pocket's helpers isolate all credentials, sessions, and model calls.
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
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "./_pocket/src/server/http.ts";
import createTeam, { Identity, privateToolBlock, roster } from "./team.ts";

/**
 * Pi Pocket 0.28.0 adds `host.sessions`, which starts an ordinary session: an older release has none, and the Team panel
 * refuses a private agent's start with the way that works there. The tests of that start skip on the old release.
 */
const pocketVersion = (): string =>
    (
        JSON.parse(readFileSync(join(import.meta.dirname, "_pocket", "package.json"), "utf8")) as {
            version: string;
        }
    ).version;
const startsPlainSessions = Number(pocketVersion().split(".")[1] ?? "0") >= 28;

test("roster: private is true, false, or absent, and another value makes the profile invalid", async () => {
    const folder = join(root, "private-agents");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "chani.md"), "---\nprivate: true\n---\n# Chani\n");
    writeFileSync(join(folder, "duncan.md"), "---\nprivate: false\n---\n# Duncan Idaho\n");
    writeFileSync(join(folder, "moneo.md"), "---\nmodel: faux/faux-2\n---\n# Moneo\n");
    const of = async (id: string) =>
        (await roster(folder)).find((each) => each.id === id) ?? assert.fail(id);

    // `true`: a private agent. `false`, or absent: the agent keeps the team behavior, and the field is not set.
    assert.equal((await of("chani")).private, true);
    assert.equal((await of("duncan")).private, undefined);
    assert.equal((await of("moneo")).private, undefined);

    // Another value: the profile is invalid, so the roster read fails and names the file.
    for (const bad of [
        "private: 1",
        'private: "true"',
        "private:",
        "private: []",
        "private: nope",
    ]) {
        writeFileSync(join(folder, "bad.md"), `---\n${bad}\n---\n# Bad\n`);
        await assert.rejects(
            roster(folder),
            /bad\.md: private must be true or false, or absent\./,
            bad,
        );
    }

    rmSync(join(folder, "bad.md"), { force: true });
    assert.equal((await roster(folder)).length, 3);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const definitions = join(root, "agents");
const repo = join(root, "notes-repo");
const chaniHome = join(root, "chani-home");
/** The desk's config file and fake `gh`, in the test folder: no test reads Brian's desk data or calls GitHub. */
const deskConfig = join(root, "desk.json");
const fakeGh = join(root, "fake-gh.sh");
/** Each model request's context, as text: the prompt a session's turns carry. */
const prompts: string[] = [];

const model = scriptedModel((ctx) => {
    const { text } = lastText(ctx as never);

    prompts.push(JSON.stringify(ctx));

    // The 2 markers that end with a marker of another tool go first: "… tool test" and "… test" both fit the others.
    if (text.endsWith("delegate tool test")) {
        return fauxAssistantMessage(
            [fauxToolCall("team_delegate", { agent: "duncan", task: "x" })],
            {
                stopReason: "toolUse",
            },
        );
    }

    if (text.endsWith("desk tool test")) {
        return fauxAssistantMessage([fauxToolCall("desk", { action: "list" })], {
            stopReason: "toolUse",
        });
    }

    if (text.endsWith("delegate to chani test")) {
        return fauxAssistantMessage(
            [fauxToolCall("team_delegate", { agent: "chani", task: "Sort my notes." })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("work test")) {
        return fauxAssistantMessage(
            [fauxToolCall("team_work", { repository: "frostyard/notes", task: "Sort my notes." })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("message test")) {
        return fauxAssistantMessage(
            [fauxToolCall("team_message", { to: "session-someone", message: "Hello." })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("team tool test")) {
        return fauxAssistantMessage([fauxToolCall("team", { action: "list" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

/** The newer prompt that holds `marker`: the request a session's own turns carry. */
const promptWith = (marker: string): string => {
    const found = prompts.filter((each) => each.includes(marker)).at(-1);

    assert(found !== undefined, `a prompt holds ${marker}`);

    return found;
};

/** How many private-agent blocks a session's transcript holds. */
const blocks = async (id: ConversationId): Promise<number> =>
    (await modelTexts(app, id)).join("\n").split("is a private agent: it sends nothing").length - 1;

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions);
mkdirSync(repo);
mkdirSync(chaniHome);
writeFileSync(
    join(definitions, "odrade.md"),
    "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate Brian's team.",
);
writeFileSync(
    join(definitions, "duncan.md"),
    `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/notes: ${repo}\n---\n# Duncan Idaho\nYou are Duncan Idaho.`,
);
// The private agent: a personal agent, with its own home and no place on the team.
writeFileSync(
    join(definitions, "chani.md"),
    `---\nmodel: faux/faux-2\nprivate: true\nhome: ${chaniHome}\nrepositories:\n  frostyard/notes: ${repo}\n---\n# Chani\nYou are Chani. Keep Brian's notes.`,
);

let app: App;
let server: Server | undefined;
let base = "";
let source: ConversationId;

before(async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });

    for (const file of [
        "team.ts",
        "desk.ts",
        "_desk-usage.ts",
        "_desk-dashboard.ts",
        "_desk-metrics.ts",
        "_desk-board.ts",
        "_desk-meter.ts",
    ]) {
        cpSync(join(import.meta.dirname, file), join(dropIns, file));
    }

    for (const folder of ["team-web", "desk-web"]) {
        cpSync(join(import.meta.dirname, folder), join(dropIns, folder), { recursive: true });
    }

    // The desk stays in the test folder: its config file, and a fake `gh` that reads no GitHub.
    writeFileSync(deskConfig, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
    writeFileSync(fakeGh, '#!/bin/sh\nprintf %s \'{"data":{"viewer":{"login":"test-viewer"}}}\'\n');
    chmodSync(fakeGh, 0o755);
    process.env.PI_POCKET_DESK_CONFIG = deskConfig;
    process.env.PI_POCKET_DESK_GH = fakeGh;
    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    // Pi Pocket's own linked-session tool, so the guard is checked on the real tool.
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    // The desk's tool too: a private agent's session must not call it either.
    await app.setExtensionEnabled(owner(app), "desk.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;
    source = await newSession(app);

    // The session that starts work carries the supervisor's identity, and a run: a start acts for the person who last
    // asked there.
    assert.equal((await call(`session/${source}/identity`, { agent: "odrade" })).status, 200);
    await say(app, source, "Hello");
});

async function call(path: string, body?: object) {
    const res = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return { status: res.status, data: await res.json() };
}

test(
    "a private agent's start makes a plain session in its home: no link, the person's words only, and 1 session for a key",
    { skip: !startsPlainSessions && "Pi Pocket before 0.28.0 has no host.sessions" },
    async () => {
        const sessions = app.sessions().length;
        const request = {
            agent: "chani",
            message: "Sort my notes.\nThen rest.",
            key: "private-start-0001",
        };
        const started = await call(`session/${source}/start`, request);

        assert.equal(started.status, 200, JSON.stringify(started.data));
        const child = started.data.session as ConversationId;

        assert.equal("address" in started.data, false, "no return address: nothing links to it");
        assert.equal(app.cwdOf(child), chaniHome, "the session opens in the agent's home");
        assert.equal(app.sessions().length, sessions + 1);
        // The session is no linked session: it is Brian's own, at the top.
        assert.equal(
            app.sessions().find((each) => Number(each.id) === Number(child))?.linkedFrom,
            undefined,
        );
        const linked = (await call(`session/${source}`)).data.linked as {
            conversationId: string;
        }[];

        assert.equal(
            linked.some((each) => Number(each.conversationId) === Number(child)),
            false,
            "the source session has no linked session",
        );

        await until(() => !app.isBusy(child), "the private session settled");
        const texts = (await modelTexts(app, child)).join("\n");

        assert.match(texts, /Sort my notes\./);
        assert.doesNotMatch(texts, /Named identity/, "the first message has no identity preface");
        // The identity is kept for later turns, and the prompt is the private one: no report to anyone.
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "chani");
        const here = promptWith("Sort my notes.");

        assert.match(here, /You work for Brian directly, in sessions he starts\./);
        assert.doesNotMatch(here, /return address/);
        assert.doesNotMatch(here, /report the result once with team_message/);

        // A repeat of the same key returns the same session, and sends no second message.
        const again = await call(`session/${source}/start`, request);

        assert.equal(again.data.session, child);
        assert.equal(app.sessions().length, sessions + 1);
    },
);

test(
    "a private agent's start refuses a source session where nobody wrote yet, and starts nothing",
    { skip: !startsPlainSessions && "Pi Pocket before 0.28.0 has no host.sessions" },
    async () => {
        // A plain session acts for the person who wrote last there: with no such person, the start has no one to act
        // for, and it must say so before it starts anything.
        const fresh = await newSession(app);
        const sessions = app.sessions().length;
        const started = await call(`session/${fresh}/start`, {
            agent: "chani",
            message: "Sort my notes.",
            key: "private-no-person-0001",
        });

        assert.equal(started.status, 409, JSON.stringify(started.data));
        assert.match(
            String(started.data.error),
            /Chani's session starts for the person who wrote last in this session, and nobody wrote here yet: send a message here first, or start Chani with New session in .*\./,
        );
        assert.equal(app.sessions().length, sessions, "no session started");
    },
);

test(
    "a private agent's start refuses a source session where another person wrote last, and starts nothing",
    { skip: !startsPlainSessions && "Pi Pocket before 0.28.0 has no host.sessions" },
    async () => {
        const guest = app.config.addUser("Guest", "guest").user;
        const theirs = await newSession(app);
        const submitted = await app.commands.submit(theirs, guest, {
            text: "Please sort the notes.",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submitted.submissionId, context))!.wait(context);

        const sessions = app.sessions().length;
        // The owner asks, but the guest wrote last: the session would start in the guest's name.
        const started = await call(`session/${theirs}/start`, {
            agent: "chani",
            message: "Sort my notes.",
            key: "private-other-person-0001",
        });

        assert.equal(started.status, 409, JSON.stringify(started.data));
        assert.match(
            String(started.data.error),
            /Another person wrote last in this session, so Chani's session would start in their name: start Chani with New session in .*\./,
        );
        assert.equal(app.sessions().length, sessions, "no session started");
    },
);

test("a guard whose identity read fails blocks nothing, and a private identity blocks", async () => {
    const failed = {
        snapshot: async () => {
            throw new Error("the read failed");
        },
    };

    // A read that fails answers undefined: it never stops another agent's report or desk call.
    assert.equal(
        await privateToolBlock("team_message", failed, 7 as ConversationId, context, definitions),
        undefined,
    );
    assert.equal(
        await privateToolBlock("desk", failed, 7 as ConversationId, context, definitions),
        undefined,
    );
    // A tool this guard does not hold is never read for.
    assert.equal(
        await privateToolBlock("bash", failed, 7 as ConversationId, context, definitions),
        undefined,
    );

    const chani = {
        snapshot: async () => ({ persona: { id: "chani", name: "Chani", role: "agent" } }),
    };

    assert.equal(
        await privateToolBlock("team_message", chani, 7 as ConversationId, context, definitions),
        "Chani is a private agent: it sends nothing to other sessions or the desk.",
    );
});

test("another agent's start is still a linked task, with the return address in its first message", async () => {
    const sessions = app.sessions().length;
    const started = await call(`session/${source}/start`, {
        agent: "duncan",
        repository: "frostyard/notes",
        message: "Say hello",
        key: "linked-start-0001",
    });

    assert.equal(started.status, 200, JSON.stringify(started.data));

    const child = started.data.session as ConversationId;

    assert.equal(typeof started.data.address, "string", "a linked start gives its address");
    assert.equal(app.sessions().length, sessions + 1);
    await until(() => !app.isBusy(child), "the linked task settled");

    const linked = (await call(`session/${source}`)).data.linked as { conversationId: string }[];

    assert.equal(
        linked.some((each) => Number(each.conversationId) === Number(child)),
        true,
        "the source session lists it",
    );
    assert.equal(app.cwdOf(child), repo);
    // The linked task still tells the agent where to report.
    assert.match(promptWith("Say hello"), /return address/);
    assert.doesNotMatch(promptWith("Say hello"), /You work for Brian directly/);
});

test("team_delegate to a private agent is refused, and starts nothing", async () => {
    const sessions = app.sessions().length;

    await say(app, source, "delegate to chani test");
    assert.match(
        (await modelTexts(app, source)).join("\n"),
        /Chani is a private agent: Brian talks to Chani directly, in a session in .*Nobody delegates to Chani\./,
    );
    assert.equal(app.sessions().length, sessions, "no session started");
});

test(
    "in a private agent's session the tools that reach another session or the desk are blocked",
    {
        skip: !startsPlainSessions && "Pi Pocket before 0.28.0 has no host.sessions",
    },
    async () => {
        // A session of Chani's own: the start of the panel, which every Pocket since 0.28.0 makes.
        const started = await call(`session/${source}/start`, {
            agent: "chani",
            message: "Hello.",
            key: "private-guard-0001",
        });

        assert.equal(started.status, 200, JSON.stringify(started.data));
        const child = started.data.session as ConversationId;

        await until(() => !app.isBusy(child), "the private session settled");

        // Each call's own refusal: the count goes up at each step, so a later step cannot pass on an earlier block.
        for (const words of [
            "work test",
            "message test",
            "team tool test",
            "delegate tool test",
            "desk tool test",
        ]) {
            const before = await blocks(child);

            await say(app, child, words);
            const after = await blocks(child);

            assert(after > before, `${words} is blocked: ${String(before)} → ${String(after)}`);
        }

        // A normal agent's session is not held by this guard: the same calls add no block.
        const normal = await newSession(app, repo);

        assert.equal((await call(`session/${normal}/identity`, { agent: "duncan" })).status, 200);

        for (const words of [
            "work test",
            "message test",
            "team tool test",
            "delegate tool test",
            "desk tool test",
        ]) {
            const before = await blocks(normal);

            await say(app, normal, words);
            assert.equal(await blocks(normal), before, `another agent's ${words} is not blocked`);
        }
    },
);

test("team_work in a private agent's session is refused, and starts nothing", async () => {
    // The tool itself, with no hook in the way: the panel and the guard are tested above. A stub host keeps this to the
    // refusal, and the live Team module of the other tests is put back afterwards.
    const shared = globalThis as unknown as Record<symbol, unknown>;
    const saved = shared[Symbol.for("pi-pocket-team.team")];
    const starts: string[] = [];
    const stubWeb = {
        conversationRoute() {},
        route() {},
        client() {},
        command() {},
        send() {},
        onDispose() {},
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    const stubHost = {
        requesterOf: () => owner(app).id,
        subagentModels: () => ["faux/faux-2"],
        text: { defang: (value: string) => value, quoted: () => "" },
        notice() {},
        linkedSessions: {
            start: async () => {
                starts.push("start");

                return { session: 1, address: "session-refused" };
            },
            list: async () => [],
            send: async () => {},
        },
    };
    const extension = createTeam(stubHost as never, stubWeb as never) as unknown as {
        tools: {
            name: string;
            execute: (args: object, api: object, context: unknown) => Promise<unknown>;
        }[];
    };

    try {
        const session = await newSession(app, chaniHome);

        assert.equal((await call(`session/${session}/identity`, { agent: "chani" })).status, 200);

        const work = extension.tools.find((each) => each.name === "team_work")!;

        await assert.rejects(
            work.execute(
                { repository: "frostyard/notes", task: "Sort my notes." },
                {
                    conversationId: session,
                    taskId: "task-private",
                    callId: "call-1",
                    snapshot: (...args: unknown[]) =>
                        Reflect.apply(app.harness.snapshot, app.harness, args),
                    commit: (change: never, ctx: never) => app.harness.commit(change, ctx),
                },
                context,
            ),
            /Chani is a private agent: Brian talks to Chani directly, in a session in .*Nobody delegates to Chani\./,
        );
        assert.equal(starts.length, 0, "nothing started");
    } finally {
        if (saved === undefined) {
            delete shared[Symbol.for("pi-pocket-team.team")];
        } else {
            shared[Symbol.for("pi-pocket-team.team")] = saved;
        }
    }
});
