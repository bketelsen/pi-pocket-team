// Team and Night shift together: a night shift that team_delegate starts in a linked session, its report back to the
// supervisor session, the replay key, the refusals, and the start wait. Pi Pocket's helpers isolate all credentials,
// sessions, and model calls.
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
} from "/var/home/bjk/projects/pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { delegatedRequest, type Goal, GoalDoc } from "./night-shift.ts";

const ZONE = "America/New_York";
const TASK = "Tend the test repository";
const SUMMARY = "SUMMARY-TEXT";

// ─── The delegated request ───────────────────────────────────────────────────

describe("delegatedRequest", () => {
    // 2026-10-21 23:30 in New York (EDT, UTC-4).
    const now = Date.UTC(2026, 9, 22, 3, 30);

    test("fields become one request: for counts from start, and there is no check", () => {
        const request = delegatedRequest(
            {
                objective: "  migrate X  ",
                stop_when: " all tests pass ",
                start: "06:00",
                for: "8h",
            },
            now,
            ZONE,
        );

        assert(!("error" in request));
        assert.equal(request.objective, "migrate X");
        assert.equal(request.stop, "all tests pass");
        assert.equal(request.maxRounds, 20);
        assert.equal(request.start, Date.UTC(2026, 9, 22, 10, 0));
        assert.equal(request.startLabel, "06:00 EDT");
        assert.equal(request.deadline, Date.UTC(2026, 9, 22, 18, 0));
        assert.equal(request.check, undefined);
    });

    test("a field carries only its own option", () => {
        for (const fields of [
            { objective: "a", stop_when: "b", until: "07:00 check `rm -rf /`" },
            { objective: "a", stop_when: "b", start: "06:00 start 07:00" },
            { objective: "a", stop_when: "b", for: "8h; stop when now" },
            { objective: "a", stop_when: "b", until: "07:00 until 07:30" },
        ]) {
            const request = delegatedRequest(fields, now, ZONE);

            assert("error" in request, JSON.stringify(fields));
        }
    });

    test("the cross-field rules hold", () => {
        const early = delegatedRequest(
            { objective: "a", stop_when: "b", start: "06:00", until: "05:00" },
            now,
            ZONE,
        );

        assert("error" in early);
        assert.match(early.error, /not after start 06:00 EDT/);

        const both = delegatedRequest(
            { objective: "a", stop_when: "b", until: "07:00", for: "2h" },
            now,
            ZONE,
        );

        assert("error" in both);

        const many = delegatedRequest({ objective: "a", stop_when: "b", max: 101 }, now, ZONE);

        assert("error" in many);
    });

    test("the worker is one option, and DeepSeek's peak hours apply", () => {
        const peak = Date.UTC(2026, 9, 21, 7, 0);
        const request = delegatedRequest(
            {
                objective: "a",
                stop_when: "b",
                worker: "github-copilot/claude-sonnet-5.5",
                start: "06:00",
                for: "8h",
            },
            now,
            ZONE,
        );

        assert(!("error" in request));
        assert.equal(request.worker, "github-copilot/claude-sonnet-5.5");
        assert.equal(request.deadline, Date.UTC(2026, 9, 22, 18, 0));

        for (const worker of [
            "openai/gpt-6-astra until 07:00",
            "openai/gpt-6-astra check `rm -rf /`",
            "nomodel",
        ]) {
            assert(
                "error" in delegatedRequest({ objective: "a", stop_when: "b", worker }, now, ZONE),
                worker,
            );
        }

        const deep = delegatedRequest(
            { objective: "a", stop_when: "b", worker: "deepseek/deepseek-flash", for: "2h" },
            peak,
            ZONE,
        );

        assert(!("error" in deep));
        assert.equal(deep.start, Date.UTC(2026, 9, 21, 10, 0));
        assert.equal(deep.startWhy, "deepseek-peak");
        assert.equal(deep.deadline, Date.UTC(2026, 9, 21, 12, 0));

        const explicit = delegatedRequest(
            { objective: "a", stop_when: "b", worker: "deepseek/deepseek-flash", start: "08:00" },
            peak,
            ZONE,
        );

        assert(!("error" in explicit));
        assert.equal(explicit.start, Date.UTC(2026, 9, 21, 12, 0));
        assert.equal(explicit.startWhy, undefined);
    });

    test("the objective and the stop condition must be there, and short enough", () => {
        assert("error" in delegatedRequest({ objective: " ", stop_when: "b" }, now, ZONE));
        assert("error" in delegatedRequest({ objective: "a", stop_when: "  " }, now, ZONE));
        assert(
            "error" in
                delegatedRequest(
                    { objective: "a".repeat(2000), stop_when: "b".repeat(1001) },
                    now,
                    ZONE,
                ),
        );
        assert.match(
            (
                delegatedRequest(
                    { objective: "a".repeat(2000), stop_when: "b".repeat(1001) },
                    now,
                    ZONE,
                ) as { error: string }
            ).error,
            /limited to 3000 characters/,
        );
    });
});

