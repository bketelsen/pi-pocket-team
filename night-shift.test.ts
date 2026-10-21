// Night shift: parsing, each stop reason, no second round or check after a restart, a person's message pauses it, and
// the check with Pi's status. Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
} from "/var/home/bjk/projects/pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    deepseekStart,
    DEFAULT_ROUNDS,
    type Goal,
    GoalDoc,
    nextClockTime,
    parseArgs,
    parseVerdict,
    personOf,
    standing,
    statusCard,
    waiting,
} from "./night-shift.ts";
import { statusItem } from "./night-shift-web/index.js";

const ZONE = "America/New_York";

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe("parsing", () => {
    // 2026-10-21 23:30 in New York (EDT, UTC-4).
    const now = Date.UTC(2026, 9, 22, 3, 30);

    test("the example: a deadline, a round limit, the objective, and the stop condition", () => {
        const parsed = parseArgs(
            "until 07:00 max 30: migrate X; stop when all tests pass and the PR is open",
            now,
            ZONE,
        );

        assert.equal(parsed.kind, "set");
        assert(parsed.kind === "set");
        assert.equal(parsed.goal.objective, "migrate X");
        assert.equal(parsed.goal.stop, "all tests pass and the PR is open");
        assert.equal(parsed.goal.maxRounds, 30);
        assert.equal(
            parsed.goal.deadline,
            Date.UTC(2026, 9, 22, 11, 0),
            "07:00 EDT the next morning",
        );
        assert.equal(parsed.goal.deadlineLabel, "07:00 EDT");
        assert.equal(parsed.goal.check, undefined);
    });

    test("defaults, a check command, `for`, am/pm, and `stop only when`", () => {
        const plain = parseArgs("Do X. Stop only when Y.", now, ZONE);

        assert(plain.kind === "set");
        assert.deepEqual(plain.goal, { objective: "Do X", stop: "Y.", maxRounds: DEFAULT_ROUNDS });

        const checked = parseArgs(
            "check `npm test -- --run` for 7h30m: fix it, stop when green",
            now,
            ZONE,
        );

        assert(checked.kind === "set");
        assert.equal(checked.goal.check, "npm test -- --run");
        assert.equal(checked.goal.deadline, now + 450 * 60_000);
        assert.equal(checked.goal.objective, "fix it");

        const pm = parseArgs("until 11:45pm: a; stop when b", now, ZONE);

        assert(pm.kind === "set");
        assert.equal(pm.goal.deadline, Date.UTC(2026, 9, 22, 3, 45), "later the same evening");

        const am = parseArgs("until 7am max 1 round: a; stop when b", now, ZONE);

        assert(am.kind === "set");
        assert.equal(am.goal.deadline, Date.UTC(2026, 9, 22, 11, 0));
        assert.equal(am.goal.maxRounds, 1);
    });

    test("subcommands and mistakes", () => {
        assert.equal(parseArgs("status", now, ZONE).kind, "status");
        assert.equal(parseArgs(" STOP ", now, ZONE).kind, "stop");
        assert.equal(parseArgs("resume", now, ZONE).kind, "resume");
        assert.equal(parseArgs("", now, ZONE).kind, "help");

        const mistakes: [string, RegExp][] = [
            ["migrate X", /Say when to stop/],
            ["stop when tests pass", /Say what to do/],
            ["max 101: a; stop when b", /1 to 100 rounds/],
            ["max 0: a; stop when b", /1 to 100 rounds/],
            ["until 25:00: a; stop when b", /not a time/],
            ["until 13pm: a; stop when b", /not a time/],
            ["for 25h: a; stop when b", /1 minute to 24 hours/],
            ["until 07:00 for 2h: a; stop when b", /one deadline/],
            ["check ``: a; stop when b", /empty/],
            ["a; stop when ", /stop condition/],
        ];

        for (const [args, message] of mistakes) {
            const parsed = parseArgs(args, now, ZONE);

            assert.equal(parsed.kind, "error", args);
            assert(parsed.kind === "error");
            assert.match(parsed.message, message, args);
        }
    });

    test("clock times hold across a daylight saving change", () => {
        // 2026-11-01 01:30 EDT; 07:00 that morning is EST (UTC-5).
        assert.equal(
            nextClockTime(7, 0, Date.UTC(2026, 10, 1, 5, 30), ZONE),
            Date.UTC(2026, 10, 1, 12, 0),
        );
        // At 08:00, 07:00 is tomorrow.
        assert.equal(
            nextClockTime(7, 0, Date.UTC(2026, 9, 22, 12, 0), ZONE),
            Date.UTC(2026, 9, 23, 11, 0),
        );
    });

    test("start: round 1 waits for a clock time, and the options come in any order", () => {
        const parsed = parseArgs("start 06:00 until 17:00 max 40: a; stop when b", now, ZONE);

        assert(parsed.kind === "set");
        assert.equal(parsed.goal.start, Date.UTC(2026, 9, 22, 10, 0));
        assert.equal(parsed.goal.startLabel, "06:00 EDT");
        assert.equal(parsed.goal.deadline, Date.UTC(2026, 9, 22, 21, 0));
        assert.equal(parsed.goal.maxRounds, 40);

        const anyOrder = parseArgs("max 40 until 17:00 start 6am: a; stop when b", now, ZONE);

        assert(anyOrder.kind === "set");
        assert.deepEqual(anyOrder.goal, parsed.goal);
    });

    test("start: `for` counts from start, and the mistakes", () => {
        const start = Date.UTC(2026, 9, 22, 10, 0);
        const eight = parseArgs("start 06:00 for 8h: a; stop when b", now, ZONE);

        assert(eight.kind === "set");
        assert.equal(eight.goal.start, start);
        assert.equal(eight.goal.deadline, start + 8 * 3600_000);
        assert.equal(parseArgs("start 06:00 for 24h: a; stop when b", now, ZONE).kind, "set");

        const mistakes: [string, RegExp][] = [
            ["start 06:00 until 05:00: a; stop when b", /not after start 06:00 EDT/],
            ["start 06:00 start 07:00: a; stop when b", /one start time/],
            ["start 25:00: a; stop when b", /not a time/],
            ["start 13pm: a; stop when b", /not a time/],
            ["start 06:00 for 25h: a; stop when b", /1 minute to 24 hours/],
        ];

        for (const [args, message] of mistakes) {
            const parsed = parseArgs(args, now, ZONE);

            assert.equal(parsed.kind, "error", args);
            assert(parsed.kind === "error");
            assert.match(parsed.message, message, args);
        }
    });

    test("start: a daylight saving change, and the 24-hour limit", () => {
        // 2026-10-31 23:00 EDT; 2026-11-01 06:00 is EST (UTC-5).
        const dst = parseArgs(
            "start 06:00 for 2h: a; stop when b",
            Date.UTC(2026, 10, 1, 3, 0),
            ZONE,
        );

        assert(dst.kind === "set");
        assert.equal(dst.goal.start, Date.UTC(2026, 10, 1, 11, 0));
        assert.equal(dst.goal.startLabel, "06:00 EST");
        assert.equal(dst.goal.deadline, Date.UTC(2026, 10, 1, 13, 0));

        // 2026-11-01 00:30 EDT: the next 00:15 is 24h45m away.
        const far = parseArgs("start 00:15: a; stop when b", Date.UTC(2026, 10, 1, 4, 30), ZONE);

        assert(far.kind === "error");
        assert.match(far.message, /at most 24 hours/);
    });

    test("a worker, and `with` twice", () => {
        const worker = parseArgs(
            "with github-copilot/claude-sonnet-5.5 until 07:00 max 25: a; stop when b",
            now,
            ZONE,
        );

        assert(worker.kind === "set");
        assert.equal(worker.goal.worker, "github-copilot/claude-sonnet-5.5");
        assert.equal(worker.goal.maxRounds, 25);
        assert.equal(worker.goal.deadline, Date.UTC(2026, 9, 22, 11, 0));
        assert.equal(worker.goal.start, undefined);

        const anyOrder = parseArgs(
            "max 25 with openai/gpt-6-astra until 07:00: a; stop when b",
            now,
            ZONE,
        );

        assert(anyOrder.kind === "set");
        assert.equal(anyOrder.goal.worker, "openai/gpt-6-astra");
        assert.deepEqual(
            { ...anyOrder.goal, worker: undefined },
            { ...worker.goal, worker: undefined },
        );

        const twice = parseArgs("with a/b with c/d: a; stop when b", now, ZONE);

        assert(twice.kind === "error");
        assert.match(twice.message, /Give one worker/);

        // No slash: not a worker option, so it stays in the objective.
        const plain = parseArgs("with nomodel: a; stop when b", now, ZONE);

        assert(plain.kind === "set");
        assert.equal(plain.goal.worker, undefined);
        assert.match(plain.goal.objective, /^with nomodel/);
    });

    test("DeepSeek's peak hours move round 1, unless a start is given", () => {
        assert.equal(deepseekStart(Date.UTC(2026, 9, 21, 2, 30)), Date.UTC(2026, 9, 21, 4, 0));
        assert.equal(deepseekStart(Date.UTC(2026, 9, 21, 7, 0)), Date.UTC(2026, 9, 21, 10, 0));
        assert.equal(deepseekStart(Date.UTC(2026, 9, 21, 5, 0)), undefined);
        assert.equal(deepseekStart(Date.UTC(2026, 9, 21, 12, 0)), undefined);

        // 2026-11-01 06:30 UTC is 01:30 EST, after the change.
        const after = parseArgs(
            "with deepseek/deepseek-flash: a; stop when b",
            Date.UTC(2026, 10, 1, 6, 30),
            ZONE,
        );

        assert(after.kind === "set");
        assert.equal(after.goal.start, Date.UTC(2026, 10, 1, 10, 0));
        assert.equal(after.goal.startLabel, "05:00 EST");
        assert.equal(after.goal.startWhy, "deepseek-peak");

        // 2026-10-31 06:30 UTC is 02:30 EDT.
        const before = parseArgs(
            "with deepseek/deepseek-flash: a; stop when b",
            Date.UTC(2026, 9, 31, 6, 30),
            ZONE,
        );

        assert(before.kind === "set");
        assert.equal(before.goal.startLabel, "06:00 EDT");

        // `for` counts from the end of the peak window.
        const peak = parseArgs(
            "with deepseek/deepseek-flash for 2h: a; stop when b",
            Date.UTC(2026, 9, 21, 7, 0),
            ZONE,
        );

        assert(peak.kind === "set");
        assert.equal(peak.goal.start, Date.UTC(2026, 9, 21, 10, 0));
        assert.equal(peak.goal.deadline, Date.UTC(2026, 9, 21, 12, 0));

        // An explicit start always wins.
        const explicit = parseArgs(
            "with deepseek/deepseek-flash start 08:00: a; stop when b",
            Date.UTC(2026, 9, 21, 7, 0),
            ZONE,
        );

        assert(explicit.kind === "set");
        assert.equal(explicit.goal.start, Date.UTC(2026, 9, 21, 12, 0));
        assert.equal(explicit.goal.startWhy, undefined);
    });

    test("a waiting goal's words", () => {
        const goal: Goal = {
            id: "wait",
            objective: "a",
            stop: "b",
            maxRounds: 40,
            start: Date.UTC(2026, 9, 22, 10, 0),
            startLabel: "06:00 EDT",
            deadline: Date.UTC(2026, 9, 22, 21, 0),
            deadlineLabel: "17:00 EDT",
            by: "u1",
            byName: "Brian",
            setAt: now,
            status: "running",
            round: 0,
            seen: 0,
            rounds: [],
        };

        assert.equal(waiting(goal, now), true);
        assert.equal(standing(goal, now), "waiting until 06:00 EDT (6h 30m), then until 17:00 EDT");
        assert.match(standing(goal, now), /waiting until 06:00 EDT/);
        assert.match(statusCard(goal, now), /waiting until 06:00 EDT/);
        assert.match(statusCard(goal, now), /stop cancels it/);
        assert.equal(
            statusItem({
                status: "running",
                waiting: true,
                startLabel: "06:00 EDT",
                round: 0,
                maxRounds: 40,
            }).text,
            "Night shift waiting until 06:00 EDT",
        );
    });

    test("a DeepSeek waiting goal says why, and a worker shows", () => {
        const goal: Goal = {
            id: "peak",
            objective: "a",
            stop: "b",
            maxRounds: 40,
            start: Date.UTC(2026, 9, 22, 10, 0),
            startLabel: "06:00 EDT",
            startWhy: "deepseek-peak",
            worker: "deepseek/deepseek-flash",
            by: "u1",
            byName: "Brian",
            setAt: now,
            status: "running",
            round: 0,
            seen: 0,
            rounds: [],
        };

        assert.equal(
            standing(goal, now),
            "waiting until 06:00 EDT (after DeepSeek's peak hours; 6h 30m left)",
        );
        assert.match(statusCard(goal, now), /Worker: deepseek\/deepseek-flash/);
    });

    test("Pi's status line, and whose a message is", () => {
        assert.deepEqual(parseVerdict("Did it.\n\nSTATUS: DONE: tests pass"), {
            verdict: "done",
            reason: "tests pass",
        });
        assert.deepEqual(parseVerdict("**STATUS: CONTINUE** — two files left"), {
            verdict: "continue",
            reason: "two files left",
        });
        assert.deepEqual(parseVerdict("STATUS: DONE: early\nSTATUS: BLOCKED: no token"), {
            verdict: "blocked",
            reason: "no token",
        });
        assert.equal(parseVerdict("All good, I think.").verdict, "none");

        assert.equal(personOf("wake up"), "A person");
        assert.equal(personOf("[from: Brian] wake up"), "Brian");
        assert.equal(personOf([{ type: "text", text: "[from: Ann] hi" }]), "Ann");
        assert.equal(personOf("[night-shift] Round 2 of 20."), undefined);
        assert.equal(personOf("[from: Brian] [via linked session session-1] do it"), undefined);
        assert.equal(personOf("[via PR watch] checks failed"), undefined);
        assert.equal(personOf("[scheduled] standup"), undefined);
        assert.equal(personOf("[subagent a answered, no reply needed] ok"), undefined);
    });

    test("the status line's words", () => {
        const goal = { round: 3, maxRounds: 30, deadlineLabel: "07:00 EDT" };

        assert.equal(
            statusItem({ ...goal, status: "running" }).text,
            "Night shift 3/30 · until 07:00 EDT",
        );
        assert.equal(statusItem({ ...goal, status: "paused" }).tone, "warn");
        assert.equal(
            statusItem({ ...goal, status: "ended", reason: "failed", reasonWord: "failed" }).tone,
            "error",
        );
    });
});

