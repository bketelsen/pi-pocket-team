// Isolated browser preview of the Desk: its Dashboard and its plans. Pocket's test harness (temporary data, test
// credentials, a fake model), only `desk.ts` on, the facts of `desk-dashboard-fixture.ts`, and the plans of
// `desk-plans-fixture.ts` (drafting, building, verifying, done, dropped), each with a planning session of its own that
// holds 1 short exchange. Nothing reads Brian's data or GitHub. The desk's export folder is `<tmp>/odrade/desk`, a
// temporary folder: `GET file` reads the desk files beside it, such as the 1 report this preview writes in
// `<tmp>/odrade/reports/`.
//
// The collector never runs here, so it cannot overwrite the fixture: it starts only from a desk sweep or `desk sync`,
// and no thread of the desk has a supervisor, so no sweeper starts. The fake `gh` also fails every call. The asks
// thread of `/preview-asks?on=1` is the 1 exception: it has a supervisor (the preview's first session), so a tap on
// `artifact:<id>` opens a session. While it is there, a desk read can start a sweep; seed the dashboard again with
// `/preview-fixture` if it changed, and take the thread out with `/preview-asks?on=0`. The board of `/preview-board?on=1`
// is the same: its threads T150 to T152 have the same supervisor (the first session), so the Board view shows its
// rows. A board pass changes none of them: the Team module is off here, so a pass lets its waiting and starting rows
// wait; and its threads have no session, so a sweep does not change their shift state. Take them out with
// `/preview-board?on=0`.
//
// Routes beside the app's own, for the checks:
//   /preview-login            sign in as the owner, in the preview's first session
//   /preview-login?plan=N     sign in, in the planning session of plan N (T101 to T105): the Plan panel's place
//   /preview-plans?on=0|1     take the fixture's plans and their threads out of the desk, or seed them again
//   /preview-asks?on=1|0      seed thread T140 with 3 open asks in Markdown (inline code, a command block with Copy,
//                            bold, a link, an artifact, a desk path; 1-line numbered steps with options; a long ask),
//                            or take it out
//   /preview-board?on=1|0     seed the first session's goal board with 1 row in each status (proposed, picked,
//                            waiting, starting, launched and running, launched and finished by a closed thread or an
//                            ended shift, failed, unknown, dropped) and their threads, or take them out
//   /preview-fixture?name=N   seed variant N again (main, empty, not-started, stale, usage-unavailable, partial-usage,
//                            residual-only, long)
//   /preview-fail?on=1|0      make `GET dashboard` fail with a 500, or not
//   /preview-fail-records?on=1|0
//                             make `GET dashboard/records` (the drill-down) fail with a 500, or not
//   /preview-delay?ms=N       hold each `GET dashboard` and `GET dashboard/records` answer N ms (the loading states)
//   /preview-module?on=0|1    turn the preview's Desk module off (its browser module goes) or on again
//   /preview-count            how many `GET dashboard` requests came
//
// `GET /api/x/desk/threads/<id>` answers here for the dashboard fixture's threads, so the drill-down can open the
// Desk's thread detail: a small answer of the shape `Detail` reads, made from the fixture's thread and PR facts. A
// thread gone from the desk is a 404, as on the desk. Any other id goes to the desk itself: the plans' threads are
// there (T101 and up, apart from the dashboard fixture's ids).
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./_pocket/test/helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createHandler } from "./_pocket/src/server/http.ts";
import { setAuthCookie } from "./_pocket/src/server/auth.ts";
import { DeskDashboard } from "./_desk-dashboard.ts";
import { DeskUsage } from "./_desk-usage.ts";
import {
    dashboardFixture,
    type Fixture,
    VARIANTS,
    type Variant,
} from "./desk-dashboard-fixture.ts";
import { DeskThreads, type Thread, writeStore } from "./desk.ts";
import type { BoardRow, BoardRowState } from "./_desk-board.ts";
import { FIXTURE_PLANS, plansFixture } from "./desk-plans-fixture.ts";

