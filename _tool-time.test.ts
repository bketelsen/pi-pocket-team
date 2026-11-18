// Load the isolated Pocket harness before the extension modules.
import {
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
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Host } from "./_pocket.d.ts";
import { toolTimeLine, withMessageTime } from "./_tool-time.ts";
import { digestText, linkedSend as deskSend } from "./desk.ts";
import { linkedSend as shiftSend } from "./night-shift.ts";
import { Identity, linkedSend as teamSend } from "./team.ts";

const AT = Date.UTC(2026, 10, 16, 17, 34);
const UTC_LINE = "Current time: 2026-11-16 17:34 UTC (UTC).";
const NEW_YORK_LINE = "Current time: 2026-11-16 12:34 EST (America/New_York).";
const FALLBACK = "Current time unavailable (server clock or time zone could not be read).";
const CLOCK_LINE = /^Current time: \d{4,}-\d{2}-\d{2} \d{2}:\d{2} [^\r\n]+ \([^\r\n]+\)\.$/m;

/** Each delivered message has 1 clock line and otherwise keeps its complete body. */
function stampedBody(message: string): string {
    const [line, ...body] = message.split("\n");

    assert.match(line ?? "", CLOCK_LINE);
    assert.equal(message.split("\n").filter((item) => CLOCK_LINE.test(item)).length, 1);

    return body.join("\n");
}

after(cleanUp);

test("toolTimeLine formats injected UTC and New York clocks exactly", () => {
    assert.equal(toolTimeLine(AT, "UTC"), UTC_LINE);
    assert.equal(toolTimeLine(AT, "America/New_York"), NEW_YORK_LINE);
    assert.equal(toolTimeLine(AT + 60_000, "UTC"), "Current time: 2026-11-16 17:35 UTC (UTC).");
});

test("runtime default zone is resolved fresh for every message, with an injected instant", (t) => {
    const formatter = Intl.DateTimeFormat;
    let zone = "UTC";
    let reads = 0;

    t.mock.method(
        Intl,
        "DateTimeFormat",
        new Proxy(formatter, {
            construct(target, args) {
                if (args.length === 0) {
                    reads += 1;

                    return { resolvedOptions: () => ({ timeZone: zone }) };
                }

                return Reflect.construct(target, args);
            },
        }),
    );
    assert.equal(withMessageTime("first", AT), `${UTC_LINE}\nfirst`);
    zone = "America/New_York";
    assert.equal(withMessageTime("second", AT), `${NEW_YORK_LINE}\nsecond`);
    assert.equal(reads, 2);
});

for (const zone of ["", "   ", "Not/A_Zone"]) {
    test(`an injected invalid zone ${JSON.stringify(zone)} gives an honest fallback`, () => {
        assert.equal(toolTimeLine(AT, zone), FALLBACK);
        assert.equal(
            withMessageTime("Keep this message.", AT, zone),
            `${FALLBACK}\nKeep this message.`,
        );
    });
}

for (const at of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    test(`an injected invalid clock ${String(at)} gives an honest fallback`, () => {
        assert.equal(toolTimeLine(at, "UTC"), FALLBACK);
    });
}

test("a failed default-zone read cannot block a message", (t) => {
    t.mock.method(
        Intl,
        "DateTimeFormat",
        new Proxy(Intl.DateTimeFormat, {
            construct() {
                throw new Error("formatter unavailable");
            },
        }),
    );
    assert.equal(withMessageTime("Keep this message.", AT), `${FALLBACK}\nKeep this message.`);
});

for (const message of ["", "continue", "First line.\nSecond line."]) {
    test(`the message clock prefixes exactly 1 line and preserves ${JSON.stringify(message)}`, () => {
        assert.equal(withMessageTime(message, AT, "UTC"), `${UTC_LINE}\n${message}`);
    });
}

test("the duplicate guard keeps an existing clock, also inside a forwarded brief or after a failure", () => {
    for (const line of [UTC_LINE, NEW_YORK_LINE, FALLBACK]) {
        for (const message of [
            `${line}\nOriginal message.`,
            `Forwarded brief:\n${line}\nOriginal message.`,
        ]) {
            assert.equal(withMessageTime(message, AT + 60_000, "UTC"), message);
            assert.equal(withMessageTime(withMessageTime(message, AT, "UTC"), AT, "UTC"), message);
        }
    }

    assert.equal(
        withMessageTime("Current time: please check it.", AT, "UTC"),
        `${UTC_LINE}\nCurrent time: please check it.`,
    );
});

const DIGEST = digestText([], { at: AT, timeZone: "UTC" });

test("the desk digest keeps only its existing Now header", () => {
    assert.equal(
        DIGEST,
        "[desk] digest: 0 new. Now 2026-11-16 17:34 UTC. Read each with desk read <id> before you act.",
    );
    assert.equal(withMessageTime(DIGEST, AT, "UTC"), DIGEST);
    assert.doesNotMatch(DIGEST, /Current time/);
});

