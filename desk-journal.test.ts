// PocketJournal: the rules (the settings, the day in a zone, the template, the model's answer checks), then the desk's
// queue and its writer, against a fake notes MCP server on 127.0.0.1. Nothing goes to lodge or to frostnotes, and the
// model is never called: its sentences are checked with a fake `complete`.
import {
    type App,
    cleanUp,
    context,
    lastText,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { createHandler } from "./_pocket/src/server/http.ts";
import { McpHttpError } from "@earendil-works/pi-mcp";
import { marked } from "marked";
import {
    checkSentences,
    DeskThreads,
    hasJournalMarker,
    JOURNAL_INPUT_CHARS,
    JOURNAL_ZONE,
    journalBackoff,
    journalConfig,
    journalDay,
    journalEntryText,
    journalFailure,
    journalItemOf,
    journalNoteStart,
    journalPlain,
    journalSafe,
    JOURNAL_COMPLETE,
    journalPrompt,
    journalSentences,
    journalTemplate,
    journalTime,
    listText,
    openThread,
    type DeskState,
    type JournalItem,
    type Thread,
} from "./desk.ts";

// ─── The rules ──────────────────────────────────────────────────────────────

const empty = (): DeskState => ({ next: { T: 1, F: 1 }, threads: {}, grants: [], seen: {} });

/** A thread with every required field: the tests change the fields they care about. */
const baseThread = (overrides: Partial<Thread> = {}): Thread => ({
    id: "T1",
    key: "x.test:1",
    origin: "delegate",
    title: "the blob sweep",
    agents: ["duncan"],
    repo: "frostyard/test",
    state: "closed",
    startedAt: 1,
    lastEventAt: 1,
    prs: {},
    branches: [],
    asks: [],
    run: {},
    events: [],
    ...overrides,
});

const baseItem = (overrides: Partial<JournalItem> = {}): JournalItem => ({
    thread: "T1",
    title: "the blob sweep",
    agents: ["duncan"],
    repo: "frostyard/test",
    at: 0,
    outcome: "completed",
    prs: [],
    ...overrides,
});

describe("the journal's settings", () => {
    const url = "https://lodge.example/mcp/notes";

    test("only url is needed, and every other key has a default", () => {
        assert.deepEqual(journalConfig({ url }, "/home/t"), {
            url,
            folder: "PocketJournal",
            model: "",
            timeZone: "America/New_York",
            dailyCalls: 50,
            tokenFile: "/home/t/.config/pi-pocket-team/journal-token",
        });
    });

    test("no key, or no usable url, keeps the journal off", () => {
        assert.equal(journalConfig(undefined), undefined);
        assert.equal(journalConfig(false), undefined);
        assert.equal(journalConfig({}), undefined);
        assert.equal(journalConfig({ model: "deepseek/deepseek-flash" }), undefined);
        assert.equal(journalConfig({ url: "http://lodge.example/mcp/notes" }), undefined);
        assert.equal(journalConfig({ url: "ftp://lodge.example/mcp/notes" }), undefined);
        assert.equal(journalConfig({ url: "the notes" }), undefined);
    });

    test("http is for localhost and 127.0.0.1 only, for tests", () => {
        assert.equal(
            journalConfig({ url: "http://127.0.0.1:8123/mcp" })?.url,
            "http://127.0.0.1:8123/mcp",
        );
        assert.equal(
            journalConfig({ url: "http://localhost:8123/mcp" })?.url,
            "http://localhost:8123/mcp",
        );
        assert.equal(journalConfig({ url: "http://localhost.example/mcp" }), undefined);
    });

    test("a good value is kept, and a bad one gives its default", () => {
        const good = journalConfig(
            {
                url,
                folder: "/Notes/Daily/",
                model: " deepseek/deepseek-flash ",
                timeZone: "Europe/Berlin",
                dailyCalls: 7,
                tokenFile: "~/t",
            },
            "/home/t",
        );

        assert.deepEqual(good, {
            url,
            folder: "Notes/Daily",
            model: "deepseek/deepseek-flash",
            timeZone: "Europe/Berlin",
            dailyCalls: 7,
            tokenFile: "/home/t/t",
        });

        const bad = journalConfig(
            { url, folder: "../etc", timeZone: "Mars/Olympus", dailyCalls: 5000, tokenFile: 7 },
            "/home/t",
        );

        assert.equal(bad?.folder, "PocketJournal");
        assert.equal(bad?.timeZone, "America/New_York");
        assert.equal(bad?.dailyCalls, 50);
        assert.equal(bad?.tokenFile, "/home/t/.config/pi-pocket-team/journal-token");
    });
});

describe("the day and the time", () => {
    test("the day is New York's, near midnight", () => {
        // 03:30 UTC is 23:30 EDT on the day before.
        assert.equal(journalDay(Date.UTC(2026, 9, 29, 3, 30), "America/New_York"), "2026-10-28");
        assert.equal(journalTime(Date.UTC(2026, 9, 29, 3, 30), "America/New_York"), "23:30");
        // 04:00 UTC is midnight in New York, and the next day starts.
        assert.equal(journalDay(Date.UTC(2026, 9, 29, 4, 0), "America/New_York"), "2026-10-29");
        assert.equal(journalTime(Date.UTC(2026, 9, 29, 4, 0), "America/New_York"), "00:00");
        // Another zone: the same instant is another day.
        assert.equal(journalDay(Date.UTC(2026, 9, 29, 3, 30), "Europe/Berlin"), "2026-10-29");
    });

    test("a clock change does not move the time of an entry", () => {
        // Spring forward, 2026-03-08: 01:59 EST is 06:59 UTC, and 03:00 EDT is 07:00 UTC.
        assert.equal(journalTime(Date.UTC(2026, 2, 8, 6, 59), "America/New_York"), "01:59");
        assert.equal(journalTime(Date.UTC(2026, 2, 8, 7, 0), "America/New_York"), "03:00");
        assert.equal(journalDay(Date.UTC(2026, 2, 8, 7, 0), "America/New_York"), "2026-03-08");
        // Fall back, 2026-11-01: 01:30 happens twice, and both are the same day, at the same time.
        assert.equal(journalTime(Date.UTC(2026, 10, 1, 5, 30), "America/New_York"), "01:30");
        assert.equal(journalTime(Date.UTC(2026, 10, 1, 6, 30), "America/New_York"), "01:30");
        assert.equal(journalDay(Date.UTC(2026, 10, 1, 6, 30), "America/New_York"), "2026-11-01");
        // 04:59 UTC on the 2nd is 23:59 EST on the 1st; 05:00 UTC is midnight.
        assert.equal(journalDay(Date.UTC(2026, 10, 2, 4, 59), "America/New_York"), "2026-11-01");
        assert.equal(journalDay(Date.UTC(2026, 10, 2, 5, 0), "America/New_York"), "2026-11-02");
    });
});

describe("the entry", () => {
    test("only merged PRs of the agent count, and never a guessed one", () => {
        const thread = baseThread({
            prs: {
                "frostyard/test#2": {
                    via: "seen",
                    state: "MERGED",
                    url: "https://github.com/frostyard/test/pull/2",
                    title: "two",
                },
                "frostyard/test#1": {
                    via: "branch",
                    state: "MERGED",
                    url: "https://github.com/frostyard/test/pull/1",
                    title: "one",
                },
                "frostyard/test#3": { via: "seen", state: "OPEN", title: "three" },
                "frostyard/test#4": {
                    via: "window",
                    state: "MERGED",
                    url: "https://github.com/frostyard/test/pull/4",
                    title: "four",
                },
            },
            closed: { at: 5, why: "done", by: "sweep", outcome: "completed" },
        });
        const item = journalItemOf(thread, "a report");

        assert.deepEqual(
            item.prs.map((pr) => pr.ref),
            ["frostyard/test#1", "frostyard/test#2"],
            "merged and not guessed, by ref",
        );
        assert.equal(item.at, 5);
        assert.equal(item.outcome, "completed");
        assert.equal(item.report, "a report");
        assert.equal(item.thread, "T1");
        assert.equal(item.repo, "frostyard/test");
        assert.deepEqual(item.agents, ["duncan"]);
    });

    test("the report is cut to 4,000 characters, and an empty one is left out", () => {
        assert.equal(
            journalItemOf(baseThread(), "x".repeat(5000)).report?.length,
            JOURNAL_INPUT_CHARS,
        );
        assert.equal("report" in journalItemOf(baseThread(), "   "), false);
        assert.equal("report" in journalItemOf(baseThread()), false);
    });

    test("the outcome comes from the close, else from the rules", () => {
        assert.equal(
            journalItemOf(
                baseThread({ closed: { at: 9, why: "done", by: "desk", outcome: "verified" } }),
            ).outcome,
            "verified",
        );
        // An older close has no outcome: the rules give it, from the PRs.
        assert.equal(
            journalItemOf(
                baseThread({ prs: { "frostyard/test#1": { via: "seen", state: "CLOSED" } } }),
            ).outcome,
            "abandoned",
        );
    });

    test("the template is 1 to 3 plain sentences", () => {
        assert.equal(
            journalTemplate(baseItem(), { duncan: "Duncan Idaho" }),
            "Duncan Idaho finished “the blob sweep” in frostyard/test.",
        );
        assert.equal(
            journalTemplate(baseItem({ repo: undefined })),
            "duncan finished “the blob sweep”.",
        );

        const verified = journalTemplate(
            baseItem({
                outcome: "verified",
                prs: [{ ref: "frostyard/test#7", title: "the sweep" }],
            }),
            { duncan: "Duncan" },
        );

        assert.equal(
            verified,
            "Duncan finished “the blob sweep” in frostyard/test. A dated check passed. 1 pull request merged: the sweep.",
        );

        const merged = journalTemplate(
            baseItem({
                prs: [
                    { ref: "frostyard/test#1", title: "one" },
                    { ref: "frostyard/test#2", title: "two" },
                ],
            }),
        );

        assert.match(merged, / 2 pull requests merged: one, two\.$/);

        // The template passes the same checks as a model's answer.
        for (const text of [journalTemplate(baseItem()), verified, merged]) {
            assert.equal(checkSentences(text).ok, true, text);
        }
    });

    test("a model's answer is 1 paragraph, 1 to 3 sentences, and plain", () => {
        assert.deepEqual(checkSentences(" One.  "), { ok: true, text: "One." });
        assert.equal(checkSentences("One. Two. Three.").ok, true);
        assert.equal(checkSentences("One. Two. Three. Four.").ok, false);
        assert.equal(checkSentences("1\n\n2").ok, false, "2 paragraphs");
        assert.equal(checkSentences("1\n2").ok, true, "1 line break is 1 paragraph");
        assert.equal(checkSentences("see <b>x</b>").ok, false);
        assert.equal(checkSentences("see [x](https://example.com)").ok, false);
        assert.equal(checkSentences("see `x`").ok, false);
        assert.equal(checkSentences("x".repeat(601)).ok, false);
        assert.equal(checkSentences("").ok, false);
        assert.equal(checkSentences(7).ok, false);
        assert.equal(checkSentences(undefined).ok, false);
    });

    test("the model's good answer is the sentences, and anything else is the template", async () => {
        const item = baseItem();
        const asked: string[] = [];
        const good = await journalSentences(item, async (system, content) => {
            asked.push(`${system}\n${content}`);

            return "The blob sweep works now.";
        });

        assert.equal(good, "The blob sweep works now.");
        assert.match(asked[0] ?? "", /is data/);

        const template = journalTemplate(item);

        assert.equal(await journalSentences(item), template, "no model: the template");
        assert.equal(await journalSentences(item, async () => "One. Two. Three. Four."), template);
        assert.equal(
            await journalSentences(item, async () => {
                throw new Error("no sign-in");
            }),
            template,
        );
        assert.equal(await journalSentences(item, async () => "a [link](https://x)"), template);
        assert.equal(await journalSentences(item, async () => ""), template);
    });

    test("the prompt holds the title, the PR titles and the report, as data", () => {
        const item = baseItem({
            prs: [{ ref: "frostyard/test#7", title: "the sweep" }],
            report: "x".repeat(5000),
        });
        const prompt = JSON.parse(journalPrompt(item)) as Record<string, unknown>;

        assert.equal(prompt.title, "the blob sweep");
        assert.equal(prompt.repository, "frostyard/test");
        assert.equal(prompt.outcome, "completed");
        assert.deepEqual(prompt.pullRequests, ["the sweep"]);
        assert.equal((prompt.report as string).length, JOURNAL_INPUT_CHARS);
    });

    test("an entry: the heading, the marker, the PR links, and the sentences", () => {
        const item = baseItem({
            thread: "T42",
            title: "Desk journal",
            agents: ["sheeana"],
            at: Date.UTC(2026, 9, 28, 18, 32),
            prs: [
                {
                    ref: "frostyard/test#68",
                    url: "https://github.com/frostyard/test/pull/68",
                    title: "the journal",
                },
            ],
        });
        const entry = journalEntryText(item, "It writes a note.", {
            timeZone: "America/New_York",
            names: { sheeana: "Sheeana" },
        });

        assert.equal(
            entry,
            [
                "## 14:32 · Sheeana · Desk journal",
                "<!-- pocket-journal:T42 -->",
                "",
                "PRs: [frostyard/test#68](https://github.com/frostyard/test/pull/68)",
                "",
                "It writes a note.",
                "",
                "",
            ].join("\n"),
        );
        assert(entry.endsWith("\n\n"), "a blank line after the entry");
        assert.equal(hasJournalMarker(entry, "T42"), true);
        assert.equal(hasJournalMarker(entry, "T4"), false);

        const plain = journalEntryText({ ...item, prs: [] }, "It writes a note.", {
            timeZone: "America/New_York",
        });

        assert.equal(plain.includes("PRs:"), false, "no line without a PR");
        assert.match(plain, /^## 14:32 · sheeana · Desk journal\n/, "no name: the id");

        assert.equal(journalNoteStart("2026-10-28"), "# PocketJournal 2026-10-28\n\n");
    });

    test("the wait doubles from 5 minutes, and stops at 2 hours", () => {
        assert.equal(journalBackoff(0), 5 * 60_000);
        assert.equal(journalBackoff(1), 5 * 60_000);
        assert.equal(journalBackoff(2), 10 * 60_000);
        assert.equal(journalBackoff(3), 20 * 60_000);
        assert.equal(journalBackoff(6), 2 * 3600_000);
        assert.equal(journalBackoff(40), 2 * 3600_000);
    });

    test("desk list says how many entries wait, while the writes fail", () => {
        const state = empty();

        state.journal = {
            items: [baseItem({ thread: "T1" }), baseItem({ thread: "T2" })],
            failures: 2,
            lastError: "The notes server is down.",
        };

        assert.equal(
            listText(state),
            "No threads on the desk.\nJournal: 2 entries waiting, 2 failures in a row: The notes server is down.",
        );

        state.journal.failures = 0;
        assert.equal(listText(state), "No threads on the desk.");
    });
});

// ─── The desk, with a fake notes server ─────────────────────────────────────

/** The fake notes server's token: the token file holds it, and every other token is a 401. */
const token = "lgm_test_token";
const dataDir = join(root, "journal-data");
const definitions = join(root, "journal-agents");
const repo = join(root, "journal-repo");
const fixturePath = join(root, "journal-github.json");
const configPath = join(root, "journal-desk.json");
const fakeGh = join(root, "journal-gh.sh");
const tokenPath = join(root, "journal-token");

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: Record<string, JsonValue>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Pi, scripted: the supervisor sweeps and records a watch's result by the words of each test. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    if (text.endsWith("desk sync test")) {
        return call("desk", { action: "sync" });
    }

    const result = /^desk result (T[0-9]+) pass test$/.exec(text);

    if (result?.[1] !== undefined) {
        return call("desk", { action: "result", thread: result[1], pass: true, text: "it passed" });
    }

    return answer(`echo: ${text.slice(0, 40)}`);
});