const fakeGh = join(root, "preview-gh");
const agents = join(root, "preview-agents");
const config = join(root, "preview-desk.json");
/** Odrade's folder, temporary: the export folder `desk/` and the desk files beside it, for `GET file`. */
const odrade = join(root, "odrade");
const reportPath = "reports/2026-11-05-intake-go-live/502-check.md";

writeFileSync(fakeGh, "#!/bin/sh\necho 'preview: no GitHub here' >&2\nexit 1\n", { mode: 0o755 });
mkdirSync(agents, { recursive: true });
mkdirSync(join(odrade, "desk"), { recursive: true });
mkdirSync(dirname(join(odrade, reportPath)), { recursive: true });
writeFileSync(
    join(odrade, reportPath),
    [
        "# Intake go-live: the 502 check",
        "",
        "The preview's report, for the tap on a desk path.",
        "",
        "## Result",
        "",
        "- 500 requests to `/intake` through the proxy: **0** answers with 502.",
        "- p95 latency: 180 ms (it was 210 ms).",
        "",
        "```",
        "ab -n 500 -c 20 https://intake.example.org/intake",
        "```",
        "",
        "Next: turn the flag on for all.",
        "",
    ].join("\n"),
);
writeFileSync(config, JSON.stringify({ digest: { minutes: 0 }, export: join(odrade, "desk") }));
process.env.PI_POCKET_DESK_GH = fakeGh;
process.env.PI_POCKET_DESK_CONFIG = config;
process.env.PI_POCKET_TEAM_AGENTS = agents;

const extensions = join(root, "data", "extensions");

mkdirSync(extensions, { recursive: true });

for (const file of [
    "desk.ts",
    "_desk-usage.ts",
    "_desk-dashboard.ts",
    "_desk-metrics.ts",
    "_desk-board.ts",
]) {
    cpSync(join(import.meta.dirname, file), join(extensions, file));
}

cpSync(join(import.meta.dirname, "desk-web"), join(extensions, "desk-web"), { recursive: true });

// The planning sessions' 1 answer: a planning session's words, so the chat beside the Plan panel shows something.
const app = await openApp(
    scriptedModel(() =>
        fauxAssistantMessage([
            fauxText(
                "I wrote the Approach section. The plan waits for your answer on its open ask; then I draft the task graph.",
            ),
        ]),
    ),
);

const session = await newSession(app);
const plansFolder = join(root, "preview-plans");

// Each plan's planning session, with 1 exchange: made before the desk is on, so no desk hook sees them.
const planSessions: number[] = [];

for (const id of FIXTURE_PLANS) {
    const planSession = await newSession(app);

    await say(
        app,
        planSession,
        `Plan ${id}: write the Approach section, and ask me what you need.`,
    );
    planSessions.push(planSession);
}

await app.setExtensionEnabled(owner(app), "desk.ts", true);

/** Put the fixture's plans, their threads and their texts in the desk; or take them out (`on` false). */
const seedPlans = async (on: boolean): Promise<void> => {
    const fixture = plansFixture(Date.now(), plansFolder, planSessions);

    for (const text of fixture.texts) {
        await writeStore(plansFolder, text);
    }

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);

        for (const id of Object.keys(fixture.threads)) {
            delete state.threads[id];
        }

        for (const id of Object.keys(fixture.plans)) {
            delete state.plans?.[id];
        }

        if (on) {
            Object.assign(state.threads, fixture.threads);
            state.plans = { ...state.plans, ...fixture.plans };
            state.next = { ...state.next, T: Math.max(state.next.T, 130) };
        }
    }, context);
};

await seedPlans(true);

/** The asks thread's id: after the plans' threads. */
const ASKS_THREAD = "T140";

