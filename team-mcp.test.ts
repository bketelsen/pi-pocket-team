// Per-agent MCP servers (docs/modules/team.md, "MCP servers"): the walk from a session to its agent, the block rules of
// the 3 tools of the `mcp` module, and the team's prompt line. The first part reads fixture documents; the second runs
// the hook in Pi Pocket, with a fake `mcp` module, a subagent, a linked session and a codemode script. Pi Pocket's
// helpers isolate all credentials, sessions, and model calls.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    Identity,
    MCP_PARENT_READS,
    MCP_TOOLS,
    MCP_WALK_STEPS,
    mcpBlock,
    type McpParents,
    mcpScope,
    type McpScope,
    mcpText,
    roster,
} from "./team.ts";

const definitions = join(root, "agents");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions, { recursive: true });

/** Each profile file gets its own time: the roster cache keys on file times, and 2 writes can fall in 1 millisecond. */
let clock = Date.now() / 1000;

function profile(id: string, text: string): void {
    const file = join(definitions, `${id}.md`);

    writeFileSync(file, text);
    clock += 10;
    utimesSync(file, clock, clock);
}

profile("odrade", "---\nrole: supervisor\n---\n# Odrade\nCoordinate the team.");
profile("moneo", "---\nmcp: [truenas]\n---\n# Moneo\nOwn the NAS.");
profile("duncan", "---\nmodel: faux/faux-2\n---\n# Duncan Idaho\nOwn the suite.");
profile("chani", "---\nmcp: [frostnotes, frostmail]\n---\n# Chani\nBrian's personal life.");

// ─── The walk, on fixture documents ──────────────────────────────────────────

type Persona = Awaited<ReturnType<typeof roster>>[number];

/** The documents the walk reads, by conversation: an Identity, a folder, the session list, subagent records. */
type Fixture = {
    identity?: Record<number, { persona?: Persona; cleared?: true }>;
    cwd?: Record<number, string>;
    sessions?: Record<string, unknown>;
    subagents?: Record<number, Record<string, { conversationId: number }>>;
    fail?: Set<string>;
};

/** A reader over a fixture, which counts each read of a kind. */
function reader(fixture: Fixture) {
    const reads = new Map<string, number>();
    const read = {
        snapshot: async (token: { definition: { kind: string } }, ...rest: unknown[]) => {
            const kind = token.definition.kind;

            reads.set(kind, (reads.get(kind) ?? 0) + 1);

            if (fixture.fail?.has(kind) === true) {
                throw new Error(`read of ${kind} failed`);
            }

            const id = Number(rest[0]);

            switch (kind) {
                case "x.team.identity":
                    return fixture.identity?.[id];
                case "pi.agent":
                    return fixture.cwd?.[id] === undefined ? undefined : { cwd: fixture.cwd[id] };
                case "pocket.sessions":
                    return { items: fixture.sessions ?? {} };
                case "pocket.subagents":
                    return fixture.subagents?.[id] === undefined
                        ? undefined
                        : { agents: fixture.subagents[id], reporters: {} };
                default:
                    throw new Error(`unexpected read of ${kind}`);
            }
        },
    };

    return { read: read as never, reads };
}

const persona = async (id: string): Promise<Persona> =>
    (await roster(definitions)).find((each) => each.id === id) ?? assert.fail(id);

/** A stored persona copy, as an Identity doc keeps it: it may be old. */
const stored = (id: string, extra: Partial<Persona> = {}): Persona => ({
    id,
    name: id,
    role: "agent",
    model: "",
    instructions: "",
    repositories: {},
    ...extra,
});

const scopeOf = (fixture: Fixture, id: number, parents?: McpParents, directory = definitions) =>
    mcpScope(reader(fixture).read, id as ConversationId, context, directory, parents);

const session = (linkedFrom?: unknown) =>
    linkedFrom === undefined ? { cwd: work } : { cwd: work, linkedFrom };