/** The app's clock is this far ahead: the wait test moves it past the journal's sleep. */
let shift = 0;
let app: App;
let routes: ReturnType<typeof createServer> | undefined;
let routeBase = "";

// The fake notes server: 3 tools over a Map of notes, and a record of every call.
const notes = new Map<string, string>();
const notesCalls: { tool: string; args: Record<string, unknown> }[] = [];
/** Every request gets a 503: the notes host is down. */
let notesDown = false;
/** Every request gets a 500 whose body echoes the Authorization header, as a bad proxy could. */
let notesEcho = false;
let notesServer: Server | undefined;
let notesUrl = "";

const resetNotes = (): void => {
    notes.clear();
    notesCalls.length = 0;
    notesDown = false;
    notesEcho = false;
};

const answerAt = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
};

async function startNotes(): Promise<void> {
    notesServer = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on("end", () => {
            if (notesEcho) {
                response.writeHead(500, { "content-type": "text/plain" });
                response.end(
                    `bad gateway for Authorization: ${String(request.headers.authorization)}`,
                );

                return;
            }

            if (notesDown) {
                response.writeHead(503, { "content-type": "text/plain" });
                response.end("the notes server is down");

                return;
            }

            if (request.headers.authorization !== `Bearer ${token}`) {
                response.writeHead(401, { "content-type": "text/plain" });
                response.end("lodge: no live token for app notes");

                return;
            }

            const message = JSON.parse(body === "" ? "{}" : body) as {
                id?: number;
                method?: string;
                params?: {
                    protocolVersion?: string;
                    name?: string;
                    arguments?: Record<string, unknown>;
                };
            };

            if (message.method === "initialize") {
                answerAt(response, 200, {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: message.params?.protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: { name: "fake-notes", version: "1" },
                    },
                });

                return;
            }

            if (message.method === "notifications/initialized") {
                response.writeHead(202);
                response.end();

                return;
            }

            if (message.method !== "tools/call") {
                answerAt(response, 200, {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: -32601, message: "no such method" },
                });

                return;
            }

            const name = String(message.params?.name ?? "");
            const args = message.params?.arguments ?? {};
            const path = String(args.path ?? "");
            const tool = (result: unknown) =>
                answerAt(response, 200, { jsonrpc: "2.0", id: message.id, result });
            const fail = (text: string) =>
                tool({ isError: true, content: [{ type: "text", text }] });
            const ok = (text: string, structured: unknown) =>
                tool({ content: [{ type: "text", text }], structuredContent: structured });

            notesCalls.push({ tool: name, args });

            if (name === "read_note") {
                const note = notes.get(path);

                if (note === undefined) {
                    fail(`notFound: the note ${path} does not exist`);

                    return;
                }

                ok(note, { path, text: note });

                return;
            }

            if (name === "create_note") {
                if (notes.has(path)) {
                    fail(`the note ${path} exists already`);

                    return;
                }

                notes.set(path, String(args.content ?? ""));
                ok(`created ${path}`, { path });

                return;
            }

            if (name === "edit_note") {
                const note = notes.get(path);

                if (note === undefined) {
                    fail(`notFound: the note ${path} does not exist`);

                    return;
                }

                notes.set(path, note + String(args.append ?? ""));
                ok(`edited ${path}`, { path });

                return;
            }

            fail(`no tool ${name}`);
        });
    });

    await new Promise<void>((resolve) => notesServer?.listen(0, "127.0.0.1", resolve));
    notesUrl = `http://127.0.0.1:${String((notesServer.address() as { port: number }).port)}/mcp/notes`;
}