// ─── In a Pi Pocket ──────────────────────────────────────────────────────────

/** How far the app's clock is ahead: a test moves it past a deadline. */
let shift = 0;
/** Requests that wait for a test, by scenario. */
const gates = new Map<string, () => void>();
/** The rounds whose requests carried the night-shift prompt section, as "scenario n". */
const sectioned = new Set<string>();
/** Whether a request that is not a round carried the prompt section: it must not, before round 1. */
let sectionBeforeRound = false;
/** The last round request that carried the prompt section, as JSON. */
let sectionRequest = "";

function gate(name: string): Promise<void> {
    return new Promise((resolve) => gates.set(name, resolve));
}

function open(name: string): void {
    gates.get(name)?.();
    gates.delete(name);
}

const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

/**
 * Pi, scripted. The objective names the scenario; the round number comes from the round's message. A summary request
 * gets a summary.
 */
const route: FauxResponseStep = async (request, options) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return say("Wrote it.\nSTATUS: DONE: the file is there");
    }

    if (text.startsWith("[night-shift] The night shift has stopped")) {
        return say("Summary for the morning: I did the rounds. Nothing is left.");
    }

    const round = /^\[night-shift\] Round (\d+) of/.exec(text);
    const scenario = /Objective: (scenario-[a-z-]+)/.exec(text)?.[1];

    if (round === null && JSON.stringify(request).includes("This session runs a night shift")) {
        sectionBeforeRound = true;
    }

    if (round === null || scenario === undefined) {
        return say(`echo: ${text.slice(0, 40)}`);
    }

    const n = Number(round[1]);

    if (JSON.stringify(request).includes("This session runs a night shift")) {
        sectioned.add(`${scenario} ${n}`);
        sectionRequest = JSON.stringify(request);
    }
    const wait = async (name: string) => {
        await new Promise<void>((resolve) => {
            gates.set(name, resolve);
            options?.signal?.addEventListener("abort", () => resolve());
        });
    };

    switch (scenario) {
        case "scenario-done":
            return say(
                n === 1 ? "Half way.\nSTATUS: CONTINUE: one step left" : "STATUS: DONE: it works",
            );
        case "scenario-blocked":
            return say("STATUS: BLOCKED: the token is missing");
        case "scenario-worker":
            return say("STATUS: DONE: it works");
        case "scenario-deadline":
            shift = 3600_000;

            return say("STATUS: CONTINUE: more to do");
        case "scenario-person":
        case "scenario-stop":
        case "scenario-command":
        case "scenario-plan":
            if (n === 1) {
                await wait(scenario);
            }

            return say("STATUS: CONTINUE: more to do");
        case "scenario-spend":
            await recordCost(app, current!, 2);

            return say("STATUS: CONTINUE: more to do");
        case "scenario-replay":
            if (n === 2 && !replayed) {
                await wait(scenario);
            }

            return say(n === 3 ? "STATUS: DONE: all three" : "STATUS: CONTINUE: more");
        case "scenario-check":
            // Round 1: not done. Round 2: says DONE too early. Round 3: makes the check pass.
            if (n === 3) {
                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: "done.txt", content: "ok\n" })],
                    {
                        stopReason: "toolUse",
                    },
                );
            }

            return say(n === 1 ? "STATUS: CONTINUE: started" : "STATUS: DONE: I think so");
        case "scenario-cut":
            if (n === 2) {
                return fauxAssistantMessage(
                    [fauxToolCall("write", { path: "done.txt", content: "ok\n" })],
                    {
                        stopReason: "toolUse",
                    },
                );
            }

            return say("STATUS: DONE: maybe");
        default:
            return say("STATUS: CONTINUE: more");
    }
};

