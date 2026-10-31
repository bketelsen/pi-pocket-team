// The dashboard's sources: the pure rules (thread facts, tracked refs, read planning, the query, the answer, the
// merge into the document), a pass with a fake GitHub, and the collector in Pocket's test harness with a fake `gh`.
// Nothing reads Brian's data, and nothing goes to GitHub.
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
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import {
    applyPass,
    BOUNDARY_DAYS,
    CHECK_HEARTBEAT_MS,
    buildQuery,
    classifyFailure,
    CLOSED_REFRESH_MS,
    collectPass,
    collectorLive,
    COLLECTOR_TASK,
    defineCollector,
    DeskDashboard,
    ensureCollector,
    ERROR_RETRY_MS,
    MAX_CLOSING_PAGES,
    MAX_REF_READS,
    OPEN_REFRESH_MS,
    PASS_MS,
    parseAnswer,
    parseTime,
    planReads,
    RATE_BACKOFF_MS,
    threadFacts,
    trackedRefs,
    type DashboardState,
    type Read,
} from "./_desk-dashboard.ts";
import { DeskUsage } from "./_desk-usage.ts";
import { DeskThreads, SWEEP_SLEEP_MS, type DeskState, type PrLink, type Thread } from "./desk.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 2026-10-30T00:00:00Z. */
const T0 = Date.UTC(2026, 9, 30);
const iso = (at: number): string => new Date(at).toISOString();

/** A thread with every required field: each test changes the fields it cares about. */
const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id,
    key: `x.test:${id}`,
    origin: "delegate",
    title: `thread ${id}`,
    agents: ["duncan"],
    repo: "frostyard/test",
    state: "open",
    startedAt: T0 - DAY,
    lastEventAt: T0 - DAY,
    prs: {},
    branches: [],
    asks: [],
    run: {},
    events: [],
    ...overrides,
});

const link = (overrides: Partial<PrLink> = {}): PrLink => ({ via: "seen", ...overrides });

const deskOf = (threads: Thread[], plans: Record<string, { issue?: string }> = {}): DeskState =>
    ({
        next: { T: 1, F: 1 },
        threads: Object.fromEntries(threads.map((each) => [each.id, each])),
        grants: [],
        seen: {},
        plans,
    }) as unknown as DeskState;

const fresh = (): DashboardState => ({ threads: {}, prs: {}, issues: {}, sources: {} });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type PrWorld = {
    state: string;
    createdAt: number;
    mergedAt?: number;
    closedAt?: number;
    archived?: boolean;
};
type ClosingNode = { ref: string; mergedAt?: number };
type IssueWorld = {
    state: "OPEN" | "CLOSED";
    stateReason?: string;
    createdAt?: number;
    closedAt?: number;
    /** The latest timeline event: a close with a closer, a close with none (null), a reopen, or none. */
    event?:
        | { type: "closed"; closer: null | { pr: string; mergedAt?: number } | { commit: true } }
        | { type: "reopened" };
    closing?: ClosingNode[];
    /** More pages, by cursor: the first page ends with cursor "page2". */
    pages?: Record<string, { nodes: ClosingNode[]; next?: string }>;
};

/** What the fake GitHub knows: PRs and issues by lowercased ref, or an error type. */
type World = {
    prs?: Record<string, PrWorld | "NOT_FOUND" | "FORBIDDEN">;
    issues?: Record<string, IssueWorld | "NOT_FOUND" | "FORBIDDEN">;
    rate?: { remaining: number; resetAt?: number };
};

const prNode = (ref: string, mergedAt?: number) => {
    const [repo, number] = ref.split("#");

    return {
        __typename: "PullRequest",
        number: Number(number),
        merged: mergedAt !== undefined,
        mergedAt: mergedAt === undefined ? null : iso(mergedAt),
        repository: { nameWithOwner: repo },
    };
};

