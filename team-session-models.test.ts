// Session models and worker models have separate roles. All profiles and sessions here use isolated test data.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
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
    until,
} from "./_pocket/test/helpers.ts";
import { createHandler } from "./_pocket/src/server/http.ts";
import * as team from "./team.ts";
import { GoalDoc } from "./night-shift.ts";

const definitions = join(root, "session-model-agents");
const workspace = join(root, "session-model-workspace");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions);
mkdirSync(workspace);

for (const [id, role, model] of [
    ["supervisor", "supervisor", "faux/faux-1"],
    ["mai", "agent", "faux/mai-code-2"],
    ["normal", "agent", "faux/faux-2"],
    ["clerk", "clerk", "faux/mai-code-2-flash"],
]) {
    writeFileSync(
        join(definitions, `${id}.md`),
        `---\nrole: ${role}\nmodel: ${model}\nworkspace: ${workspace}\nhome: ${workspace}\n---\n# ${id}\nTest agent.`,
    );
}

const model = fauxProvider({
    tokensPerSecond: 2000,
    models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "mai-code-2" }, { id: "mai-code-2-flash" }],
});

model.setResponses(
    Array.from({ length: 1000 }, () => (ctx: Parameters<typeof lastText>[0]) => {
        const { text, role } = lastText(ctx);

        if (role === "user" && ["delegate marker", "clerk marker", "shift marker"].includes(text)) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: text === "clerk marker" ? "clerk" : "mai",
                        task: "Say hello.",
                        ...(text === "shift marker"
                            ? { shift: { stop_when: "done", max: 1, worker: "faux/mai-code-2" } }
                            : {}),
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([
            fauxText(text.startsWith("[shift] Round") ? "STATUS: DONE: done" : "ok"),
        ]);
    }),
);
let app: App;
let server: Server | undefined;
let base = "";
let source: ConversationId;
const api = () =>
    (globalThis as unknown as Record<symbol, team.TeamApi>)[Symbol.for("pi-pocket-team.team")]!;

async function call(path: string, body?: object) {
    const response = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return { status: response.status, data: await response.json() };
}

before(async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });

    for (const file of ["_tool-time.ts", "team.ts", "night-shift.ts"]) {
        cpSync(join(import.meta.dirname, file), join(dropIns, file));
    }

    for (const folder of ["team-web", "night-shift-web"]) {
        cpSync(join(import.meta.dirname, folder), join(dropIns, folder), { recursive: true });
    }

    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "night-shift.ts", true);
    await app.setSubagentModels(owner(app), [
        "faux/faux-1",
        "faux/faux-2",
        "faux/mai-code-2",
        "faux/mai-code-2-flash",
    ]);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;
    source = await newSession(app);
    assert.equal((await call(`session/${source}/identity`, { agent: "supervisor" })).status, 200);
    await say(app, source, "Hello");
});
after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("1: workerOnlyModel matches only MAI-Code model ids", () => {
    for (const value of [
        "github-copilot/mai-code-2",
        "github-copilot/mai-code-2-flash",
        "faux/mai-code-2",
        "mai-code-2",
        " github-copilot/MAI-CODE-2 ",
    ]) {
        assert.equal(team.workerOnlyModel(value), true, value);
    }

    for (const value of [
        "",
        "github-copilot/gpt-6.1-sol",
        "github-copilot/claude-opus-5.5",
        "github-copilot/maicode-2",
        "github-copilot/mai-code-2/x",
    ]) {
        assert.equal(team.workerOnlyModel(value), false, value);
    }
});

test("2: published roster hides worker-only models and keeps session models", async () => {
    const roster = await api().roster();
    const mai = roster.find((agent) => agent.id === "mai")!;

    assert.equal(mai.model, undefined);
    assert.equal(Object.hasOwn(mai, "model"), false);
    assert.equal(roster.find((agent) => agent.id === "normal")?.model, "faux/faux-2");
});

async function delegate(marker: string): Promise<ConversationId> {
    const seen = new Set(app.sessions(owner(app)).map((session) => session.id));

    await say(app, source, marker);
    await until(
        () => app.sessions(owner(app)).some((session) => !seen.has(session.id)),
        "linked session created",
    );
    const child = app.sessions(owner(app)).find((session) => !seen.has(session.id))!.id;

    await until(() => !app.isBusy(child) && !app.isBusy(source), "delegation settled");

    return child;
}

test("3: delegation inherits the source model and explains the worker-only profile", async () => {
    const child = await delegate("delegate marker");
    const runs = (await app.agentState(child))?.model;

    assert.equal(`${runs?.provider}/${runs?.modelId}`, "faux/faux-1");
    assert.match(
        (await modelTexts(app, source)).join("\n"),
        /your model \(faux\/mai-code-2 runs only worker subagents for code, never a session\)/,
    );
});

test("4: preferred worker-only web start returns 400 without creating a session", async () => {
    const count = app.sessions(owner(app)).length;
    const result = await call(`session/${source}/start`, {
        agent: "mai",
        usePreferredModel: true,
        message: "Hello",
        key: "worker-only-web-start",
    });

    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.data), /runs only worker subagents/);
    assert.equal(app.sessions(owner(app)).length, count);
});

test("5: published plan start rejects an explicit worker-only model", async () => {
    await assert.rejects(
        api().startPlan!({
            supervisor: Number(source),
            read: app.harness,
            context,
            commit: (change) => app.harness.commit(change, context),
            start: async () => assert.fail("a worker-only plan must not start"),
            key: "worker-only-plan",
            lead: "mai",
            title: "Test plan",
            idea: "Test",
            model: "faux/mai-code-2",
        }),
        /runs only worker subagents for code, never a session/,
    );
});

test("6: Clerk refuses its worker-only profile model", async () => {
    const count = app.sessions(owner(app)).length;

    await say(app, source, "clerk marker");
    await until(() => !app.isBusy(source), "Clerk refusal settled");
    assert.match(
        (await modelTexts(app, source)).join("\n"),
        /faux\/mai-code-2-flash runs only worker subagents for code, never a session\. Brian sets the Clerk's model/,
    );
    assert.equal(app.sessions(owner(app)).length, count);
});

test("7: a shift still accepts MAI-Code as its worker", async () => {
    const child = await delegate("shift marker");

    await until(
        async () => (await app.harness.snapshot(GoalDoc, child, context))?.goal !== undefined,
        "shift goal stored",
    );
    const goal = (await app.harness.snapshot(GoalDoc, child, context))!.goal!;

    assert.equal(goal.worker, "faux/mai-code-2");
    const runs = (await app.agentState(child))?.model;

    assert.equal(`${runs?.provider}/${runs?.modelId}`, "faux/faux-1");
});