const model = scriptedModel(route);
const dataDir = join(root, "data");
let app: App;
/** The session of the scenario that runs. */
let current: ConversationId | undefined;
let replayed = false;

before(async () => {
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "night-shift.ts"), join(dropIns, "night-shift.ts"));
    cpSync(join(import.meta.dirname, "night-shift-web"), join(dropIns, "night-shift-web"), {
        recursive: true,
    });
    app = await openApp(model, dataDir, () => Date.now() + shift);
    await app.setExtensionEnabled(owner(app), "night-shift.ts", true);
});

after(async () => {
    for (const name of [...gates.keys()]) {
        open(name);
    }

    await app?.close();
    cleanUp();
});

async function session(name: string): Promise<ConversationId> {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });
    current = await newSession(app, folder);

    return current;
}

function command(id: ConversationId, args: string, user = owner(app)) {
    const commandId = app.webs.commands().find((each) => each.name === "night-shift")?.id;

    return app.extensionCommands.run(id, user, { commandId, args, requestId: crypto.randomUUID() });
}

/** A run its handler refused, with the words the person reads. */
function refused(result: { status?: string; message?: string }, words: RegExp): void {
    assert.equal(result.status, "failed");
    assert.match(result.message ?? "", words);
}

const goalOf = async (id: ConversationId): Promise<Goal | undefined> =>
    (await app.harness.snapshot(GoalDoc, id, context))?.goal;