// ─── In a Pi Pocket ──────────────────────────────────────────────────────────

/** How far the app's clock is ahead: a test moves it past a start time. */
let shift = 0;
/** The start time the scripted model puts in a delegated night shift. */
let waitStart = "";
let app: App;

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const teamCall = (args: object) =>
    fauxAssistantMessage([fauxToolCall("team_delegate", args)], { stopReason: "toolUse" });

/**
 * Pi, scripted. The supervisor session asks for a delegation; the linked session's first message gets one short line,
 * its rounds get a status, and the summary request gets a fixed summary.
 */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    if (text.startsWith("[night-shift] The night shift has stopped")) {
        return answer(SUMMARY);
    }

    if (text.startsWith("[night-shift] Round")) {
        const objective = /Objective: [^\n]*/.exec(text)?.[0] ?? "";

        return answer(
            objective.includes("SCENARIO-CONTINUE")
                ? "STATUS: CONTINUE: more to do"
                : "STATUS: DONE: it works",
        );
    }

    if (text.includes("This task runs as a night shift")) {
        return answer("Night shift noted. I start in round 1.");
    }

    if (text.endsWith("allowed worker night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", worker: "faux/faux-2" },
        });
    }

    if (text.endsWith("worker night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", worker: "nobody/nothing" },
        });
    }

    if (text.endsWith("wait night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", start: waitStart },
        });
    }

    if (text.endsWith("check night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", check: "touch forbidden.txt" },
        });
    }

    if (text.endsWith("specialist night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done" },
        });
    }

    if (text.endsWith("night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done" },
        });
    }

    if (text.endsWith("delegate test")) {
        return teamCall({ agent: "duncan", repository: "frostyard/test", task: TASK });
    }

    return answer(`echo: ${text.slice(0, 40)}`);
});

const dataDir = join(root, "data");
const definitions = join(root, "agents");
const repo = join(root, "repo");

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;
    mkdirSync(definitions, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate Brian's team.",
    );
    writeFileSync(
        join(definitions, "duncan.md"),
        `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/test: ${repo}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repository.`,
    );
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    cpSync(join(import.meta.dirname, "night-shift.ts"), join(dropIns, "night-shift.ts"));
    cpSync(join(import.meta.dirname, "night-shift-web"), join(dropIns, "night-shift-web"), {
        recursive: true,
    });
    app = await openApp(model, dataDir, () => Date.now() + shift);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "night-shift.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Run one of a module's commands in a session, as the owner. */
function command(
    id: ConversationId,
    name: string,
    args: string,
    user = owner(app),
): ReturnType<typeof app.extensionCommands.run> {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, user, {
        commandId,
        args,
        requestId: crypto.randomUUID(),
    });
}

/** A new session that carries Odrade's identity. */
async function supervisor(name: string): Promise<ConversationId> {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });
    const id = await newSession(app, folder);

    await command(id, "team-agent", "odrade");

    return id;
}

/** The sessions linked from `id`. */
function linkedTo(id: ConversationId) {
    return app.sessions().filter((each) => each.linkedFrom?.id === Number(id));
}

