// Run-end answers and the desk: since Pi Pocket 0.28.0, a linked session's run end goes to the session that started it.
// The desk turns that off for each supervisor (`linkedSessions.reports`, since 0.28.0-bk.1), and Team sets it before
// each desk-tracked start. Each desk-tracked start here runs its child to a done, a failed and a stopped run, and the
// supervisor's session gets no run-end answer, no run and no model request. A `team_work` start keeps its answers. The
// model is scripted, and no test reaches Brian's data. A Pi Pocket with no switch skips the file.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    type App,
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
import { createHandler } from "./_pocket/src/server/http.ts";
import {
    DeskThreads,
    DIGEST_KINDS,
    openThread,
    reportsOffKey,
    type DeskState,
    type Thread,
} from "./desk.ts";
import { RUN_END, turnTexts } from "./scripted-turn-fixture.ts";

/** The switch is Pocket's `linkedSessions.reports`: a checkout whose types have none cannot run this file. */
const SKIP: string | false = /^\s*reports\(/m.test(
    readFileSync(join(import.meta.dirname, "_pocket", "types", "pocket.d.ts"), "utf8"),
)
    ? false
    : "needs linkedSessions.reports";

const dataDir = join(root, "data");
const definitions = join(root, "agents");
/** Duncan's delegation folder: no git, so a delegation makes no worktree. */
const duncanFolder = join(root, "duncan-test");
/** Duncan's repository for `team_work`: a git work tree, so the tool can make its worktree. */
const duncanRepo = join(root, "duncan-work");
const duncanHome = join(root, "duncan-home");
const lucillaHome = join(root, "lucilla-home");
const tegHome = join(root, "teg-home");
const paulHome = join(root, "paul-home");
const clerkFolder = join(root, "clerk-folder");
const plansFolder = join(root, "plans");
const configPath = join(root, "desk.json");
const fixturePath = join(root, "github.json");
const fakeGh = join(root, "fake-gh.sh");

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const toolCall = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** The return address in a linked session's first message. */
const addressIn = (request: unknown): string =>
    /Message from linked session (session-[0-9a-f-]+)/.exec(JSON.stringify(request))?.[1] ?? "";

/** The system text of each model request, in order: a test counts the requests of 1 session by its folder. */
const requests: string[] = [];

/** The system text of a request: Pi's prompt names the session's folder. */
function systemText(request: unknown): string {
    const value = request as {
        systemPrompt?: unknown;
        messages?: readonly { role: string; content: unknown }[];
    };

    return [
        typeof value.systemPrompt === "string" ? value.systemPrompt : "",
        ...(value.messages ?? [])
            .filter((message) => message.role === "system")
            // Pocket's system message keeps its text in sections: the environment section names the folder.
            .map((message) => JSON.stringify(message)),
    ].join("\n");
}

/** Pi, scripted: `run-tool <name> <json>` calls a tool; the children answer, fail, or stream until stopped. */
const script: Parameters<typeof scriptedModel>[0] = (request) => {
    requests.push(systemText(request));

    const { role } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    for (const text of turnTexts(request as never)) {
        const run = /run-tool (\S+) (\{.*\})\s*$/s.exec(text);

        if (run !== null) {
            return toolCall(run[1] ?? "", JSON.parse(run[2] ?? "{}") as object);
        }

        if (text.includes("RT-FAIL")) {
            return {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "the model fell over",
            } as never;
        }

        if (text.includes("RT-STREAM")) {
            return answer("word ".repeat(80_000));
        }

        if (text.includes("RT-REPORT")) {
            return toolCall("team_message", {
                to: addressIn(request),
                message: "Progress: the first part works.",
                status: "working",
            });
        }

        if (text.startsWith("[night-shift] The night shift has stopped")) {
            return answer("Summary: 3 rounds ran.\n\nASKS FOR BRIAN: none");
        }

        if (text.startsWith("[night-shift] Round")) {
            return answer("STATUS: CONTINUE: more to do");
        }

        if (text.includes("This task runs as a night shift")) {
            return answer("Night shift noted.");
        }

        if (text.includes("[plan-consult ")) {
            return answer("I read the plan.");
        }
    }

    return answer("Done.");
};

const model = scriptedModel(script);

// The helper queues 1000 responses: the children's runs of this file take many, so 1000 more.
model.appendResponses(Array.from({ length: 1000 }, () => script));

let app: App;
/** How far the app's clock is ahead: the Clerk's test moves it past its digests. */
let shift = 0;
let server: Server | undefined;
/** The base URL of the desk's routes. */
let base = "";

/** Every session run start and end, from the app's events. */
const runs: { kind: "started" | "ended"; id: number; outcome?: string }[] = [];
/** Every call of Pocket's switch: the source and the key. */
const switchCalls: { source: number; key: string }[] = [];
/** Every notice: its level, words and session. */
const notices: { level: string; message: string; conversationId?: number }[] = [];

const startedIn = (id: ConversationId) =>
    runs.filter((each) => each.kind === "started" && each.id === Number(id)).length;
const endedIn = (id: ConversationId, outcome?: string) =>
    runs.filter(
        (each) =>
            each.kind === "ended" &&
            each.id === Number(id) &&
            (outcome === undefined || each.outcome === outcome),
    ).length;
const requestsOf = (folder: string) => requests.filter((each) => each.includes(folder)).length;
const callsFor = (id: ConversationId) =>
    switchCalls.filter((each) => each.source === Number(id)).length;

const deskState = (): Promise<DeskState | undefined> => app.harness.snapshot(DeskThreads, context);

/** The texts of a session's user entries, oldest first, as the person or the sender wrote them. */
async function userTexts(id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages
        .filter((message) => message.role === "user")
        .map((message) =>
            typeof message.content === "string"
                ? message.content
                : (message.content as { type: string; text?: string }[])
                      .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
                      .join(""),
        );
}

/** The run-end answers a session got: its user entries that match RUN_END. */
const runEndAnswers = async (id: ConversationId) =>
    (await userTexts(id)).filter((text) => RUN_END.test(text)).length;

/** Run one of a module's commands in a session, as the owner. */
function command(id: ConversationId, name: string, args: string) {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, owner(app), {
        commandId,
        args,
        requestId: crypto.randomUUID(),
    });
}