async function settled(id: ConversationId, what = "the night shift to end"): Promise<Goal> {
    await until(
        async () => {
            const goal = await goalOf(id);

            return goal?.status === "ended" || goal?.status === "paused";
        },
        what,
        20_000,
    );
    await until(async () => !app.isBusy(id), "the session to go idle", 20_000);

    return (await goalOf(id))!;
}

/** The live driver tasks of a session. */
async function drivers(id: ConversationId): Promise<number> {
    const live = await app.harness.inspect(context);

    return live.tasks.filter(
        (task) => task.record.kind === "x.night-shift.driver" && task.record.conversationId === id,
    ).length;
}

/** The texts of the messages this module sent, oldest first. */
async function sent(id: ConversationId): Promise<string[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        500,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model))
        .filter((text) => text.includes("[night-shift]"))
        .map((text) => /\[night-shift\] (Round \d+|The night shift has stopped)/.exec(text)![1]!)
        .reverse();
}

/** The server's clock in ZONE, 3 hours from now, as "HH:MM"; and that time as epoch ms. */
function soon(): { hhmm: string; start: number } {
    const at = Date.now() + 3 * 3600_000;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: ZONE,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const hour = get("hour");
    const minute = get("minute");

    return {
        hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        start: nextClockTime(hour, minute, Date.now(), ZONE),
    };
}

