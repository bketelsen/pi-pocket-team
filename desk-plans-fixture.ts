// A known set of plans, for the browser preview (`preview-desk.ts`) and for the test that checks their views
// (`desk-plans.test.ts`): 1 drafting with an open ask, 1 building (2 of 4 tasks done), 1 verifying after 1 failed round,
// 1 done (verified), and 1 dropped. Each plan thread has a planning session, and each plan's text goes to the revision
// store, where `GET plans/:id` reads it. No thread has a supervisor, so no sweep starts. Every time is relative to `now`.
// Nothing here reads Brian's data.
import {
    gitBlobSha,
    renderDecisions,
    renderPlanText,
    renderTasks,
    type Ask,
    type Plan,
    type PlanState,
    type PlanTask,
    type TaskGraph,
    type Thread,
} from "./desk.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** The fixture's plans and threads, and the plan texts the revision store must hold. */
export type PlansFixture = {
    threads: Record<string, Thread>;
    plans: Record<string, Plan>;
    texts: string[];
};

/** The plan thread ids of the fixture, in order: drafting, building, verifying, done, dropped. */
export const FIXTURE_PLANS = ["T101", "T102", "T103", "T104", "T105"] as const;

/** 1 thread of the desk, with the fields every thread has. */
const thread = (
    id: string,
    patch: Partial<Thread> & Pick<Thread, "title" | "startedAt">,
): Thread => ({
    id,
    key: `preview:${id}`,
    origin: "delegate",
    agents: ["lucilla"],
    state: "open",
    lastEventAt: patch.startedAt,
    prs: {},
    branches: [],
    asks: [],
    run: {},
    events: [],
    ...patch,
});

/** 1 task of a graph. */
const task = (
    id: string,
    title: string,
    state: PlanTask["state"],
    attempts: PlanTask["attempts"] = [],
    deps: string[] = [],
): PlanTask => ({
    id,
    title,
    agent: id === "t3" ? "teg" : "lucilla",
    repo: id === "t3" ? "frostyard/nsl" : "frostyard/snow",
    acceptance: [`${title}: it works, and a test shows it.`],
    deps,
    state,
    attempts,
});

/** 1 attempt that merged its PR. */
const merged = (threadId: string, at: number, pr: number): PlanTask["attempts"][number] => ({
    thread: threadId,
    at,
    prs: [
        {
            ref: `frostyard/snow#${String(pr)}`,
            head: `${String(pr).padStart(4, "0")}${"a".repeat(36)}`,
        },
    ],
    end: { at: at + 6 * HOUR, how: "merged" },
});