/** Put thread T140 with 3 open asks in Markdown in the desk; or take it out (`on` false). */
const seedAsks = async (on: boolean): Promise<void> => {
    const now = Date.now();
    const thread: Thread = {
        id: ASKS_THREAD,
        key: `preview:${ASKS_THREAD}`,
        origin: "delegate",
        agents: ["duncan"],
        repo: "frostyard/intake",
        title: "Intake go-live (preview asks)",
        state: "open",
        startedAt: now - 3 * 3600_000,
        lastEventAt: now - 600_000,
        supervisor: session,
        prs: {},
        branches: [],
        run: {},
        events: [],
        asks: [
            {
                id: `${ASKS_THREAD}a`,
                at: now - 900_000,
                by: "odrade",
                from: "duncan",
                text: `Before go-live, check the **502** fix: run \`npm run check:502\` and read the [runbook](https://github.com/frostyard/intake/blob/main/docs/runbook.md). The chart is artifact:intake-502-check and the report is ${reportPath}. To update the host first, run \`git pull && npm run install-check && npm run install-extension\` there. Go live today?`,
                options: ["Go live today", "Wait"],
            },
            {
                id: `${ASKS_THREAD}b`,
                at: now - 600_000,
                by: "odrade",
                text: "How do we roll out the intake change (Phases 1-5 are done)? 1) merge #502 behind the flag \`intake.v2\` 2) turn the flag on for 10% of traffic for 15-30 min 3) turn it on for all, and watch the 5xx rate - stop at 1%.",
                options: ["Steps as written", "Skip the 10% step", "Wait a week"],
            },
            {
                id: `${ASKS_THREAD}c`,
                at: now - 300_000,
                by: "odrade",
                from: "duncan",
                text: "The intake service writes each form to the queue and then to the archive. On 2026-11-04 the archive write failed for 37 forms, because the bucket policy changed at 14:02 UTC and the service had no retry. The forms are safe in the queue, and \`intake replay --since 2026-11-04T14:00Z\` can write them again. Do you want me to replay the 37 forms now, add a retry with backoff in a PR first, or both: the PR first, then the replay with the new code? I vote both: a new policy change must not lose forms.",
            },
        ],
    };

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);

        delete state.threads[ASKS_THREAD];

        if (on) {
            state.threads[ASKS_THREAD] = thread;
            state.next = { ...state.next, T: Math.max(state.next.T, 141) };
        }
    }, context);
};

/** The board's threads: open with a running shift, closed, and open with an ended shift. */
const BOARD_THREADS = ["T150", "T151", "T152"] as const;
/** The board's row ids: far above the ids a test of the page adds. */
const BOARD_FIRST_ROW = 901;

