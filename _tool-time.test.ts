// Load the isolated Pocket harness before the extension modules.
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
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { boundOutput } from "@earendil-works/chord/output";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { isClockTool, toolTimeLine, withToolTime } from "./_tool-time.ts";
import { digestText } from "./desk.ts";
import { Identity } from "./team.ts";

const AT = Date.UTC(2026, 10, 16, 17, 34);
const UTC_LINE = "Current time: 2026-11-16 17:34 UTC (UTC).";
const NEW_YORK_LINE = "Current time: 2026-11-16 12:34 EST (America/New_York).";
const FALLBACK = "Current time unavailable (server clock or time zone could not be read).";

/** Pocket's modelTexts serializes the content array; inspect its text, not that JSON encoding. */
function contentText(serialized: string): string {
    const content = JSON.parse(serialized) as { type: string; text?: string }[];

    return content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
}

/** Keep every clock and formatter replacement inside this test, including when an assertion fails. */
async function withClock(run: () => void | Promise<void>): Promise<void> {
    const now = Date.now;
    const formatter = Intl.DateTimeFormat;
    const timeZone = process.env.TZ;

    try {
        Date.now = () => AT;
        process.env.TZ = "UTC";
        await run();
    } finally {
        Date.now = now;
        Intl.DateTimeFormat = formatter;

        if (timeZone === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = timeZone;
        }
    }
}

/** Change only the default-zone read; explicit-zone formatting still uses the real formatter. */
function defaultZone(read: () => unknown): void {
    Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
        construct(target, args) {
            return args.length === 0
                ? { resolvedOptions: () => ({ timeZone: read() }) }
                : Reflect.construct(target, args);
        },
    });
}

after(cleanUp);

test("toolTimeLine formats the exact UTC date, 24-hour time and server zone", () =>
    withClock(() => {
        assert.equal(toolTimeLine(), UTC_LINE);
    }));

test("toolTimeLine reads a changed TZ for the next result", () =>
    withClock(() => {
        assert.equal(toolTimeLine(), UTC_LINE);
        process.env.TZ = "America/New_York";
        assert.equal(toolTimeLine(), NEW_YORK_LINE);
    }));

test("toolTimeLine never caches the default-zone resolution", () =>
    withClock(() => {
        let zone = "UTC";
        let reads = 0;

        defaultZone(() => {
            reads += 1;

            return zone;
        });
        assert.equal(toolTimeLine(), UTC_LINE);
        zone = "America/New_York";
        assert.equal(toolTimeLine(), NEW_YORK_LINE);
        assert.equal(reads, 2, "each result resolves the server time zone anew");
    }));

for (const zone of [undefined, "", "   ", "Not/A_Zone"]) {
    test(`toolTimeLine gives an honest fallback for zone ${JSON.stringify(zone)}`, () =>
        withClock(() => {
            defaultZone(() => zone);
            assert.equal(toolTimeLine(), FALLBACK);
        }));
}

for (const clock of [NaN, Infinity, 8.64e15 + 1]) {
    test(`toolTimeLine gives an honest fallback for invalid clock ${String(clock)}`, () =>
        withClock(() => {
            Date.now = () => clock;
            assert.equal(toolTimeLine(), FALLBACK);
        }));
}

test("toolTimeLine contains a clock read failure", () =>
    withClock(() => {
        Date.now = () => {
            throw new Error("clock unavailable");
        };

        assert.equal(toolTimeLine(), FALLBACK);
    }));

test("toolTimeLine contains a formatter construction failure", () =>
    withClock(() => {
        Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
            construct() {
                throw new Error("formatter unavailable");
            },
        });
        assert.equal(toolTimeLine(), FALLBACK);
    }));

test("toolTimeLine contains a formatToParts failure", () =>
    withClock(() => {
        Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
            construct(target, args) {
                return args.length === 0
                    ? Reflect.construct(target, args)
                    : {
                          formatToParts() {
                              throw new Error("formatting failed");
                          },
                      };
            },
        });
        assert.equal(toolTimeLine(), FALLBACK);
    }));

test("withToolTime preserves result fields and output without mutating the original", () =>
    withClock(() => {
        const result = {
            output: [{ type: "text" as const, text: "Existing result." }],
            isError: true,
            diagnostics: [{ severity: "error" as const, code: "blocked", message: "Refused." }],
            details: { retry: false },
            structuredOutput: { answer: "no" },
        };
        const stamped = withToolTime(result);

        assert.notEqual(stamped, result);
        assert.notEqual(stamped.output, result.output);
        assert.deepEqual(result.output, [{ type: "text", text: "Existing result." }]);
        assert.deepEqual(stamped, {
            ...result,
            output: [{ type: "text", text: `${UTC_LINE}\nExisting result.` }],
        });
        assert.equal(stamped.diagnostics, result.diagnostics);
        assert.equal(stamped.details, result.details);
        assert.equal(stamped.structuredOutput, result.structuredOutput);
    }));