/** The plans and their threads, at `now`. `sessions` are 5 conversation ids, 1 for each plan, in `FIXTURE_PLANS` order. */
export function plansFixture(
    now: number,
    folder: string,
    sessions: readonly number[],
): PlansFixture {
    const threads: Record<string, Thread> = {};
    const plans: Record<string, Plan> = {};
    const texts: string[] = [];

    /** A task thread of a plan: closed when its attempt ended. */
    const taskThread = (
        id: string,
        plan: string,
        taskId: string,
        at: number,
        closed: boolean,
    ): void => {
        threads[id] = thread(id, {
            title: `${plan} ${taskId}: preview task`,
            repo: "frostyard/snow",
            startedAt: at,
            planTask: { plan, task: taskId },
            ...(closed
                ? {
                      state: "closed" as const,
                      closed: {
                          at: at + 6 * HOUR,
                          why: "done" as const,
                          by: "sweep" as const,
                          outcome: "completed" as const,
                      },
                  }
                : {}),
        });
    };

    /** 1 plan, its thread and its text: the text holds an idea, 2 sections of the planning session, and the desk's 2. */
    const plan = (
        index: number,
        title: string,
        state: PlanState,
        started: number,
        build: {
            graph?: TaskGraph;
            patch?: Partial<Plan>;
            asks?: Ask[];
            closed?: Thread["closed"];
        },
    ): void => {
        const id = FIXTURE_PLANS[index] ?? "T100";
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const planThread = thread(id, {
            origin: "plan",
            title,
            startedAt: started,
            lastEventAt: build.closed?.at ?? now - HOUR,
            ...(sessions[index] === undefined ? {} : { session: sessions[index] }),
            asks: build.asks ?? [],
            ...(build.closed === undefined
                ? {}
                : { state: "closed" as const, closed: build.closed }),
        });
        const sections = [
            { id: "idea", heading: "Idea", body: `> ${title}: the preview's plan.` },
            {
                id: "approach",
                heading: "Approach",
                body: "Build it in small steps. Each step has its own PR, and a test that shows it works.",
            },
            {
                id: "risks",
                heading: "Risks",
                body: "- A step can take longer than planned.\n- A reviewer can ask for changes.",
            },
            { id: "decisions", heading: "Decisions", body: renderDecisions(planThread) },
            { id: "tasks", heading: "Tasks", body: renderTasks(build.graph) },
        ];
        const text = renderPlanText(
            `# ${id} ${title}\n\n<!-- Written only by the desk. Change it with the plan tool. -->`,
            sections,
        );
        const rev = gitBlobSha(text);

        for (const ask of planThread.asks) {
            if (ask.plan !== undefined) {
                ask.plan.rev = rev;
            }
        }

        texts.push(text);
        threads[id] = planThread;
        plans[id] = {
            thread: id,
            slug,
            file: `${folder}/${id}-${slug}.md`,
            lead: "lucilla",
            idea: `${title}: the preview's plan.`,
            source: "page",
            state,
            rev,
            revs: [{ rev, at: started + HOUR, by: "lucilla", key: `preview:${id}:write` }],
            sections: sections.map((section) => ({ id: section.id, heading: section.heading })),
            comments: [],
            graphs: build.graph === undefined ? [] : [{ ...build.graph, rev }],
            approvals: [],
            consults: [],
            findings: [],
            ...build.patch,
        };

        const made = plans[id];

        // A ready call and an approval name the revision the plan has.
        for (const each of made.readies ?? []) {
            each.rev = rev;
        }

        for (const each of made.approvals) {
            each.rev = rev;
        }
    };

    // 1. Drafting, with 1 open pick-one ask on its approach.
    plan(0, "Snow ISO signing", "drafting", now - 2 * DAY, {
        asks: [
            {
                id: "T101a",
                text: "Where do the signing keys live?",
                at: now - 3 * HOUR,
                key: "preview:T101a",
                by: "lucilla",
                options: ["TPM", "YubiKey", "A file"],
                plan: { section: "approach", heading: "Approach", rev: "" },
                criteria: [
                    { id: "r1", label: "Easy reset" },
                    { id: "r2", label: "No new hardware" },
                ],
            },
        ],
    });

    // 2. Building: 4 tasks, 2 done, 1 delegated, 1 waiting for it.
    const building = now - 6 * DAY;

    taskThread("T111", "T102", "t1", building + DAY, true);
    taskThread("T112", "T102", "t2", building + 2 * DAY, true);
    taskThread("T113", "T102", "t3", now - DAY, false);
    plan(1, "Frostmail search index", "building", building, {
        graph: {
            version: 1,
            rev: "",
            state: "approved",
            at: building + 12 * HOUR,
            key: "preview:T102:graph",
            tasks: [
                task("t1", "Index schema", "done", [merged("T111", building + DAY, 41)]),
                task("t2", "Indexer job", "done", [merged("T112", building + 2 * DAY, 42)], ["t1"]),
                task(
                    "t3",
                    "Search API",
                    "delegated",
                    [{ thread: "T113", at: now - DAY, prs: [] }],
                    ["t1"],
                ),
                task("t4", "Search box in the web app", "waiting", [], ["t3"]),
            ],
        },
        patch: {
            readies: [{ key: "preview:T102:ready", rev: "", graph: 1, at: building + 14 * HOUR }],
            approvals: [
                {
                    rev: "",
                    graph: 1,
                    at: building + 20 * HOUR,
                    by: "brian",
                    key: "preview:T102:approve",
                },
            ],
        },
    });

    // 3. Verifying, after 1 failed round and its repair.
    const verifying = now - 9 * DAY;

    taskThread("T114", "T103", "t1", verifying + DAY, true);
    taskThread("T115", "T103", "t2", verifying + DAY, true);
    taskThread("T116", "T103", "t2", verifying + 4 * DAY, true);
    taskThread("T117", "T103", "verify", verifying + 3 * DAY, true);
    taskThread("T118", "T103", "verify", now - 5 * HOUR, false);
    plan(2, "Desk dashboard export", "verifying", verifying, {
        graph: {
            version: 1,
            rev: "",
            state: "approved",
            at: verifying + 12 * HOUR,
            key: "preview:T103:graph",
            tasks: [
                task("t1", "Export the numbers as CSV", "done", [
                    merged("T114", verifying + DAY, 51),
                ]),
                task("t2", "A download button", "done", [
                    merged("T115", verifying + DAY, 52),
                    merged("T116", verifying + 4 * DAY, 53),
                ]),
            ],
        },
        patch: {
            readies: [{ key: "preview:T103:ready", rev: "", graph: 1, at: verifying + 14 * HOUR }],
            approvals: [
                {
                    rev: "",
                    graph: 1,
                    at: verifying + 18 * HOUR,
                    by: "brian",
                    key: "preview:T103:approve",
                },
            ],
            verification: {
                threads: ["T117", "T118"],
                rounds: [
                    {
                        at: verifying + 3 * DAY + 6 * HOUR,
                        by: "lucilla",
                        reviewer: "openai/gpt-6.1-sol",
                        heads: {},
                        pass: false,
                        tasks: [
                            { task: "t1", pass: true, evidence: "The CSV has every column." },
                            {
                                task: "t2",
                                pass: false,
                                evidence: "The button has no label for a screen reader.",
                            },
                        ],
                        key: "preview:T103:verify:1",
                        thread: "T117",
                    },
                ],
            },
        },
    });

    // 4. Done: verified on its first round.
    const done = now - 20 * DAY;

    taskThread("T119", "T104", "t1", done + DAY, true);
    taskThread("T120", "T104", "t2", done + 2 * DAY, true);
    taskThread("T121", "T104", "verify", done + 3 * DAY, true);
    plan(3, "Nightly hygiene digest", "done", done, {
        graph: {
            version: 1,
            rev: "",
            state: "approved",
            at: done + 12 * HOUR,
            key: "preview:T104:graph",
            tasks: [
                task("t1", "Collect the hygiene facts", "done", [merged("T119", done + DAY, 61)]),
                task("t2", "Send the digest", "done", [merged("T120", done + 2 * DAY, 62)], ["t1"]),
            ],
        },
        patch: {
            readies: [{ key: "preview:T104:ready", rev: "", graph: 1, at: done + 14 * HOUR }],
            approvals: [
                {
                    rev: "",
                    graph: 1,
                    at: done + 16 * HOUR,
                    by: "brian",
                    key: "preview:T104:approve",
                },
            ],
            verification: {
                threads: ["T121"],
                rounds: [
                    {
                        at: done + 4 * DAY,
                        by: "lucilla",
                        reviewer: "openai/gpt-6.1-sol",
                        heads: {},
                        pass: true,
                        tasks: [
                            { task: "t1", pass: true, evidence: "The facts are complete." },
                            { task: "t2", pass: true, evidence: "The digest went at 06:00." },
                        ],
                        key: "preview:T104:verify:1",
                        thread: "T121",
                    },
                ],
            },
        },
        closed: { at: done + 4 * DAY, why: "done", by: "desk", outcome: "verified" },
    });

    // 5. Dropped in review: a ready call, a draft graph, and no approval.
    const dropped = now - 14 * DAY;

    plan(4, "Old tray applet", "dropped", dropped, {
        graph: {
            version: 1,
            rev: "",
            state: "draft",
            at: dropped + 12 * HOUR,
            key: "preview:T105:graph",
            tasks: [task("t1", "Port the applet", "waiting")],
        },
        patch: {
            readies: [{ key: "preview:T105:ready", rev: "", graph: 1, at: dropped + 14 * HOUR }],
        },
        closed: { at: dropped + 2 * DAY, why: "dropped", by: "brian" },
    });

    return { threads, plans, texts };
}