/** Put 1 board row in each status on the first session's board, with their threads; or take them out (`on` false). */
const seedBoard = async (on: boolean): Promise<void> => {
    const now = Date.now();
    const until = new Date(now + 6 * 3600_000);
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    const boardThread = (
        id: string,
        title: string,
        state: Thread["state"],
        shift?: string,
    ): Thread => ({
        id,
        key: `preview:${id}`,
        origin: "delegate",
        agents: ["teg"],
        repo: "frostyard/teg",
        title,
        state,
        startedAt: now - 2 * 3600_000,
        lastEventAt: now - 600_000,
        supervisor: session,
        prs: {},
        branches: [],
        run: shift === undefined ? {} : { shift },
        events: [],
        asks: [],
        ...(state === "closed"
            ? { closed: { at: now - 300_000, why: "done" as const, by: "desk" as const } }
            : {}),
    });
    const threads = [
        boardThread("T150", "Tend teg (preview board, running)", "open", "running"),
        boardThread("T151", "Groom teg (preview board, closed)", "closed"),
        boardThread("T152", "Sweep teg (preview board, shift ended)", "open", "ended"),
    ];
    const row = (
        n: number,
        state: BoardRowState,
        title: string,
        patch: Partial<BoardRow> = {},
    ): BoardRow => ({
        id: BOARD_FIRST_ROW + n,
        supervisor: session,
        rev: 1 + (n % 3),
        state,
        by: "odrade",
        at: now - 3 * 3600_000,
        changedAt: now - 600_000,
        agent: "teg",
        repo: "frostyard/teg",
        title,
        task: `The preview board's ${state} row.`,
        stopWhen: "the tests pass",
        max: 10,
        until: hhmm,
        kind: "goal",
        order: (n + 1) * 10,
        attempts: [],
        ...patch,
    });
    const rows: BoardRow[] = [
        row(0, "proposed", "A proposed row", { note: "neutral" }),
        row(1, "picked", "A picked row", { kind: "feature" }),
        row(2, "waiting", "A waiting row"),
        row(3, "starting", "A starting row", { kind: "hygiene" }),
        row(4, "launched", "A launched row, running", {
            thread: "T150",
            launchedAt: now - 3600_000,
        }),
        row(5, "launched", "A launched row, its thread closed", {
            kind: "grooming",
            thread: "T151",
            launchedAt: now - 7200_000,
            changedAt: now - 7200_000,
        }),
        row(6, "launched", "A launched row, its shift ended", {
            kind: "sweep",
            thread: "T152",
            launchedAt: now - 5400_000,
            changedAt: now - 900_000,
        }),
        row(7, "failed", "A failed row", { error: "over the day's round budget" }),
        row(8, "unknown", "An unknown row", { error: "the start threw: no answer from the team" }),
        row(9, "dropped", "A dropped row", { changedAt: now - 300_000 }),
    ];

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);

        for (const id of BOARD_THREADS) {
            delete state.threads[id];
        }

        const kept = (state.board?.rows ?? []).filter(
            (each) => each.id < BOARD_FIRST_ROW || each.id >= BOARD_FIRST_ROW + rows.length,
        );

        state.board = {
            ...state.board,
            next: Math.max(state.board?.next ?? 1, BOARD_FIRST_ROW + rows.length),
            rows: on ? [...kept, ...rows] : kept,
        };

        if (on) {
            for (const thread of threads) {
                state.threads[thread.id] = thread;
            }

            state.next = { ...state.next, T: Math.max(state.next.T, 153) };
        }
    }, context);
};

/** The variant seeded last: the thread details answer from it. */
let seeded: Variant = "main";

/** Replace both documents with 1 variant of the fixture, at the real clock. */
const seed = async (variant: Variant): Promise<void> => {
    const fixture = dashboardFixture(Date.now(), variant);

    seeded = variant;

    await app.harness.commit(async (tx) => {
        const dashboard = (await tx.doc(DeskDashboard)) as unknown as Record<string, unknown>;
        const usage = (await tx.doc(DeskUsage)) as unknown as Record<string, unknown>;

        for (const key of Object.keys(dashboard)) {
            delete dashboard[key];
        }

        for (const key of Object.keys(usage)) {
            delete usage[key];
        }

        Object.assign(dashboard, fixture.dashboard);
        Object.assign(usage, fixture.usage);
    }, context);
};

await seed("main");

/**
 * The answer of `GET threads/<id>` for 1 fixture thread, in the shape `Detail` reads, or undefined: no such thread, or
 * gone from the desk. Its PRs are the fixture's PR facts that name the thread.
 */
const threadDetail = (fixture: Fixture, id: string): object | undefined => {
    const fact = Object.values(fixture.dashboard.threads).find((each) => each.id === id);

    if (fact === undefined || fact.goneAt !== undefined) {
        return undefined;
    }

    const prs = Object.values(fixture.dashboard.prs)
        .filter((pr) => pr.threads.includes(id) || fact.prs.includes(pr.ref.toLowerCase()))
        .map((pr) => ({
            ref: pr.ref,
            url: `https://github.com/${pr.repo}/pull/${String(pr.number)}`,
            state: pr.state ?? "",
            via: pr.via[0] ?? "",
        }));

    return {
        thread: {
            id,
            title: `Fixture thread ${id} (preview)`,
            repo: fact.repo ?? "",
            state: fact.state,
            next: fact.state === "closed" ? "nothing: closed" : "the preview has no next step",
            open: [],
            prs,
            asks: [],
            events: [],
        },
        reports: [],
    };
};