const ALIAS =
    /(p|i|c)(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ (?:isArchived )?(?:pullRequest|issue)\(number: (\d+)\)(?: \{ closedByPullRequestsReferences\(first: 25, includeClosedPrs: true, after: "([^"]+)"\))?/g;

/** A fake `gh api graphql`: it answers each alias of the query from `world`, and counts its calls. */
function fakeGitHub(world: World) {
    const calls: string[] = [];

    const answer = (query: string) => {
        calls.push(query);

        const data: Record<string, unknown> = {
            rateLimit: {
                remaining: world.rate?.remaining ?? 4999,
                resetAt: iso(world.rate?.resetAt ?? T0 + HOUR),
            },
        };
        const errors: unknown[] = [];

        for (const match of query.matchAll(ALIAS)) {
            const [, kind, index, owner, name, number, cursor] = match;
            const alias = `${kind}${index}`;
            const ref = `${owner}/${name}#${number}`.toLowerCase();
            const known = kind === "p" ? world.prs?.[ref] : world.issues?.[ref];

            if (known === undefined || known === "NOT_FOUND" || known === "FORBIDDEN") {
                data[alias] = kind === "p" ? { isArchived: false, pullRequest: null } : null;
                errors.push({
                    type: known ?? "NOT_FOUND",
                    path: kind === "p" ? [alias, "pullRequest"] : [alias],
                    message: "Could not resolve",
                });
                continue;
            }

            if (kind === "p") {
                const pr = known as PrWorld;

                data[alias] = {
                    isArchived: pr.archived === true,
                    pullRequest: {
                        state: pr.state,
                        createdAt: iso(pr.createdAt),
                        mergedAt: pr.mergedAt === undefined ? null : iso(pr.mergedAt),
                        closedAt: pr.closedAt === undefined ? null : iso(pr.closedAt),
                    },
                };
                continue;
            }

            const issue = known as IssueWorld;
            const page = (nodes: ClosingNode[], next?: string) => ({
                pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
                nodes: nodes.map((node) => prNode(node.ref, node.mergedAt)),
            });

            if (kind === "c") {
                const more = issue.pages?.[cursor ?? ""];

                data[alias] = {
                    issue: {
                        closedByPullRequestsReferences: page(more?.nodes ?? [], more?.next),
                    },
                };
                continue;
            }

            const event = issue.event;
            const nodes =
                event === undefined
                    ? []
                    : event.type === "reopened"
                      ? [{ __typename: "ReopenedEvent" }]
                      : [
                            {
                                __typename: "ClosedEvent",
                                createdAt: iso(issue.closedAt ?? T0),
                                closer:
                                    event.closer === null
                                        ? null
                                        : "commit" in event.closer
                                          ? { __typename: "Commit" }
                                          : prNode(event.closer.pr, event.closer.mergedAt),
                            },
                        ];

            data[alias] = {
                isArchived: false,
                issue: {
                    state: issue.state,
                    stateReason: issue.stateReason ?? null,
                    createdAt: issue.createdAt === undefined ? null : iso(issue.createdAt),
                    closedAt: issue.closedAt === undefined ? null : iso(issue.closedAt),
                    timelineItems: { nodes },
                    closedByPullRequestsReferences: page(
                        issue.closing ?? [],
                        issue.pages === undefined ? undefined : "page2",
                    ),
                },
            };
        }

        return errors.length === 0 ? { data } : { data, errors };
    };

    return {
        calls,
        graphql: async (query: string) => ({ stdout: JSON.stringify(answer(query)) }),
    };
}

/** 1 pass with fakes: the desk, the stored document, a GitHub call, and the commit into `doc`. */
async function pass(
    doc: DashboardState,
    desk: DeskState,
    now: number,
    graphql: (query: string) => Promise<{ stdout: string }>,
): Promise<number> {
    return collectPass({
        readDesk: async () => copy(desk),
        readDashboard: async () => copy(doc),
        now: () => now,
        graphql,
        commit: async (apply) => apply(doc),
    });
}

// ─── Thread facts ────────────────────────────────────────────────────────────

describe("thread facts", () => {
    test("an old record with no outcome keeps the outcome unknown", () => {
        const facts = threadFacts(
            deskOf([
                thread("T1", { state: "closed", closed: { at: T0, why: "done", by: "sweep" } }),
            ]),
        );

        assert.deepEqual(facts.T1?.closed, { at: T0, why: "done" });
        assert.equal("outcome" in (facts.T1?.closed ?? {}), false);
    });

    test("every why and outcome is copied as it is", () => {
        const cases = [
            { why: "done", outcome: "completed" },
            { why: "done", outcome: "verified" },
            { why: "done", outcome: "abandoned" },
            { why: "done", outcome: "frozen" },
            { why: "dropped" },
            { why: "failed" },
        ] as const;
        const threads = cases.map((closed, index) =>
            thread(`T${String(index + 1)}`, {
                state: "closed",
                closed: { at: T0 + index, by: "sweep", ...closed },
            }),
        );
        const facts = threadFacts(deskOf(threads));

        cases.forEach((closed, index) => {
            assert.deepEqual(facts[`T${String(index + 1)}`]?.closed, { at: T0 + index, ...closed });
        });
    });

    test("a reopened thread has no closure; the latest closure wins after it closes again", () => {
        const reopened = thread("T1", {
            state: "open",
            closed: { at: T0, why: "done", by: "sweep", outcome: "completed" },
        });

        assert.equal(threadFacts(deskOf([reopened])).T1?.closed, undefined);

        const doc = fresh();

        applyPass(doc, { threads: threadFacts(deskOf([reopened])), reads: [], now: T0 });

        const reclosed = thread("T1", {
            state: "closed",
            closed: { at: T0 + DAY, why: "failed", by: "desk" },
        });

        applyPass(doc, { threads: threadFacts(deskOf([reclosed])), reads: [], now: T0 + DAY });
        assert.deepEqual(doc.threads.T1?.closed, { at: T0 + DAY, why: "failed" });
    });

    test("a plan thread is a coordinator only while a task thread names it", () => {
        const plan = thread("T10", { origin: "plan", session: 5 });
        const task = thread("T11", { planTask: { plan: "T10", task: "t1" } });

        assert.equal(threadFacts(deskOf([plan, task])).T10?.role, "coordinator");

        const facts = threadFacts(deskOf([plan, task]));

        assert.equal(facts.T11?.role, "delivery");
        assert.equal(facts.T11?.plan, "T10");
        assert.equal(facts.T11?.task, "t1");
        // No task thread: a plan thread is like any other, and counts with a session.
        assert.equal(threadFacts(deskOf([plan])).T10?.role, "delivery");

        const idle = threadFacts(deskOf([thread("T12", { origin: "plan" })])).T12;

        assert.equal(idle?.role, "excluded");
        assert.equal(idle?.excluded, "no-work");
    });

    test("ask-only and no-work threads are excluded; a session or an attributable PR counts", () => {
        const facts = threadFacts(
            deskOf([
                thread("T1", { origin: "ask" }),
                thread("F1", { origin: "found" }),
                thread("T2", { origin: "seed" }),
                thread("T3", { origin: "seed", prs: { "a/b#1": link({ via: "window" }) } }),
                thread("F2", { origin: "found", session: 9 }),
                thread("T4", { origin: "ask", prs: { "a/b#2": link({ via: "attached" }) } }),
            ]),
        );

        assert.deepEqual(
            [facts.T1?.excluded, facts.F1?.excluded, facts.T2?.excluded, facts.T3?.excluded],
            ["ask-only", "no-work", "no-work", "no-work"],
        );
        assert.equal(facts.F2?.role, "delivery");
        assert.equal(facts.T4?.role, "delivery");
        assert.deepEqual(facts.T3?.prs, [], "a window link is not attributable");
    });

    test("a delegation that failed before its session started still counts", () => {
        const fact = threadFacts(
            deskOf([
                thread("T1", {
                    state: "closed",
                    closed: { at: T0, why: "failed", by: "desk" },
                }),
            ]),
        ).T1;

        assert.equal(fact?.role, "delivery");
        assert.equal(fact?.session, undefined);
    });

    test("an invalid repository and invalid timestamps are left out and named", () => {
        const fact = threadFacts(
            deskOf([
                thread("T1", {
                    repo: "not a repo",
                    startedAt: Number.NaN,
                    state: "closed",
                    closed: { at: 0, why: "done", by: "sweep", outcome: "completed" },
                }),
                thread("T2", { repo: "pi-pocket-team", startedAt: -5 }),
            ]),
        );

        assert.equal(fact.T1?.repo, undefined);
        assert.equal(fact.T1?.startedAt, undefined);
        assert.deepEqual(fact.T1?.closed, { why: "done", outcome: "completed" });
        assert.deepEqual(fact.T1?.invalid, ["repo", "startedAt", "closed.at"]);
        assert.equal(fact.T2?.repo, undefined, "a repository is never guessed from a short name");
        assert.deepEqual(fact.T2?.invalid, ["repo", "startedAt"]);
    });

    test("a thread gone from the desk keeps its fact; an unchanged pass writes no thread", () => {
        const doc = fresh();
        const desk = deskOf([thread("T1"), thread("T2")]);

        applyPass(doc, { threads: threadFacts(desk), reads: [], now: T0 });

        const first = copy(doc);

        applyPass(doc, { threads: threadFacts(desk), reads: [], now: T0 + HOUR / 2 });
        assert.deepEqual(doc, first, "nothing changed, nothing written");

        applyPass(doc, { threads: threadFacts(deskOf([thread("T1")])), reads: [], now: T0 + DAY });
        assert.equal(doc.threads.T2?.goneAt, T0 + DAY);
        assert.equal(doc.threads.T2?.id, "T2");
    });
});

// ─── Tracked refs ────────────────────────────────────────────────────────────

describe("tracked refs", () => {
    test("PR refs are deduplicated across threads and case; the first case is kept", () => {
        const tracked = trackedRefs(
            deskOf([
                thread("T2", { prs: { "Frostyard/Test#7": link({ via: "branch" }) } }),
                thread("T10", { prs: { "frostyard/test#7": link({ via: "attached" }) } }),
                thread("T3", {
                    state: "closed",
                    prs: { "FROSTYARD/TEST#7": link({ via: "seen" }), "bad ref": link() },
                }),
            ]),
        );

        assert.deepEqual(Object.keys(tracked.prs), ["frostyard/test#7"]);
        assert.equal(tracked.prs["frostyard/test#7"]?.ref, "Frostyard/Test#7");
        assert.deepEqual(tracked.prs["frostyard/test#7"]?.threads, ["T2", "T3", "T10"]);
        assert.deepEqual(tracked.prs["frostyard/test#7"]?.via, ["attached", "branch", "seen"]);
    });

    test("otherPrs never become tracked PRs", () => {
        const desk = deskOf([thread("T1")]);

        desk.otherPrs = {
            "frostyard/test": [
                {
                    ref: "frostyard/test#99",
                    number: 99,
                    title: "bump",
                    author: "dependabot",
                    url: "",
                    createdAt: T0,
                    draft: false,
                    checks: "",
                },
            ],
        };
        assert.deepEqual(trackedRefs(desk).prs, {});
    });

    test("a window-only ref is counted but excluded, and never read", () => {
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link({ via: "window" }) } })]);
        const doc = fresh();
        const tracked = trackedRefs(desk);

        assert.deepEqual(planReads(doc, tracked, T0), []);
        applyPass(doc, { threads: threadFacts(desk), tracked, reads: [], now: T0 });
        assert.equal(doc.prs["a/b#1"]?.excluded, "window");
    });

    test("MISSING and FROZEN desk links are excluded and keep their earlier facts", () => {
        const doc = fresh();
        const open = deskOf([thread("T1", { prs: { "a/b#1": link({ state: "OPEN" }) } })]);

        applyPass(doc, { tracked: trackedRefs(open), reads: [], now: T0 });
        doc.prs["a/b#1"]!.createdAt = T0 - DAY;
        doc.prs["a/b#1"]!.state = "OPEN";
        doc.prs["a/b#1"]!.readAt = T0;

        const missing = deskOf([thread("T1", { prs: { "a/b#1": link({ state: "MISSING" }) } })]);

        applyPass(doc, { tracked: trackedRefs(missing), reads: [], now: T0 + HOUR });
        assert.equal(doc.prs["a/b#1"]?.excluded, "missing");
        assert.equal(doc.prs["a/b#1"]?.createdAt, T0 - DAY, "the earlier facts stay");
        assert.deepEqual(planReads(doc, trackedRefs(missing), T0 + DAY), []);

        const frozen = deskOf([thread("T1", { prs: { "a/b#1": link({ state: "FROZEN" }) } })]);

        applyPass(doc, { tracked: trackedRefs(frozen), reads: [], now: T0 + 2 * HOUR });
        assert.equal(doc.prs["a/b#1"]?.excluded, "frozen");
    });

    test("issues come from threads and plans, deduplicated", () => {
        const tracked = trackedRefs(
            deskOf(
                [
                    thread("T1", { issues: ["frostyard/test#3", "nope"] }),
                    thread("T2", { issues: ["Frostyard/Test#3"] }),
                ],
                { T5: { issue: "FROSTYARD/test#3" }, T6: {} },
            ),
        );

        assert.deepEqual(Object.keys(tracked.issues), ["frostyard/test#3"]);
        assert.deepEqual(tracked.issues["frostyard/test#3"]?.threads, ["T1", "T2"]);
        assert.deepEqual(tracked.issues["frostyard/test#3"]?.plans, ["T5"]);
    });
});

// ─── Read planning and the query ─────────────────────────────────────────────

