// Team's tools of linked sessions in a subagent (docs/modules/team.md, "Tools in a subagent"). Pi Pocket gives a
// subagent no linked sessions, and its own refusal does not say that the caller is a subagent: the daily audit (A4)
// found subagents that called `team_sessions` again and again. Team then says what to do instead. A session keeps
// Pocket's own words. Pi Pocket's helpers isolate all credentials, sessions, and model calls.
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
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { subagentText } from "./team.ts";

const definitions = join(root, "agents");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions, { recursive: true });

const tool = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Each request as the model got it: the tool declarations are in its system messages. */
const requests: string[] = [];

/** The calls each user text asks for: SPAWN:<call> starts a subagent with CALL:<call>; CALL:<call> makes the call. */
const calls: Record<string, () => ReturnType<typeof tool>> = {
    sessions: () => tool("team_sessions", {}),
    message: () => tool("team_message", { to: "session-nobody", message: "My result." }),
};

const model = scriptedModel((ctx) => {
    const { text, role } = lastText(ctx as never);

    requests.push(JSON.stringify(ctx));

    if (role !== "user") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    const spawn = /SPAWN:(\S+)/.exec(text);

    if (spawn !== null) {
        return tool("subagent", { action: "spawn", name: "helper", message: `CALL:${spawn[1]}` });
    }

    const call = /CALL:(\S+)/.exec(text);
    const make = call === null ? undefined : calls[call[1]];

    return make === undefined ? fauxAssistantMessage([fauxText("echo")]) : make();
});

/**
 * Offer `subagent` in each session that `app` starts from now on, as if Pi had loaded it (it waits for tool search).
 * The same copy as in `team-mcp.test.ts`: Pi Pocket's own helper came after v0.27.0.
 */
function offerSubagents(app: App): void {
    const create = app.commands.createSession.bind(app.commands);

    app.commands.createSession = async (...args: Parameters<typeof create>) => {
        const created = await create(...args);

        await loadTools(app, created.id, "subagent");

        return created;
    };
}

describe("Team's linked-session tools in a subagent", () => {
    let app: App;

    before(async () => {
        const dropIns = join(root, "data", "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(import.meta.dirname, "_tool-time.ts"), join(dropIns, "_tool-time.ts"));
        cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
        cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), {
            recursive: true,
        });
        app = await openApp(model);
        offerSubagents(app);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
    });

    after(async () => {
        await app?.close();
        cleanUp();
    });

    const said = async (id: ConversationId) => (await modelTexts(app, id)).join("\n");

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

    test("team_sessions in a subagent says what to do instead; in a session it lists", async () => {
        const session = await newSession(app);

        await say(app, session, "CALL:sessions");
        assert.match(await said(session), /No linked sessions\./);

        await say(app, session, "SPAWN:sessions");
        const child = await subagentOf(session);
        const told = await said(child);

        assert(told.includes(subagentText("team_sessions")), told);
        assert.doesNotMatch(told, /where Pi works for someone/);
    });

    test("team_message in a subagent says what to do instead; a session keeps Pocket's words", async () => {
        const session = await newSession(app);

        await say(app, session, "CALL:message");
        const own = await said(session);

        assert.doesNotMatch(own, /does not work in a subagent/);
        assert.match(own, /linked session/i);

        await say(app, session, "SPAWN:message");
        const child = await subagentOf(session);
        const told = await said(child);

        assert(told.includes(subagentText("team_message")), told);
    });

    test("the descriptions of team_sessions and team_message say: not in a subagent", () => {
        const request = requests.find((each) => each.includes("List linked teammates"));

        assert(request !== undefined, "a request that offered team_sessions");
        assert.match(
            request,
            /"List linked teammates[^"]*Not in a subagent: [^"]*final answer goes to the session that started it\."/,
        );
        assert.match(
            request,
            /"Send a task follow-up[^"]*Not in a subagent: [^"]*final answer goes to the session that started it\."/,
        );
    });
});
