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
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DeskThreads, type Thread, threadOfSession } from "./desk.ts";
import { GoalDoc, type Goal } from "./night-shift.ts";
import { ROUTE_GUARD_MS, type RouteMemo, routeOnce } from "./team.ts";

const TASK = "Tend the test repository";
const ROUTER = Symbol.for("pi-pocket-team.model-router");

/** The line a fake route gives: 1 sentence, as the router says it. */
const SHADOW_LINE =
    "Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: acme/suggested, thinking medium (no worker named; profile: faux/faux-2; shadow, not applied)";
const WORKER_LINE = "Route: high: acme/suggested (implement 1.9); named faux/faux-2 runs; shadow";
const EXPLICIT_LINE = "Route: worker faux/faux-2 named by the supervisor; the router did not run";

/** The features a fake router gives: the shape of the router's `Features`, version 1. */
const FEATURES = {
    v: 1,
    briefChars: 42,
    pathsNamed: 1,
    reposNamed: 1,
    language: "other",
    riskPathNamed: null,
    testsBeside: false,
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A route as the router module publishes one. With a `worker`, the route carries it, and says so in its line. It
 * carries features and no `briefHash`: team.ts adds the hash for a router that keeps none.
 */
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
    features: {
        ...FEATURES,
        kind: "implement",
        complexity: 1.8,
        capability: 1.9,
        deepReasoning: 0.4,
        demand: 1.9,
    },
    reason: "shadow: recorded only",
    at: Date.now(),
    line: worker === undefined ? SHADOW_LINE : WORKER_LINE,
});

type RouterCall = {
    brief: string;
    startAt: number;
    profileModel?: string;
    worker?: string;
    repoDirs?: string[];
    roster?: string[];
    shift?: boolean;
    repo?: string;
    threadId?: string;
};
type ExplicitCall = { worker: string; profileModel?: string };

/**
 * A fake router on the global the module publishes: it answers, throws, never answers, records the mode off, or
 * records Jev's failure (as the real router does: features with no Jev fields, and the brief's hash). Version 1 is the
 * old API; version 3 also publishes `features`.
 */
function fakeRouter(
    behaviour: "ok" | "throw" | "hang" | "off" | "jev-failed" | "assign" = "ok",
    version = 3,
    assigned = "faux/faux-1",
) {
    const calls: RouterCall[] = [];
    const explicitCalls: ExplicitCall[] = [];
    const featureCalls: {
        brief: string;
        repoDirs: readonly string[];
        roster?: readonly string[];
    }[] = [];
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

            if (behaviour === "off") {
                return {
                    mode: "off",
                    status: "off",
                    ...(request.worker === undefined ? {} : { worker: request.worker }),
                    features: FEATURES,
                    briefHash: sha256(request.brief),
                    reason: "the router's mode is off",
                    at: Date.now(),
                    line: "Route: off (the router's mode is off); nothing changes",
                };
            }

            if (behaviour === "jev-failed") {
                return {
                    mode: "shadow",
                    status: "failed",
                    ...(request.worker === undefined ? {} : { worker: request.worker }),
                    features: FEATURES,
                    briefHash: sha256(request.brief),
                    reason: "Jev returned the status 500",
                    at: Date.now(),
                    line: "Route: failed (Jev returned the status 500); no worker named, nothing changes",
                };
            }

            if (behaviour === "assign") {
                // A router in mode assign on a live band: it assigns even beside a named worker here, so the test
                // sees that team.ts lets a named worker win.
                return {
                    ...shadowRoute(request.worker),
                    mode: "assign",
                    status: "assigned",
                    tier: "easy",
                    tierRule: "v1",
                    model: assigned,
                    thinking: "high",
                    arm: "A",
                    assigned,
                    assignedThinking: "high",
                    reason: "assign: arm A",
                    line: `Route: v1 easy: arm A assigned ${assigned}, thinking high (implement 1.9); assign`,
                };
            }

            return shadowRoute(request.worker);
        },
        ...(version >= 3
            ? {
                  features: (
                      brief: string,
                      repoDirs: readonly string[],
                      roster?: readonly string[],
                  ) => {
                      featureCalls.push({ brief, repoDirs, roster });

                      return FEATURES;
                  },
              }
            : {}),
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
        featureCalls,
        remove: () => {
            delete shared[ROUTER];
        },
    };
}

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const teamCall = (args: object) =>
    fauxAssistantMessage([fauxToolCall("team_delegate", args)], { stopReason: "toolUse" });