/** The block of each of the 3 tools with `server`, and of mcp_tools with no server, in a scope. */
const blocks = (scope: McpScope, server: string) => ({
    tools: mcpBlock("mcp_tools", { server }, scope),
    call: mcpBlock("mcp_call", { server, tool: "x" }, scope),
    readOnly: mcpBlock("mcp_call_read_only", { server, tool: "x" }, scope),
    list: mcpBlock("mcp_tools", {}, scope),
});

describe("the MCP scope of a session", () => {
    test("the 3 tool names and the limits stay", () => {
        assert.deepEqual(MCP_TOOLS, ["mcp_tools", "mcp_call", "mcp_call_read_only"]);
        assert.equal(MCP_WALK_STEPS, 20);
        assert.equal(MCP_PARENT_READS, 5000);
    });

    test("Moneo, a subagent of Moneo and a linked session of Moneo get truenas only", async () => {
        const fixture: Fixture = {
            identity: { 10: { persona: await persona("moneo") } },
            sessions: { 10: session(), 12: session({ id: 10 }) },
            subagents: { 10: { helper: { conversationId: 11 } } },
        };

        for (const id of [10, 11, 12]) {
            const scope = await scopeOf(fixture, id);

            assert.deepEqual(scope, {
                kind: "agent",
                id: "moneo",
                name: "Moneo",
                servers: ["truenas"],
            });
            assert.deepEqual(blocks(scope, "truenas"), {
                tools: undefined,
                call: undefined,
                readOnly: undefined,
                list: "Moneo (moneo) may use only the MCP servers: truenas. Give server: one of truenas.",
            });

            const other = blocks(scope, "frostnotes");

            assert.match(
                other.call ?? "",
                /Moneo \(moneo\) may use only the MCP servers: truenas\. The server "frostnotes" is blocked/,
            );
            assert.match(other.readOnly ?? "", /"frostnotes" is blocked/);
            assert.match(other.tools ?? "", /"frostnotes" is blocked/);
        }
    });

    test("a subagent of Duncan gets no server: each of the 3 tools is blocked", async () => {
        const fixture: Fixture = {
            identity: { 20: { persona: await persona("duncan") } },
            sessions: { 20: session() },
            subagents: { 20: { helper: { conversationId: 21 } } },
        };
        const scope = await scopeOf(fixture, 21);

        assert.deepEqual(scope, { kind: "agent", id: "duncan", name: "Duncan Idaho", servers: [] });

        for (const text of Object.values(blocks(scope, "truenas"))) {
            assert.match(
                text ?? "",
                /^No MCP server is given to Duncan Idaho \(duncan\): mcp_\w+ is blocked/,
            );
        }
    });

    test("Chani gets frostnotes and frostmail, and not truenas", async () => {
        const fixture: Fixture = {
            identity: { 30: { persona: await persona("chani") } },
            sessions: { 30: session() },
        };
        const scope = await scopeOf(fixture, 30);

        assert.equal(blocks(scope, "frostnotes").call, undefined);
        assert.equal(blocks(scope, "frostmail").readOnly, undefined);
        assert.match(
            blocks(scope, "truenas").call ?? "",
            /may use only the MCP servers: frostnotes, frostmail\. The server "truenas" is blocked/,
        );
    });

    test("a plain session is Brian's own: every server, and every mcp_ tool", async () => {
        const scope = await scopeOf({ sessions: { 40: session() } }, 40);

        assert.deepEqual(scope, { kind: "root" });
        assert.deepEqual(blocks(scope, "frostnotes"), {
            tools: undefined,
            call: undefined,
            readOnly: undefined,
            list: undefined,
        });
        assert.equal(mcpBlock("mcp_other", {}, scope), undefined);
        // A subagent of Brian's session, and a linked session it started: his too.
        const tree: Fixture = {
            sessions: { 40: session(), 42: session({ id: 40 }) },
            subagents: { 40: { helper: { conversationId: 41 } } },
        };

        assert.deepEqual(await scopeOf(tree, 41), { kind: "root" });
        assert.deepEqual(await scopeOf(tree, 42), { kind: "root" });
    });

    test("a cleared identity is no agent: the folder's agent does not come back, and the walk goes on", async () => {
        const fixture: Fixture = {
            identity: { 45: { cleared: true } },
            sessions: { 45: session() },
        };

        assert.deepEqual(await scopeOf(fixture, 45), { kind: "root" });
    });

    test("an unknown mcp_ tool is blocked for a named agent, also one that has servers", async () => {
        const moneo: McpScope = { kind: "agent", id: "moneo", name: "Moneo", servers: ["truenas"] };

        assert.match(
            mcpBlock("mcp_other", { server: "truenas" }, moneo) ?? "",
            /may use MCP only through mcp_tools, mcp_call and mcp_call_read_only, with the servers: truenas\. mcp_other is blocked/,
        );
        // Not an MCP tool: never the hook's business.
        assert.equal(mcpBlock("bash", { server: "frostnotes" }, moneo), undefined);
        assert.equal(mcpBlock("read", {}, { kind: "blocked", reason: "x" }), undefined);
    });

    test("the walk reads mcp from the current roster by id, never from the Identity doc's copy", async () => {
        // An old copy that says more than the profile does now.
        const fixture: Fixture = {
            identity: { 50: { persona: stored("moneo", { mcp: ["truenas", "frostnotes"] }) } },
            sessions: { 50: session() },
        };
        const scope = await scopeOf(fixture, 50);

        assert.deepEqual(scope, {
            kind: "agent",
            id: "moneo",
            name: "Moneo",
            servers: ["truenas"],
        });
        assert.match(blocks(scope, "frostnotes").call ?? "", /is blocked/);
        // A copy from before the field: the roster still gives the list.
        assert.deepEqual(
            await scopeOf({ ...fixture, identity: { 50: { persona: stored("moneo") } } }, 50),
            scope,
        );
    });

    test("a server granted or revoked in the profile reaches a running session at its next call", async () => {
        const fixture: Fixture = {
            identity: { 55: { persona: await persona("duncan") } },
            sessions: { 55: session() },
        };

        try {
            assert.match(blocks(await scopeOf(fixture, 55), "truenas").call ?? "", /No MCP server/);
            profile(
                "duncan",
                "---\nmodel: faux/faux-2\nmcp: [truenas]\n---\n# Duncan Idaho\nOwn the suite.",
            );
            assert.equal(blocks(await scopeOf(fixture, 55), "truenas").call, undefined);
            profile("duncan", "---\nmodel: faux/faux-2\n---\n# Duncan Idaho\nOwn the suite.");
            assert.match(blocks(await scopeOf(fixture, 55), "truenas").call ?? "", /No MCP server/);
        } finally {
            profile("duncan", "---\nmodel: faux/faux-2\n---\n# Duncan Idaho\nOwn the suite.");
        }
    });

    test("a profile removed, an empty roster, or a roster that cannot be read blocks a named agent", async () => {
        const ghost: Fixture = {
            identity: { 60: { persona: stored("ghost") } },
            sessions: { 60: session() },
        };
        const removed = await scopeOf(ghost, 60);

        assert.deepEqual(removed, {
            kind: "blocked",
            reason: "this session belongs to the agent ghost, which has no profile now",
        });
        assert.equal(
            blocks(removed, "truenas").call,
            "MCP tools are blocked in this session: this session belongs to the agent ghost, which has no profile now. mcp_call is blocked.",
        );

        const empty = join(root, "no-agents");

        mkdirSync(empty, { recursive: true });
        const moneo: Fixture = {
            identity: { 61: { persona: stored("moneo") } },
            sessions: { 61: session() },
        };

        assert.deepEqual(await scopeOf(moneo, 61, undefined, empty), {
            kind: "blocked",
            reason: "the roster is empty, so the MCP servers of moneo are not known",
        });

        // An invalid profile: the read fails, and no last good roster keeps an old grant.
        const broken = join(root, "broken-agents");

        mkdirSync(broken, { recursive: true });
        writeFileSync(join(broken, "moneo.md"), "---\nmcp: [truenas]\n---\n# Moneo\n");
        assert.equal((await scopeOf(moneo, 61, undefined, broken)).kind, "agent");
        writeFileSync(join(broken, "moneo.md"), "---\nmcp: truenas\n---\n# Moneo\n");
        utimesSync(join(broken, "moneo.md"), clock + 1000, clock + 1000);
        assert.deepEqual(await scopeOf(moneo, 61, undefined, broken), {
            kind: "blocked",
            reason: "the profiles cannot be read, so the MCP servers of moneo are not known",
        });
        // A profile that cannot be read, with its file time unchanged (a mode change): no cached grant survives.
        const locked = join(root, "locked-agents");
        const file = join(locked, "moneo.md");

        mkdirSync(locked, { recursive: true });
        writeFileSync(file, "---\nmcp: [truenas]\n---\n# Moneo\n");
        assert.equal((await scopeOf(moneo, 61, undefined, locked)).kind, "agent");
        chmodSync(file, 0o000);

        try {
            assert.deepEqual(await scopeOf(moneo, 61, undefined, locked), {
                kind: "blocked",
                reason: "the profiles cannot be read, so the MCP servers of moneo are not known",
            });
        } finally {
            chmodSync(file, 0o600);
        }

        // Brian's own session reads the roster for its folder's agent: a broken roster blocks there too.
        assert.equal(
            (
                await scopeOf(
                    { sessions: { 62: session() }, cwd: { 62: work } },
                    62,
                    undefined,
                    broken,
                )
            ).kind,
            "blocked",
        );
    });

    test("a cycle, more than 20 steps, a missing parent, a bad linkedFrom, or a failed read blocks", async () => {
        const blocked = async (fixture: Fixture, id: number, reason: RegExp) => {
            const scope = await scopeOf(fixture, id);

            assert.equal(scope.kind, "blocked");
            assert.match(scope.kind === "blocked" ? scope.reason : "", reason);
            assert.match(
                mcpBlock("mcp_call", { server: "truenas" }, scope) ?? "",
                /^MCP tools are blocked in this session/,
            );
        };

        // A cycle of linked sessions, and a session that names itself.
        await blocked(
            { sessions: { 70: session({ id: 71 }), 71: session({ id: 70 }) } },
            70,
            /is a cycle/,
        );
        await blocked({ sessions: { 72: session({ id: 72 }) } }, 72, /is a cycle/);

        // A chain of 20 sessions ends at Brian's own; a chain of 21 is too long.
        const chain = (length: number): Fixture => {
            const sessions: Record<string, unknown> = { 100: session() };

            for (let id = 101; id < 100 + length; id++) {
                sessions[String(id)] = session({ id: id - 1 });
            }

            return { sessions };
        };

        assert.deepEqual(await scopeOf(chain(20), 119), { kind: "root" });
        await blocked(chain(21), 120, /longer than 20/);

        // A subagent with no parent record, and a linked session whose source is gone.
        await blocked({ sessions: { 80: session() } }, 81, /cannot be found/);
        await blocked({ sessions: { 82: session({ id: 999 }) } }, 82, /cannot be found/);

        // A bad linkedFrom: no id, a string, a negative id, null; and a session record that is no object.
        for (const linkedFrom of [{}, { id: "10" }, { id: -1 }, { id: 1.5 }, null]) {
            await blocked(
                { sessions: { 85: session(linkedFrom) } },
                85,
                /no valid id \(linkedFrom\)/,
            );
        }

        await blocked({ sessions: { 86: null } }, 86, /no valid record/);

        // A failed read: the Identity doc, the session list, the subagent records.
        for (const kind of ["x.team.identity", "pocket.sessions"]) {
            await blocked(
                { sessions: { 90: session() }, fail: new Set([kind]) },
                90,
                /a read failed/,
            );
        }

        await blocked(
            { sessions: { 91: session() }, subagents: {}, fail: new Set(["pocket.subagents"]) },
            92,
            /a read failed/,
        );
    });

    test("a subagent's parent: the hint is checked, the folder's sessions come first, and edges are kept", async () => {
        const fixture: Fixture = {
            identity: { 201: { persona: await persona("moneo") } },
            cwd: { 205: join(root, "there") },
            sessions: {
                200: session(),
                201: { cwd: join(root, "there") },
                202: session(),
            },
            subagents: { 200: {}, 201: { helper: { conversationId: 205 } }, 202: {} },
        };
        // A wrong hint (202) costs 1 read, then the session in the subagent's folder holds it.
        const parents: McpParents = { hint: () => 202, found: new Map(), missing: new Set() };
        const { read, reads } = reader(fixture);

        assert.equal(
            (await mcpScope(read, 205 as ConversationId, context, definitions, parents)).kind,
            "agent",
        );
        assert.equal(reads.get("pocket.subagents"), 2);
        assert.equal(parents.found.get(205), 201);

        // Again: the kept edge, no search.
        await mcpScope(read, 205 as ConversationId, context, definitions, parents);
        assert.equal(reads.get("pocket.subagents"), 2);

        // A conversation with no parent anywhere: searched once, then kept as missing.
        assert.equal(
            (await mcpScope(read, 299 as ConversationId, context, definitions, parents)).kind,
            "blocked",
        );
        const after = reads.get("pocket.subagents");

        assert.equal(
            (await mcpScope(read, 299 as ConversationId, context, definitions, parents)).kind,
            "blocked",
        );
        assert.equal(reads.get("pocket.subagents"), after);
    });

    test("the prompt line names the servers, says there are none, or says MCP is blocked; none for Brian", () => {
        assert.equal(
            mcpText({ kind: "agent", id: "moneo", name: "Moneo", servers: ["truenas"] }),
            "Of the MCP servers above, you may use only: truenas. Give server in each call of mcp_tools, mcp_call and mcp_call_read_only.",
        );
        assert.equal(
            mcpText({ kind: "agent", id: "duncan", name: "Duncan", servers: [] }),
            "No MCP server is given to you: do not call mcp_tools or mcp_call.",
        );
        assert.match(
            mcpText({ kind: "blocked", reason: "a read failed" }) ?? "",
            /^MCP tools are blocked in this session: a read failed\./,
        );
        assert.equal(mcpText({ kind: "root" }), undefined);
    });
});