test("withToolTime adds only the clock output when an error has no output", () =>
    withClock(() => {
        const result = {
            isError: true,
            diagnostics: [{ severity: "error" as const, code: "tool_error", message: "Refused." }],
        };
        const stamped = withToolTime(result);

        assert.deepEqual(stamped.output, [{ type: "text", text: UTC_LINE }]);
        assert.equal(stamped.isError, true);
        assert.equal(stamped.diagnostics, result.diagnostics);
        assert.equal(Object.hasOwn(result, "output"), false);
    }));

test("the shared filter covers exactly the 7 owned names, without double-stamping or near matches", () => {
    const team = ["team_delegate", "team_work", "team_message", "team_memory", "team_sessions"];
    const desk = ["desk", "plan"];
    const excluded = ["", "schedule", "bash", "team", "subagent", "codemode", "events_list"];
    const names = [...team, ...desk];

    for (const owner of ["team", "desk"] as const) {
        const expected = owner === "team" ? team : desk;

        for (const name of [...names, ...excluded]) {
            assert.equal(isClockTool(owner, name), expected.includes(name), `${owner}: ${name}`);
        }

        for (const name of names) {
            for (const near of [
                `${name}_extra`,
                `nested.${name}`,
                ` ${name}`,
                name.toUpperCase(),
            ]) {
                assert.equal(isClockTool(owner, near), false, `${owner}: ${near}`);
            }
        }
    }
});

test("withToolTime changes only the first text item, preserving other items and their order", () =>
    withClock(() => {
        const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
        const first = { type: "text" as const, text: "" };
        const last = { type: "text" as const, text: "Original text." };
        const output = [image, first, image, last];
        const stamped = withToolTime({ output });

        assert.deepEqual(stamped.output, [image, { ...first, text: `${UTC_LINE}\n` }, image, last]);
        assert.deepEqual(output, [image, first, image, last]);
        assert.equal(stamped.output[0], image);
        assert.equal(stamped.output[2], image);
        assert.equal(stamped.output[3], last);
        assert.deepEqual(withToolTime({ output: [image] }).output, [
            { type: "text", text: UTC_LINE },
            image,
        ]);
        assert.deepEqual(withToolTime({ output: [] }).output, [{ type: "text", text: UTC_LINE }]);
    }));

/** Mirror Pi Durable's boundContent: concatenate text without separators, replace the first text on head truncation. */
function boundContent(output: NonNullable<ToolExecutionResult["output"]>) {
    const texts = output.filter((item) => item.type === "text");
    const bounded = boundOutput(texts.map((item) => item.text).join(""), {
        maxBytes: 50 * 1024,
        maxLines: 2000,
        retain: "head",
    });

    return {
        ...bounded,
        content:
            bounded.droppedBytes === 0
                ? output
                : output.flatMap((item) =>
                      item.type !== "text"
                          ? [item]
                          : item === texts[0]
                            ? [{ ...item, text: bounded.text }]
                            : [],
                  ),
    };
}

for (const limit of ["bytes", "lines"] as const) {
    for (const delta of [-1, 0, 1]) {
        test(`the clock survives default head retention at the ${limit} limit ${delta >= 0 ? "+" : ""}${delta}`, () =>
            withClock(() => {
                const maximum = limit === "bytes" ? 50 * 1024 : 2000;
                const size = maximum + delta;
                const body =
                    limit === "bytes"
                        ? "x".repeat(size - Buffer.byteLength(`${UTC_LINE}\n`))
                        : Array.from({ length: size - 1 }, () => "x").join("\n");
                const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
                const result = withToolTime({
                    output: [
                        image,
                        { type: "text" as const, text: "" },
                        image,
                        { type: "text" as const, text: body },
                    ],
                });
                const bounded = boundContent(result.output);
                const text = bounded.content
                    .flatMap((item) => (item.type === "text" ? [item.text] : []))
                    .join("");

                assert.equal(text.split("\n")[0], UTC_LINE);
                assert.equal(text.split(UTC_LINE).length - 1, 1);
                assert.equal(bounded.droppedBytes > 0, delta > 0);
                assert.equal(bounded.content[0], image);
                assert.equal(bounded.content[2], image);
                assert.equal(bounded.content.length, delta > 0 ? 3 : 4);

                if (delta <= 0) {
                    assert.equal(text, `${UTC_LINE}\n${body}`);
                }
            }));
    }
}

test("the desk digest keeps exactly 1 clock line, in its existing header", () => {
    const text = digestText([], { at: AT, timeZone: "UTC" });

    assert.equal(
        text,
        "[desk] digest: 0 new. Now 2026-11-16 17:34 UTC. Read each with desk read <id> before you act.",
    );
    assert.equal(text.split("\n").filter((line) => /Now |Current time/.test(line)).length, 1);
});