/** The stop line of the assigned shift's goal: its round requests, and no other, hold it. */
const ASSIGN_MARK = "the assigned shift is done (assign-round-mark)";

/** Each round request a linked session sent, as JSON: the prompt section is in it. */
const roundRequests: string[] = [];

/** Pi, scripted: the supervisor session asks for a delegation, and the linked session's own turns say little. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role !== "toolResult" && text.startsWith("[shift] Round")) {
        roundRequests.push(JSON.stringify(request));
    }

    if (role === "toolResult") {
        return answer("ok");
    }

    if (text.startsWith("[shift] The shift has stopped")) {
        return answer("SUMMARY-TEXT");
    }

    if (text.startsWith("[shift] Round")) {
        return answer("STATUS: DONE: it works");
    }

    if (text.includes("This task runs as a shift")) {
        return answer("Shift noted. I start in round 1.");
    }

    // The assigned shift's own stop line marks its rounds: a test finds that round, not a round of another session.
    if (text.endsWith("assign marked route night shift test")) {
        return teamCall({
            agent: "duncan",
            repository: "frostyard/test",
            task: TASK,
            night_shift: { stop_when: ASSIGN_MARK },
        });
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
    cpSync(join(import.meta.dirname, "_desk-usage.ts"), join(dropIns, "_desk-usage.ts"));
    cpSync(join(import.meta.dirname, "_desk-dashboard.ts"), join(dropIns, "_desk-dashboard.ts"));
    cpSync(join(import.meta.dirname, "_desk-metrics.ts"), join(dropIns, "_desk-metrics.ts"));
    cpSync(join(import.meta.dirname, "_desk-board.ts"), join(dropIns, "_desk-board.ts"));
    cpSync(join(import.meta.dirname, "_desk-meter.ts"), join(dropIns, "_desk-meter.ts"));
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
            assert.deepEqual(router.calls[0].repoDirs, [repo], "the roster checkout");
            assert.deepEqual(
                router.calls[0].roster,
                ["frostyard/test"],
                "the roster's repositories",
            );
            assert.equal(router.explicitCalls.length, 0);

            const goal = (await goalOf(linked))!;

            assert.equal(goal.worker, undefined, "the goal keeps no worker");

            const thread = await threadOf(linked);

            assert(thread, "the delegation opened a desk thread");
            assert.equal(thread.route?.status, "shadow");
            assert.equal(thread.route?.model, "acme/suggested");
            assert.equal(
                thread.route?.features?.kind,
                "implement",
                "the router's features are kept",
            );
            assert.equal(thread.route?.features?.pathsNamed, 1);
            assert.equal(
                thread.route?.briefHash,
                sha256(router.calls[0].brief),
                "team.ts adds the hash a router did not keep",
            );
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
            assert.deepEqual(
                route?.features,
                FEATURES,
                "the features still record, with no Jev field",
            );
            assert.equal(route?.briefHash, sha256(router.calls[0].brief));
            assert.deepEqual(router.featureCalls, [
                { brief: router.calls[0].brief, repoDirs: [repo], roster: ["frostyard/test"] },
            ]);
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

    test("a delegation with no night shift records a route, and its result and model are as before", async () => {
        const router = fakeRouter();

        try {
            const { source, linked } = await delegate("route-plain", "plain route test");

            await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

            assert.equal(router.calls.length, 1, "the router ran once");
            assert.equal(router.calls[0].brief, TASK, "the task is the brief");
            assert.equal(router.calls[0].worker, undefined, "no night shift: no worker");
            assert.deepEqual(router.calls[0].repoDirs, [repo]);

            const thread = await threadOf(linked);

            assert.equal(thread?.route?.status, "shadow");
            assert.equal(thread?.route?.worker, undefined);
            assert.equal(thread?.route?.features?.v, 1);
            assert.equal(thread?.route?.briefHash, sha256(TASK));
            assert.equal(
                thread?.events.filter((event) => event.key === "route").length,
                1,
                "1 route event",
            );
            assert.equal(await goalOf(linked), undefined, "no goal");

            const result = (await modelTexts(app, source)).find((text) =>
                text.includes("Assigned to"),
            );

            assert.equal(result?.includes("Route:"), false, "the result names no route");
            assert.equal(
                app.sessions().find((session) => session.id === Number(linked))?.model,
                "faux-2",
            );
        } finally {
            router.remove();
        }
    });

    test("with the router off, a delegation records why, and the features", async () => {
        const router = fakeRouter("off");

        try {
            const { linked } = await delegate("route-off", "plain route test");

            await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

            const route = (await threadOf(linked))?.route;

            assert.equal(route?.status, "off");
            assert.equal(route?.reason, "the router's mode is off");
            assert.deepEqual(route?.features, FEATURES);
            assert.equal(route?.briefHash, sha256(TASK));
            assert.equal(route?.kind, undefined, "no Jev field");
        } finally {
            router.remove();
        }
    });

    test("a Jev failure records why, and the features with no Jev field", async () => {
        const router = fakeRouter("jev-failed");

        try {
            const { linked } = await delegate("route-jev", "plain route test");

            await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

            const route = (await threadOf(linked))?.route;

            assert.equal(route?.status, "failed");
            assert.equal(route?.reason, "Jev returned the status 500");
            assert.deepEqual(route?.features, FEATURES);
            assert.equal(route?.features?.kind, undefined);
            assert.equal(route?.briefHash, sha256(TASK));
            assert.equal(
                router.featureCalls.length,
                0,
                "the router's own route holds the features",
            );
        } finally {
            router.remove();
        }
    });

    test("the model, the worker and the result are the same with and without the router", async () => {
        /**
         * A result with its session address and thread id taken out, and the route's line, which a night shift's result
         * names when there is a route: what is left must not change.
         */
        const resultOf = async (source: ConversationId, line?: string) =>
            (await modelTexts(app, source))
                .find((text) => text.includes("Assigned to"))!
                .replace(/session-[0-9a-f-]+/g, "<address>")
                .replace(/Thread T\d+/g, "Thread <id>")
                .replace(line === undefined ? /^$/ : ` ${line}.`, "");

        const run = async (name: string, words: string) => {
            const { source, linked } = await delegate(name, words);

            await until(() => !app.isBusy(linked), "the linked task to settle", 20_000);

            const route = (await threadOf(linked))?.route;

            return {
                model: app.sessions().find((session) => session.id === Number(linked))?.model,
                worker: (await goalOf(linked))?.worker,
                result: await resultOf(source, route?.line),
                route,
            };
        };

        for (const words of ["worker route night shift test", "plain route test"]) {
            const router = fakeRouter();
            let routed;

            try {
                routed = await run(`same-routed-${words.length}`, words);
            } finally {
                router.remove();
            }

            const plain = await run(`same-plain-${words.length}`, words);

            assert.notEqual(routed.route, undefined, "the router recorded a route");
            assert.equal(plain.route, undefined, "no router, no route");
            assert.equal(routed.model, plain.model, `${words}: the session's model`);
            assert.equal(routed.worker, plain.worker, `${words}: the worker`);
            assert.equal(routed.result, plain.result, `${words}: the result`);
        }
    });
});