/** The desk's config: the journal on, with the fake server, no model, and the default folder and zone. */
function journalOn(extra: Record<string, unknown> = {}): void {
    writeFileSync(
        configPath,
        JSON.stringify({
            digest: { minutes: 0 },
            cap: 100,
            journal: { url: notesUrl, model: "", ...extra },
        }),
    );
}

/** The desk's config with no `journal` key: nothing is queued, and every path works as before. */
function journalOff(): void {
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
}

const deskState = () => app.harness.snapshot(DeskThreads, context);

/** The journal's entry for a thread, or undefined while it is not queued. */
const itemOf = async (id: string): Promise<JournalItem | undefined> =>
    (await deskState())?.journal?.items.find((each) => each.thread === id);

/** The note of the day a time closes in, as the journal names it. */
const noteOf = async (at: number): Promise<{ path: string; note: string }> => {
    const path = `PocketJournal/${journalDay(at, JOURNAL_ZONE)}.md`;

    return { path, note: notes.get(path) ?? "" };
};

/** Wait until the queue is empty and no writer runs. */
async function drained(): Promise<void> {
    await until(
        async () => {
            const journal = (await deskState())?.journal;

            return (
                journal === undefined ||
                (journal.items.length === 0 && journal.writer === undefined)
            );
        },
        "the journal to drain",
        20_000,
    );
}