test("owned results begin with 1 fresh clock line, including errors and blocks, through the Pocket harness", async () => {
    const definitions = join(root, "clock-agents");
    const dropIns = join(root, "data", "extensions");
    const savedAgents = process.env.PI_POCKET_TEAM_AGENTS;
    const savedDeskConfig = process.env.PI_POCKET_DESK_CONFIG;

    mkdirSync(definitions, { recursive: true });
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nrole: supervisor\n---\n# Odrade\nCoordinate the test team.",
    );

    writeFileSync(
        join(definitions, "private-test.md"),
        "---\nprivate: true\n---\n# Private Test\n",
    );

    for (const file of [
        "team.ts",
        "desk.ts",
        "_tool-time.ts",
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

    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        const call = text.endsWith("sessions")
            ? fauxToolCall("team_sessions", {})
            : text.endsWith("refusal")
              ? fauxToolCall("desk", { action: "seed" })
              : text.endsWith("invalid")
                ? fauxToolCall("team_delegate", {})
                : text.endsWith("unrelated")
                  ? fauxToolCall("schedule", { action: 42 })
                  : text.endsWith("blocked")
                    ? fauxToolCall("team_work", { task: "Never start this task." })
                    : fauxToolCall("desk", { action: "issues" });

        return fauxAssistantMessage([call], { stopReason: "toolUse" });
    });

    try {
        process.env.PI_POCKET_TEAM_AGENTS = definitions;
        process.env.PI_POCKET_DESK_CONFIG = join(root, "clock-desk.json");
        writeFileSync(process.env.PI_POCKET_DESK_CONFIG, "{}");
        const app = await openApp(model);

        try {
            await app.setExtensionEnabled(owner(app), "team.ts", true);
            await app.setExtensionEnabled(owner(app), "desk.ts", true);
            const session = await newSession(app);

            await app.harness.commit(async (tx) => {
                (await tx.doc(Identity, session)).persona = {
                    id: "odrade",
                    name: "Odrade",
                    role: "supervisor",
                    model: "",
                    instructions: "Coordinate the test team.",
                    repositories: {},
                };
            }, context);

            await withClock(async () => {
                await say(app, session, "clock sessions");
                const sessions = contentText((await modelTexts(app, session)).at(-1) ?? "[]");

                assert.equal(sessions, `tool said: ${UTC_LINE}\nNo linked sessions.`);
                process.env.TZ = "America/New_York";
                await say(app, session, "clock issues");
                const issues = contentText((await modelTexts(app, session)).at(-1) ?? "[]");

                assert.equal(issues.split("\n")[0], `tool said: ${NEW_YORK_LINE}`);
                assert.equal(issues.split(NEW_YORK_LINE).length - 1, 1);

                await say(app, session, "clock refusal");
                const refused = contentText((await modelTexts(app, session)).at(-1) ?? "[]");

                assert(refused.startsWith(`tool said: ${NEW_YORK_LINE}`));
                assert.match(refused, /seed needs path/);
                assert.equal(refused.split(NEW_YORK_LINE).length - 1, 1);
                assert.match(refused, /\[error\]/);

                await say(app, session, "clock invalid");
                const invalid = contentText((await modelTexts(app, session)).at(-1) ?? "[]");

                assert(invalid.startsWith(`tool said: ${NEW_YORK_LINE}`));
                assert.match(invalid, /\[error\]/);
                assert.equal(invalid.split(NEW_YORK_LINE).length - 1, 1);

                await say(app, session, "clock unrelated");
                const unrelated = contentText((await modelTexts(app, session)).at(-1) ?? "[]");

                assert.doesNotMatch(unrelated, /Current time/);

                const privateSession = await newSession(app);

                await app.harness.commit(async (tx) => {
                    (await tx.doc(Identity, privateSession)).persona = {
                        id: "private-test",
                        name: "Private Test",
                        role: "agent",
                        model: "",
                        instructions: "Keep this isolated test private.",
                        repositories: {},
                    };
                }, context);
                const sessionCount = app.sessions().length;

                await say(app, privateSession, "clock blocked");
                const blocked = contentText((await modelTexts(app, privateSession)).at(-1) ?? "[]");

                assert(blocked.startsWith(`tool said: ${NEW_YORK_LINE}`));
                assert.equal(blocked.split(NEW_YORK_LINE).length - 1, 1);
                assert.match(blocked, /Private Test is a private agent/);
                assert.match(blocked, /\[error\]/);
                assert.equal(
                    app.sessions().length,
                    sessionCount,
                    "the blocked call starts no task",
                );
            });
        } finally {
            await app.close();
        }
    } finally {
        for (const [name, value] of [
            ["PI_POCKET_TEAM_AGENTS", savedAgents],
            ["PI_POCKET_DESK_CONFIG", savedDeskConfig],
        ]) {
            if (value === undefined) {
                delete process.env[name!];
            } else {
                process.env[name!] = value;
            }
        }
    }
});