describe("stop reasons", () => {
    test("done: Pi says the stop condition holds; then the summary for the morning", async () => {
        const id = await session("done");
        const card = await command(id, "max 5: scenario-done; stop when it works");

        assert.match(JSON.stringify(card), /Night shift set/);
        const goal = await settled(id);

        assert.equal(goal.reason, "done");
        assert.equal(goal.status, "ended");
        assert.equal(goal.round, 2);
        assert.deepEqual(
            goal.rounds.map((round) => [round.verdict, round.reason]),
            [
                ["continue", "one step left"],
                ["done", "it works"],
            ],
        );
        assert.deepEqual(await sent(id), ["Round 1", "Round 2", "The night shift has stopped"]);
        assert.equal(goal.driver, undefined);
    });

    test("max rounds; and the prompt section while it runs", async () => {
        const id = await session("max");

        await command(id, "max 3: scenario-max; stop when never");
        const goal = await settled(id);

        assert.equal(goal.reason, "max-rounds");
        assert.equal(goal.round, 3);
        assert.deepEqual(await sent(id), [
            "Round 1",
            "Round 2",
            "Round 3",
            "The night shift has stopped",
        ]);
        assert(
            sectioned.has("scenario-max 1") && sectioned.has("scenario-max 3"),
            "the section while it runs",
        );
        const view = await (await app.harness.conversation(id, context))!.context(context);

        assert.match(JSON.stringify(view.messages), /Last round you said CONTINUE: more/);
    });

    test("deadline", async () => {
        const id = await session("deadline");

        shift = 0;
        await command(id, "for 30m max 10: scenario-deadline; stop when never");
        const goal = await settled(id);

        shift = 0;
        assert.equal(goal.reason, "deadline");
        assert.equal(goal.round, 1, "the clock passed the deadline during round 1");
        assert.deepEqual(await sent(id), ["Round 1", "The night shift has stopped"]);
    });

    test("blocked", async () => {
        const id = await session("blocked");

        await command(id, "scenario-blocked; stop when done");
        const goal = await settled(id);

        assert.equal(goal.reason, "blocked");
        assert.match(goal.why!, /the token is missing/);
        assert.deepEqual(await sent(id), ["Round 1", "The night shift has stopped"]);
    });

    test("a person's message pauses it, and resume goes on", async () => {
        const id = await session("person");

        await command(id, "max 2: scenario-person; stop when never");
        await until(() => gates.has("scenario-person"), "round 1 to start");
        // A person writes while round 1 runs: the message waits for the round's answer.
        await app.commands.submit(id, owner(app), {
            text: "I am awake, hold on",
            requestId: crypto.randomUUID(),
        });
        open("scenario-person");
        let goal = await settled(id);

        assert.equal(goal.status, "paused");
        assert.equal(goal.reason, "person");
        assert.match(goal.why!, /A person wrote in the session/);
        assert.deepEqual(
            await sent(id),
            ["Round 1"],
            "no round 2, and no summary: the person is here",
        );

        const resumed = await command(id, "resume");

        assert.match(JSON.stringify(resumed), /resumed/);
        goal = await settled(id);
        assert.equal(goal.reason, "max-rounds");
        assert.deepEqual(await sent(id), ["Round 1", "Round 2", "The night shift has stopped"]);
    });

    test("Stop", async () => {
        const id = await session("stop");

        await command(id, "scenario-stop; stop when never");
        await until(() => gates.has("scenario-stop"), "round 1 to start");
        await app.commands.abort(id, owner(app));
        open("scenario-stop");
        const goal = await settled(id);

        assert.equal(goal.status, "ended");
        assert.equal(goal.reason, "stopped");
        assert.deepEqual(await sent(id), ["Round 1"]);
    });

    test("/night-shift stop: the round that runs finishes, and no other starts", async () => {
        const id = await session("command");

        await command(id, "scenario-command; stop when never");
        await until(() => gates.has("scenario-command"), "round 1 to start");
        const card = await command(id, "stop");

        assert.match(JSON.stringify(card), /stopped by/);
        open("scenario-command");
        await until(async () => !app.isBusy(id), "round 1 to end");
        await until(async () => (await drivers(id)) === 0, "the driver to read the answer and end");
        const goal = (await goalOf(id))!;

        assert.equal(goal.reason, "stopped");
        assert.match(goal.why!, /stopped it/);
        assert.deepEqual(await sent(id), ["Round 1"]);
    });

    test("a spend limit", async () => {
        const id = await session("spend");

        await app.spend.setSessionBudget(owner(app), id, 1);
        await command(id, "scenario-spend; stop when never");
        const goal = await settled(id);

        assert.equal(goal.status, "ended");
        assert.equal(goal.reason, "spend");
        assert.deepEqual(await sent(id), ["Round 1"], "no summary: Pi may not start");
    });

    test("plan mode pauses it, and a goal cannot start in plan mode", async () => {
        const id = await session("plan");

        await command(id, "scenario-plan; stop when never");
        await until(() => gates.has("scenario-plan"), "round 1 to start");
        await app.commands.setPlan(id, owner(app), true);
        open("scenario-plan");
        const goal = await settled(id);

        assert.equal(goal.status, "paused");
        assert.equal(goal.reason, "plan");
        refused(await command(id, "scenario-plan; stop when never"), /Plan mode is on/);
        refused(await command(id, "resume"), /Plan mode is on/);
        await app.commands.setPlan(id, owner(app), false);
    });
});

