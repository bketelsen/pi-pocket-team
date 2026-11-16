// The events bridge's tools in Pi Pocket (docs/modules/events-bridge.md): the profile's `mcp:` list gates them, the
// prompt section shows only to an agent with a lodge gateway, and a session with no agent gets nothing. The engine is
// in events-bridge.test.ts. Pi Pocket's helpers isolate all credentials, sessions and model calls; the bridge's store
// goes to a temporary folder (PI_POCKET_TEAM_EVENTS_DIR).
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
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Identity, roster } from "./team.ts";

const definitions = join(root, "agents");
const homes = join(root, "homes");
const store = join(root, "events-bridge");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
process.env.PI_POCKET_TEAM_EVENTS_DIR = store;
mkdirSync(definitions, { recursive: true });

let clock = Date.now() / 1000;

function profile(id: string, text: string): void {
    const file = join(definitions, `${id}.md`);

    writeFileSync(file, text);
    clock += 10;
    utimesSync(file, clock, clock);
}

for (const id of ["moneo", "duncan"]) {
    mkdirSync(join(homes, id), { recursive: true });
}

profile("odrade", "---\nrole: supervisor\n---\n# Odrade\nCoordinate the team.");
profile(
    "moneo",
    `---\nhome: ${join(homes, "moneo")}\nmcp: [truenas, moneo-lodge]\n---\n# Moneo\nOwn the NAS.`,
);
profile(
    "duncan",
    `---\nhome: ${join(homes, "duncan")}\nmcp: [truenas]\n---\n# Duncan Idaho\nOwn the suite.`,
);
// Pi's mcp.json: a lodge gateway entry for Moneo, and a server that is no gateway.
writeFileSync(
    join(root, "agent", "mcp.json"),
    JSON.stringify({
        mcpServers: {
            "moneo-lodge": { url: "https://lodge.example/gateway/mcp" },
            truenas: { command: "truenas-mcp" },
        },
    }),
);

const TOOLS = ["events_subscribe", "events_list", "events_unsubscribe", "events_pending"];
const prompts: string[] = [];

const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

const model = scriptedModel((ctx) => {
    const { text, role } = lastText(ctx as never);

    prompts.push(JSON.stringify(ctx));

    if (role !== "user") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    const call = /TOOL:(\w+)/.exec(text);

    if (call !== null) {
        const args =
            call[1] === "events_subscribe"
                ? { topic_prefix: "marks.bookmark", mode: "now" }
                : call[1] === "events_unsubscribe"
                  ? { id: "s0000000000" }
                  : {};

        return tool(call[1]!, args);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 40)}`)]);
});

describe("the events bridge in Pocket", () => {
    let app: App;

    before(async () => {
        const dropIns = join(root, "data", "extensions");

        mkdirSync(dropIns, { recursive: true });

        for (const file of ["team.ts", "events-bridge.ts", "_events-bridge-nats.mjs"]) {
            cpSync(join(import.meta.dirname, file), join(dropIns, file));
        }

        cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), {
            recursive: true,
        });
        app = await openApp(model);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        await app.setExtensionEnabled(owner(app), "events-bridge.ts", true);
    });

    after(async () => {
        await app?.close();
        cleanUp();
    });

    async function sessionAs(id: string | undefined): Promise<ConversationId> {
        const created = await newSession(app);

        if (id !== undefined) {
            const chosen = (await roster(definitions)).find((each) => each.id === id)!;

            await app.harness.commit(async (tx) => {
                (await tx.doc(Identity, created)).persona = chosen;
            }, context);
        }

        await loadTools(app, created, ...TOOLS);

        return created;
    }

    const said = async (id: ConversationId) => (await modelTexts(app, id)).join("\n");

    test("an agent whose profile names a lodge gateway gets the tools and the prompt section", async () => {
        const moneo = await sessionAs("moneo");

        await say(app, moneo, "TOOL:events_list MONEO-LIST");
        const told = await said(moneo);

        assert.match(told, /Bridge: running/);
        assert.match(told, /No subscriptions\./);
        assert.match(told, /Events session: none yet\./);

        await say(app, moneo, "TOOL:events_pending");
        assert.match(await said(moneo), /No events wait in your digest\./);

        await say(app, moneo, "TOOL:events_unsubscribe");
        assert.match(await said(moneo), /No subscription s0000000000/);

        const prompt = prompts.find((each) => each.includes("MONEO-LIST")) ?? "";

        assert.match(prompt, /Lodge events: the tools events_subscribe/);
        // Its store is the bridge's own, never the mcp module's oauth.json.
        assert.equal(existsSync(join(store, "moneo.events.json")), true);
        assert.deepEqual(
            readdirSync(store).filter((file) => file.includes("oauth")),
            [],
        );
    });

    test("an agent with no lodge gateway in its profile is refused each tool, and gets no section", async () => {
        const duncan = await sessionAs("duncan");

        for (const name of TOOLS) {
            await say(app, duncan, `TOOL:${name} DUNCAN-${name}`);
        }

        const told = await said(duncan);

        assert.equal(
            told.match(
                /The events bridge is not for this session: Duncan Idaho's profile mcp: list names no lodge gateway entry/g,
            )?.length,
            TOOLS.length,
        );

        const prompt = prompts.find((each) => each.includes("DUNCAN-events_list")) ?? "";

        assert.doesNotMatch(prompt, /Lodge events: the tools/);
        assert.equal(existsSync(join(store, "duncan.events.json")), false);
    });

    test("a profile that gains the gateway gets the tools at its next call, and loses them when it goes", async () => {
        const duncan = await sessionAs("duncan");

        try {
            profile(
                "duncan",
                `---\nhome: ${join(homes, "duncan")}\nmcp: [moneo-lodge]\n---\n# Duncan Idaho\nOwn the suite.`,
            );
            await say(app, duncan, "TOOL:events_list");
            assert.match(await said(duncan), /Bridge: running/);
        } finally {
            profile(
                "duncan",
                `---\nhome: ${join(homes, "duncan")}\nmcp: [truenas]\n---\n# Duncan Idaho\nOwn the suite.`,
            );
        }

        await say(app, duncan, "TOOL:events_pending");
        assert.match(await said(duncan), /names no lodge gateway entry/);
    });

    test("a session with no named agent is refused", async () => {
        const plain = await sessionAs(undefined);

        await say(app, plain, "TOOL:events_list");
        assert.match(await said(plain), /not for this session: this session has no named agent/);
    });
});