const goalOf = async (id: ConversationId): Promise<Goal | undefined> =>
    (await app.harness.snapshot(GoalDoc, id, context))?.goal;

/** The live driver tasks of a session. */
async function drivers(id: ConversationId): Promise<number> {
    const live = await app.harness.inspect(context);

    return live.tasks.filter(
        (task) => task.record.kind === "x.night-shift.driver" && task.record.conversationId === id,
    ).length;
}

async function entries(id: ConversationId) {
    return (await app.harness.conversation(id, context))!.entries({}, 500, undefined, context);
}

async function settled(id: ConversationId): Promise<Goal> {
    await until(
        async () => {
            const goal = await goalOf(id);

            return goal?.status === "ended" || goal?.status === "paused";
        },
        "the night shift to stop",
        20_000,
    );

    return (await goalOf(id))!;
}

/** Delegate with `text`, and give back the supervisor session and the linked session it started. */
async function delegateShift(
    name: string,
    text: string,
): Promise<{ source: ConversationId; linked: ConversationId }> {
    const source = await supervisor(name);

    await say(app, source, text);
    const linked = linkedTo(source)[0];

    assert(linked, "the tool started a linked session");

    return { source, linked: linked.id as ConversationId };
}

/** The server's clock in ZONE, 3 hours from now, as "HH:MM". */
function soon(): string {
    const at = Date.now() + 3 * 3600_000;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: ZONE,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);

    return `${String(get("hour")).padStart(2, "0")}:${String(get("minute")).padStart(2, "0")}`;
}