// ─── In Pocket: the hook, the section, a subagent, a linked session, a script ─

/** What the fake `mcp` module was asked to do, by conversation: only calls that the hook let through get here. */
type FakeCall = { name: string; server?: string; conversation: number };

const FAKE_CALLS = Symbol.for("pi-pocket-team.test.fake-mcp");
const fakeCalls = (): FakeCall[] =>
    ((globalThis as unknown as Record<symbol, FakeCall[] | undefined>)[FAKE_CALLS] ??= []);

/** A drop-in with the `mcp` module's 3 tool names and 1 more: it records each call, and calls no server. */
const FAKE_MCP = `import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const pocketApi = 2;

export default function createFakeMcp() {
    const shared = globalThis;
    const key = Symbol.for("pi-pocket-team.test.fake-mcp");
    const make = (name) =>
        defineTool({
            name,
            description: "A fake MCP tool for tests.",
            parameters: Type.Object({
                server: Type.Optional(Type.String()),
                tool: Type.Optional(Type.String()),
            }),
            replay: "safe",
            execute: async (args, api) => {
                (shared[key] ??= []).push({ name, server: args.server, conversation: Number(api.conversationId) });

                return { output: [{ type: "text", text: "fake " + name + " answered for " + String(args.server) }] };
            },
        });

    return defineExtension({
        name: "fake-mcp",
        tools: [make("mcp_tools"), make("mcp_call"), make("mcp_call_read_only"), make("mcp_other")],
    });
}
`;