describe("the router's assignment (router v4, mode assign)", () => {
    test("an assigned worker and its thinking go in the goal and the rounds; the profile model stays", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2", "faux/faux-1"]);
        const router = fakeRouter("assign", 4);

        try {
            const { linked } = await delegate(
                "route-assign",
                "assign marked route night shift test",
            );

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            const thread = await threadOf(linked);

            assert.equal(router.calls.length, 1);
            assert.equal(router.calls[0].shift, true, "the router hears it is a shift");
            assert.equal(router.calls[0].repo, "frostyard/test");
            assert.equal(router.calls[0].threadId, thread?.id, "the desk thread sets the arm");

            const goal = (await goalOf(linked))!;

            assert.equal(goal.worker, "faux/faux-1", "the assigned worker");
            assert.equal(goal.workerThinking, "high", "its thinking level");
            assert.equal(thread?.route?.status, "assigned");
            assert.equal(thread?.route?.arm, "A");
            assert.equal(thread?.route?.assigned, "faux/faux-1");
            assert.equal(
                app.sessions().find((session) => session.id === Number(linked))?.model,
                "faux-2",
                "the linked session stays on the profile model",
            );

            const ownRound = () => roundRequests.find((request) => request.includes(ASSIGN_MARK));

            await until(() => ownRound() !== undefined, "round 1 of this shift", 20_000);
            assert.match(
                ownRound()!,
                /give execution to subagents on `faux\/faux-1` and thinking `high`/,
            );
        } finally {
            router.remove();
            await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        }
    });

    test("a named worker wins over an assignment, and an assigned model off the allowed list is not used", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2", "faux/faux-1"]);

        try {
            const named = fakeRouter("assign", 4);

            try {
                const { linked } = await delegate(
                    "route-assign-named",
                    "worker route night shift test",
                );

                await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

                const goal = (await goalOf(linked))!;

                assert.equal(goal.worker, "faux/faux-2", "the named worker runs");
                assert.equal(goal.workerThinking, undefined);
                assert.equal("workerThinking" in goal, false);
            } finally {
                named.remove();
            }

            const offList = fakeRouter("assign", 4, "acme/not-allowed");

            try {
                const { linked } = await delegate(
                    "route-assign-off-list",
                    "route night shift test",
                );

                await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

                const goal = (await goalOf(linked))!;

                assert.equal(goal.worker, undefined, "a model off the allowed list is not set");
                assert.equal(goal.workerThinking, undefined);
            } finally {
                offList.remove();
            }
        } finally {
            await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        }
    });

    test("an assigned route from a memo is not applied when the shift module is older than version 4", async () => {
        await app.setSubagentModels(owner(app), ["faux/faux-2", "faux/faux-1"]);
        // The fake answers `assigned` with no thread id: as a memo written before a reload to an older shift module.
        const router = fakeRouter("assign", 4);
        const shiftApi = (globalThis as unknown as Record<symbol, { version: number }>)[
            Symbol.for("pi-pocket-team.night-shift")
        ]!;
        const version = shiftApi.version;

        shiftApi.version = 3;

        try {
            const { linked } = await delegate("route-assign-old-shift", "route night shift test");

            await until(async () => (await goalOf(linked)) !== undefined, "the goal", 20_000);

            assert.equal(router.calls[0].threadId, undefined, "no thread for an arm");
            assert.equal((await threadOf(linked))?.route?.status, "assigned", "the memo's route");

            const goal = (await goalOf(linked))!;

            assert.equal(goal.worker, undefined, "an older shift module gets no assigned worker");
            assert.equal("workerThinking" in goal, false);
        } finally {
            shiftApi.version = version;
            router.remove();
            await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        }
    });

    test("a delegation with no shift tells the router so, and gives it no thread for an arm", async () => {
        const router = fakeRouter("assign", 4);

        try {
            const { linked } = await delegate("route-assign-plain", "plain route test");

            await until(
                async () => (await threadOf(linked))?.route !== undefined,
                "the route",
                20_000,
            );

            assert.equal(router.calls[0].shift, false);
            assert.equal(router.calls[0].threadId, undefined);
            assert.equal(await goalOf(linked), undefined, "no goal, so no worker");
        } finally {
            router.remove();
        }
    });

    test("a replay reads the assigned route from the memo: the same arm and worker, and no second ask", async () => {
        const stored = {
            status: "assigned",
            tierRule: "v1",
            tier: "easy",
            arm: "B",
            assigned: "deepseek/deepseek-flash",
        };
        const memo: RouteMemo<typeof stored> = {
            stored: async () => stored,
            keep: async (value) => value,
            started: async () => true,
            start: async () => undefined,
        };
        let asked = 0;
        const route = await routeOnce(
            memo,
            async () => {
                asked += 1;

                return { ...stored, arm: "A", assigned: "github-copilot/gpt-6-luna" };
            },
            () => ({ ...stored, status: "failed" }),
        );

        assert.equal(asked, 0);
        assert.equal(route.arm, "B");
        assert.equal(route.assigned, "deepseek/deepseek-flash");
    });
});