/** A new session in its own folder that carries an agent's identity. */
async function session(
    name: string,
    agent = "odrade",
    folder = join(root, name),
): Promise<{ id: ConversationId; folder: string }> {
    mkdirSync(folder, { recursive: true });
    const id = await newSession(app, folder);

    await command(id, "team-agent", agent);
    // Pi works for the owner here from now on: Pocket's linked-session calls need that person.
    await say(app, id, "hello");

    return { id, folder };
}

/** Say `run-tool` in a session: its model calls the tool once. */
const runTool = (id: ConversationId, name: string, args: object) =>
    say(app, id, `run-tool ${name} ${JSON.stringify(args)}`);

/** Send a message as the owner, and do not wait: a failed or a stopped run is the point. */
const submit = (id: ConversationId, text: string) =>
    app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

/** The desk thread of a linked session. */
const threadOf = async (child: ConversationId): Promise<Thread | undefined> =>
    Object.values((await deskState())?.threads ?? {}).find(
        (thread) => thread.session === Number(child),
    );

/** The desk threads of a supervisor, oldest first. */
const threadsOf = async (supervisor: ConversationId): Promise<Thread[]> =>
    Object.values((await deskState())?.threads ?? {}).filter(
        (thread) => thread.supervisor === Number(supervisor),
    );

/** The newest linked session that `lead` started. */
function childOf(lead: ConversationId): ConversationId {
    const found = app
        .sessions()
        .filter((each) => each.linkedFrom?.id === Number(lead))
        .at(-1);

    assert(found, "the lead started a linked session");

    return found.id as ConversationId;
}

/**
 * A child's first run ended done; then 1 failed run and 1 stopped run, each waited on by its run end. The lead's
 * switch is read when a run ends, so a run end that sends nothing is settled when its event fired.
 */