/** Each request's system prompt and messages, by the last user text: the team section is in the prompt. */
const prompts: string[] = [];

/** The first request whose messages hold `marker`: the prompt of that 1 session. */
const promptWith = (marker: string): string =>
    prompts.find((each) => each.includes(marker)) ?? assert.fail(`a request with ${marker}`);

const tool = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const model = scriptedModel((ctx) => {
    const { text, role } = lastText(ctx as never);

    prompts.push(JSON.stringify(ctx));

    if (role !== "user") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    const spawn = /SPAWN:(\S+)/.exec(text);

    if (spawn !== null) {
        return tool("subagent", { action: "spawn", name: "helper", message: `CALL:${spawn[1]}` });
    }

    const link = /LINK:(\S+)/.exec(text);

    if (link !== null && !text.includes("<linked-session-message>")) {
        return tool("team", { action: "start", message: `CALL:${link[1]}` });
    }

    const script = /SCRIPT:(\S+)/.exec(text);

    if (script !== null) {
        return tool("codemode", {
            code: `return await tools.mcp_call({ server: ${JSON.stringify(script[1])}, tool: "ping" })`,
        });
    }

    if (text.includes("LIST-ALL")) {
        return tool("mcp_tools", {});
    }

    if (text.includes("OTHER")) {
        return tool("mcp_other", { server: "truenas" });
    }

    const call = /CALL:(\S+)/.exec(text);

    if (call !== null) {
        return tool("mcp_call", { server: call[1], tool: "ping" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 40)}`)]);
});

/**
 * Offer `subagent` in each session that `app` starts from now on, as if Pi had loaded it (it waits for tool search).
 * Pi Pocket's own helper of that name came after v0.27.0, a release the CI matrix still tests: this is its copy.
 */
function offerSubagents(app: App): void {
    const create = app.commands.createSession.bind(app.commands);

    app.commands.createSession = async (...args: Parameters<typeof create>) => {
        const created = await create(...args);

        await loadTools(app, created.id, "subagent");

        return created;
    };
}

describe("the MCP guard in Pocket", () => {
    let app: App;

    before(async () => {
        const dropIns = join(root, "data", "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(import.meta.dirname, "_tool-time.ts"), join(dropIns, "_tool-time.ts"));
        cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
        cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), {
            recursive: true,
        });
        writeFileSync(join(dropIns, "fake-mcp.ts"), FAKE_MCP);
        app = await openApp(model);
        offerSubagents(app);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        await app.setExtensionEnabled(owner(app), "fake-mcp.ts", true);
        await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    });

    after(async () => {
        await app?.close();
        cleanUp();
    });

    /** A new session in the work folder, as the agent `id`: its Identity doc holds the roster's persona. */
    async function sessionAs(id: string): Promise<ConversationId> {
        const created = await newSession(app);
        const chosen = await persona(id);

        await app.harness.commit(async (tx) => {
            (await tx.doc(Identity, created)).persona = chosen;
        }, context);

        return created;
    }

    const said = async (id: ConversationId | number) =>
        (await modelTexts(app, id as ConversationId)).join("\n");
    const calls = (conversation: number | ConversationId) =>
        fakeCalls()
            .filter((each) => each.conversation === Number(conversation))
            .map((each) => `${each.name} ${String(each.server)}`);

    /** The subagent conversation that `parent` spawned, once it answered. */
    async function subagentOf(parent: ConversationId): Promise<ConversationId> {
        const child = await app.harness.commit(
            async (tx) =>
                (await tx.scanConversations({ ownerConversationId: parent }, 10)).items[0]?.id,
            context,
        );

        assert(child !== undefined, "the subagent's conversation");
        await until(
            async () => (await said(child)).includes("done"),
            "the subagent's answer",
            20_000,
        );

        return child;
    }

    test("Moneo may call truenas and not frostnotes; the prompt names truenas", async () => {
        const moneo = await sessionAs("moneo");

        await say(app, moneo, "CALL:truenas MONEO-PROMPT");
        await say(app, moneo, "CALL:frostnotes");
        await say(app, moneo, "LIST-ALL");
        await say(app, moneo, "OTHER");

        assert.deepEqual(calls(moneo), ["mcp_call truenas"]);
        const told = await said(moneo);

        assert.match(told, /fake mcp_call answered for truenas/);
        assert.match(
            told,
            /Moneo \(moneo\) may use only the MCP servers: truenas\. The server .{0,4}frostnotes.{0,4} is blocked/,
        );
        assert.match(told, /Give server: one of truenas/);
        assert.match(told, /mcp_other is blocked/);
        assert.match(
            promptWith("MONEO-PROMPT"),
            /Of the MCP servers above, you may use only: truenas\./,
        );
    });

    test("a subagent and a linked session of Moneo get truenas; a subagent of Duncan gets nothing", async () => {
        const moneo = await sessionAs("moneo");

        await say(app, moneo, "SPAWN:truenas");
        const child = await subagentOf(moneo);

        assert.deepEqual(calls(child), ["mcp_call truenas"]);

        await say(app, moneo, "LINK:truenas");
        const linked = app.sessions().find((each) => each.linkedFrom?.id === Number(moneo));

        assert(linked, "a linked session of Moneo's session");
        await until(async () => calls(linked.id).length > 0, "the linked session's call", 20_000);
        assert.deepEqual(calls(linked.id), ["mcp_call truenas"]);

        const duncan = await sessionAs("duncan");

        await say(app, duncan, "SPAWN:truenas");
        const helper = await subagentOf(duncan);

        assert.deepEqual(calls(helper), []);
        assert.match(
            await said(helper),
            /No MCP server is given to Duncan Idaho \(duncan\): mcp_call is blocked/,
        );

        // A linked session of Duncan's: the walk reaches Duncan through linkedFrom, so it is no root session.
        await say(app, duncan, "LINK:truenas");
        const started = app.sessions().find((each) => each.linkedFrom?.id === Number(duncan));

        assert(started, "a linked session of Duncan's session");
        await until(
            async () => /mcp_call is blocked/.test(await said(started.id)),
            "the linked session's blocked call",
            20_000,
        );
        assert.deepEqual(calls(started.id), []);
        assert.match(await said(started.id), /No MCP server is given to Duncan Idaho \(duncan\)/);
    });

    test("a codemode script's call of mcp_call to a server not in the list is blocked", async () => {
        const moneo = await sessionAs("moneo");

        await say(app, moneo, "SCRIPT:frostnotes");
        await say(app, moneo, "SCRIPT:truenas");

        assert.deepEqual(calls(moneo), ["mcp_call truenas"]);
        assert.match(
            await said(moneo),
            /may use only the MCP servers: truenas\. The server .{0,6}frostnotes.{0,6} is blocked/,
        );
    });

    test("Chani gets frostnotes, and Brian's own session gets every server with no MCP line", async () => {
        const chani = await sessionAs("chani");

        await say(app, chani, "CALL:frostnotes");
        await say(app, chani, "CALL:truenas");
        assert.deepEqual(calls(chani), ["mcp_call frostnotes"]);

        const plain = await newSession(app);

        await say(app, plain, "CALL:frostnotes PLAIN-PROMPT");
        assert.doesNotMatch(promptWith("PLAIN-PROMPT"), /MCP servers above|No MCP server is given/);
        await say(app, plain, "OTHER");
        assert.deepEqual(calls(plain), ["mcp_call frostnotes", "mcp_other truenas"]);
    });

    test("a duncan session is told it has no server", async () => {
        const duncan = await sessionAs("duncan");

        await say(app, duncan, "DUNCAN-PROMPT");
        assert.match(
            promptWith("DUNCAN-PROMPT"),
            /No MCP server is given to you: do not call mcp_tools or mcp_call\./,
        );
    });
});