describe("delegated goals", () => {
    test("the goal is set in the linked session, and its status card works there", async () => {
        const { linked } = await delegateShift("goal", "night shift test");

        await until(async () => (await goalOf(linked)) !== undefined, "the goal to be set", 20_000);
        const goal = (await goalOf(linked))!;

        assert.equal(goal.delegated?.supervisor, "Odrade");
        assert.equal(goal.by, owner(app).id);
        assert.equal(goal.objective, TASK, "the task is the objective when none is given");
        assert.equal(goal.stop, "the work is done");
        assert.equal(goal.maxRounds, 20);

        const card = await command(linked, "night-shift", "status");

        assert.match(JSON.stringify(card), /Night shift/);
    });

    test("the summary answer reaches the supervisor session by itself", async () => {
        const { source, linked } = await delegateShift("summary", "night shift test");
        const goal = await settled(linked);

        assert.equal(goal.reason, "done");
        assert.equal(goal.round, 1);
        await until(
            async () =>
                (await entries(source)).items.some(
                    (entry) =>
                        entry.kind === "pi.user" &&
                        JSON.stringify(entry.model).includes("Message from linked session") &&
                        JSON.stringify(entry.model).includes(SUMMARY),
                ),
            "the report in the supervisor session",
            20_000,
        );
        await until(() => !app.isBusy(source), "the supervisor to settle", 20_000);
        const report = (await entries(source)).items.find(
            (entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes(SUMMARY),
        );

        assert.match(
            JSON.stringify(report?.model),
            /Night shift report from this linked session: stopped at round 1 of 20: /,
        );
        assert.equal(linkedTo(source).length, 1, "one linked session for one delegate call");
    });

    test("a replayed key sets one goal and one driver", async () => {
        const source = await supervisor("replay");

        await say(app, source, "delegate test");
        const linked = linkedTo(source)[0]!.id as ConversationId;

        await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

        type Api = {
            delegatedRequest: typeof delegatedRequest;
            setDelegated: (
                tx: unknown,
                conversationId: ConversationId,
                request: object,
                who: object,
                key: string,
            ) => Promise<{ id: string }>;
            zone: () => string;
        };
        const api = (globalThis as unknown as Record<symbol, Api | undefined>)[
            Symbol.for("pi-pocket-team.night-shift")
        ];

        assert(api, "the night-shift module publishes its API");
        const request = api.delegatedRequest(
            { objective: "Replay the goal", stop_when: "done", start: soon() },
            Date.now(),
            api.zone(),
        );

        assert(!("error" in request));
        const who = { by: owner(app).id, byName: "Brian", supervisor: "Odrade" };
        const key = "x.test.replay-goal";
        const first = await app.harness.commit(
            (tx) => api.setDelegated(tx, linked, request, who, key),
            context,
        );
        const second = await app.harness.commit(
            (tx) => api.setDelegated(tx, linked, request, who, key),
            context,
        );

        assert.equal(first.id, second.id);
        assert.equal(await drivers(linked), 1, "one driver for the goal");
        assert.equal((await goalOf(linked))!.round, 0);
        assert.equal(linkedTo(source).length, 1, "the replay started no other session");
    });

    test("a check command is refused, and no linked session starts", async () => {
        const source = await supervisor("check-refused");
        const before = app.sessions().length;

        await say(app, source, "check night shift test");
        assert.match(
            (await modelTexts(app, source)).join("\n"),
            /cannot have a check command: the check does not go through Lancet Guard/,
        );
        assert.equal(app.sessions().length, before);
    });

    test("a specialist session cannot delegate a night shift", async () => {
        const source = await supervisor("specialist");

        await say(app, source, "delegate test");
        const linked = linkedTo(source)[0]!.id as ConversationId;

        await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);
        const before = app.sessions().length;

        await say(app, linked, "specialist night shift test");
        assert.match(
            (await modelTexts(app, linked)).join("\n"),
            /Only a session assigned a supervisor identity can delegate/,
        );
        assert.equal(app.sessions().length, before);
    });

    test("a worker outside the owner's list is refused, and no linked session starts", async () => {
        const source = await supervisor("worker-refused");
        const before = app.sessions().length;

        await say(app, source, "worker night shift test");
        assert.match(
            (await modelTexts(app, source)).join("\n"),
            /nobody\/nothing is not in the owner's allowed list for subagents/,
        );
        assert.equal(app.sessions().length, before);
    });

    test("an allowed worker reaches the goal, the rounds, and the report", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        const { source, linked } = await delegateShift("worker", "allowed worker night shift test");
        const goal = await settled(linked);

        assert.equal(goal.worker, "faux/faux-2");
        assert.equal(goal.rounds[0]?.worker, "faux/faux-2");
        await until(
            async () =>
                (await entries(source)).items.some(
                    (entry) =>
                        entry.kind === "pi.user" &&
                        JSON.stringify(entry.model).includes("Rounds: 1, worker: faux/faux-2."),
                ),
            "the report with the worker",
            20_000,
        );
    });

    test("a delegated start waits, and a restart past it runs round 1", async () => {
        waitStart = soon();

        try {
            const { source, linked } = await delegateShift("wait", "wait night shift test");

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);
            let goal = (await goalOf(linked))!;

            assert.equal(goal.status, "running");
            assert.equal(goal.round, 0);
            assert.equal(goal.delegated?.supervisor, "Odrade");
            assert(goal.start! - Date.now() > 2.9 * 3600_000);
            assert(goal.start! - Date.now() < 3.1 * 3600_000);
            assert.equal(await drivers(linked), 1);
            assert.equal(
                (await entries(linked)).items.filter(
                    (entry) =>
                        entry.kind === "pi.user" &&
                        JSON.stringify(entry.model).includes("[night-shift] Round"),
                ).length,
                0,
                "no round before start",
            );

            // A restart with the clock past start: round 1 runs once.
            await app.close();
            shift = goal.start! - Date.now() + 60_000;
            app = await openApp(model, dataDir, () => Date.now() + shift);
            goal = await settled(linked);

            assert.equal(goal.reason, "done");
            assert.equal(goal.round, 1);
            await until(
                async () =>
                    (await entries(source)).items.some(
                        (entry) =>
                            entry.kind === "pi.user" &&
                            JSON.stringify(entry.model).includes(SUMMARY),
                    ),
                "the report after the restart",
                20_000,
            );
        } finally {
            shift = 0;
        }
    });
});
