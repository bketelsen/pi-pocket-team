// Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import {
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
    work,
} from "/var/home/bjk/projects/pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "/var/home/bjk/projects/pi-pocket/src/server/http.ts";
import { Identity } from "./team.ts";

after(cleanUp);
const definitions = join(root, "agents");
const repoA = join(root, "nsl");
const repoB = join(root, "igloo");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions);
mkdirSync(repoA);
mkdirSync(repoB);
writeFileSync(
    join(definitions, "odrade.md"),
    "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate Brian's team.",
);
writeFileSync(
    join(definitions, "duncan.md"),
    `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/nsl: ${repoA}\n  frostyard/igloo: ${repoB}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repositories.`,
);
writeFileSync(
    join(definitions, "teg.md"),
    `---\nrepositories:\n  bketelsen/fleet: ${repoA}\n---\n# Miles Teg\nOwn fleet.`,
);
writeFileSync(
    join(definitions, "moneo.md"),
    `---\nworkspace: ${repoB}\n---\n# Moneo\nOwn the NAS.`,
);

test("drop-in identities, named delegation, HTTP permissions, replay and restart", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    let requestContext = "";
    const model = scriptedModel((ctx) => {
        requestContext = JSON.stringify(ctx);
        const { text, role } = lastText(ctx as never);

        if (role === "user" && text.endsWith("delegate test")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "duncan",
                        repository: "frostyard/igloo",
                        task: "Say hello. No tools needed.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("report test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            assert(address, "The worker receives a return address in its initial context.");

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan finished the prototype task.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    let app = await openApp(model);
    let server: ReturnType<typeof createServer> | undefined;

    try {
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        const id = await newSession(app);
        const plain = await newSession(app);

        server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;

        async function call(path: string, body?: object, token = app.config.ownerToken) {
            const res = await fetch(base + path, {
                method: body ? "POST" : "GET",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });

            return { status: res.status, data: await res.json() };
        }

        assert.equal((await call("agents")).data.agents.length, 4);
        const guest = app.config.addUser("Guest", "guest");

        assert.equal((await call("agents", undefined, guest.token)).status, 404);
        assert.equal((await call(`session/${id}/identity`, { agent: "../missing" })).status, 400);
        assert.equal((await call(`session/${id}/identity`, { agent: "odrade" })).status, 200);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        await say(app, id, "Hello");
        const transcript = requestContext;

        assert.match(transcript, /You are Odrade/);
        assert.match(transcript, /frostyard\/nsl/);
        await say(app, plain, "Hello");
        assert.doesNotMatch(requestContext, /You are Odrade/);

        for (const [agent, cwd] of [
            ["teg", repoA],
            ["moneo", repoB],
        ]) {
            const response = await call(`session/${id}/start`, {
                agent,
                message: "Use your working folder",
                key: `default-folder-${agent}`,
            });

            assert.equal(response.status, 200);
            assert.equal(app.cwdOf(response.data.session), cwd);
            await until(() => !app.isBusy(response.data.session), "default-folder task settled");
        }

        // Default starts use the source model; opting into an unallowed model fails in core.
        const denied = await call(`session/${id}/start`, {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Hello",
            key: "denied-model-001",
            usePreferredModel: true,
        });

        assert.notEqual(denied.status, 200);
        const count = app.sessions().length;

        for (const repository of [undefined, "someone/else"]) {
            assert.equal(
                (
                    await call(`session/${id}/start`, {
                        agent: "duncan",
                        repository,
                        message: "Choose the right repository",
                        key: "bad-repository-001",
                    })
                ).status,
                400,
            );
            assert.equal(app.sessions().length, count);
        }

        const request = {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Say hello",
            key: "named-task-0001",
        };
        const started = await call(`session/${id}/start`, request);

        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(
            (await call(`session/${id}/start`, request)).data.session,
            started.data.session,
        );
        const child = started.data.session;

        await until(() => !app.isBusy(child), "linked task settled");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.match((await modelTexts(app, child)).join("\n"), /You are Duncan Idaho/);
        assert.equal(app.cwdOf(child), repoA);
        assert.equal(app.cwdOf(id), work);
        await say(app, child, "report test");
        await until(
            async () =>
                (await modelTexts(app, id))
                    .join("\n")
                    .includes("Duncan finished the prototype task."),
            "specialist report delivered to supervisor",
        );
        await until(() => !app.isBusy(id), "supervisor received the report");
        const before = (await call(`session/${id}`)).data.linked.length;

        await say(app, id, "delegate test");
        await until(
            async () => (await call(`session/${id}`)).data.linked.length > before,
            "named delegation",
        );
        const linked = (await call(`session/${id}`)).data.linked;

        assert(linked.some((s: { title?: string }) => s.title?.startsWith("Duncan Idaho:")));
        const delegated = linked.find((s: { cwd?: string }) => s.cwd === repoB);

        assert(delegated, "Odrade's tool creates the task in Duncan's selected repository.");
        await until(() => !app.isBusy(delegated.conversationId), "delegated task settled");
        assert.equal(app.cwdOf(id), work);
        // A specialist can't create a second layer of agents.
        await say(app, child, "delegate test");
        assert.match(
            (await modelTexts(app, child)).join("\n"),
            /Only a session assigned a supervisor/,
        );
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await app.close();
        app = await openApp(model);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.equal(app.cwdOf(child), repoA);
        await say(app, id, "Still here?");
        assert.match(requestContext, /You are Odrade/);
    } finally {
        server?.closeAllConnections();
        server?.close();
        await app.close();
    }
});
