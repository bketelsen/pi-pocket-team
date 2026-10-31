// Team and the model router together: a delegated night shift gets a shadow route, a worker the supervisor named still
// runs (a router of version 2 records its suggestion beside it; an older one records `explicit`), a router that throws
// or hangs changes nothing, and a delegation without a night shift asks it nothing. The router module is not installed
// here: the test puts a fake API where the module publishes its own.
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
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DeskThreads, type Thread, threadOfSession } from "./desk.ts";
import { GoalDoc, type Goal } from "./night-shift.ts";

const TASK = "Tend the test repository";
const ROUTER = Symbol.for("pi-pocket-team.model-router");

/** The line a fake route gives: 1 sentence, as the router says it. */
const SHADOW_LINE =
    "Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: acme/suggested, thinking medium (no worker named; profile: faux/faux-2; shadow, not applied)";
const WORKER_LINE = "Route: high: acme/suggested (implement 1.9); named faux/faux-2 runs; shadow";
const EXPLICIT_LINE = "Route: worker faux/faux-2 named by the supervisor; the router did not run";

/** A route as the router module publishes one. With a `worker`, the route carries it, and says so in its line. */
const shadowRoute = (worker?: string) => ({
    mode: "shadow",
    status: "shadow",
    kind: "implement",
    kindConfidence: 0.82,
    complexity: 1.8,
    capability: 1.9,
    deepReasoning: 0.4,
    demand: 1.9,
    tier: "high",
    // A model that must never run: the test would see it if the router changed anything.
    model: "acme/suggested",
    thinking: "medium",
    profileModel: "faux/faux-2",
    ...(worker === undefined ? {} : { worker }),
    reason: "shadow: recorded only",
    at: Date.now(),
    line: worker === undefined ? SHADOW_LINE : WORKER_LINE,
});

type RouterCall = { brief: string; startAt: number; profileModel?: string; worker?: string };
type ExplicitCall = { worker: string; profileModel?: string };

/** A fake router on the global the module publishes: it answers, throws, or never answers. Version 1 is the old API. */
function fakeRouter(behaviour: "ok" | "throw" | "hang" = "ok", version = 2) {
    const calls: RouterCall[] = [];
    const explicitCalls: ExplicitCall[] = [];
    const shared = globalThis as unknown as Record<symbol, unknown>;

    shared[ROUTER] = {
        version,
        route: async (request: RouterCall) => {
            calls.push(request);

            if (behaviour === "throw") {
                throw new Error("the router fell over");
            }

            if (behaviour === "hang") {
                return new Promise(() => {});
            }

            return shadowRoute(request.worker);
        },
        explicit: (request: ExplicitCall) => {
            explicitCalls.push(request);

            return {
                mode: "shadow",
                status: "explicit",
                worker: request.worker,
                profileModel: request.profileModel,
                reason: "the supervisor named the worker",
                at: Date.now(),
                line: EXPLICIT_LINE,
            };
        },
    };

    return {
        calls,
        explicitCalls,
        remove: () => {
            delete shared[ROUTER];
        },
    };
}

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const teamCall = (args: object) =>
    fauxAssistantMessage([fauxToolCall("team_delegate", args)], { stopReason: "toolUse" });