describe("read planning", () => {
    test("the order: never read, a desk change, an error, a closing page, open, closed; budget 20 shared", () => {
        const prs: Record<string, PrLink> = {};

        for (let n = 1; n <= 30; n += 1) {
            prs[`a/b#${String(n)}`] = link();
        }

        const desk = deskOf([thread("T1", { prs, issues: ["a/c#1", "a/c#2"] })]);
        const tracked = trackedRefs(desk);
        const doc = fresh();
        const reads = planReads(doc, tracked, T0);

        assert.equal(reads.length, MAX_REF_READS);
        assert.ok(reads.every((read) => read.why === 0));

        // Every ref read once: then each state decides.
        const now = T0 + 2 * DAY;

        for (const key of Object.keys(tracked.prs)) {
            doc.prs[key] = {
                ref: key,
                repo: "a/b",
                number: Number(key.split("#")[1]),
                threads: ["T1"],
                via: ["seen"],
                state: "MERGED",
                readAt: T0,
            };
        }

        doc.prs["a/b#1"]!.state = "OPEN";
        doc.prs["a/b#2"]!.state = "CLOSED";
        doc.prs["a/b#3"]!.error = "boom";
        doc.prs["a/b#3"]!.errorAt = now - ERROR_RETRY_MS;
        doc.prs["a/b#4"]!.error = "boom";
        doc.prs["a/b#4"]!.errorAt = now - 1;
        doc.issues["a/c#1"] = {
            ref: "a/c#1",
            repo: "a/c",
            number: 1,
            threads: ["T1"],
            plans: [],
            state: "CLOSED",
            readAt: now - 1,
            closing: { merged: [], complete: false, cursor: "page2", pages: 1 },
        };

        const changed = deskOf([
            thread("T1", {
                prs: { ...prs, "a/b#5": link({ state: "OPEN", readAt: now - 1 }) },
                issues: ["a/c#1", "a/c#2"],
            }),
        ]);
        const order = planReads(doc, trackedRefs(changed), now).map(
            (read) => `${read.kind}:${read.key}:${String(read.why)}`,
        );

        assert.deepEqual(order, [
            "issue:a/c#2:0",
            "pr:a/b#5:1",
            "pr:a/b#3:2",
            "closing:a/c#1:3",
            "pr:a/b#1:4",
            "pr:a/b#2:5",
        ]);
        assert.equal(planReads(doc, trackedRefs(changed), now, 3).length, 3);
    });

    test("nothing is read during a backoff", () => {
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const doc = fresh();

        doc.sources.github = { backoffUntil: T0 + HOUR };
        assert.deepEqual(planReads(doc, trackedRefs(desk), T0), []);
        assert.equal(planReads(doc, trackedRefs(desk), T0 + HOUR).length, 1);
    });

    test("the query quotes every value, leaves out bad reads, and asks for the rate limit", () => {
        const reads: Read[] = [
            { kind: "pr", key: "a/b#1", owner: "a", name: "b", number: 1, why: 0 },
            { kind: "pr", key: "x", owner: 'a") { evil', name: "b", number: 2, why: 0 },
            { kind: "issue", key: "a/b#3", owner: "a", name: "b", number: 3, why: 0 },
            {
                kind: "closing",
                key: "a/b#4",
                owner: "a",
                name: "b",
                number: 4,
                cursor: "a b",
                why: 3,
            },
            {
                kind: "closing",
                key: "a/b#5",
                owner: "a",
                name: "b",
                number: 5,
                cursor: "Y3Vy",
                why: 3,
            },
            { kind: "pr", key: "a/b#0", owner: "a", name: "b", number: 0, why: 0 },
        ];
        const query = buildQuery(reads);

        assert.match(query, /rateLimit \{ remaining resetAt \}/);
        assert.match(
            query,
            /p0: repository\(owner: "a", name: "b"\) \{ isArchived pullRequest\(number: 1\)/,
        );
        assert.match(
            query,
            /i2: repository\(owner: "a", name: "b"\) \{ isArchived issue\(number: 3\)/,
        );
        assert.match(query, /c4: .*after: "Y3Vy"/);
        assert.equal(query.includes("evil"), false);
        assert.equal(query.includes("p1:"), false);
        assert.equal(query.includes("c3:"), false);
        assert.equal(query.includes("p5:"), false);
    });
});

// ─── The answer ──────────────────────────────────────────────────────────────

describe("the answer", () => {
    test("UTC ISO times parse to exact milliseconds", () => {
        assert.equal(parseTime("2026-10-30T23:59:59Z"), Date.UTC(2026, 9, 30, 23, 59, 59));
        assert.equal(parseTime("2026-10-30T23:59:59.250Z"), Date.UTC(2026, 9, 30, 23, 59, 59, 250));
        assert.equal(parseTime("2026-10-30T23:59:59+02:00"), Date.UTC(2026, 9, 30, 21, 59, 59));
        assert.equal(parseTime("2026-10-30"), undefined, "a day without a time is no timestamp");
        assert.equal(parseTime(null), undefined);
        assert.equal(parseTime("yesterday"), undefined);
    });

    test("a partial answer keeps its data; NOT_FOUND and FORBIDDEN fail their own read only", () => {
        const reads: Read[] = [
            { kind: "pr", key: "a/b#1", owner: "a", name: "b", number: 1, why: 0 },
            { kind: "pr", key: "a/b#2", owner: "a", name: "b", number: 2, why: 0 },
            { kind: "issue", key: "a/b#3", owner: "a", name: "b", number: 3, why: 0 },
            { kind: "pr", key: "a/b#4", owner: "a", name: "b", number: 4, why: 0 },
        ];
        const answer = parseAnswer(
            {
                data: {
                    rateLimit: { remaining: 4000, resetAt: "2026-10-30T01:00:00Z" },
                    p0: {
                        isArchived: false,
                        pullRequest: {
                            state: "MERGED",
                            createdAt: "2026-10-01T00:00:00Z",
                            mergedAt: "2026-10-02T00:00:00Z",
                            closedAt: "2026-10-02T00:00:00Z",
                        },
                    },
                    p1: { isArchived: false, pullRequest: null },
                    i2: null,
                },
                errors: [
                    { type: "NOT_FOUND", path: ["p1", "pullRequest"], message: "no" },
                    { type: "FORBIDDEN", path: ["i2"], message: "no" },
                ],
            },
            reads,
        );

        assert.deepEqual(answer.results[0], {
            kind: "pr",
            key: "a/b#1",
            ok: true,
            archived: false,
            state: "MERGED",
            createdAt: Date.UTC(2026, 9, 1),
            mergedAt: Date.UTC(2026, 9, 2),
            closedAt: Date.UTC(2026, 9, 2),
        });
        assert.deepEqual(answer.results[1], {
            kind: "pr",
            key: "a/b#2",
            ok: false,
            error: "NOT_FOUND",
        });
        assert.deepEqual(answer.results[2], {
            kind: "issue",
            key: "a/b#3",
            ok: false,
            error: "FORBIDDEN",
        });
        assert.deepEqual(answer.results[3], {
            kind: "pr",
            key: "a/b#4",
            ok: false,
            error: "no answer",
        });
        assert.deepEqual(answer.partial, ["a/b#2", "a/b#3", "a/b#4"], "every failed read");
        assert.deepEqual(answer.errors, []);
        assert.deepEqual(answer.rate, { remaining: 4000, resetAt: Date.UTC(2026, 9, 30, 1) });
    });

    test("failures are classified from gh's words", () => {
        const failure = (stderr: string) => Object.assign(new Error("Command failed"), { stderr });

        assert.equal(classifyFailure(failure("HTTP 401: Bad credentials")), "auth");
        assert.equal(
            classifyFailure(failure("To get started with GitHub CLI, please run:  gh auth login")),
            "auth",
        );
        assert.equal(classifyFailure(failure("API rate limit exceeded for user")), "rate");
        assert.equal(classifyFailure(failure("You have exceeded a secondary rate limit")), "rate");
        assert.equal(classifyFailure(failure("HTTP 429")), "rate");
        assert.equal(
            classifyFailure(failure("dial tcp: lookup api.github.com: ENOTFOUND")),
            "network",
        );
        assert.equal(classifyFailure(Object.assign(new Error("x"), { killed: true })), "network");
        assert.equal(classifyFailure(failure("something odd")), "other");
    });
});

// ─── PR lifecycle ────────────────────────────────────────────────────────────

describe("PR lifecycle", () => {
    test("lifecycle dates come from GitHub, not from the read time", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const github = fakeGitHub({
            prs: {
                "a/b#1": {
                    state: "MERGED",
                    createdAt: T0 - 3 * DAY,
                    mergedAt: T0 - DAY,
                    closedAt: T0 - DAY,
                },
            },
        });

        assert.equal(await pass(doc, desk, T0, github.graphql), 1);

        const fact = doc.prs["a/b#1"];

        assert.equal(fact?.createdAt, T0 - 3 * DAY);
        assert.equal(fact?.mergedAt, T0 - DAY);
        assert.equal(fact?.closedAt, T0 - DAY);
        assert.equal(fact?.readAt, T0);
        assert.equal(fact?.state, "MERGED");
        assert.equal(doc.sources.github?.ok, true);
        assert.equal(doc.sources.github?.complete, true);
        assert.equal(doc.sources.github?.pending, 0);

        // A merged PR is final: no read again.
        assert.equal(await pass(doc, desk, T0 + 30 * DAY, github.graphql), 0);
        assert.equal(github.calls.length, 1);
    });

    test("a reopened PR loses its close time and keeps its creation time", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const world: World = {
            prs: { "a/b#1": { state: "CLOSED", createdAt: T0 - DAY, closedAt: T0 - HOUR } },
        };
        const github = fakeGitHub(world);

        await pass(doc, desk, T0, github.graphql);
        assert.equal(doc.prs["a/b#1"]?.closedAt, T0 - HOUR);

        world.prs!["a/b#1"] = { state: "OPEN", createdAt: T0 - DAY };

        // The desk saw it open after the last read: it is read first, at the next pass.
        const seen = deskOf([
            thread("T1", { prs: { "a/b#1": link({ state: "OPEN", readAt: T0 + HOUR }) } }),
        ]);

        assert.equal(planReads(doc, trackedRefs(seen), T0 + 2 * HOUR)[0]?.why, 1);
        await pass(doc, seen, T0 + 2 * HOUR, github.graphql);

        const fact = doc.prs["a/b#1"];

        assert.equal(fact?.state, "OPEN");
        assert.equal(fact?.closedAt, undefined);
        assert.equal(fact?.createdAt, T0 - DAY);
        assert.equal(fact?.reopenedAt, T0 + 2 * HOUR);
    });

    test("a detached PR stays, untracked, and is not read again", async () => {
        const doc = fresh();
        const github = fakeGitHub({ prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY } } });

        await pass(doc, deskOf([thread("T1", { prs: { "a/b#1": link() } })]), T0, github.graphql);
        await pass(doc, deskOf([thread("T1")]), T0 + DAY, github.graphql);
        assert.equal(doc.prs["a/b#1"]?.untracked, true);
        assert.equal(doc.prs["a/b#1"]?.createdAt, T0 - DAY);
        assert.equal(github.calls.length, 1);
    });

    test("a NOT_FOUND PR is excluded as missing, keeps its facts, and waits a day", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const world: World = { prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY } } };
        const github = fakeGitHub(world);

        await pass(doc, desk, T0, github.graphql);
        world.prs!["a/b#1"] = "NOT_FOUND";
        await pass(doc, desk, T0 + OPEN_REFRESH_MS, github.graphql);

        const fact = doc.prs["a/b#1"];

        assert.equal(fact?.excluded, "missing");
        assert.equal(fact?.error, "NOT_FOUND");
        assert.equal(fact?.createdAt, T0 - DAY);
        assert.equal(fact?.readAt, T0, "the last good read stays");
        // The only read failed: no success, and the last good read time stays.
        assert.equal(doc.sources.github?.ok, false);
        assert.equal(doc.sources.github?.kind, "partial");
        assert.equal(doc.sources.github?.lastGoodAt, T0);
        assert.deepEqual(doc.sources.github?.partial, ["a/b#1"]);
        assert.equal(planReads(doc, trackedRefs(desk), T0 + OPEN_REFRESH_MS + HOUR).length, 0);
        assert.equal(
            planReads(doc, trackedRefs(desk), T0 + OPEN_REFRESH_MS + CLOSED_REFRESH_MS).length,
            1,
        );
    });

    test("an archived repository makes a PR frozen", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);

        await pass(
            doc,
            desk,
            T0,
            fakeGitHub({ prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY, archived: true } } })
                .graphql,
        );
        assert.equal(doc.prs["a/b#1"]?.excluded, "frozen");
    });
});