let fail = false;
let failRecords = false;
let delay = 0;
let count = 0;
const host = "127.0.0.2";
const handler = createHandler({ app, listen: { host, port: 0 }, restart: () => {} });

const text = (res: import("node:http").ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.pathname === "/preview-login") {
        const plan = FIXTURE_PLANS.indexOf(
            (url.searchParams.get("plan") ?? "").toUpperCase() as (typeof FIXTURE_PLANS)[number],
        );

        setAuthCookie(req, res, app.config.ownerToken);
        res.writeHead(302, { location: `/s/${plan === -1 ? session : planSessions[plan]}` });
        res.end();

        return;
    }

    if (url.pathname === "/preview-plans") {
        const on = url.searchParams.get("on") !== "0";

        void seedPlans(on).then(
            () => text(res, 200, `plans ${on ? "seeded" : "gone"}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-asks") {
        const on = url.searchParams.get("on") !== "0";

        void seedAsks(on).then(
            () => text(res, 200, `asks ${on ? "seeded" : "gone"}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-board") {
        const on = url.searchParams.get("on") !== "0";

        void seedBoard(on).then(
            () => text(res, 200, `board ${on ? "seeded" : "gone"}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-fixture") {
        const name = url.searchParams.get("name") as Variant;

        if (!VARIANTS.includes(name)) {
            text(res, 400, `name must be 1 of ${VARIANTS.join(", ")}`);

            return;
        }

        void seed(name).then(
            () => text(res, 200, `seeded ${name}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-fail") {
        fail = url.searchParams.get("on") === "1";
        text(res, 200, `fail ${String(fail)}`);

        return;
    }

    if (url.pathname === "/preview-fail-records") {
        failRecords = url.searchParams.get("on") === "1";
        text(res, 200, `fail records ${String(failRecords)}`);

        return;
    }

    if (url.pathname === "/preview-delay") {
        delay = Math.max(0, Number(url.searchParams.get("ms")) || 0);
        text(res, 200, `delay ${String(delay)}`);

        return;
    }

    if (url.pathname === "/preview-module") {
        // Turns the preview's own Desk module off or on: its browser module goes, and its dispose runs.
        const on = url.searchParams.get("on") === "1";

        void app.setExtensionEnabled(owner(app), "desk.ts", on).then(
            () => text(res, 200, `desk.ts ${on ? "on" : "off"}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-count") {
        text(res, 200, String(count));

        return;
    }

    if (url.pathname === "/api/x/desk/dashboard") {
        count += 1;

        if (fail) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "preview: the dashboard read failed on purpose" }));

            return;
        }

        if (delay > 0) {
            setTimeout(() => void handler(req, res), delay);

            return;
        }
    }

    if (url.pathname === "/api/x/desk/dashboard/records") {
        if (failRecords) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "preview: the records read failed on purpose" }));

            return;
        }

        if (delay > 0) {
            setTimeout(() => void handler(req, res), delay);

            return;
        }
    }

    const detail = /^\/api\/x\/desk\/threads\/([^/]+)$/.exec(url.pathname);

    const fixtureIds = new Set(
        Object.values(dashboardFixture(Date.now(), seeded).dashboard.threads).map(
            (each) => each.id,
        ),
    );

    if (
        req.method === "GET" &&
        detail !== null &&
        fixtureIds.has(decodeURIComponent(detail[1] ?? ""))
    ) {
        const answer = threadDetail(
            dashboardFixture(Date.now(), seeded),
            decodeURIComponent(detail[1] ?? ""),
        );

        res.writeHead(answer === undefined ? 404 : 200, { "content-type": "application/json" });
        res.end(
            JSON.stringify(
                answer ?? {
                    error: `preview: there is no thread ${detail[1] ?? ""} in the fixture`,
                },
            ),
        );

        return;
    }

    void handler(req, res);
});

await new Promise<void>((resolve) => server.listen(0, host, resolve));
console.log(`Preview: http://${host}:${(server.address() as { port: number }).port}/preview-login`);

const stop = async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