async function threeOutcomes(child: ConversationId): Promise<void> {
    await until(() => endedIn(child, "done") >= 1 && !app.isBusy(child), "a done run", 30_000);

    const failed = endedIn(child, "failed");

    await submit(child, "RT-FAIL");
    await until(() => endedIn(child, "failed") === failed + 1, "a failed run", 30_000);
    await until(() => !app.isBusy(child), "the failed run to settle", 30_000);

    const aborted = endedIn(child, "aborted");

    await submit(child, "RT-STREAM");
    await until(() => app.isBusy(child), "the streaming run", 30_000);
    await app.commands.abort(child, owner(app));
    await until(() => endedIn(child, "aborted") === aborted + 1, "a stopped run", 30_000);
}

/** What a supervisor's session has now: its runs and its model requests, to compare after the start. */
function mark(supervisor: { id: ConversationId; folder: string }) {
    // The counts see this session: its own turns ran, and each of its requests names its folder.
    assert(startedIn(supervisor.id) > 0, "the supervisor's runs are counted");
    assert(requestsOf(supervisor.folder) > 0, "the supervisor's requests are counted");

    return { runs: startedIn(supervisor.id), requests: requestsOf(supervisor.folder) };
}

/** The supervisor got no run-end answer, no run and no model request since `before`. */
async function heardNothing(
    supervisor: { id: ConversationId; folder: string },
    since: { runs: number; requests: number },
    answers = 0,
): Promise<void> {
    assert.equal(await runEndAnswers(supervisor.id), answers, "no run-end answer");
    assert.equal(startedIn(supervisor.id), since.runs, "no run in the supervisor's session");
    assert.equal(requestsOf(supervisor.folder), since.requests, "no model request");
    assert.equal(app.isBusy(supervisor.id), false);
}

/** POST a desk route as the owner. */
async function route(
    path: string,
    body: object,
): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(base + path, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, data: (await response.json().catch(() => ({}))) as never };
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** A git work tree with 1 commit. */
function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });

    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: folder, env: gitEnv, stdio: "ignore" });

    git("init", "-q");
    writeFileSync(join(folder, "file.txt"), "one\n");
    git("add", ".");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "one");
}

/**
 * Open the app on the test's data folder, with its clock `shift` ahead, and watch it: its run starts and ends, the calls
 * of Pocket's switch, and its notices. A restart opens it again, and watches the new instance.
 */
async function openWatched(): Promise<void> {
    app = await openApp(model, dataDir, () => Date.now() + shift);

    const events = (
        app as unknown as {
            events: {
                on: (
                    name: string,
                    listener: (run: {
                        conversationId: number;
                        session: number;
                        outcome?: string;
                    }) => void,
                ) => () => void;
            };
        }
    ).events;

    for (const kind of ["started", "ended"] as const) {
        events.on(`run.${kind}`, (run) => {
            if (run.conversationId === run.session) {
                runs.push({
                    kind,
                    id: run.conversationId,
                    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
                });
            }
        });
    }

    // Count Pocket's switch calls: the host's `linkedSessions` is the app's.
    const linked = app.linkedSessions as unknown as Record<
        string,
        (source: ConversationId, request: { take: boolean }, key: string) => Promise<unknown>
    >;
    const reports = linked.reports!.bind(app.linkedSessions);

    linked.reports = async (source, request, key) => {
        switchCalls.push({ source: Number(source), key });

        return reports(source, request, key);
    };

    const notice = app.notice.bind(app);

    app.notice = (level, message, conversationId) => {
        notices.push({
            level,
            message,
            ...(conversationId === undefined ? {} : { conversationId: Number(conversationId) }),
        });
        notice(level, message, conversationId);
    };
}

/** Restart the app with its clock moved ahead by `by` milliseconds: a durable sleep that is due runs. */
async function restart(by: number): Promise<void> {
    await app.close();
    shift += by;
    await openWatched();
}