// ─── Source failures ─────────────────────────────────────────────────────────

describe("source failures", () => {
    const failing = (stderr: string) => async () => {
        throw Object.assign(new Error("Command failed: gh api graphql"), { stderr, code: 1 });
    };

    for (const [name, stderr, kind] of [
        ["auth", "HTTP 401: Bad credentials (https://api.github.com/graphql)", "auth"],
        ["network", "Post https://api.github.com/graphql: dial tcp: ECONNRESET", "network"],
        ["rate", "API rate limit exceeded", "rate"],
    ] as const) {
        test(`a ${name} failure keeps the last good facts and is no success`, async () => {
            const doc = fresh();
            const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);

            await pass(
                doc,
                desk,
                T0,
                fakeGitHub({ prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY } } }).graphql,
            );

            const facts = copy(doc.prs);
            const later = T0 + OPEN_REFRESH_MS;

            await pass(doc, desk, later, failing(stderr));
            assert.deepEqual(doc.prs, facts, "every fact stays");
            assert.equal(doc.sources.github?.ok, false);
            assert.equal(doc.sources.github?.kind, kind);
            assert.equal(doc.sources.github?.at, later);
            assert.equal(doc.sources.github?.lastGoodAt, T0, "the last good read stays");
            assert.match(
                doc.sources.github?.error ?? "",
                new RegExp(stderr.slice(0, 12).replace(/[()]/g, ".")),
            );
            assert.equal(doc.sources.github?.pending, 1, "the read is still due");

            if (kind === "rate") {
                assert.equal(doc.sources.github?.backoffUntil, later + RATE_BACKOFF_MS);
            } else {
                assert.equal(doc.sources.github?.backoffUntil, undefined);
            }
        });
    }

    test("a RATE_LIMITED answer backs off until GitHub's reset time", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const graphql = async () => ({
            stdout: JSON.stringify({
                data: { rateLimit: { remaining: 0, resetAt: iso(T0 + 2 * HOUR) }, p0: null },
                errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
            }),
        });

        await pass(doc, desk, T0, graphql);
        assert.equal(doc.sources.github?.ok, false);
        assert.equal(doc.sources.github?.kind, "rate");
        assert.equal(doc.sources.github?.backoffUntil, T0 + 2 * HOUR);

        const calls: string[] = [];

        await pass(doc, desk, T0 + HOUR, async (query) => {
            calls.push(query);

            return { stdout: "{}" };
        });
        assert.equal(calls.length, 0, "no GitHub call during the backoff");
    });

    test("a partial answer from a gh that exits non-zero keeps its data", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link(), "a/b#2": link() } })]);

        const graphql = async () => {
            throw Object.assign(new Error("Command failed"), {
                code: 1,
                stderr: "GraphQL: Could not resolve to a PullRequest",
                stdout: JSON.stringify({
                    data: {
                        p0: {
                            isArchived: false,
                            pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) },
                        },
                        p1: { isArchived: false, pullRequest: null },
                    },
                    errors: [{ type: "NOT_FOUND", path: ["p1", "pullRequest"] }],
                }),
            });
        };

        await pass(doc, desk, T0, graphql);
        assert.equal(doc.prs["a/b#1"]?.createdAt, T0 - DAY);
        assert.equal(doc.prs["a/b#2"]?.excluded, "missing");
        assert.deepEqual(doc.sources.github?.partial, ["a/b#2"]);
    });

    test("applying the same pass twice gives the same document as once", () => {
        const desk = deskOf(
            [
                thread("T1", {
                    prs: { "a/b#1": link({ state: "OPEN", readAt: T0 }) },
                    issues: ["a/b#5"],
                }),
            ],
            { T9: { issue: "a/b#5" } },
        );
        const tracked = trackedRefs(desk);
        const reads = planReads(fresh(), tracked, T0);
        const answer = parseAnswer(
            {
                data: {
                    p0: {
                        isArchived: false,
                        pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) },
                    },
                    i1: {
                        isArchived: false,
                        issue: {
                            state: "CLOSED",
                            createdAt: iso(T0 - 5 * DAY),
                            closedAt: iso(T0 - DAY),
                            timelineItems: { nodes: [{ __typename: "ClosedEvent", closer: null }] },
                            closedByPullRequestsReferences: {
                                pageInfo: { hasNextPage: true, endCursor: "page2" },
                                nodes: [prNode("a/b#1", T0 - 2 * DAY)],
                            },
                        },
                    },
                },
            },
            reads,
        );
        const input = { threads: threadFacts(desk), tracked, reads, answer, now: T0 };
        const once = fresh();

        applyPass(once, input);

        const twice = copy(once);

        applyPass(twice, input);
        assert.deepEqual(twice, once);

        // A closing page applied twice (a restart between the read and the commit) counts once.
        const page = [
            {
                kind: "closing",
                key: "a/b#5",
                owner: "a",
                name: "b",
                number: 5,
                cursor: "page2",
                why: 3,
            },
        ] as Read[];
        const more = parseAnswer(
            {
                data: {
                    c0: {
                        issue: {
                            closedByPullRequestsReferences: {
                                pageInfo: { hasNextPage: false, endCursor: null },
                                nodes: [prNode("a/b#9", T0 - 3 * DAY)],
                            },
                        },
                    },
                },
            },
            page,
        );
        const next = { tracked, reads: page, answer: more, now: T0 + 1000 };

        applyPass(twice, next);

        const thrice = copy(twice);

        applyPass(thrice, next);
        assert.deepEqual(thrice, twice);
        assert.equal(twice.issues["a/b#5"]?.closing?.pages, 2);
    });

    test("a failed document read fails no pass: no GitHub call, every fact stays, the next pass tries again", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const github = fakeGitHub({ prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY } } });

        await pass(doc, desk, T0, github.graphql);

        const facts = copy({ threads: doc.threads, prs: doc.prs, github: doc.sources.github });
        const later = T0 + OPEN_REFRESH_MS;
        let commits = 0;
        const broken = (which: "desk" | "dashboard") =>
            collectPass({
                readDesk: async () => {
                    if (which === "desk") {
                        throw new Error("the desk document cannot be read\nsecond line");
                    }

                    return copy(desk);
                },
                readDashboard: async () => {
                    if (which === "dashboard") {
                        throw new Error("the dashboard document cannot be read");
                    }

                    return copy(doc);
                },
                now: () => later,
                graphql: github.graphql,
                commit: async (apply) => {
                    commits += 1;
                    apply(doc);
                },
            });

        assert.equal(await broken("desk"), 0);
        assert.equal(commits, 1, "the pass commits, so its task sleeps and tries again");
        assert.equal(github.calls.length, 1, "no GitHub call in that pass");
        assert.deepEqual({ threads: doc.threads, prs: doc.prs, github: doc.sources.github }, facts);
        assert.deepEqual(doc.sources.threads, {
            at: later,
            ok: false,
            error: "the desk document cannot be read",
            lastGoodAt: T0,
            checkedAt: T0,
        });

        assert.equal(await broken("dashboard"), 0);
        assert.equal(commits, 2);
        assert.equal(github.calls.length, 1);
        assert.equal(doc.sources.threads?.error, "the dashboard document cannot be read");
        assert.equal(doc.sources.threads?.lastGoodAt, T0);

        // The next good pass reads again.
        await pass(doc, desk, later + PASS_MS, github.graphql);
        assert.equal(doc.sources.threads?.ok, true);
        assert.equal(doc.sources.threads?.error, undefined);
        assert.equal(github.calls.length, 2);
    });

    test("an abort during a document read still throws, and commits nothing", async () => {
        const controller = new AbortController();
        let commits = 0;

        controller.abort();
        await assert.rejects(
            collectPass({
                readDesk: async () => deskOf([]),
                readDashboard: async () => {
                    throw new Error("aborted");
                },
                now: () => T0,
                graphql: async () => ({ stdout: "{}" }),
                commit: async () => {
                    commits += 1;
                },
                signal: controller.signal,
            }),
            /aborted/,
        );
        assert.equal(commits, 0);
    });

    test("the threads source's checkedAt: no write within the hour, 1 write after it", () => {
        const doc = fresh();
        const desk = deskOf([thread("T1")]);
        const input = (now: number) => ({ threads: threadFacts(desk), reads: [], now });

        applyPass(doc, input(T0));
        assert.deepEqual(doc.sources.threads, { at: T0, ok: true, lastGoodAt: T0, checkedAt: T0 });

        const first = copy(doc);

        applyPass(doc, input(T0 + CHECK_HEARTBEAT_MS - 1));
        assert.deepEqual(doc, first, "no change within the hour: nothing written");

        applyPass(doc, input(T0 + CHECK_HEARTBEAT_MS));
        assert.deepEqual(doc.sources.threads, {
            at: T0,
            ok: true,
            lastGoodAt: T0,
            checkedAt: T0 + CHECK_HEARTBEAT_MS,
        });
        assert.deepEqual({ ...doc, sources: first.sources }, first, "only checkedAt moved");

        // An older status with no checkedAt gets one at the next pass.
        delete (doc.sources.threads as { checkedAt?: number }).checkedAt;
        applyPass(doc, input(T0 + CHECK_HEARTBEAT_MS + 1));
        assert.equal(doc.sources.threads?.checkedAt, T0 + CHECK_HEARTBEAT_MS + 1);
    });

    test("an unknown collector state starts no collector, and a failed read is unknown", async () => {
        let created = 0;
        const tx = {
            doc: async () => {
                throw new Error("the dashboard document cannot be read");
            },
            createTask: async () => {
                created += 1;

                return 1;
            },
        } as unknown as Tx;

        await assert.rejects(collectorLive(tx), /cannot be read/);
        await ensureCollector(tx, 1, Collector, undefined);
        assert.equal(created, 0);
    });

    test("the recovery boundary is fixed at the first pass", () => {
        const doc = fresh();

        applyPass(doc, { reads: [], now: T0 });
        assert.equal(doc.initializedAt, T0);
        assert.equal(doc.boundary, T0 - BOUNDARY_DAYS * DAY);
        applyPass(doc, { reads: [], now: T0 + 30 * DAY });
        assert.equal(doc.initializedAt, T0);
        assert.equal(doc.boundary, T0 - BOUNDARY_DAYS * DAY);
    });
});