/** Pi, scripted: the supervisor session asks for a delegation, and the linked session's own turns say little. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    if (text.startsWith("[night-shift] The night shift has stopped")) {
        return answer("SUMMARY-TEXT");
    }

    if (text.startsWith("[night-shift] Round")) {
        return answer("STATUS: DONE: it works");
    }

    if (text.includes("This task runs as a night shift")) {
        return answer("Night shift noted. I start in round 1.");
    }

    if (text.endsWith("worker route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", worker: "faux/faux-2" },
        });
    }

    if (text.endsWith("worker throw route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", worker: "faux/faux-2" },
        });
    }

    if (text.endsWith("worker hang route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done", worker: "faux/faux-2" },
        });
    }

    if (text.endsWith("throw route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done" },
        });
    }

    if (text.endsWith("hang route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done" },
        });
    }

    if (text.endsWith("plain route test")) {
        return teamCall({ agent: "duncan", repository: "frostyard/test", task: TASK });
    }

    if (text.endsWith("route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: "the work is done" },
        });
    }

    return answer(`echo: ${text.slice(0, 40)}`);
});

const dataDir = join(root, "data");
const definitions = join(root, "agents");
const repo = join(root, "repo");
const configPath = join(root, "desk.json");
const fixturePath = join(root, "gh.json");
const fakeGh = join(root, "gh");
let app: App;

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
    cpSync(join(import.meta.dirname, "desk.ts"), join(dropIns, "desk.ts"));
    // The dashboard helper that desk.ts imports.
    cpSync(join(import.meta.dirname, "_desk-dashboard.ts"), join(dropIns, "_desk-dashboard.ts"));
    cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), { recursive: true });
    cpSync(join(import.meta.dirname, "night-shift.ts"), join(dropIns, "night-shift.ts"));
    cpSync(join(import.meta.dirname, "night-shift-web"), join(dropIns, "night-shift-web"), {
        recursive: true,
    });

    // A fake `gh`: the desk's sweeps read this fixture and nothing goes to GitHub.
    writeFileSync(fixturePath, JSON.stringify({ data: { viewer: { login: "github-viewer" } } }));
    writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`);
    chmodSync(fakeGh, 0o755);
    process.env.PI_POCKET_DESK_GH = fakeGh;
    process.env.PI_POCKET_DESK_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));

    app = await openApp(model, dataDir, () => Date.now());
    // The profile model is in the owner's allowed list, so the linked session starts on it: the router changes nothing.
    await app.setSubagentModels(owner(app), ["faux/faux-2"]);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);
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
): ReturnType<typeof app.extensionCommands.run> {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, owner(app), {
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

const goalOf = async (id: ConversationId): Promise<Goal | undefined> =>
    (await app.harness.snapshot(GoalDoc, id, context))?.goal;

/** The desk thread of a session, as the desk stored it. */
async function threadOf(id: ConversationId): Promise<Thread | undefined> {
    return threadOfSession(await app.harness.snapshot(DeskThreads, context), Number(id));
}

/** Delegate with `words`, and give back the supervisor session and the linked session it started. */
async function delegate(
    name: string,
    words: string,
): Promise<{ source: ConversationId; linked: ConversationId }> {
    const source = await supervisor(name);

    await say(app, source, words);
    const linked = app
        .sessions()
        .filter((session) => session.linkedFrom?.id === Number(source))
        .at(-1);

    assert(linked, "the tool started a linked session");

    return { source, linked: linked.id as ConversationId };
}