describe("run-end answers with the desk", { skip: SKIP }, () => {
    before(async () => {
        process.env.PI_POCKET_TEAM_AGENTS = definitions;

        for (const folder of [
            definitions,
            duncanFolder,
            duncanHome,
            lucillaHome,
            tegHome,
            paulHome,
            clerkFolder,
            plansFolder,
        ]) {
            mkdirSync(folder, { recursive: true });
        }

        repository(duncanRepo);
        writeFileSync(
            join(definitions, "odrade.md"),
            "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
        );
        writeFileSync(
            join(definitions, "duncan.md"),
            `---\nmodel: faux/faux-2\nhome: ${duncanHome}\nrepositories:\n  frostyard/test: ${duncanFolder}\n  frostyard/work: ${duncanRepo}\n---\n# Duncan Idaho\nYou are Duncan Idaho.`,
        );

        for (const [id, home] of [
            ["lucilla", lucillaHome],
            ["teg", tegHome],
            ["paul", paulHome],
        ] as const) {
            writeFileSync(
                join(definitions, `${id}.md`),
                `---\nmodel: faux/faux-2\nhome: ${home}\n---\n# ${id}\nYou are ${id}.`,
            );
        }

        writeFileSync(
            join(definitions, "clerk.md"),
            `---\nrole: clerk\nmodel: faux/faux-2\nworkspace: ${clerkFolder}\n---\n# Clerk\nYou are the desk clerk.`,
        );

        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });

        for (const file of [
            "team.ts",
            "desk.ts",
            "night-shift.ts",
            "_desk-usage.ts",
            "_desk-dashboard.ts",
            "_desk-metrics.ts",
        ]) {
            cpSync(join(import.meta.dirname, file), join(dropIns, file));
        }

        for (const folder of ["team-web", "desk-web", "night-shift-web"]) {
            cpSync(join(import.meta.dirname, folder), join(dropIns, folder), { recursive: true });
        }

        // A fake `gh`: every sweep reads this fixture, and nothing goes to GitHub.
        writeFileSync(
            fixturePath,
            JSON.stringify({ data: { viewer: { login: "github-viewer" } } }),
        );
        writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`, { mode: 0o755 });
        process.env.PI_POCKET_DESK_GH = fakeGh;
        process.env.PI_POCKET_DESK_CONFIG = configPath;
        // The digest holds every kind of news for an hour, so no desk message wakes a supervisor before a restart moves
        // the clock; with a Clerk, every kind goes to the Clerk.
        writeFileSync(
            configPath,
            JSON.stringify({
                digest: { minutes: 60, now: [], clerk: DIGEST_KINDS },
                cap: 100,
                plans: { root: plansFolder, max: 20 },
            }),
        );

        await openWatched();
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        await app.setExtensionEnabled(owner(app), "desk.ts", true);
        await app.setExtensionEnabled(owner(app), "night-shift.ts", true);

        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/api/x/desk/`;
    });

    after(async () => {
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        await app?.close();
    });

    test("a delegated task: done, failed and stopped runs send the supervisor nothing", async () => {
        const supervisor = await session("rt-delegate");

        await runTool(supervisor.id, "team_delegate", {
            agent: "duncan",
            repository: "frostyard/test",
            task: "RT-TASK one",
        });

        const since = mark(supervisor);
        const child = childOf(supervisor.id);

        assert(await threadOf(child), "the start is desk-tracked");
        assert.equal(app.sessionMeta(supervisor.id)?.linkedReports, false, "the switch is set");
        assert.equal(
            typeof (await deskState())?.reportsOff?.[String(Number(supervisor.id))]?.at,
            "number",
        );
        await threeOutcomes(child);
        await heardNothing(supervisor, since);
    });

    test("a night shift of 3 rounds sends the supervisor nothing", async () => {
        const supervisor = await session("rt-night");

        await runTool(supervisor.id, "team_delegate", {
            agent: "duncan",
            repository: "frostyard/test",
            task: "RT-TASK night",
            night_shift: { stop_when: "the work is done", max: 3 },
        });

        const since = mark(supervisor);
        const child = childOf(supervisor.id);

        await until(
            async () => typeof (await threadOf(child))?.run.reportedAt === "number",
            "the night shift's report",
            60_000,
        );
        // The first message, 3 rounds and the summary ran: a round can share a turn with the one before.
        const texts = (await userTexts(child)).join("\n");

        assert.match(texts, /\[night-shift\] Round 3 of 3/);
        assert.match(texts, /\[night-shift\] The night shift has stopped/);
        await threeOutcomes(child);
        await heardNothing(supervisor, since);
    });

    test("a planning session from team_delegate, and its plan consult, send the supervisor nothing", async () => {
        const supervisor = await session("rt-plan-tool");

        await runTool(supervisor.id, "team_delegate", {
            agent: "lucilla",
            repository: "home",
            title: "Snow ISO signing",
            task: "Sign the ISO with the TPM key.",
            plan: { start: true },
        });

        const since = mark(supervisor);
        const planning = childOf(supervisor.id);
        const thread = await threadOf(planning);

        assert.equal(thread?.origin, "plan");
        await until(
            () => endedIn(planning, "done") >= 1 && !app.isBusy(planning),
            "the plan's first run",
        );

        // The planning session files an ask, then asks 1 agent: the consult starts under the supervisor.
        await runTool(planning, "plan", {
            action: "ask",
            section: "idea",
            text: "Where do the keys live?",
            options: ["TPM", "A file"],
        });

        const ask = (await deskState())?.threads[thread!.id]?.asks[0]?.id ?? "";

        await runTool(planning, "plan", {
            action: "consult",
            agents: ["paul"],
            question: "Do TPM keys survive a re-image?",
            ask,
        });

        const consult = (await deskState())?.plans?.[thread!.id]?.consults[0];

        assert(consult?.session !== undefined, "the consult started");
        assert.equal(
            app.sessionMeta(consult.session as unknown as ConversationId)?.linkedFrom?.id,
            Number(supervisor.id),
            "the consult's lead is the supervisor",
        );
        await threeOutcomes(consult.session as unknown as ConversationId);
        await threeOutcomes(planning);
        await heardNothing(supervisor, since);
    });

    test("a planning session from the Desk page's New plan sends the supervisor nothing", async () => {
        const supervisor = await session("rt-plan-page");
        const since = mark(supervisor);
        const started = await route(`plans/new/${String(supervisor.id)}`, {
            title: "Page plan",
            idea: "Rotate the signing key each year.",
            lead: "teg",
            key: "rt-new-plan-key-1",
        });

        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(app.sessionMeta(supervisor.id)?.linkedReports, false, "the switch is set");
        await threeOutcomes(Number(started.data.session) as unknown as ConversationId);
        await heardNothing(supervisor, since);
    });

    test("a session started before the switch: its later runs send nothing; an archived child neither", async () => {
        const supervisor = await session("rt-before");
        const plain = await app.linkedSessions.start(
            supervisor.id,
            // Its own folder: the requests of the supervisor's session are counted by the supervisor's folder.
            { message: "RT-TASK plain", model: "faux/faux-2", cwd: duncanFolder },
            "rt-plain",
        );

        // Before the switch, the run end reaches the supervisor: 1 answer, as Pocket sends it.
        await until(async () => (await runEndAnswers(supervisor.id)) === 1, "the answer before");
        await until(() => !app.isBusy(supervisor.id), "the supervisor to settle", 30_000);
        await runTool(supervisor.id, "team_delegate", {
            agent: "duncan",
            repository: "frostyard/test",
            task: "RT-TASK after",
        });

        const since = mark(supervisor);
        const thread = (await threadsOf(supervisor.id))[0] ?? assert.fail("the thread");
        const child = thread.session as unknown as ConversationId;
        const address = thread.address ?? assert.fail("the thread's address");

        await submit(plain.session, "RT-TASK again");
        await until(() => endedIn(plain.session, "done") >= 2, "the plain session's second run");
        await threeOutcomes(plain.session);
        await until(() => endedIn(child, "done") >= 1 && !app.isBusy(child), "the child's run");

        // An archived child of the supervisor: its run ends after the archive.
        await app.linkedSessions.archive(supervisor.id, { to: address }, "rt-archive");
        assert.equal(app.sessionMeta(child)?.archived, true);

        const sent = await app.linkedSessions.send(
            supervisor.id,
            { to: address, message: "RT-TASK archived" },
            "rt-archived-send",
        );

        assert.equal(sent.answers, false, "send says the supervisor takes no answers");
        await until(() => endedIn(child, "done") >= 2, "the archived child's run");
        await threeOutcomes(child);
        await heardNothing(supervisor, since, 1);
    });

    test("team_work from an agent's home keeps its answers: 1 for each run", async () => {
        const home = await session("rt-home", "duncan", duncanHome);

        await runTool(home.id, "team_work", { repository: "frostyard/work", task: "RT-TASK work" });

        const child = childOf(home.id);

        assert.equal(app.sessionMeta(home.id)?.linkedReports, undefined, "no switch on a home");
        await until(
            async () => (await runEndAnswers(home.id)) === 1,
            "the done run's answer",
            30_000,
        );
        await threeOutcomes(child);
        await until(async () => (await runEndAnswers(home.id)) === 3, "the 3 answers", 30_000);
        await until(() => !app.isBusy(home.id), "the home to settle", 30_000);
        assert.equal(await runEndAnswers(home.id), 3, "exactly 1 answer for each run");
        assert.equal(callsFor(home.id), 0, "no switch call for a home");
    });

    test("a failed switch is 1 warning; the next sweep calls again and records it; a replay calls nothing", async () => {
        const supervisor = await session("rt-failed");
        const desk = (globalThis as unknown as Record<symbol, Record<string, unknown>>)[
            Symbol.for("pi-pocket-team.desk")
        ] as {
            reportsOff: (
                api: { snapshot: unknown; commit: unknown },
                context: unknown,
                supervisor: number,
            ) => Promise<void>;
        };
        const api = {
            snapshot: (...args: unknown[]) =>
                Reflect.apply(app.harness.snapshot, app.harness, args),
            commit: (...args: unknown[]) => Reflect.apply(app.harness.commit, app.harness, args),
        };
        const warnings = () =>
            notices.filter(
                (each) =>
                    each.level === "warning" &&
                    each.conversationId === Number(supervisor.id) &&
                    /could not turn off automatic run-end answers/.test(each.message),
            ).length;

        await app.commands.setPlan(supervisor.id, owner(app), true);
        await desk.reportsOff(api, context, Number(supervisor.id));
        await desk.reportsOff(api, context, Number(supervisor.id));
        assert.equal(callsFor(supervisor.id), 2, "each call reached Pocket");
        assert.equal(warnings(), 1, "1 warning for 2 failures in the hour");
        assert.equal((await deskState())?.reportsOff?.[String(Number(supervisor.id))], undefined);
        assert.notEqual(app.sessionMeta(supervisor.id)?.linkedReports, false);
        await app.commands.setPlan(supervisor.id, owner(app), false);

        // A thread makes the session a desk supervisor; its next sync starts the task that calls again.
        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            openThread(state, {
                key: "rt-failed-thread",
                supervisor: Number(supervisor.id),
                agents: ["duncan"],
                title: "A thread to sweep",
                at: Date.now(),
            });
        }, context);
        await runTool(supervisor.id, "desk", { action: "sync" });
        await until(
            async () =>
                (await deskState())?.reportsOff?.[String(Number(supervisor.id))] !== undefined,
            "the switch recorded by the sweep",
            30_000,
        );
        assert.equal(callsFor(supervisor.id), 3);
        assert.equal(
            switchCalls.filter((each) => each.source === Number(supervisor.id)).at(-1)?.key,
            reportsOffKey(Number(supervisor.id)),
        );
        assert.equal(app.sessionMeta(supervisor.id)?.linkedReports, false);
        await until(
            async () =>
                (await deskState())?.reportsOffTasks?.[String(Number(supervisor.id))] === undefined,
            "the task to drop its record",
        );

        // A replay: a second sweep, a start, and a list make no second call.
        await runTool(supervisor.id, "desk", { action: "sync" });
        await runTool(supervisor.id, "team_delegate", {
            agent: "duncan",
            repository: "frostyard/test",
            task: "RT-TASK replay",
        });
        await runTool(supervisor.id, "desk", { action: "list" });
        assert.equal(callsFor(supervisor.id), 3, "no second call once recorded");
        const view = await (await app.harness.conversation(supervisor.id, context))!.context(
            context,
        );

        assert.match(
            JSON.stringify(view.messages),
            /Run-end answers: off since \d{4}-\d{2}-\d{2}T/,
            "desk list shows the switch",
        );
        assert.equal(warnings(), 1, "no warning after the call worked");
    });

    test("a reload of the desk keeps the 1-hour limit of the failure warning", async () => {
        const supervisor = await session("rt-reload");
        const symbol = Symbol.for("pi-pocket-team.desk");

        type ReportsOff = (
            api: { snapshot: unknown; commit: unknown },
            context: unknown,
            supervisor: number,
        ) => Promise<void>;
        const deskNow = () =>
            (globalThis as unknown as Record<symbol, { reportsOff: ReportsOff } | undefined>)[
                symbol
            ] ?? assert.fail("the desk publishes its API");
        const api = {
            snapshot: (...args: unknown[]) =>
                Reflect.apply(app.harness.snapshot, app.harness, args),
            commit: (...args: unknown[]) => Reflect.apply(app.harness.commit, app.harness, args),
        };
        const warnings = () =>
            notices.filter(
                (each) =>
                    each.level === "warning" &&
                    each.conversationId === Number(supervisor.id) &&
                    /could not turn off automatic run-end answers/.test(each.message),
            ).length;

        await app.commands.setPlan(supervisor.id, owner(app), true);

        try {
            const before = deskNow();

            await before.reportsOff(api, context, Number(supervisor.id));
            assert.equal(warnings(), 1, "the first failure warns");
            assert.equal(
                typeof (await deskState())?.reportsOffNoticed?.[String(Number(supervisor.id))],
                "number",
                "the warning's time is stored",
            );

            // A reload: the desk module loads again, with nothing in memory from the load before.
            await app.setExtensionEnabled(owner(app), "desk.ts", false);
            await app.setExtensionEnabled(owner(app), "desk.ts", true);

            const after = deskNow();

            assert.notEqual(after, before, "the desk loaded again");
            await after.reportsOff(api, context, Number(supervisor.id));
            assert.equal(callsFor(supervisor.id), 2, "both calls reached Pocket");
            assert.equal(warnings(), 1, "no second warning within the hour, also after a reload");
        } finally {
            await app.commands.setPlan(supervisor.id, owner(app), false);
        }
    });

    // Last: it restarts the app with its clock moved ahead, and the page's server keeps the first instance.
    test("a Clerk that takes 2 digests sends the supervisor nothing", async () => {
        const supervisor = await session("rt-clerk");

        await runTool(supervisor.id, "team_delegate", { agent: "clerk", task: "Run the desk." });

        const clerk = (await deskState())?.clerks?.[String(Number(supervisor.id))];

        assert(clerk, "the Clerk is registered");
        assert.equal(app.sessionMeta(supervisor.id)?.linkedReports, false, "the switch is set");
        await runTool(supervisor.id, "team_delegate", {
            agent: "duncan",
            repository: "frostyard/test",
            task: "RT-REPORT first",
        });

        const since = mark(supervisor);
        const clerkId = clerk.session as unknown as ConversationId;
        const reporter = (await threadsOf(supervisor.id))[0]?.session as unknown as ConversationId;

        assert(reporter !== undefined && Number(reporter) !== clerk.session, "the reporter");

        const digests = async () =>
            (await userTexts(clerkId)).filter((text) => text.includes("[desk] digest:")).length;

        /** The report waits in the box; a restart an hour later sends the Clerk its digest. */
        const digestOf = async (count: number) => {
            await until(() => !app.isBusy(reporter), "the reporter to settle", 30_000);
            await until(
                async () =>
                    ((await deskState())?.digests?.[String(Number(supervisor.id))]?.items.length ??
                        0) > 0,
                "the report in the box",
                30_000,
            );
            await restart(61 * 60_000);
            await until(
                async () => (await digests()) === count,
                `the Clerk's digest ${String(count)}`,
                30_000,
            );
        };

        await digestOf(1);
        await submit(reporter, "RT-REPORT second");
        await until(
            () => app.isBusy(reporter) || endedIn(reporter, "done") >= 2,
            "the second report",
        );
        await digestOf(2);
        await until(() => !app.isBusy(clerkId), "the Clerk to settle", 30_000);
        assert(endedIn(clerkId, "done") >= 2, "the Clerk's runs ended done");
        await threeOutcomes(clerkId);
        await threeOutcomes(reporter);
        await heardNothing(supervisor, since);
    });
});

after(() => {
    cleanUp();
});