// ─── Issue resolution ────────────────────────────────────────────────────────

// ─── Review fixes: unavailable relationships, failed answers, lifecycle gaps ─

/** 1 pass whose GitHub answer is `json`. */
const answerPass = (doc: DashboardState, desk: DeskState, now: number, json: unknown) =>
    pass(doc, desk, now, async () => ({ stdout: JSON.stringify(json) }));

/** A full issue node: a close by a merged PR, and 1 page of closing references. */
const issueNode = (overrides: Record<string, unknown> = {}) => ({
    isArchived: false,
    issue: {
        state: "CLOSED",
        stateReason: "COMPLETED",
        createdAt: iso(T0 - 10 * DAY),
        closedAt: iso(T0 - DAY),
        timelineItems: {
            nodes: [{ __typename: "ClosedEvent", closer: prNode("a/b#7", T0 - DAY) }],
        },
        closedByPullRequestsReferences: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [prNode("a/b#7", T0 - DAY)],
        },
        ...overrides,
    },
});

describe("review fixes", () => {
    const desk = deskOf([thread("T1", { issues: ["a/b#5"] })]);

    /** A document with a resolved issue, read at T0. */
    async function resolved(): Promise<DashboardState> {
        const doc = fresh();

        await answerPass(doc, desk, T0, { data: { i0: issueNode() } });
        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#7");

        return doc;
    }

    const kept = (doc: DashboardState) => {
        const fact = doc.issues["a/b#5"];

        return {
            resolution: fact?.resolution,
            unresolved: fact?.unresolved,
            closing: fact?.closing,
        };
    };

    for (const [name, answer] of [
        [
            "a nested error on timelineItems",
            {
                data: { i0: issueNode({ timelineItems: null }) },
                errors: [
                    { type: "INTERNAL", path: ["i0", "issue", "timelineItems"], message: "x" },
                ],
            },
        ],
        [
            "a nested error on the closing list",
            {
                data: { i0: issueNode({ closedByPullRequestsReferences: null }) },
                errors: [
                    {
                        type: "INTERNAL",
                        path: ["i0", "issue", "closedByPullRequestsReferences"],
                        message: "x",
                    },
                ],
            },
        ],
        [
            "a missing closing field",
            { data: { i0: issueNode({ closedByPullRequestsReferences: undefined }) } },
        ],
        [
            "a closing list with no pageInfo",
            { data: { i0: issueNode({ closedByPullRequestsReferences: { nodes: [] } }) } },
        ],
    ] as const) {
        test(`${name} is an unavailable read: the stored resolution stays`, async () => {
            const doc = await resolved();
            const before = kept(doc);
            const now = T0 + CLOSED_REFRESH_MS;

            await answerPass(doc, desk, now, answer);
            assert.deepEqual(kept(doc), before);
            assert.equal(doc.issues["a/b#5"]?.error, "partial");
            assert.equal(doc.issues["a/b#5"]?.errorAt, now);
            assert.equal(doc.issues["a/b#5"]?.readAt, T0, "no good read");
            assert.equal(planReads(doc, trackedRefs(desk), now + ERROR_RETRY_MS - 1).length, 0);
            assert.equal(planReads(doc, trackedRefs(desk), now + ERROR_RETRY_MS).length, 1);
        });
    }

    test("a closing page that is not there keeps the cursor and the pages read", async () => {
        const doc = fresh();

        await answerPass(doc, desk, T0, {
            data: {
                i0: issueNode({
                    timelineItems: { nodes: [{ __typename: "ClosedEvent", closer: null }] },
                    closedByPullRequestsReferences: {
                        pageInfo: { hasNextPage: true, endCursor: "page2" },
                        nodes: [],
                    },
                }),
            },
        });

        const before = kept(doc);

        assert.equal(before.closing?.cursor, "page2");
        await answerPass(doc, desk, T0 + PASS_MS, {
            data: { c0: { issue: { closedByPullRequestsReferences: null } } },
            errors: [{ path: ["c0", "issue", "closedByPullRequestsReferences"], message: "x" }],
        });
        assert.deepEqual(kept(doc), before);
        assert.equal(doc.issues["a/b#5"]?.error, "partial");
        assert.deepEqual(
            planReads(doc, trackedRefs(desk), T0 + PASS_MS + ERROR_RETRY_MS).map((read) => [
                read.kind,
                read.cursor,
            ]),
            [["closing", "page2"]],
        );
    });

    test("an answer in which no read worked is no success: lastGoodAt stays", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link(), "a/b#2": link() } })]);
        const good = {
            data: {
                p0: { isArchived: false, pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) } },
                p1: { isArchived: false, pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) } },
            },
        };

        await answerPass(doc, prs, T0, good);
        assert.equal(doc.sources.github?.lastGoodAt, T0);

        // No alias error at all, and no data: each read fails, and each is in `partial`.
        const later = T0 + OPEN_REFRESH_MS;

        await answerPass(doc, prs, later, { data: { p0: null, p1: null } });
        assert.equal(doc.sources.github?.ok, false);
        assert.equal(doc.sources.github?.kind, "partial");
        assert.equal(doc.sources.github?.at, later);
        assert.equal(doc.sources.github?.lastGoodAt, T0);
        assert.deepEqual(doc.sources.github?.partial, ["a/b#1", "a/b#2"]);
        assert.equal(doc.prs["a/b#1"]?.createdAt, T0 - DAY, "the facts stay");

        // An error with no alias path, and no read worked: its line is the source's error.
        await answerPass(doc, prs, later + ERROR_RETRY_MS, {
            data: null,
            errors: [{ message: "Something went wrong while executing your query." }],
        });
        assert.equal(doc.sources.github?.ok, false);
        assert.equal(doc.sources.github?.error, "Something went wrong while executing your query.");
        assert.equal(doc.sources.github?.lastGoodAt, T0);
    });

    test("an error with no alias path beside a good read: ok, and its line is kept", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);

        await answerPass(doc, prs, T0, {
            data: {
                p0: { isArchived: false, pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) } },
            },
            errors: [{ message: "A field is deprecated." }, { path: ["other"], message: "Odd." }],
        });
        assert.equal(doc.sources.github?.ok, true);
        assert.equal(doc.sources.github?.lastGoodAt, T0);
        assert.equal(doc.sources.github?.error, "A field is deprecated.");
        assert.equal(doc.sources.github?.kind, "partial");
        assert.equal(doc.sources.github?.partial, undefined);
    });

    test("a merged PR with a missing lifecycle time has gaps, and is read again once a day", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const merged = (closedAt: string | null) => ({
            data: {
                p0: {
                    isArchived: false,
                    pullRequest: {
                        state: "MERGED",
                        createdAt: iso(T0 - 3 * DAY),
                        mergedAt: iso(T0 - DAY),
                        closedAt,
                    },
                },
            },
        });

        await answerPass(doc, prs, T0, merged(null));
        assert.deepEqual(doc.prs["a/b#1"]?.gaps, ["closedAt"]);
        assert.equal(doc.sources.github?.complete, false);
        assert.equal(planReads(doc, trackedRefs(prs), T0 + CLOSED_REFRESH_MS - 1).length, 0);
        assert.equal(planReads(doc, trackedRefs(prs), T0 + CLOSED_REFRESH_MS)[0]?.why, 5);

        await answerPass(doc, prs, T0 + CLOSED_REFRESH_MS, merged(iso(T0 - DAY)));
        assert.equal(doc.prs["a/b#1"]?.gaps, undefined);
        assert.equal(doc.sources.github?.complete, true);
        assert.equal(planReads(doc, trackedRefs(prs), T0 + 30 * DAY).length, 0, "final now");
    });

    test("the lifecycle times each state needs", async () => {
        const doc = fresh();
        const prs = deskOf([
            thread("T1", { prs: { "a/b#1": link(), "a/b#2": link(), "a/b#3": link() } }),
        ]);

        await answerPass(doc, prs, T0, {
            data: {
                p0: { isArchived: false, pullRequest: { state: "OPEN", createdAt: null } },
                p1: {
                    isArchived: false,
                    pullRequest: { state: "CLOSED", createdAt: iso(T0 - DAY), closedAt: null },
                },
                p2: {
                    isArchived: false,
                    pullRequest: {
                        state: "MERGED",
                        createdAt: null,
                        mergedAt: null,
                        closedAt: iso(T0 - DAY),
                    },
                },
            },
        });
        assert.deepEqual(doc.prs["a/b#1"]?.gaps, ["createdAt"]);
        assert.deepEqual(doc.prs["a/b#2"]?.gaps, ["closedAt"]);
        assert.deepEqual(doc.prs["a/b#3"]?.gaps, ["createdAt", "mergedAt"]);
    });

    test("a closed issue with no creation or close time has gaps, and the source is not complete", async () => {
        const doc = fresh();

        await answerPass(doc, desk, T0, {
            data: { i0: issueNode({ createdAt: null, closedAt: null }) },
        });
        assert.deepEqual(doc.issues["a/b#5"]?.gaps, ["createdAt", "closedAt"]);
        assert.equal(doc.sources.github?.complete, false);

        await answerPass(doc, desk, T0 + CLOSED_REFRESH_MS, { data: { i0: issueNode() } });
        assert.equal(doc.issues["a/b#5"]?.gaps, undefined);
        assert.equal(doc.sources.github?.complete, true);
    });
});