/** Stop 1 task, and wait for it to be terminal. An abort that is only marked resumes after a restart. */
async function stopTask(id: string): Promise<void> {
    const taskId = id as unknown as TaskId;

    await app.harness.abortTask(taskId, context);
    await app.harness.waitForTask(taskId, context).catch(() => undefined);
}

/** Stop every live sweeper: a test that moves the clock must not wake the sweepers of earlier tests. */
async function stopSweepers(): Promise<void> {
    const live = await app.harness.inspect(context);

    for (const task of live.tasks) {
        if (task.record.kind === "x.desk.sweeper") {
            await stopTask(String(task.record.id));
        }
    }
}

/** Stop every journal writer, so its item and its wait stay out of the next test. */
async function stopJournal(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
        const live = (await app.harness.inspect(context)).tasks.filter(
            (task) => task.record.kind === "x.desk.journal",
        );

        if (live.length === 0) {
            return;
        }

        for (const task of live) {
            await stopTask(String(task.record.id));
        }
    }

    throw new Error("a journal writer keeps coming back");
}

/** A new session that carries Odrade's identity. */
async function supervisor(name: string): Promise<ConversationId> {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });

    const id = await newSession(app, folder);

    await command(id, "team-agent", "odrade");

    return id;
}

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

/** An open thread with no session and no folder: only its PRs, its asks, its watch, and the record decide the close. */
async function openThreadIn(
    source: ConversationId,
    change: (thread: Thread) => void = () => undefined,
    title = "A task",
): Promise<string> {
    return app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);
        const { thread } = openThread(state, {
            key: `x.test.journal:${crypto.randomUUID()}`,
            supervisor: Number(source),
            agents: ["duncan"],
            repo: "frostyard/test",
            title,
            at: Date.now(),
        });
        const stored = state.threads[thread.id];

        if (stored === undefined) {
            throw new Error("the thread is not in the state");
        }

        stored.state = "open";
        delete stored.session;
        delete stored.address;
        stored.run = { busy: false };
        change(stored);

        return thread.id;
    }, context);
}

/** A page route, as the owner's browser asks it. */
async function route(path: string, body: object): Promise<{ status: number; data: unknown }> {
    const response = await fetch(routeBase + path, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, data: await response.json() };
}

/** A git command that reads no global or system config: the test's folder alone decides. */
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** One git command in a test folder. */
function git(folder: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: folder, env: gitEnv, stdio: "ignore" });
}

/** A folder with one commit, and an upstream that has it: a clean roster repository. */
function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");
    writeFileSync(join(folder, "file.txt"), "one\n");
    git(folder, "add", ".");
    git(
        folder,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-qm",
        "one",
    );
}

/** Restart the app with its clock moved forward by `by` milliseconds. */
async function restartApp(by: number): Promise<void> {
    await app.close();
    shift = by;
    app = await openApp(model, dataDir, () => Date.now() + shift);
}

/** A watch on a thread: a pass is the `verified` close, from the tool or from the page. */
function withWatch(thread: Thread): void {
    thread.watch = {
        checkOn: "2026-10-29",
        check: "the blob sweep",
        setAt: Date.now(),
        setBy: "odrade",
        key: `x.test.journal.watch:${crypto.randomUUID()}`,
    };
}