describe("workers", () => {
    test("the owner's allowed list holds the worker", async () => {
        const id = await session("worker-rules");

        refused(
            await command(id, "with nobody/nothing: a; stop when b"),
            /nobody\/nothing is not in the owner's allowed list for subagents\. Allowed: /,
        );
        assert.equal(await goalOf(id), undefined);
    });

    test("a worker goes in the prompt and the status, and only with one", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        const id = await session("worker");

        await command(id, "max 1 with faux/faux-2: scenario-worker; stop when never");
        const goal = await settled(id);

        assert.equal(goal.worker, "faux/faux-2");
        assert.equal(goal.rounds[0]?.worker, "faux/faux-2");
        assert.match(sectionRequest, /give execution to subagents on `faux\/faux-2`/);
        assert.match(statusCard(goal, Date.now()), /Worker: faux\/faux-2/);

        const plain = await session("worker-plain");

        await command(plain, "max 1: scenario-worker; stop when never");
        await settled(plain);
        assert.doesNotMatch(sectionRequest, /give execution to subagents on/);
    });

    test("resume checks the allowed list again", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        const id = await session("worker-resume");

        await command(id, "max 2 with faux/faux-2: scenario-blocked; stop when never");
        const goal = await settled(id);

        assert.equal(goal.worker, "faux/faux-2");
        assert.equal(goal.reason, "blocked");

        await app.setSubagentModels(owner(app), []);
        refused(
            await command(id, "resume"),
            /faux\/faux-2 is not in the owner's allowed list for subagents\. Allowed: none\./,
        );

        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
    });
});