describe("routeOnce: 1 route for 1 call, over every replay", () => {
    /** A memo in memory, as a tool call's memo keeps it. */
    function memoryMemo<R>(route?: R, started?: boolean) {
        const held: { route?: R; started?: boolean } = { route, started };

        const memo: RouteMemo<R> = {
            stored: async () => held.route,
            keep: async (value) => (held.route = value),
            started: async () => held.started,
            start: async () => (held.started = true),
        };

        return { memo, held };
    }

    type Recorded = { status: string; reason?: string; features?: object; briefHash?: string };

    test("a replay of an older memo, with no features, gives it back as it is, and asks nothing", async () => {
        const older: Recorded = { status: "shadow", reason: "shadow: recorded only" };
        const { memo, held } = memoryMemo<Recorded>(older, true);
        let asked = 0;
        const route = await routeOnce<Recorded>(
            memo,
            async () => {
                asked += 1;

                return { status: "shadow", features: FEATURES, briefHash: "x" };
            },
            (reason) => ({ status: "failed", reason }),
        );

        assert.equal(asked, 0, "the router is not asked again");
        assert.deepEqual(route, { status: "shadow", reason: "shadow: recorded only" });
        assert.equal("features" in route, false, "no features are added to an older route");
        assert.equal(held.route, older, "the memo is not written again");
    });

    test("a first call asks once and keeps the answer; a restart after the started mark asks nothing", async () => {
        const first = memoryMemo<Recorded>();
        const answer = { status: "shadow", features: FEATURES, briefHash: "h" };
        let asked = 0;

        const ask = async () => {
            asked += 1;

            return answer;
        };

        const failed = (reason: string): Recorded => ({ status: "failed", reason });

        assert.deepEqual(await routeOnce(first.memo, ask, failed), answer);
        assert.equal(first.held.started, true);
        assert.deepEqual(
            await routeOnce(first.memo, ask, failed),
            answer,
            "a replay reads the memo",
        );
        assert.equal(asked, 1);

        const restarted = memoryMemo<Recorded>(undefined, true);

        assert.deepEqual(await routeOnce(restarted.memo, ask, failed), {
            status: "failed",
            reason: "interrupted by a server restart",
        });
        assert.equal(asked, 1, "nothing is asked after a restart");
    });

    test("a router that throws or takes too long gives a failed route, and the memo keeps it", async () => {
        const failed = (reason: string): Recorded => ({ status: "failed", reason });
        const thrown = memoryMemo<Recorded>();

        assert.deepEqual(
            await routeOnce(thrown.memo, async () => Promise.reject(new Error("x")), failed),
            { status: "failed", reason: "the router failed" },
        );
        assert.equal(thrown.held.route?.reason, "the router failed");

        const slow = memoryMemo<Recorded>();

        assert.deepEqual(await routeOnce(slow.memo, () => new Promise(() => {}), failed, 10), {
            status: "failed",
            reason: "the router took more than 0.01 s",
        });
        assert.equal(ROUTE_GUARD_MS, 4000, "the guard a delegation gets");
    });
});