describe("issue resolution", () => {
    const desk = deskOf([thread("T1", { issues: ["a/b#5"] })]);

    async function resolveWith(issue: IssueWorld, now = T0) {
        const doc = fresh();

        await pass(doc, desk, now, fakeGitHub({ issues: { "a/b#5": issue } }).graphql);

        return doc;
    }

    test("1 resolving PR from the closed event", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - DAY } },
            closing: [{ ref: "a/b#7", mergedAt: T0 - DAY }],
        });

        assert.deepEqual(doc.issues["a/b#5"]?.resolution, {
            pr: "a/b#7",
            mergedAt: T0 - DAY,
            evidence: "closed-event",
            at: T0,
        });
        assert.equal(doc.issues["a/b#5"]?.createdAt, T0 - 10 * DAY);
        assert.equal(doc.issues["a/b#5"]?.unresolved, undefined);
    });

    test("many closing PRs: the closed event's closer is the final resolver", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "a/b#8", mergedAt: T0 - DAY } },
            closing: [
                { ref: "a/b#7", mergedAt: T0 - 5 * DAY },
                { ref: "a/b#8", mergedAt: T0 - DAY },
            ],
        });

        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#8");
    });

    test("a manual close with 2 merged closing PRs is ambiguous; with 1 it resolves", async () => {
        const ambiguous = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: null },
            closing: [
                { ref: "a/b#7", mergedAt: T0 - 5 * DAY },
                { ref: "a/b#8", mergedAt: T0 - 2 * DAY },
            ],
        });

        assert.equal(ambiguous.issues["a/b#5"]?.unresolved, "ambiguous");
        assert.equal(ambiguous.issues["a/b#5"]?.resolution, undefined);

        const one = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: null },
            closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
        });

        assert.deepEqual(one.issues["a/b#5"]?.resolution, {
            pr: "a/b#7",
            mergedAt: T0 - 5 * DAY,
            evidence: "closing-reference",
            at: T0,
        });
    });

    test("a manual close with no merged PR has no resolving PR", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: null },
            closing: [],
        });

        assert.equal(doc.issues["a/b#5"]?.unresolved, "no-resolving-pr");
    });

    test("not planned, a Commit closer, and an open issue have no sample", async () => {
        const notPlanned = await resolveWith({
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - DAY } },
        });

        assert.equal(notPlanned.issues["a/b#5"]?.unresolved, "not-planned");

        const commit = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { commit: true } },
            closing: [{ ref: "a/b#7", mergedAt: T0 - 2 * DAY }],
        });

        assert.equal(commit.issues["a/b#5"]?.unresolved, "no-resolving-pr");

        const open = await resolveWith({ state: "OPEN", createdAt: T0 - DAY });

        assert.equal(open.issues["a/b#5"]?.unresolved, "open");
    });

    test("a reopened issue loses its resolution; a later resolution counts once", async () => {
        const doc = fresh();
        const world: World = {
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - DAY } },
                },
            },
        };
        const github = fakeGitHub(world);

        await pass(doc, desk, T0, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#7");

        world.issues!["a/b#5"] = {
            state: "OPEN",
            createdAt: T0 - 10 * DAY,
            event: { type: "reopened" },
        };
        await pass(doc, desk, T0 + CLOSED_REFRESH_MS, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.resolution, undefined);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "open");
        assert.equal(doc.issues["a/b#5"]?.closedAt, undefined);

        const later = T0 + CLOSED_REFRESH_MS + OPEN_REFRESH_MS;

        world.issues!["a/b#5"] = {
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: later - HOUR,
            event: { type: "closed", closer: { pr: "a/b#9", mergedAt: later - HOUR } },
        };
        await pass(doc, desk, later, github.graphql);
        assert.deepEqual(doc.issues["a/b#5"]?.resolution, {
            pr: "a/b#9",
            mergedAt: later - HOUR,
            evidence: "closed-event",
            at: later,
        });
        assert.equal(doc.issues["a/b#5"]?.createdAt, T0 - 10 * DAY, "the original creation time");
    });

    test("1 PR resolves 2 issues; 1 issue linked by 2 threads and a plan is 1 fact", async () => {
        const doc = fresh();
        const both = deskOf(
            [thread("T1", { issues: ["a/b#5", "a/b#6"] }), thread("T2", { issues: ["A/B#5"] })],
            { T3: { issue: "a/b#5" } },
        );
        const closed = (closedAt: number): IssueWorld => ({
            state: "CLOSED",
            createdAt: closedAt - DAY,
            closedAt,
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - HOUR } },
        });

        await pass(
            doc,
            both,
            T0,
            fakeGitHub({ issues: { "a/b#5": closed(T0 - HOUR), "a/b#6": closed(T0 - HOUR) } })
                .graphql,
        );
        assert.equal(Object.keys(doc.issues).length, 2);
        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#7");
        assert.equal(doc.issues["a/b#6"]?.resolution?.pr, "a/b#7");
        assert.deepEqual(doc.issues["a/b#5"]?.threads, ["T1", "T2"]);
        assert.deepEqual(doc.issues["a/b#5"]?.plans, ["T3"]);
    });

    test("a resolver in another repository: the issue keeps its own repository", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "other/repo#3", mergedAt: T0 - DAY } },
        });

        assert.equal(doc.issues["a/b#5"]?.repo, "a/b");
        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "other/repo#3");
    });

    test("enrichment PRs never become tracked PRs", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: null },
            closing: [{ ref: "a/b#7", mergedAt: T0 - 2 * DAY }],
        });

        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#7");
        assert.deepEqual(doc.prs, {});
    });

    test("closing pages: incomplete, then resumed by cursor in the next pass", async () => {
        const doc = fresh();
        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: null },
                    closing: [],
                    pages: { page2: { nodes: [{ ref: "a/b#7", mergedAt: T0 - 2 * DAY }] } },
                },
            },
        });

        await pass(doc, desk, T0, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "incomplete");
        assert.equal(doc.issues["a/b#5"]?.closing?.cursor, "page2");

        const reads = planReads(doc, trackedRefs(desk), T0 + PASS_MS);

        assert.deepEqual(
            reads.map((read) => [read.kind, read.cursor]),
            [["closing", "page2"]],
        );
        await pass(doc, desk, T0 + PASS_MS, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, undefined);
        assert.equal(doc.issues["a/b#5"]?.resolution?.pr, "a/b#7");
        assert.equal(doc.issues["a/b#5"]?.closing?.pages, 2);
        assert.equal(doc.issues["a/b#5"]?.closing?.complete, true);
        assert.match(github.calls[1] ?? "", /after: "page2"/);
    });

    test("closing pages stop at the page limit, incomplete", async () => {
        const doc = fresh();
        const pages: Record<string, { nodes: ClosingNode[]; next?: string }> = {};

        for (let n = 2; n <= MAX_CLOSING_PAGES + 2; n += 1) {
            pages[n === 2 ? "page2" : `page${String(n)}`] = {
                nodes: [],
                next: `page${String(n + 1)}`,
            };
        }

        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: null },
                    pages,
                },
            },
        });

        for (let n = 0; n < MAX_CLOSING_PAGES + 2; n += 1) {
            await pass(doc, desk, T0 + n * PASS_MS, github.graphql);
        }

        assert.equal(doc.issues["a/b#5"]?.closing?.pages, MAX_CLOSING_PAGES);
        assert.equal(doc.issues["a/b#5"]?.closing?.cursor, undefined);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "incomplete");
        assert.equal(github.calls.length, MAX_CLOSING_PAGES);
    });

    test("missing timestamps make the issue invalid; raw values stay", async () => {
        const doc = await resolveWith({
            state: "CLOSED",
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - DAY } },
        });

        assert.equal(doc.issues["a/b#5"]?.unresolved, "invalid");
        assert.equal(doc.issues["a/b#5"]?.closedAt, T0 - DAY);

        const merged = await resolveWith({
            state: "CLOSED",
            createdAt: T0 - DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: { pr: "a/b#7" } },
        });

        assert.equal(merged.issues["a/b#5"]?.unresolved, "no-resolving-pr", "an unmerged closer");

        // A merge before the creation: the raw facts stay, and t3 judges the duration.
        const early = await resolveWith({
            state: "CLOSED",
            createdAt: T0,
            closedAt: T0 + HOUR,
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - HOUR } },
        });

        assert.equal(early.issues["a/b#5"]?.resolution?.mergedAt, T0 - HOUR);
    });

    test("missing and inaccessible issues keep their earlier facts", async () => {
        const doc = fresh();
        const world: World = {
            issues: { "a/b#5": { state: "OPEN", createdAt: T0 - DAY } },
        };
        const github = fakeGitHub(world);

        await pass(doc, desk, T0, github.graphql);
        world.issues!["a/b#5"] = "FORBIDDEN";
        await pass(doc, desk, T0 + OPEN_REFRESH_MS, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "inaccessible");
        assert.equal(doc.issues["a/b#5"]?.createdAt, T0 - DAY);
        world.issues!["a/b#5"] = "NOT_FOUND";
        await pass(doc, desk, T0 + OPEN_REFRESH_MS + CLOSED_REFRESH_MS, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "missing");
        assert.equal(doc.issues["a/b#5"]?.state, "OPEN");
    });
});