describe("check command and status together", () => {
    test("DONE ends it only when the check passes; the check runs only after DONE", async () => {
        const id = await session("check");
        const folder = join(root, "check");

        await command(
            id,
            "max 5 check `printf x >> runs.txt; test -f done.txt`: scenario-check; stop when done.txt exists",
        );
        const goal = await settled(id);

        assert.equal(goal.reason, "done");
        assert.equal(goal.round, 3);
        assert.deepEqual(
            goal.rounds.map((round) => [round.verdict, round.check?.passed]),
            [
                ["continue", undefined],
                ["done", false],
                ["done", true],
            ],
        );
        assert.equal(
            readFileSync(join(folder, "runs.txt"), "utf8"),
            "xx",
            "after each DONE, not after CONTINUE",
        );
        const view = await (await app.harness.conversation(id, context))!.context(context);

        assert.match(
            JSON.stringify(view.messages),
            /but the check `printf x >> runs.txt; test -f done.txt` failed \(exit code 1\)/,
        );
    });

    test("only the owner sets a check, and people who cannot steer set nothing", async () => {
        const id = await session("rules");
        const guest = app.config.addUser("Gus", "guest", [String(id)]).user;
        const viewer = app.config.addUser("Vee", "viewer").user;

        refused(await command(id, "check `true`: a; stop when b", guest), /Only the owner/);
        await assert.rejects(command(id, "a; stop when b", viewer), { status: 403 });
        refused(await command(id, "max 500: a; stop when b"), /1 to 100 rounds/);
        assert.equal(await goalOf(id), undefined);
    });
});