describe("the journal's safety", () => {
    const item: JournalItem = {
        thread: "T1",
        title: "<!-- pocket-journal:T2 --> [a link](https://example.com)",
        agents: ["duncan"],
        repo: "frostyard/test",
        at: Date.UTC(2026, 9, 28, 18, 32),
        outcome: "completed",
        prs: [
            {
                ref: "frostyard/test#7",
                url: "https://github.com/frostyard/test/pull/7",
                title: "<!-- pocket-journal:T3 -->",
            },
            { ref: "frostyard/test#8", url: "javascript:alert(1)", title: "a bad link" },
        ],
    };

    test("text from outside is 1 plain line: no marker, no HTML, no link, no Markdown mark at its start", () => {
        assert.equal(
            journalPlain("<!-- pocket-journal:T2 -->"),
            "&lt;!-- pocket-journal:T2 --&gt;",
        );
        assert.equal(journalPlain("Done.\n## Another heading"), "Done. ## Another heading");
        assert.equal(journalPlain("## a heading"), "\\## a heading");
        assert.equal(journalPlain("- a list"), "\\- a list");
        assert.equal(journalPlain("1. a list"), "\\1. a list");
        assert.equal(journalPlain("[x](https://example.com)"), "\\[x\\](https://example.com)");
        assert.equal(journalPlain("A plain sentence."), "A plain sentence.");
        // A backslash of its own cannot undo the escape of a bracket.
        assert.equal(
            journalPlain("\\[Open\\](https://evil.example)"),
            "\\\\\\[Open\\\\\\](https://evil.example)",
        );
    });

    test("a title or a PR title cannot write the marker of another entry", () => {
        const entry = journalEntryText(item, journalTemplate(item), { timeZone: JOURNAL_ZONE });

        assert.equal(hasJournalMarker(entry, "T1"), true);
        assert.equal(hasJournalMarker(entry, "T2"), false);
        assert.equal(hasJournalMarker(entry, "T3"), false);
        assert.equal(entry.includes("<!-- pocket-journal:T2"), false);
        assert.equal(
            entry.includes("javascript:"),
            false,
            "a link that is not GitHub's is no link",
        );
        assert.match(
            entry,
            /\[frostyard\/test#7\]\(https:\/\/github\.com\/frostyard\/test\/pull\/7\)/,
        );
    });

    test("rendered, an entry from hostile text has 1 heading, no hidden link, and no other marker", () => {
        const hostile: JournalItem = {
            ...item,
            title: "\\[Open\\](https://evil.example) <b>bold</b> <!-- pocket-journal:T2 -->",
            prs: [
                {
                    ref: "frostyard/test#7",
                    url: "https://github.com/frostyard/test/pull/7",
                    title: "\\\\[x\\\\](https://evil.example/2) [y](https://evil.example/3)",
                },
            ],
        };
        const answer = "Done. ## A heading\n\\[z\\](https://evil.example/4) <script>x</script>.";
        const html = String(
            marked.parse(
                journalEntryText(hostile, answer, { timeZone: JOURNAL_ZONE }) +
                    journalEntryText(hostile, journalTemplate(hostile), { timeZone: JOURNAL_ZONE }),
            ),
        );
        const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(
            (match) => ({ href: match[1], text: match[2] }),
        );

        // The PR links, as the writer makes them: the ref is the text.
        assert.deepEqual(
            links.filter((link) => link.text === "frostyard/test#7").map((link) => link.href),
            [
                "https://github.com/frostyard/test/pull/7",
                "https://github.com/frostyard/test/pull/7",
            ],
        );

        // Any other link is a bare address that a renderer links by itself: its text is the address, so it hides nothing.
        for (const link of links.filter((each) => each.text !== "frostyard/test#7")) {
            assert.equal(link.text, link.href, `no hidden link: ${String(link.href)}`);
        }

        assert.equal((html.match(/<h\d/g) ?? []).length, 2, "1 heading for each entry");
        assert.equal(html.includes("<script"), false);
        assert.equal(html.includes("<b>"), false);
        assert.equal(
            html.includes("<!-- pocket-journal:T2"),
            false,
            "the marker shows as text, not as a comment",
        );
    });

    test("a marker inside a line is no marker", () => {
        assert.equal(hasJournalMarker("text <!-- pocket-journal:T2 --> more", "T2"), false);
        assert.equal(hasJournalMarker("x\n<!-- pocket-journal:T2 -->\ny", "T2"), true);
    });

    test("a model's answer cannot add a heading to the note", () => {
        const checked = checkSentences("Done.\n## Another heading");

        assert.equal(checked.ok, true);

        const entry = journalEntryText(item, checked.ok ? checked.text : "", {
            timeZone: JOURNAL_ZONE,
        });

        assert.equal(
            entry.split("\n").filter((line) => line.startsWith("#")).length,
            1,
            "only the entry's own heading",
        );
    });

    test("a failure's text keeps no token", () => {
        const token = "lgm_secret_value_1234567890";

        assert.equal(journalSafe(`bad ${token} here`, token).includes(token), false);
        assert.equal(journalSafe("got lgm_other_token back").includes("lgm_other"), false);
        assert.equal(journalSafe("Authorization: Bearer abc.def").includes("abc.def"), false);
        assert.equal(
            journalSafe(`first line\nsecond ${token}`, token),
            "first line",
            "the first line only",
        );

        const http = journalFailure(
            Object.assign(new McpHttpError(500, `echo Bearer ${token}`, `echo ${token}`)),
            token,
        );

        assert.equal(http, "The notes server answered HTTP 500.");
        assert.match(journalFailure(new McpHttpError(401, "no"), token), /authentication failed/);
        assert.equal(
            journalFailure(new Error(`header value ${token} is bad`), token).includes(token),
            false,
        );
    });
});

describe("the journal at the desk", () => {
    before(async () => {
        process.env.PI_POCKET_TEAM_AGENTS = definitions;
        mkdirSync(definitions, { recursive: true });
        repository(repo);
        writeFileSync(
            join(definitions, "odrade.md"),
            "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
        );
        writeFileSync(
            join(definitions, "duncan.md"),
            `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/test: ${repo}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repository.`,
        );

        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
        cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), {
            recursive: true,
        });
        cpSync(join(import.meta.dirname, "desk.ts"), join(dropIns, "desk.ts"));
        cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), {
            recursive: true,
        });
        // A fake `gh`: every sweep reads this fixture, and nothing goes to GitHub.
        writeFileSync(
            fixturePath,
            JSON.stringify({ data: { viewer: { login: "github-viewer" } } }),
        );
        writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`);
        chmodSync(fakeGh, 0o755);
        process.env.PI_POCKET_DESK_GH = fakeGh;
        process.env.PI_POCKET_DESK_CONFIG = configPath;
        process.env.PI_POCKET_DESK_JOURNAL_TOKEN = tokenPath;
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
        journalOff();

        await startNotes();

        app = await openApp(model, dataDir, () => Date.now() + shift);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        await app.setExtensionEnabled(owner(app), "desk.ts", true);

        routes = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => routes?.listen(0, "127.0.0.1", resolve));
        routeBase = `http://127.0.0.1:${String((routes.address() as { port: number }).port)}/api/x/desk/`;
    });

    afterEach(async () => {
        await stopSweepers();
        await stopJournal();
        journalOff();
        process.env.PI_POCKET_DESK_JOURNAL_TOKEN = tokenPath;
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
        // The entries a test held back are the test's alone: the next test starts with no queue.
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(DeskThreads)).journal;
        }, context);
    });

    after(async () => {
        await new Promise<void>((resolve) => routes?.close(() => resolve()));
        await app?.close();
        await new Promise<void>((resolve) => notesServer?.close(() => resolve()));
        shift = 0;
        cleanUp();
    });

    test("a close the sweep makes queues 1 entry, and the writer makes the day's note", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-sweep");
        const id = await openThreadIn(source, () => undefined, "the blob sweep");

        await say(app, source, "desk sync test");
        await until(async () => (await deskState())?.threads[id]?.state === "closed", "the close");

        const closed = (await deskState())?.threads[id];

        assert.equal(closed?.closed?.outcome, "completed");
        assert.equal(typeof closed?.run.journaled, "number", "the entry is queued with the close");

        await drained();

        const { path, note } = await noteOf(closed?.closed?.at ?? Date.now());

        assert.match(note, /^# PocketJournal \d{4}-\d{2}-\d{2}\n\n/, "the note's start");
        assert.match(note, /^## \d\d:\d\d · Duncan Idaho · the blob sweep$/m, "the heading");
        assert(note.includes(`<!-- pocket-journal:${id} -->`), "the entry's marker");
        assert.match(
            note,
            /Duncan Idaho finished “the blob sweep” in frostyard\/test\./,
            "the template's sentences",
        );
        assert.deepEqual(
            notesCalls.map((each) => each.tool),
            ["read_note", "create_note"],
        );
        assert.equal(notesCalls[0]?.args.path, path);
        assert.equal((await deskState())?.journal?.writer, undefined, "the writer ended");
    });

    test("a watch pass from the tool queues 1 entry, with the outcome verified", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-result");
        const id = await openThreadIn(source, withWatch, "a dated check");

        await say(app, source, `desk result ${id} pass test`);
        await until(
            async () => typeof (await deskState())?.threads[id]?.run.journaled === "number",
            "the journal entry",
        );
        await drained();

        const closed = (await deskState())?.threads[id];

        assert.equal(closed?.state, "closed");
        assert.equal(closed?.closed?.outcome, "verified");

        const { note } = await noteOf(closed?.closed?.at ?? Date.now());

        assert.equal(note.split(`<!-- pocket-journal:${id} -->`).length - 1, 1, "1 entry");
        assert.match(note, /^## \d\d:\d\d · Duncan Idaho · a dated check$/m, "the heading");
        assert.match(note, /A dated check passed\./, "the verified template");
    });

    test("a watch pass from the page queues 1 entry, and a second pass adds none", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-page-result");
        const id = await openThreadIn(source, withWatch, "a page check");

        assert.equal(
            (await route(`threads/${id}/result`, { pass: true, text: "it passed" })).status,
            200,
        );
        await until(
            async () => typeof (await deskState())?.threads[id]?.run.journaled === "number",
            "the journal entry",
        );
        await drained();

        const closed = (await deskState())?.threads[id];
        const journaled = closed?.run.journaled;
        const { note } = await noteOf(closed?.closed?.at ?? Date.now());

        assert.equal(closed?.closed?.outcome, "verified");
        assert.equal(note.split(`<!-- pocket-journal:${id} -->`).length - 1, 1, "1 entry");

        // A second pass changes nothing: 1 entry, and the same time.
        assert.equal(
            (await route(`threads/${id}/result`, { pass: true, text: "again" })).status,
            200,
        );

        assert.equal((await deskState())?.threads[id]?.run.journaled, journaled);
        assert.equal(
            (await noteOf(Number(journaled ?? Date.now()))).note.split(
                `<!-- pocket-journal:${id} -->`,
            ).length - 1,
            1,
            "still 1 entry",
        );
    });

    test("an abandoned, frozen, dropped or failed close queues nothing", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-not");
        const abandoned = await openThreadIn(
            source,
            (thread) => {
                thread.prs["frostyard/test#1"] = {
                    via: "seen",
                    state: "CLOSED",
                    url: "https://github.com/frostyard/test/pull/1",
                    title: "closed unmerged",
                };
            },
            "an abandoned PR",
        );
        const frozen = await openThreadIn(
            source,
            (thread) => {
                thread.run.repoArchived = true;
            },
            "a frozen repository",
        );
        const failed = await openThreadIn(
            source,
            (thread) => {
                thread.state = "starting";
                thread.startedAt = Date.now() - 2 * 3600_000;
            },
            "a start that never came",
        );
        const dropped = await openThreadIn(source, () => undefined, "Brian's own PR");

        assert.equal(
            (await route(`threads/${dropped}/drop`, { reason: "Brian's own PR" })).status,
            200,
        );

        await say(app, source, "desk sync test");
        await until(async () => {
            const state = await deskState();

            return [abandoned, frozen, failed].every(
                (id) => state?.threads[id]?.state === "closed",
            );
        }, "the closes");

        const state = (await deskState())!;

        assert.equal(state.threads[abandoned]?.closed?.outcome, "abandoned");
        assert.equal(state.threads[frozen]?.closed?.outcome, "frozen");
        assert.equal(state.threads[failed]?.closed?.why, "failed");
        assert.equal(state.threads[dropped]?.closed?.why, "dropped");

        for (const id of [abandoned, frozen, failed, dropped]) {
            assert.equal(state.threads[id]?.run.journaled, undefined, `${id} queues no entry`);
        }

        assert.deepEqual(state.journal?.items ?? [], []);
        assert.deepEqual(notesCalls, [], "no write to the notes server");
    });

    test("a reopen and a second close add no second entry", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-reopen");
        const id = await openThreadIn(source, () => undefined, "a thread that reopens");

        await say(app, source, "desk sync test");
        await until(
            async () => (await deskState())?.threads[id]?.state === "closed",
            "the first close",
        );
        await drained();

        const closed = (await deskState())?.threads[id];
        const journaled = closed?.run.journaled;
        const { note } = await noteOf(closed?.closed?.at ?? Date.now());

        assert.equal(note.split(`<!-- pocket-journal:${id} -->`).length - 1, 1);

        // The thread reopens, and the next sweep closes it again.
        await app.harness.commit(async (tx) => {
            const thread = (await tx.doc(DeskThreads)).threads[id];

            if (thread === undefined) {
                throw new Error("the thread is gone");
            }

            thread.state = "open";
            delete thread.closed;
            thread.lastEventAt = Date.now();
        }, context);

        await say(app, source, "desk sync test");
        await until(
            async () => (await deskState())?.threads[id]?.state === "closed",
            "the second close",
            20_000,
        );

        assert.equal((await deskState())?.threads[id]?.run.journaled, journaled);
        assert.deepEqual((await deskState())?.journal?.items ?? [], []);
        assert.equal(
            (await noteOf(Number(journaled ?? Date.now()))).note,
            note,
            "the note does not change",
        );
    });

    test("without the journal key, a close queues nothing", async () => {
        resetNotes();
        journalOff();
        const source = await supervisor("journal-off");
        const id = await openThreadIn(source, () => undefined, "no journal");

        await say(app, source, "desk sync test");
        await until(async () => (await deskState())?.threads[id]?.state === "closed", "the close");

        const state = (await deskState())!;

        assert.equal(state.threads[id]?.closed?.outcome, "completed");
        assert.equal(state.threads[id]?.run.journaled, undefined);
        assert.equal(state.journal, undefined);
        assert.deepEqual(notesCalls, []);
    });

    test("the first entry makes the note, and the second appends, in close order", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-two");
        const one = await openThreadIn(source, () => undefined, "the first piece");
        const two = await openThreadIn(source, () => undefined, "the second piece");

        await say(app, source, "desk sync test");
        await until(async () => {
            const state = await deskState();

            return (
                state?.threads[one]?.state === "closed" && state?.threads[two]?.state === "closed"
            );
        }, "the closes");
        await drained();

        assert.deepEqual(
            notesCalls.map((each) => each.tool),
            ["read_note", "create_note", "read_note", "edit_note"],
            "a read and a create, then a read and an append",
        );

        const closed = (await deskState())?.threads[one]?.closed;
        const { note } = await noteOf(closed?.at ?? Date.now());
        const first = note.indexOf(`<!-- pocket-journal:${one} -->`);
        const second = note.indexOf(`<!-- pocket-journal:${two} -->`);

        assert(first >= 0 && second >= 0, "both entries are in the note");
        assert(first < second, "in close order");
        assert.equal(note.split("<!-- pocket-journal:").length - 1, 2, "2 entries");
        assert.match(note, /the first piece/);
        assert.match(note, /the second piece/);
    });

    test("the marker in the note stops a second write of the entry", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-marker");
        const id = await openThreadIn(source, () => undefined, "in already");
        const day = journalDay(Date.now(), JOURNAL_ZONE);
        const path = `PocketJournal/${day}.md`;
        const written = `# PocketJournal ${day}\n\n## 09:00 · Sheeana · an old entry\n<!-- pocket-journal:${id} -->\n\nIt is in.\n\n`;

        notes.set(path, written);

        await say(app, source, "desk sync test");
        await until(async () => (await deskState())?.threads[id]?.state === "closed", "the close");
        await drained();

        assert.deepEqual(
            notesCalls.map((each) => each.tool),
            ["read_note"],
            "the read, and no write",
        );
        assert.equal(notes.get(path), written, "the note does not change");
        assert.deepEqual((await deskState())?.journal?.items ?? [], []);
    });

    test("entries that wait with no writer get one at the next sweep", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-resume");
        // A thread that stays open: its watch is far away, so the sweep runs and closes nothing.
        const open = await openThreadIn(
            source,
            (thread) => {
                thread.watch = {
                    checkOn: "2099-01-01",
                    check: "a check far away",
                    setAt: Date.now(),
                    setBy: "brian",
                    key: "x.test.journal:watch",
                };
            },
            "still open",
        );
        // An entry that waits with no writer, as the journal leaves it when it was off, then on again.
        const at = Date.now();

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            state.journal = {
                items: [
                    {
                        thread: "T9999",
                        title: "an entry that waited",
                        agents: ["duncan"],
                        at,
                        outcome: "completed",
                        prs: [],
                    },
                ],
            };
        }, context);

        await say(app, source, "desk sync test");
        await drained();

        const { note } = await noteOf(at);

        assert.match(note, /<!-- pocket-journal:T9999 -->/);
        assert.equal(
            (await deskState())?.threads[open]?.state,
            "open",
            "the other thread stays open",
        );
    });

    test("a sync starts a writer for entries that wait, also with no open thread", async () => {
        resetNotes();
        journalOn();
        const source = await supervisor("journal-sync-resume");
        const at = Date.now();

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            state.journal = {
                items: [
                    {
                        thread: "T9998",
                        title: "an entry that waited, with no open thread",
                        agents: ["duncan"],
                        at,
                        outcome: "completed",
                        prs: [],
                    },
                ],
            };
        }, context);

        const open = Object.values((await deskState())?.threads ?? {}).filter(
            (thread) => thread.state !== "closed" && thread.supervisor === Number(source),
        );

        assert.equal(open.length, 0, "no open thread of this supervisor");

        await say(app, source, "desk sync test");
        await drained();

        assert.match((await noteOf(at)).note, /<!-- pocket-journal:T9998 -->/);
    });

    test("a server that echoes the token keeps it out of the stored failure", async () => {
        resetNotes();
        journalOn();
        notesEcho = true;
        const source = await supervisor("journal-echo");
        const id = await openThreadIn(source, () => undefined, "an echo");

        await say(app, source, "desk sync test");
        await until(async () => ((await deskState())?.journal?.failures ?? 0) >= 1, "the failure");

        const journal = (await deskState())?.journal;

        assert.equal(
            journal?.items.some((each) => each.thread === id),
            true,
            "the entry stays",
        );
        assert.equal(journal?.lastError, "The notes server answered HTTP 500");
        assert.equal(JSON.stringify(journal).includes(token), false, "no token in the state");
    });

    test("a token file that holds no valid token is a failure with no value in it", async () => {
        resetNotes();
        journalOn();
        writeFileSync(tokenPath, "lgm_part one\nlgm_part two\n");
        const source = await supervisor("journal-bad-token");

        await openThreadIn(source, () => undefined, "a bad token file");
        await say(app, source, "desk sync test");
        await until(async () => ((await deskState())?.journal?.failures ?? 0) >= 1, "the failure");

        const journal = (await deskState())?.journal;

        assert.match(journal?.lastError ?? "", /holds no valid token/);
        assert.equal(journal?.lastError?.includes("lgm_part"), false);
        assert.deepEqual(notesCalls, [], "nothing went to the server");
    });

    test("the model's good answer goes in the entry, and the call counts", async () => {
        resetNotes();
        journalOn({ model: "test/fake" });
        const calls: string[] = [];
        const shared = globalThis as unknown as Record<symbol, unknown>;

        shared[JOURNAL_COMPLETE] = async (_system: string, content: string) => {
            calls.push(content);

            return "The desk now keeps a journal. Each day gets its own note.";
        };

        try {
            const source = await supervisor("journal-model");
            const id = await openThreadIn(source, () => undefined, "the model's piece");

            await say(app, source, "desk sync test");
            await until(
                async () => (await deskState())?.threads[id]?.state === "closed",
                "the close",
            );
            await drained();

            const closed = (await deskState())?.threads[id]?.closed;

            assert.equal(calls.length, 1, "1 call");
            assert.match(
                (await noteOf(closed?.at ?? Date.now())).note,
                /The desk now keeps a journal\./,
            );
            assert.equal((await deskState())?.journal?.calls?.count, 1);
        } finally {
            delete shared[JOURNAL_COMPLETE];
        }
    });

    test("a restart during the model call gives the template, and no second call", async () => {
        resetNotes();
        journalOn({ model: "test/fake" });
        const shared = globalThis as unknown as Record<symbol, unknown>;
        let calls = 0;
        let release: (() => void) | undefined;

        // The call hangs until the test lets it go: the restart comes first.
        shared[JOURNAL_COMPLETE] = async () => {
            calls += 1;
            await new Promise<void>((resolve) => {
                release = resolve;
            });

            return "A late answer that nobody stores.";
        };

        try {
            const source = await supervisor("journal-model-restart");
            const id = await openThreadIn(source, () => undefined, "a call cut by a restart");

            await say(app, source, "desk sync test");
            await until(() => calls === 1, "the call");

            const closing = app.close();

            release?.();
            await closing;
            app = await openApp(model, dataDir, () => Date.now() + shift);
            await drained();

            const closed = (await deskState())?.threads[id]?.closed;
            const { note } = await noteOf(closed?.at ?? Date.now());

            assert.equal(calls, 1, "the call started once");
            assert.match(note, new RegExp(`<!-- pocket-journal:${id} -->`));
            assert.match(note, /finished “a call cut by a restart”/, "the template");
            assert.equal(note.includes("A late answer"), false);
        } finally {
            delete shared[JOURNAL_COMPLETE];
        }
    });

    test("a 401 waits, and keeps the entry", async () => {
        resetNotes();
        journalOn();
        // A token that lodge would not issue: the fake server answers 401, as lodge does.
        writeFileSync(tokenPath, "lgm_wrong_token\n");
        const source = await supervisor("journal-401");
        const id = await openThreadIn(source, () => undefined, "a bad token");

        await say(app, source, "desk sync test");
        await until(async () => ((await deskState())?.journal?.failures ?? 0) >= 1, "the failure");

        const journal = (await deskState())?.journal;

        assert.equal(
            journal?.items.filter((each) => each.thread === id).length,
            1,
            "the entry stays",
        );
        assert.match(journal?.lastError ?? "", /authentication/i);
        assert.equal(
            journal?.lastError?.includes("lgm_wrong_token"),
            false,
            "no token in the error",
        );
        assert.deepEqual(notesCalls, [], "no tool call got through");
        assert.equal(journal?.writer !== undefined, true, "the writer waits");
    });

    test("a server that is down waits, notices at the 3rd failure, then writes every entry in order", async () => {
        resetNotes();
        journalOn();
        notesDown = true;
        const source = await supervisor("journal-down");
        const tab = fakeTab(source, owner(app));

        await app.attach(tab.client);

        const one = await openThreadIn(source, () => undefined, "the first piece");
        const two = await openThreadIn(source, () => undefined, "the second piece");
        const failures = async () => (await deskState())?.journal?.failures ?? 0;
        const entryCalls = async () => (await deskState())?.journal?.items.length ?? 0;

        await say(app, source, "desk sync test");
        await until(async () => (await failures()) >= 1, "the first failure");

        const held = (await deskState())?.journal;

        assert.equal(
            held?.items.filter((each) => each.thread === one || each.thread === two).length,
            2,
            "both entries wait",
        );
        assert.equal(held?.failures, 1);
        assert.equal(typeof held?.lastError, "string");
        assert.equal(notesCalls.length, 0, "nothing reached the server");
        assert.equal((await deskState())?.threads[one]?.state, "closed");
        assert.equal((await deskState())?.threads[two]?.state, "closed");

        // The clock moves past the 5-minute wait, and the write fails again.
        await stopSweepers();
        await restartApp(6 * 60_000);
        await app.attach(tab.client);
        await until(async () => (await failures()) >= 2, "the second failure");
        assert.equal(await entryCalls(), 2, "the entries stay");

        // Past the 10-minute wait: the 3rd failure in a row, and 1 notice to the owner.
        await restartApp(17 * 60_000);
        await app.attach(tab.client);
        await until(async () => (await failures()) >= 3, "the third failure");
        assert.equal(await entryCalls(), 2, "the entries stay");
        await until(
            () =>
                tab.events.some(
                    (event) =>
                        event.event === "notice" &&
                        String(event.data.message).startsWith("The desk journal waits:"),
                ),
            "the notice",
            20_000,
        );

        // The server is up, and the clock passes the last wait: every entry, in close order.
        notesDown = false;
        await restartApp(38 * 60_000);
        await drained();

        assert.deepEqual(
            notesCalls.map((each) => each.tool),
            ["read_note", "create_note", "read_note", "edit_note"],
            "1 create, then 1 append",
        );

        const closed = (await deskState())?.threads[one]?.closed;
        const { note } = await noteOf(closed?.at ?? Date.now());
        const first = note.indexOf(`<!-- pocket-journal:${one} -->`);
        const second = note.indexOf(`<!-- pocket-journal:${two} -->`);

        assert(first >= 0 && second >= 0, "both entries are in the note");
        assert(first < second, "in close order");
        assert.equal((await deskState())?.journal?.failures, 0);
        assert.equal((await deskState())?.journal?.lastError, undefined);
        assert.deepEqual((await deskState())?.journal?.items ?? [], []);
    });
});