// ─── The collector in Pocket ─────────────────────────────────────────────────

const dataDir = join(root, "dashboard-data");
const definitions = join(root, "dashboard-agents");
const deskFixture = join(root, "dashboard-desk.json");
const dashboardFixture = join(root, "dashboard-github.json");
const ghCalls = join(root, "dashboard-gh-calls.log");
const fakeGh = join(root, "dashboard-gh.sh");
const failGh = join(root, "dashboard-gh-fail.sh");
const configPath = join(root, "dashboard-desk-config.json");

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: Record<string, JsonValue>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Pi, scripted: the supervisor runs `desk sync` when asked. */
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return answer("ok");
    }

    if (text.endsWith("desk sync test")) {
        return call("desk", { action: "sync" });
    }

    return answer(`echo: ${text.slice(0, 40)}`);
});

let app: App;
let shift = 0;
/** The supervisor of the first harness test: its thread stays open, so a sync starts its sweeper. */
let supervisorId: ConversationId | undefined;

const Collector = defineCollector({
    deskDoc: DeskThreads,
    gh: () => process.env.PI_POCKET_DESK_GH ?? "gh",
});

function command(id: ConversationId, name: string, args: string) {
    const commandId = app.webs.commands().find((each) => each.name === name)?.id;

    return app.extensionCommands.run(id, owner(app), {
        commandId,
        args,
        requestId: crypto.randomUUID(),
    });
}

async function restartApp(by: number): Promise<void> {
    await app.close();
    shift = by;
    app = await openApp(model, dataDir, () => Date.now() + shift);
}

const dashboardDoc = () => app.harness.snapshot(DeskDashboard, context);
const deskDoc = () => app.harness.snapshot(DeskThreads, context);

async function liveTasks(kind: string) {
    return (await app.harness.inspect(context)).tasks.filter((task) => task.record.kind === kind);
}

async function stopKind(kind: string): Promise<void> {
    for (const task of await liveTasks(kind)) {
        await app.harness.abortTask(task.record.id, context);
        await app.harness.waitForTask(task.record.id, context).catch(() => undefined);
    }
}