describe("restarts", () => {
    test("a restart during a round sends no round twice", async () => {
        const id = await session("replay");

        await command(id, "max 5: scenario-replay; stop when three");
        await until(() => gates.has("scenario-replay"), "round 2 to start");
        assert.deepEqual(await sent(id), ["Round 1", "Round 2"]);
        // The server stops while Pi answers round 2.
        replayed = true;
        const closing = app.close();

        open("scenario-replay");
        await closing;
        app = await openApp(model, dataDir, () => Date.now() + shift);
        const goal = await settled(id);

        assert.equal(goal.reason, "done");
        assert.equal(goal.round, 3);
        assert.deepEqual(await sent(id), [
            "Round 1",
            "Round 2",
            "Round 3",
            "The night shift has stopped",
        ]);
        assert.deepEqual(
            goal.rounds.map((round) => round.n),
            [1, 2, 3],
        );
    });

    test("a check cut off by a restart does not run again; Pi hears so, and its next DONE is checked", async () => {
        const id = await session("cut");
        const folder = join(root, "cut");
        const runs = join(folder, "runs.txt");

        await command(
            id,
            "max 5 check `printf x >> runs.txt; if [ ! -f go ]; then sleep 30; fi; test -f done.txt`: scenario-cut; stop when done.txt exists",
        );
        await until(() => existsSync(runs), "the check to run", 20_000);
        await app.close();
        writeFileSync(join(folder, "go"), "");
        app = await openApp(model, dataDir, () => Date.now() + shift);
        const goal = await settled(id);

        assert.equal(goal.reason, "done");
        assert.equal(
            readFileSync(runs, "utf8"),
            "xx",
            "once when cut off, once after the next DONE",
        );
        assert.equal(goal.rounds[0]?.check?.cutOff, true);
        assert.equal(goal.rounds[1]?.check?.passed, true);
        const view = await (await app.harness.conversation(id, context))!.context(context);

        assert.match(JSON.stringify(view.messages), /was cut off by a server restart/);
    });
});

describe("start", () => {
    test("a restart during the wait starts round 1 once, at start", async () => {
        const id = await session("waits");
        const { hhmm, start } = soon();
        const card = await command(id, `start ${hhmm} max 2: scenario-wait; stop when never`);

        try {
            assert.match(JSON.stringify(card), /Round 1 starts at/);

            let goal = (await goalOf(id))!;

            assert.equal(goal.status, "running");
            assert.equal(goal.round, 0);
            assert.deepEqual(await sent(id), []);
            assert.equal(await drivers(id), 1);
            assert.match(JSON.stringify(await command(id, "status")), /waiting until/);

            // A person writes during the wait: no pause, and no round.
            sectionBeforeRound = false;
            await app.commands.submit(id, owner(app), {
                text: "still up",
                requestId: crypto.randomUUID(),
            });
            await until(
                async () => {
                    const page = await (await app.harness.conversation(id, context))!.entries(
                        {},
                        500,
                        undefined,
                        context,
                    );

                    return page.items.some(
                        (entry) =>
                            entry.kind === "pi.assistant" &&
                            JSON.stringify(entry.model ?? "").includes("still up"),
                    );
                },
                "Pi's answer",
                20_000,
            );

            assert.equal(sectionBeforeRound, false);
            goal = (await goalOf(id))!;
            assert.equal(goal.status, "running");
            assert.equal(goal.round, 0);

            // A restart before start sleeps again: no round.
            await app.close();
            app = await openApp(model, dataDir, () => Date.now() + shift);
            await until(async () => (await drivers(id)) === 1, "the driver to come back", 20_000);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            assert.deepEqual(await sent(id), []);
            assert.equal(await drivers(id), 1);
            assert.equal((await goalOf(id))!.round, 0);

            // A restart past start: round 1 at once, and no pause for the message written during the wait.
            await app.close();
            shift = start - Date.now() + 60_000;
            app = await openApp(model, dataDir, () => Date.now() + shift);
            goal = await settled(id);

            assert.equal(goal.reason, "max-rounds");
            assert.equal(goal.round, 2);
            assert.deepEqual(await sent(id), ["Round 1", "Round 2", "The night shift has stopped"]);
        } finally {
            shift = 0;
        }
    });

    test("/night-shift stop cancels a waiting goal", async () => {
        const id = await session("cancel-wait");
        const { hhmm } = soon();

        await command(id, `start ${hhmm} max 2: scenario-wait; stop when never`);
        // Let the driver reach its sleep and its watch.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const card = await command(id, "stop");

        assert.match(JSON.stringify(card), /cancelled/);
        await until(async () => (await drivers(id)) === 0, "the waiting driver to end", 10_000);
        const goal = (await goalOf(id))!;

        assert.equal(goal.status, "ended");
        assert.equal(goal.reason, "stopped");
        assert.deepEqual(await sent(id), []);
    });
});