describe("a delegated night shift and the model router", () => {
    test("a shift with no worker gets a shadow route, and no model changes", async () => {
        const router = fakeRouter();

        try {
            const { source, linked } = await delegate("route-shadow", "route night shift test");

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls.length, 1, "the router ran once");
            assert.match(
                router.calls[0].brief,
                /^Tend the test repository\n\nStop when: the work is done$/,
            );
            assert.equal(router.calls[0].profileModel, "faux/faux-2");
            assert.equal(typeof router.calls[0].startAt, "number");
            assert.equal(router.explicitCalls.length, 0);

            const goal = (await goalOf(linked))!;

            assert.equal(goal.worker, undefined, "the goal keeps no worker");

            const thread = await threadOf(linked);

            assert(thread, "the delegation opened a desk thread");
            assert.equal(thread.route?.status, "shadow");
            assert.equal(thread.route?.model, "acme/suggested");
            assert.equal(
                thread.events.filter((event) => event.key === "route").length,
                1,
                "1 route event",
            );
            const event = thread.events.find((each) => each.key === "route");

            assert.match(event?.text ?? "", /^Route: implement \(kind 0\.82\)/);
            assert.equal(event?.text.includes("\n"), false, "1 line");

            assert.match((await modelTexts(app, source)).join("\n"), /shadow, not applied/);
            assert.equal(
                app.sessions().find((session) => session.id === Number(linked))?.model,
                "faux-2",
                "the linked session is on the profile model, not on the router's suggestion",
            );
        } finally {
            router.remove();
        }
    });

    test("a worker the supervisor named still runs, and the router records a suggestion beside it", async () => {
        const router = fakeRouter();

        try {
            const { source, linked } = await delegate(
                "route-worker",
                "worker route night shift test",
            );

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls.length, 1, "the router ran once, beside the named worker");
            assert.equal(router.calls[0].worker, "faux/faux-2");
            assert.match(router.calls[0].brief, /^Tend the test repository\n\nStop when:/);
            assert.equal(router.explicitCalls.length, 0, "a version 2 router needs no `explicit`");

            const thread = await threadOf(linked);

            assert.equal(thread?.route?.status, "shadow");
            assert.equal(thread?.route?.worker, "faux/faux-2");
            assert.equal(thread?.route?.model, "acme/suggested");

            const events = thread?.events.filter((event) => event.key === "route") ?? [];

            assert.equal(events.length, 1, "1 route event");
            assert.equal(events[0]!.text, WORKER_LINE, "the desk event holds the whole line");
            assert.equal(events[0]!.text.includes("\n"), false, "1 line");
            assert.match((await modelTexts(app, source)).join("\n"), /named faux\/faux-2 runs/);

            // The named worker still wins: nothing the router said changes a model.
            assert.equal((await goalOf(linked))!.worker, "faux/faux-2");
            assert.equal(
                app.sessions().find((session) => session.id === Number(linked))?.model,
                "faux-2",
                "the linked session stays on its model, not on the router's suggestion",
            );
        } finally {
            router.remove();
        }
    });

    test("a router of version 1 gets `explicit` for a named worker, and no route call", async () => {
        const router = fakeRouter("ok", 1);

        try {
            const { linked } = await delegate("route-worker-v1", "worker route night shift test");

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls.length, 0, "an older router gets no Jev call");
            assert.equal(router.explicitCalls.length, 1);
            assert.deepEqual(router.explicitCalls[0], {
                worker: "faux/faux-2",
                profileModel: "faux/faux-2",
            });

            const thread = await threadOf(linked);

            assert.equal(thread?.route?.status, "explicit");
            assert.match(JSON.stringify(thread?.events), /the router did not run/);
            assert.equal((await goalOf(linked))!.worker, "faux/faux-2");
        } finally {
            router.remove();
        }
    });

    test("a router that throws or hangs beside a named worker records a failed route with the worker", async () => {
        for (const behaviour of ["throw", "hang"] as const) {
            const router = fakeRouter(behaviour);

            try {
                const { linked } = await delegate(
                    `route-worker-${behaviour}`,
                    `worker ${behaviour} route night shift test`,
                );

                await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

                assert.equal(router.calls.length, 1);
                assert.equal(router.calls[0].worker, "faux/faux-2");

                const route = (await threadOf(linked))?.route;

                assert.equal(route?.status, "failed");
                assert.equal(route?.worker, "faux/faux-2");
                assert.equal(
                    route?.reason,
                    behaviour === "throw" ? "the router failed" : "the router took more than 4 s",
                );
                assert.equal(
                    route?.line,
                    `Route: failed, named faux/faux-2 runs (${route?.reason})`,
                );
                assert.equal(
                    (await goalOf(linked))!.worker,
                    "faux/faux-2",
                    "the worker still runs",
                );
            } finally {
                router.remove();
            }
        }
    });

    test("a router that throws records a failed route, and the delegation goes on", async () => {
        const router = fakeRouter("throw");

        try {
            const { source, linked } = await delegate(
                "route-throw",
                "throw route night shift test",
            );

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls.length, 1);

            const route = (await threadOf(linked))?.route;

            assert.equal(route?.status, "failed");
            assert.equal(route?.reason, "the router failed");
            assert.equal(route?.model, undefined, "a failed route suggests no model");
            assert.match(
                (await modelTexts(app, source)).join("\n"),
                /Route: failed \(the router failed\); no worker named, nothing changes/,
            );
        } finally {
            router.remove();
        }
    });

    test("a router that never answers is cut off at 4 s, and the delegation goes on", async () => {
        const router = fakeRouter("hang");

        try {
            const started = Date.now();
            const { linked } = await delegate("route-hang", "hang route night shift test");

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls.length, 1);
            assert.equal((await threadOf(linked))?.route?.reason, "the router took more than 4 s");
            assert.equal(Date.now() - started >= 4000, true, "the guard waited about 4 s");
        } finally {
            router.remove();
        }
    });

    test("a restart while the router waits records a failed route, and asks once", async () => {
        const router = fakeRouter("hang");
        let thread: Thread | undefined;

        try {
            const source = await supervisor("route-restart");

            // Pi asks for the delegation; the tool then waits on a router that never answers. The answer is not
            // awaited: the app must stop while the call is still in flight.
            void say(app, source, "hang route night shift test").catch(() => undefined);
            await until(() => router.calls.length === 1, "the router to be asked", 20_000);

            await app.close();
            app = await openApp(model, dataDir, () => Date.now());

            // The tool runs again after the restart: the started memo is there, and the answer is not.
            await until(
                async () => {
                    const linked = app
                        .sessions()
                        .filter((session) => session.linkedFrom?.id === Number(source))
                        .at(-1);

                    if (linked === undefined) {
                        return false;
                    }

                    thread = await threadOf(linked.id as ConversationId);

                    return thread?.route !== undefined;
                },
                "the route to be recorded",
                20_000,
            );

            assert.equal(router.calls.length, 1, "1 call over both runs");
            assert.equal(thread?.route?.status, "failed");
            assert.equal(thread?.route?.reason, "interrupted by a server restart");
            assert.equal(
                thread?.route?.line,
                "Route: failed (interrupted by a server restart); no worker named, nothing changes",
            );
            assert.equal(
                thread?.events.filter((event) => event.key === "route").length,
                1,
                "1 route event",
            );
        } finally {
            router.remove();
        }
    });

    test("a restart while the router waits beside a named worker asks once, and keeps the worker", async () => {
        const router = fakeRouter("hang");
        let thread: Thread | undefined;

        try {
            const source = await supervisor("route-worker-restart");

            void say(app, source, "worker hang route night shift test").catch(() => undefined);
            await until(() => router.calls.length === 1, "the router to be asked", 20_000);

            await app.close();
            app = await openApp(model, dataDir, () => Date.now());

            await until(
                async () => {
                    const linked = app
                        .sessions()
                        .filter((session) => session.linkedFrom?.id === Number(source))
                        .at(-1);

                    if (linked === undefined) {
                        return false;
                    }

                    thread = await threadOf(linked.id as ConversationId);

                    return thread?.route !== undefined;
                },
                "the route to be recorded",
                20_000,
            );

            assert.equal(router.calls.length, 1, "1 call over both runs");
            assert.equal(thread?.route?.status, "failed");
            assert.equal(thread?.route?.worker, "faux/faux-2");
            assert.equal(
                thread?.route?.line,
                "Route: failed, named faux/faux-2 runs (interrupted by a server restart)",
            );
            assert.equal(
                thread?.events.filter((event) => event.key === "route").length,
                1,
                "1 route event",
            );
        } finally {
            router.remove();
        }
    });

    test("a delegation with no night shift asks the router nothing", async () => {
        const router = fakeRouter();

        try {
            const { linked } = await delegate("route-plain", "plain route test");

            await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

            assert.equal(router.calls.length, 0);
            assert.equal(router.explicitCalls.length, 0);
            assert.equal((await threadOf(linked))?.route, undefined);
        } finally {
            router.remove();
        }
    });
});