describe("the collector in Pocket", () => {
    before(async () => {
        process.env.PI_POCKET_TEAM_AGENTS = definitions;
        mkdirSync(definitions, { recursive: true });
        writeFileSync(
            join(definitions, "odrade.md"),
            "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
        );

        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
        cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), {
            recursive: true,
        });
        cpSync(join(import.meta.dirname, "desk.ts"), join(dropIns, "desk.ts"));
        cpSync(join(import.meta.dirname, "_desk-usage.ts"), join(dropIns, "_desk-usage.ts"));
        cpSync(
            join(import.meta.dirname, "_desk-dashboard.ts"),
            join(dropIns, "_desk-dashboard.ts"),
        );
        cpSync(join(import.meta.dirname, "_desk-metrics.ts"), join(dropIns, "_desk-metrics.ts"));
        cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), {
            recursive: true,
        });
        // A fake `gh`: the desk's own reads get the desk fixture; the dashboard's query (the only one that asks for the
        // rate limit) gets its own fixture, and is logged. Nothing goes to GitHub.
        writeFileSync(
            deskFixture,
            JSON.stringify({ data: { viewer: { login: "github-viewer" } } }),
        );
        writeFileSync(
            dashboardFixture,
            JSON.stringify({
                data: {
                    rateLimit: { remaining: 4000, resetAt: "2026-10-30T01:00:00Z" },
                    p0: {
                        isArchived: false,
                        pullRequest: {
                            state: "MERGED",
                            createdAt: "2026-10-01T10:00:00Z",
                            mergedAt: "2026-10-02T10:00:00Z",
                            closedAt: "2026-10-02T10:00:00Z",
                        },
                    },
                },
            }),
        );
        writeFileSync(
            fakeGh,
            `#!/bin/sh\ncase "$*" in\n  *"rateLimit { remaining resetAt }"*) echo call >> ${JSON.stringify(ghCalls)}; cat ${JSON.stringify(dashboardFixture)} ;;\n  *) cat ${JSON.stringify(deskFixture)} ;;\nesac\n`,
        );
        chmodSync(fakeGh, 0o755);
        writeFileSync(failGh, '#!/bin/sh\necho "HTTP 401: Bad credentials" >&2\nexit 1\n');
        chmodSync(failGh, 0o755);
        writeFileSync(ghCalls, "");
        process.env.PI_POCKET_DESK_GH = fakeGh;
        process.env.PI_POCKET_DESK_CONFIG = configPath;
        writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));

        app = await openApp(model, dataDir, () => Date.now() + shift);
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        await app.setExtensionEnabled(owner(app), "desk.ts", true);
    });

    after(async () => {
        await app?.close();
        shift = 0;
        cleanUp();
    });

    test("a sync starts 1 collector, and a second sync and its sweeper add none", async () => {
        const folder = join(root, "dashboard-supervisor");

        mkdirSync(folder, { recursive: true });

        const source = await newSession(app, folder);

        await command(source, "team-agent", "odrade");
        supervisorId = source;
        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            // An open ask keeps it open: a sweeper starts, and its sweep starts the collector.
            state.threads.T1 = thread("T1", {
                supervisor: Number(source),
                startedAt: Date.now(),
                asks: [{ id: "T1a", text: "Which one?", at: Date.now() }],
            });
        }, context);
        await say(app, source, "desk sync test");
        await until(async () => (await dashboardDoc())?.collector !== undefined, "the collector");

        const first = (await dashboardDoc())?.collector;

        assert.equal((await liveTasks(COLLECTOR_TASK)).length, 1);
        await say(app, source, "desk sync test");
        await until(async () => (await liveTasks("x.desk.sweeper")).length > 0, "a sweeper");
        assert.equal((await dashboardDoc())?.collector, first);
        assert.equal((await liveTasks(COLLECTOR_TASK)).length, 1);
        assert.equal(readFileSync(ghCalls, "utf8"), "", "the first pass waits: no GitHub read yet");
        await stopKind("x.desk.sweeper");
        await stopKind(COLLECTOR_TASK);
    });

    test("a pass with a fake gh writes the dashboard and leaves x.desk.threads as it was", async () => {
        const folder = join(root, "dashboard-owner");

        mkdirSync(folder, { recursive: true });

        const conversation = await newSession(app, folder);

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            state.threads.T2 = thread("T2", {
                state: "closed",
                closed: { at: T0, why: "done", by: "sweep", outcome: "completed" },
                prs: { "frostyard/test#7": link({ state: "MERGED", readAt: T0 }) },
            });
            await ensureCollector(tx, Number(conversation), Collector, await collectorLive(tx));
        }, context);

        const before = copy(await deskDoc());

        await until(
            async () =>
                (await liveTasks(COLLECTOR_TASK)).some(
                    (task) => task.record.state.status === "sleeping",
                ),
            "the first wait",
        );
        // A restart with the clock past the first wait: the collector's durable sleep ends, and it makes its pass.
        await restartApp(PASS_MS + 60_000);
        await until(
            async () => (await dashboardDoc())?.prs["frostyard/test#7"]?.readAt !== undefined,
            "the pass",
            20_000,
        );

        const doc = await dashboardDoc();
        const fact = doc?.prs["frostyard/test#7"];

        assert.equal(fact?.state, "MERGED");
        assert.equal(fact?.createdAt, Date.UTC(2026, 9, 1, 10));
        assert.equal(fact?.mergedAt, Date.UTC(2026, 9, 2, 10));
        assert.notEqual(fact?.readAt, fact?.mergedAt);
        assert.deepEqual(doc?.threads.T2?.closed, { at: T0, why: "done", outcome: "completed" });
        assert.equal(doc?.sources.github?.ok, true);
        assert.equal(readFileSync(ghCalls, "utf8"), "call\n");
        assert.deepEqual(await deskDoc(), before, "x.desk.threads is unchanged");
    });

    test("a failing gh keeps the facts and marks the source", async () => {
        const facts = copy((await dashboardDoc())?.prs);

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            state.threads.T3 = thread("T3", { prs: { "frostyard/test#8": link() } });
        }, context);
        process.env.PI_POCKET_DESK_GH = failGh;

        try {
            await restartApp(shift + PASS_MS + 60_000);
            await until(
                async () => (await dashboardDoc())?.sources.github?.ok === false,
                "the failed pass",
                20_000,
            );

            const doc = await dashboardDoc();

            assert.equal(doc?.sources.github?.kind, "auth");
            assert.equal(doc?.prs["frostyard/test#7"]?.readAt, facts?.["frostyard/test#7"]?.readAt);
            assert.equal(doc?.prs["frostyard/test#7"]?.mergedAt, Date.UTC(2026, 9, 2, 10));
            assert.equal(
                doc?.prs["frostyard/test#8"]?.readAt,
                undefined,
                "a failure is no empty success",
            );
            assert.equal(doc?.sources.github?.pending, 1);
            assert.equal(doc?.sources.github?.complete, false);

            // The boundary was fixed at the first pass: this pass ran the usage step, which a failing gh does not touch.
            const usage = await app.harness.snapshot(DeskUsage, context);

            assert.equal(usage?.sources.usage?.ok, true);
            assert.equal(usage?.sources.usage?.boundary, doc?.boundary);
        } finally {
            process.env.PI_POCKET_DESK_GH = fakeGh;
        }
    });

    test("a sweep that sends an Odrade repair with a session scan also starts the collector", async () => {
        const source = supervisorId;

        assert(source !== undefined, "the first test's supervisor");

        const folder = join(root, "dashboard-agent");

        mkdirSync(folder, { recursive: true });

        // A thread session with no cached return address: the repair loop scans its entries.
        const agent = await newSession(app, folder);

        await say(app, source, "desk sync test");
        await until(
            async () =>
                (await liveTasks("x.desk.sweeper")).some(
                    (task) => task.record.state.status === "sleeping",
                ),
            "the sweeper's sleep",
            20_000,
        );
        // No collector: the next sweep starts one, in the same commit as the repair's scan.
        await stopKind(COLLECTOR_TASK);

        const key = "repair:frostyard/test#9:h1:CONFLICTING";

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            state.threads.T5 = thread("T5", {
                supervisor: Number(source),
                session: Number(agent),
                startedAt: Date.now(),
                asks: [{ id: "T5a", text: "Which one?", at: Date.now() }],
                prs: {
                    "frostyard/test#9": link({
                        via: "attached",
                        state: "OPEN",
                        head: "h1",
                        mergeable: "CONFLICTING",
                    }),
                },
                run: {
                    repairs: { [key]: { at: Date.now(), to: "odrade", why: "cap", sent: false } },
                },
            });
        }, context);
        assert.equal((await dashboardDoc())?.collector, undefined);
        await restartApp(shift + SWEEP_SLEEP_MS + 60_000);
        await until(
            async () => typeof (await deskDoc())?.threads.T5?.run.sweptAt === "number",
            "the sweep",
            20_000,
        );
        await until(async () => (await dashboardDoc())?.collector !== undefined, "the collector");
        assert.equal((await liveTasks(COLLECTOR_TASK)).length, 1);
        assert.equal((await liveTasks("x.desk.sweeper")).length, 1, "the sweeper did not fault");
        await stopKind("x.desk.sweeper");
        await stopKind(COLLECTOR_TASK);
    });

    test("a desk with only closed threads: desk sync starts 1 collector", async () => {
        const source = supervisorId;

        assert(source !== undefined, "the first test's supervisor");
        await stopKind("x.desk.sweeper");
        await stopKind(COLLECTOR_TASK);

        const reopen: string[] = [];

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(DeskThreads);

            for (const each of Object.values(state.threads)) {
                if (each.state !== "closed") {
                    reopen.push(each.id);
                    each.state = "closed";
                    each.closed = { at: Date.now(), why: "dropped", by: "desk" };
                }
            }
        }, context);

        try {
            assert.equal((await dashboardDoc())?.collector, undefined);
            await say(app, source, "desk sync test");
            await until(
                async () => (await dashboardDoc())?.collector !== undefined,
                "the collector",
            );
            assert.equal((await liveTasks(COLLECTOR_TASK)).length, 1);
            assert.equal(
                (await liveTasks("x.desk.sweeper")).length,
                0,
                "no open thread: no sweeper",
            );
        } finally {
            await stopKind(COLLECTOR_TASK);
            await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);

                for (const id of reopen) {
                    const each = state.threads[id];

                    if (each !== undefined && id === "T1") {
                        each.state = "open";
                        delete each.closed;
                    }
                }
            }, context);
        }
    });

    test("a dashboard document that cannot be read does not fail the sweep", async () => {
        const source = supervisorId;

        assert(source !== undefined, "the first test's supervisor");
        await stopKind(COLLECTOR_TASK);
        // The same kind at a newer version: this module's read of it throws.
        const Newer = defineDoc<{ newer: boolean }>({
            kind: "x.desk.dashboard",
            version: 2,
            scope: "session",
            checkpointWhen: () => false,
            initial: () => ({ newer: true }),
        });

        await app.harness.commit(async (tx) => {
            await tx.retireDoc(DeskDashboard);
        }, context);
        await app.harness.commit(async (tx) => {
            await tx.doc(Newer);
        }, context);
        await assert.rejects(
            app.harness.commit(async (tx) => {
                await tx.doc(DeskDashboard);
            }, context),
            Error,
            "the dashboard document cannot be read",
        );

        const before = (await deskDoc())?.threads.T1?.run.sweptAt;

        await say(app, source, "desk sync test");
        await until(
            async () => (await deskDoc())?.threads.T1?.run.sweptAt !== before,
            "the sweep",
            20_000,
        );

        const sweepers = await liveTasks("x.desk.sweeper");

        assert.equal(sweepers.length, 1, "the sweeper is live: it did not fault");
        assert.equal(
            (await liveTasks(COLLECTOR_TASK)).length,
            0,
            "no collector on an unknown state",
        );
        await stopKind("x.desk.sweeper");
    });
});