for (const [name, send] of [
    ["Team", teamSend],
    ["Desk", deskSend],
    ["Shift", shiftSend],
] as const) {
    test(`${name} linkedSend stamps a fresh message once and preserves routing, key and follow-up delivery`, async () => {
        const source = 42 as ConversationId;
        const calls: {
            source: ConversationId;
            request: { to: string; message: string; steer?: boolean };
            key: string;
        }[] = [];
        const host = {
            linkedSessions: {
                send: async (
                    source: ConversationId,
                    request: { to: string; message: string; steer?: boolean },
                    key: string,
                ) => {
                    calls.push({ source, request, key });

                    return { answers: true };
                },
            },
        } as unknown as Host;
        const original = { to: "session-worker", message: "First line.\nSecond line." };

        assert.equal(await send(host, source, original, "fresh-message"), undefined);
        const first = calls[0]!;

        assert.equal(stampedBody(first.request.message), original.message);
        assert.deepEqual(first, {
            source,
            request: { ...original, message: first.request.message, steer: false },
            key: "fresh-message",
        });
        assert.equal(original.message, "First line.\nSecond line.");

        for (const message of [
            `${UTC_LINE}\nAlready stamped.`,
            `${FALLBACK}\nUnavailable.`,
            DIGEST,
        ]) {
            await send(host, source, { ...original, message }, "existing-clock");
            assert.equal(calls.at(-1)?.request.message, message);
        }
    });
}

test("Team start briefs and team_message deliveries carry the clock, not tool results, through Pocket", async () => {
    const definitions = join(root, "clock-agents");
    const dropIns = join(root, "data", "extensions");
    const savedAgents = process.env.PI_POCKET_TEAM_AGENTS;

    mkdirSync(definitions, { recursive: true });
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nrole: supervisor\n---\n# Odrade\nCoordinate the test team.",
    );
    writeFileSync(join(definitions, "worker.md"), "# Worker\nDo the isolated test task.");

    for (const file of ["team.ts", "_tool-time.ts"]) {
        cpSync(join(import.meta.dirname, file), join(dropIns, file));
    }

    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    const incoming: string[] = [];
    const results: string[] = [];
    let address = "";
    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role === "toolResult") {
            results.push(text);

            return fauxAssistantMessage([fauxText("Tool complete.")]);
        }

        if (text === "delegate clock test") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "worker",
                        task: "Read this clock brief.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (text === "message clock test") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Read this clock follow-up.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        incoming.push(text);

        return fauxAssistantMessage([fauxText("Message received.")]);
    });

    try {
        process.env.PI_POCKET_TEAM_AGENTS = definitions;
        const app = await openApp(model);

        try {
            await app.setExtensionEnabled(owner(app), "team.ts", true);
            const source = await newSession(app);

            await app.harness.commit(async (tx) => {
                (await tx.doc(Identity, source)).persona = {
                    id: "odrade",
                    name: "Odrade",
                    role: "supervisor",
                    model: "",
                    instructions: "Coordinate the test team.",
                    repositories: {},
                };
            }, context);
            await say(app, source, "delegate clock test");
            await until(
                () => incoming.some((text) => text.includes("Read this clock brief.")),
                "the stamped first message",
            );
            const first = incoming.find((text) => text.includes("Read this clock brief."))!;

            assert.match(first, CLOCK_LINE);
            assert.equal(first.split("\n").filter((line) => CLOCK_LINE.test(line)).length, 1);
            assert.match(first, /# Worker\nDo the isolated test task\./);
            assert.match(first, /Task from the source session:\nRead this clock brief\./);
            assert(results.some((text) => text.includes("Assigned to Worker")));
            assert(
                results.every((text) => !text.includes("Current time")),
                "tool results carry no clock",
            );

            address = (await app.linkedSessions.list(source))[0]!.address;

            await say(app, source, "message clock test");
            await until(
                () => incoming.some((text) => text.includes("Read this clock follow-up.")),
                "the stamped follow-up message",
            );
            const followUp = incoming.find((text) => text.includes("Read this clock follow-up."))!;

            assert.match(followUp, CLOCK_LINE);
            assert.equal(followUp.split("\n").filter((line) => CLOCK_LINE.test(line)).length, 1);
            assert.equal(results.length, 2, "both Team tools returned");
            assert(
                results.every((text) => !text.includes("Current time")),
                "team_message results carry no clock",
            );
        } finally {
            await app.close();
        }
    } finally {
        if (savedAgents === undefined) {
            delete process.env.PI_POCKET_TEAM_AGENTS;
        } else {
            process.env.PI_POCKET_TEAM_AGENTS = savedAgents;
        }
    }
});
