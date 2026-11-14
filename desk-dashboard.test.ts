// The dashboard's sources: the pure rules (thread facts, tracked refs, read planning, the query, the answer, the
// merge into the document), a pass with a fake GitHub, and the collector in Pocket's test harness with a fake `gh`.
// Nothing reads Brian's data, and nothing goes to GitHub.
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
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    defineDoc,
    type ConversationId,
    type EntryRecord,
    type Tx,
} from "@earendil-works/pi-durable";
import {
    ANTHROPIC_USAGE_URL,
    anthropicReader,
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
    emptyMeterLedger,
    ensureCollector,
    ERROR_RETRY_MS,
    MAX_CLOSING_PAGES,
    MAX_REF_READS,
    METER_READS,
    meterPass,
    OPEN_REFRESH_MS,
    PASS_MS,
    parseAnswer,
    parseTime,
    planReads,
    RATE_BACKOFF_MS,
    threadFacts,
    trackedRefs,
    type DashboardState,
    type MeterDeps,
    type MeterTx,
    type Read,
} from "./_desk-dashboard.ts";
import { DeskUsage } from "./_desk-usage.ts";
import { createHandler } from "./_pocket/src/server/http.ts";
import {
    emptyMeterState,
    meterStatusLine,
    meterView,
    nextReadAt,
    type MeterSettings,
    type MeterState,
} from "./_desk-meter.ts";
import {
    DeskThreads,
    METER_IO,
    SWEEP_SLEEP_MS,
    type MeterHolder,
    type DeskState,
    type JsonValue,
    type PrLink,
    type Thread,
} from "./desk.ts";

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
        assert.equal(doc.sources.github?.partial, undefined, "an excluded PR is no coverage gap");
        assert.equal(doc.sources.github?.complete, true);
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
        assert.equal(doc.sources.github?.partial, undefined, "a missing PR is no coverage gap");
        assert.equal(doc.sources.github?.complete, true);
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
                            // No visible close event, and no merged reference yet: the next page is due.
                            timelineItems: { nodes: [] },
                            closedByPullRequestsReferences: {
                                pageInfo: { hasNextPage: true, endCursor: "page2" },
                                nodes: [prNode("a/b#1")],
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
        assert.equal(twice.issues["a/b#5"]?.unresolved, "ambiguous");
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
                    timelineItems: { nodes: [] },
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

    test("an issue at the closing page limit is incomplete, and the source is not complete", async () => {
        const doc = fresh();
        const pages: Record<string, { nodes: ClosingNode[]; next?: string }> = {};

        for (let n = 2; n <= MAX_CLOSING_PAGES + 2; n += 1) {
            pages[`page${String(n)}`] = { nodes: [], next: `page${String(n + 1)}` };
        }

        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    pages,
                },
            },
        });

        for (let n = 0; n < MAX_CLOSING_PAGES; n += 1) {
            await pass(doc, desk, T0 + n * PASS_MS, github.graphql);
        }

        assert.equal(doc.issues["a/b#5"]?.unresolved, "incomplete");
        assert.equal(doc.issues["a/b#5"]?.closing?.cursor, undefined);
        assert.equal(doc.issues["a/b#5"]?.error, undefined);
        assert.equal(doc.sources.github?.partial, undefined);
        assert.equal(doc.sources.github?.complete, false);
    });

    for (const [kind, failing] of [
        ["a PR", "a/b#1"],
        ["an issue", "a/b#5"],
    ] as const) {
        test(`${kind} whose later read fails stays partial until a clean read of it`, async () => {
            const doc = fresh();
            const refs = deskOf([
                thread("T1", { prs: { "a/b#1": link(), "a/b#2": link() }, issues: ["a/b#5"] }),
            ]);
            const good: World = {
                prs: {
                    "a/b#1": { state: "OPEN", createdAt: T0 - DAY },
                    "a/b#2": { state: "OPEN", createdAt: T0 - DAY },
                },
                issues: { "a/b#5": { state: "OPEN", createdAt: T0 - DAY } },
            };
            const world: World = copy(good);
            const github = fakeGitHub(world);

            await pass(doc, refs, T0, github.graphql);
            assert.equal(doc.sources.github?.complete, true);
            assert.equal(doc.sources.github?.partial, undefined);

            const t2 = T0 + OPEN_REFRESH_MS;

            if (kind === "a PR") {
                world.prs!["a/b#1"] = "FORBIDDEN";
            } else {
                world.issues!["a/b#5"] = "FORBIDDEN";
            }

            await pass(doc, refs, t2, github.graphql);
            assert.deepEqual(doc.sources.github?.partial, [failing]);
            assert.equal(doc.sources.github?.complete, false);

            // A later pass reads the other refs only: the stored error keeps the ref partial.
            const t3 = t2 + OPEN_REFRESH_MS;

            assert.ok(!planReads(doc, trackedRefs(refs), t3).some((read) => read.key === failing));
            await pass(doc, refs, t3, github.graphql);
            assert.equal(github.calls.length, 3);
            assert.deepEqual(doc.sources.github?.partial, [failing]);
            assert.equal(doc.sources.github?.complete, false);

            // A clean read of it.
            Object.assign(world, copy(good));
            await pass(doc, refs, t2 + CLOSED_REFRESH_MS, github.graphql);
            assert.equal(doc.sources.github?.partial, undefined);
            assert.equal(doc.sources.github?.complete, true);
        });
    }

    test("a deeper error beside an ok PR result stays partial, also through a whole-read failure, until a clean read", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const open = {
            isArchived: false,
            pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) },
        };

        await answerPass(doc, prs, T0, {
            data: { p0: open },
            errors: [{ type: "INTERNAL", path: ["p0", "pullRequest", "mergedAt"], message: "x" }],
        });
        assert.equal(doc.prs["a/b#1"]?.error, undefined, "an ok result stores no error");
        assert.deepEqual(doc.sources.github?.partial, ["a/b#1"]);
        assert.equal(doc.sources.github?.complete, false);

        // A pass with no read keeps it.
        const before = copy(doc);

        await pass(doc, prs, T0 + PASS_MS, async () => {
            throw new Error("no read is due");
        });
        assert.deepEqual(doc.sources.github, before.sources.github);

        // A failure of the whole read reads nothing cleanly: the list stays.
        await pass(doc, prs, T0 + OPEN_REFRESH_MS, async () => {
            throw Object.assign(new Error("Command failed: gh api graphql"), {
                stderr: "dial tcp: ECONNRESET",
                code: 1,
            });
        });
        assert.equal(doc.sources.github?.ok, false);
        assert.deepEqual(doc.sources.github?.partial, ["a/b#1"]);
        assert.equal(doc.sources.github?.complete, false);

        await answerPass(doc, prs, T0 + OPEN_REFRESH_MS + PASS_MS, { data: { p0: open } });
        assert.equal(doc.sources.github?.ok, true);
        assert.equal(doc.sources.github?.partial, undefined);
        assert.equal(doc.sources.github?.complete, true);
    });

    test("a NOT_FOUND PR is never partial; a later good read makes it follow the normal rules", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link(), "a/b#2": link() } })]);
        const open = {
            isArchived: false,
            pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) },
        };
        const settled = () => ({
            excluded: doc.prs["a/b#1"]?.excluded,
            partial: doc.sources.github?.partial,
            complete: doc.sources.github?.complete,
        });
        const missing = { excluded: "missing", partial: undefined, complete: true };

        // Its own pass.
        await answerPass(doc, prs, T0, {
            data: { p0: { isArchived: false, pullRequest: null }, p1: open },
            errors: [{ type: "NOT_FOUND", path: ["p0", "pullRequest"], message: "x" }],
        });
        assert.deepEqual(settled(), missing);

        // A pass with no read.
        await pass(doc, prs, T0 + PASS_MS, async () => {
            throw new Error("no read is due");
        });
        assert.deepEqual(settled(), missing);

        // A failure of the whole read.
        await pass(doc, prs, T0 + OPEN_REFRESH_MS, async () => {
            throw Object.assign(new Error("Command failed: gh api graphql"), {
                stderr: "dial tcp: ECONNRESET",
                code: 1,
            });
        });
        assert.equal(doc.sources.github?.ok, false);
        assert.deepEqual(settled(), missing);

        // It is there again, with a deeper error: not excluded, so partial until a clean read.
        const back = T0 + CLOSED_REFRESH_MS;

        assert.deepEqual(
            planReads(doc, trackedRefs(prs), back).map((read) => read.key),
            ["a/b#1", "a/b#2"],
        );
        await answerPass(doc, prs, back, {
            data: { p0: open, p1: open },
            errors: [{ type: "INTERNAL", path: ["p0", "pullRequest", "mergedAt"], message: "x" }],
        });
        assert.deepEqual(settled(), { excluded: undefined, partial: ["a/b#1"], complete: false });

        await answerPass(doc, prs, back + OPEN_REFRESH_MS, { data: { p0: open, p1: open } });
        assert.deepEqual(settled(), { excluded: undefined, partial: undefined, complete: true });
    });

    test("a partial ref that becomes untracked leaves the list", async () => {
        const doc = fresh();
        const prs = deskOf([thread("T1", { prs: { "a/b#1": link(), "a/b#2": link() } })]);

        await answerPass(doc, prs, T0, {
            data: {
                p0: { isArchived: false, pullRequest: { state: "OPEN", createdAt: iso(T0 - DAY) } },
                p1: { isArchived: false, pullRequest: null },
            },
            errors: [
                { type: "INTERNAL", path: ["p0", "pullRequest", "mergedAt"], message: "x" },
                { type: "FORBIDDEN", path: ["p1", "pullRequest"], message: "x" },
            ],
        });
        assert.deepEqual(doc.sources.github?.partial, ["a/b#1", "a/b#2"]);
        assert.equal(doc.sources.github?.complete, false);

        await pass(doc, deskOf([thread("T1")]), T0 + PASS_MS, async () => {
            throw new Error("no read is due");
        });
        assert.equal(doc.prs["a/b#1"]?.untracked, true);
        assert.equal(doc.prs["a/b#2"]?.untracked, true);
        assert.equal(doc.sources.github?.partial, undefined);
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

    test("a manual close with 1 or 2 earlier merged closing PRs has no resolving PR", async () => {
        for (const closing of [
            [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
            [
                { ref: "a/b#7", mergedAt: T0 - 5 * DAY },
                { ref: "a/b#8", mergedAt: T0 - 2 * DAY },
            ],
        ]) {
            const doc = await resolveWith({
                state: "CLOSED",
                createdAt: T0 - 10 * DAY,
                closedAt: T0 - DAY,
                event: { type: "closed", closer: null },
                closing,
                pages: { page2: { nodes: [] } },
            });

            assert.equal(doc.issues["a/b#5"]?.unresolved, "no-resolving-pr");
            assert.equal(doc.issues["a/b#5"]?.resolution, undefined);
            assert.equal(doc.issues["a/b#5"]?.closing?.cursor, undefined, "no more pages");
        }
    });

    test("no visible close: a merged closing PR is ambiguous; none in a complete list has no resolving PR", async () => {
        for (const event of [undefined, { type: "reopened" } as const]) {
            const ambiguous = await resolveWith({
                state: "CLOSED",
                createdAt: T0 - 10 * DAY,
                closedAt: T0 - DAY,
                event,
                closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
                pages: { page2: { nodes: [{ ref: "a/b#8", mergedAt: T0 - 2 * DAY }] } },
            });

            assert.equal(ambiguous.issues["a/b#5"]?.unresolved, "ambiguous");
            assert.equal(ambiguous.issues["a/b#5"]?.resolution, undefined);
            assert.equal(ambiguous.issues["a/b#5"]?.closing?.cursor, undefined, "paging stops");
            assert.equal(planReads(ambiguous, trackedRefs(desk), T0 + PASS_MS).length, 0);

            const none = await resolveWith({
                state: "CLOSED",
                createdAt: T0 - 10 * DAY,
                closedAt: T0 - DAY,
                event,
                closing: [],
            });

            assert.equal(none.issues["a/b#5"]?.unresolved, "no-resolving-pr");
            assert.equal(none.issues["a/b#5"]?.resolution, undefined);
            assert.equal(none.issues["a/b#5"]?.closing?.complete, true);
        }
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

    /** Closed by a/b#7 at T0 (a sample), then reopened (no sample): the document, the world, and the next pass time. */
    async function reopenedAfterPr() {
        const doc = fresh();
        const world: World = {
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - DAY } },
                    closing: [{ ref: "a/b#7", mergedAt: T0 - DAY }],
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
            closing: [{ ref: "a/b#7", mergedAt: T0 - DAY }],
        };
        await pass(doc, desk, T0 + CLOSED_REFRESH_MS, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "open");
        assert.equal(doc.issues["a/b#5"]?.resolution, undefined);

        return { doc, world, github, later: T0 + CLOSED_REFRESH_MS + OPEN_REFRESH_MS };
    }

    test("closed by a PR, reopened, then closed by hand: no resolving PR", async () => {
        const { doc, world, github, later } = await reopenedAfterPr();

        world.issues!["a/b#5"] = {
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: later - HOUR,
            event: { type: "closed", closer: null },
            closing: [{ ref: "a/b#7", mergedAt: T0 - DAY }],
        };
        await pass(doc, desk, later, github.graphql);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "no-resolving-pr");
        assert.equal(doc.issues["a/b#5"]?.resolution, undefined);
    });

    test("closed by PR A, reopened, then closed by PR B: B resolves it, once", async () => {
        const { doc, world, github, later } = await reopenedAfterPr();

        world.issues!["a/b#5"] = {
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: later - HOUR,
            event: { type: "closed", closer: { pr: "a/b#9", mergedAt: later - 2 * HOUR } },
            closing: [
                { ref: "a/b#7", mergedAt: T0 - DAY },
                { ref: "a/b#9", mergedAt: later - 2 * HOUR },
            ],
        };
        await pass(doc, desk, later, github.graphql);
        assert.deepEqual(doc.issues["a/b#5"]?.resolution, {
            pr: "a/b#9",
            mergedAt: later - 2 * HOUR,
            evidence: "closed-event",
            at: later,
        });
        assert.equal(doc.issues["a/b#5"]?.unresolved, undefined);
        assert.equal(doc.issues["a/b#5"]?.createdAt, T0 - 10 * DAY, "the creation time stays");
        assert.equal(Object.keys(doc.issues).length, 1);
    });

    test("a stored closing-reference resolution is read again at once and judged by the current rule", async () => {
        const doc = fresh();
        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: null },
                    closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
                },
            },
        });

        await pass(doc, desk, T0, github.graphql);
        assert.equal(planReads(doc, trackedRefs(desk), T0 + PASS_MS).length, 0, "not due yet");

        // What the older rule stored for this issue: 1 merged closing reference before a manual close.
        const fact = doc.issues["a/b#5"]!;

        fact.resolution = {
            pr: "a/b#7",
            mergedAt: T0 - 5 * DAY,
            evidence: "closing-reference",
            at: T0,
        };
        delete fact.unresolved;

        assert.deepEqual(
            planReads(doc, trackedRefs(desk), T0 + PASS_MS).map((read) => [read.kind, read.why]),
            [["issue", 1]],
        );
        await pass(doc, desk, T0 + PASS_MS, github.graphql);
        assert.equal(github.calls.length, 2);
        assert.equal(doc.issues["a/b#5"]?.resolution, undefined);
        assert.equal(doc.issues["a/b#5"]?.unresolved, "no-resolving-pr");
        assert.equal(planReads(doc, trackedRefs(desk), T0 + 2 * PASS_MS).length, 0);
    });

    /** A document with a resolution that the older closing-reference rule stored: read at T0, a manual close. */
    async function legacy() {
        const doc = fresh();
        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: null },
                    closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
                },
            },
        });

        await pass(doc, desk, T0, github.graphql);

        const fact = doc.issues["a/b#5"]!;

        fact.resolution = {
            pr: "a/b#7",
            mergedAt: T0 - 5 * DAY,
            evidence: "closing-reference",
            at: T0,
        };
        delete fact.unresolved;

        return { doc, github };
    }

    const legacyKept = (doc: DashboardState) => ({
        unresolved: doc.issues["a/b#5"]?.unresolved,
        evidence: doc.issues["a/b#5"]?.resolution?.evidence,
    });
    const ambiguousKept = { unresolved: "ambiguous", evidence: "closing-reference" };

    test("a legacy closing-reference resolution is ambiguous while its read fails", async () => {
        const failed = await legacy();

        await pass(failed.doc, desk, T0 + PASS_MS, async () => {
            throw Object.assign(new Error("Command failed: gh api graphql"), {
                stderr: "dial tcp: ECONNRESET",
                code: 1,
            });
        });
        assert.equal(failed.doc.sources.github?.ok, false);
        assert.deepEqual(legacyKept(failed.doc), ambiguousKept);
        assert.deepEqual(
            planReads(failed.doc, trackedRefs(desk), T0 + 2 * PASS_MS).map((read) => [
                read.kind,
                read.why,
            ]),
            [["issue", 1]],
            "still read at once",
        );

        const unavailable = await legacy();

        await answerPass(unavailable.doc, desk, T0 + PASS_MS, {
            data: { i0: issueNode({ timelineItems: null }) },
            errors: [{ type: "INTERNAL", path: ["i0", "issue", "timelineItems"], message: "x" }],
        });
        assert.equal(unavailable.doc.issues["a/b#5"]?.error, "partial");
        assert.deepEqual(legacyKept(unavailable.doc), ambiguousKept);

        // The same pass twice gives the same document.
        const once = copy(unavailable.doc);
        const input = { tracked: trackedRefs(desk), reads: [], now: T0 + 2 * PASS_MS };

        applyPass(once, input);

        const twice = copy(once);

        applyPass(twice, input);
        assert.deepEqual(twice, once);
    });

    test("a legacy closing-reference resolution is ambiguous during a backoff and when the budget defers it", async () => {
        const backoff = await legacy();

        backoff.doc.sources.github = { ...backoff.doc.sources.github, backoffUntil: T0 + DAY };
        await pass(backoff.doc, desk, T0 + PASS_MS, backoff.github.graphql);
        assert.equal(backoff.github.calls.length, 1, "no read during the backoff");
        assert.deepEqual(legacyKept(backoff.doc), ambiguousKept);

        // More never-read PRs than the budget: they go first, and the issue waits.
        const deferred = await legacy();
        const prs: Record<string, PrLink> = {};
        const world: World = { prs: {}, issues: {} };

        for (let n = 1; n <= MAX_REF_READS; n += 1) {
            prs[`a/b#${String(100 + n)}`] = link();
            world.prs![`a/b#${String(100 + n)}`] = { state: "OPEN", createdAt: T0 - DAY };
        }

        world.issues!["a/b#5"] = {
            state: "CLOSED",
            createdAt: T0 - 10 * DAY,
            closedAt: T0 - DAY,
            event: { type: "closed", closer: null },
            closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
        };

        const busy = deskOf([thread("T1", { prs, issues: ["a/b#5"] })]);
        const github = fakeGitHub(world);

        assert.ok(
            !planReads(deferred.doc, trackedRefs(busy), T0 + PASS_MS).some(
                (read) => read.key === "a/b#5",
            ),
        );
        await pass(deferred.doc, busy, T0 + PASS_MS, github.graphql);
        assert.equal(deferred.doc.prs["a/b#101"]?.readAt, T0 + PASS_MS);
        assert.deepEqual(legacyKept(deferred.doc), ambiguousKept);

        // The next pass reads it, and the current rule judges it.
        await pass(deferred.doc, busy, T0 + 2 * PASS_MS, github.graphql);
        assert.equal(deferred.doc.issues["a/b#5"]?.readAt, T0 + 2 * PASS_MS);
        assert.equal(deferred.doc.issues["a/b#5"]?.unresolved, "no-resolving-pr");
        assert.equal(deferred.doc.issues["a/b#5"]?.resolution, undefined);
    });

    test("a good read judges a legacy closing-reference resolution by the current rule", async () => {
        const { doc } = await legacy();
        const github = fakeGitHub({
            issues: {
                "a/b#5": {
                    state: "CLOSED",
                    createdAt: T0 - 10 * DAY,
                    closedAt: T0 - DAY,
                    event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - 5 * DAY } },
                    closing: [{ ref: "a/b#7", mergedAt: T0 - 5 * DAY }],
                },
            },
        });

        await pass(doc, desk, T0 + PASS_MS, github.graphql);
        assert.deepEqual(doc.issues["a/b#5"]?.resolution, {
            pr: "a/b#7",
            mergedAt: T0 - 5 * DAY,
            evidence: "closed-event",
            at: T0 + PASS_MS,
        });
        assert.equal(doc.issues["a/b#5"]?.unresolved, undefined);
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
            event: { type: "closed", closer: { pr: "a/b#7", mergedAt: T0 - 2 * DAY } },
            closing: [
                { ref: "a/b#6", mergedAt: T0 - 3 * DAY },
                { ref: "a/b#7", mergedAt: T0 - 2 * DAY },
            ],
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
                    // No visible close event: the closing references tell ambiguous from no resolving PR.
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
        assert.equal(
            doc.issues["a/b#5"]?.unresolved,
            "ambiguous",
            "a merged reference, no visible closer",
        );
        assert.equal(doc.issues["a/b#5"]?.resolution, undefined);
        assert.deepEqual(doc.issues["a/b#5"]?.closing?.merged, [
            { ref: "a/b#7", mergedAt: T0 - 2 * DAY },
        ]);
        assert.equal(doc.issues["a/b#5"]?.closing?.cursor, undefined);
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

// ─── The subscription meter's step ───────────────────────────────────────────

/** The plan's R4 answer time (2026-11-14 02:56:29 UTC): the meter tests' clock. */
const METER_NOW = Date.parse("2026-11-14T02:56:29Z");
const MINUTE = 60_000;
const METER_ZONE = "America/New_York";
/** The ledger only: no provider read. */
const LEDGER_ONLY: MeterSettings = { providers: [], pollMinutes: 5, digestAt: 75, holdAt: null };
const METER_ON: MeterSettings = { ...LEDGER_ONLY, providers: ["anthropic"] };
/** A fake token: no answer, view, error text or log line may hold it. */
const FAKE_TOKEN = "sk-ant-oat01-FAKE-TOKEN-DO-NOT-LEAK";
/** The plan's R4 answer, as `desk-meter.test.ts` has it (the parts the parser reads). */
const R4_BODY = {
    limits: [
        {
            kind: "weekly_all",
            group: "weekly",
            percent: 95,
            severity: "critical",
            resets_at: "2026-11-18T16:00:00Z",
            scope: null,
            is_active: true,
        },
        {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 19,
            severity: "normal",
            resets_at: "2026-11-18T16:00:00Z",
            scope: { model: { display_name: "Fable" } },
            is_active: false,
        },
    ],
    five_hour: null,
    seven_day: { utilization: 95, resets_at: "2026-11-18T16:00:00Z" },
    tangelo: null,
};

/**
 * The R4 answer with both windows resetting at `at`: for a test on the real clock, which must not compare with the
 * fixture's dated reset. The fixed-clock tests keep `R4_BODY`.
 */
const r4ResettingAt = (at: number) => {
    const resetsAt = new Date(at).toISOString();

    return {
        ...R4_BODY,
        limits: R4_BODY.limits.map((limit) => ({ ...limit, resets_at: resetsAt })),
        seven_day: { utilization: 95, resets_at: resetsAt },
    };
};

/** A fake store: conversations (a fork has a parent), entries in id order. */
type MeterWorld = {
    conversations: { id: number; parent?: { conversationId: number; at: number } }[];
    entries: EntryRecord[];
    next: number;
    /** The table reads of each read commit that ended. */
    commits: number[];
    /** Each `scanEntries` call, by conversation id, before a failure: how often a conversation was tried. */
    scans: number[];
    /** A read of these throws. */
    failing: Set<number>;
    /** Runs after each table read (its page is made): a test adds entries or moves the clock here. */
    onRead?: (kind: "conversations" | "entries", id?: number) => void;
};

const meterWorld = (): MeterWorld => ({
    conversations: [],
    entries: [],
    next: 0,
    commits: [],
    scans: [],
    failing: new Set(),
});

function meterConversation(w: MeterWorld, id: number, parentId?: number, at?: number): void {
    w.conversations.push({
        id,
        ...(parentId === undefined ? {} : { parent: { conversationId: parentId, at: at ?? 0 } }),
    });
}

/** 1 answer in conversation `id`, as generation writes it. `cost: null` leaves the cost out. */
function answerIn(
    w: MeterWorld,
    id: number,
    use: { at?: number; cost?: number | null; provider?: string; kind?: string } = {},
): number {
    w.next += 1;
    w.entries.push({
        id: w.next,
        conversationId: id,
        kind: use.kind ?? "pi.assistant",
        model: [
            {
                role: "assistant",
                content: [],
                api: "fake",
                provider: use.provider ?? "anthropic",
                model: "claude-opus-5-5",
                usage: {
                    input: 10,
                    output: 5,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 15,
                    ...(use.cost === null
                        ? {}
                        : {
                              cost: {
                                  input: 0,
                                  output: 0,
                                  cacheRead: 0,
                                  cacheWrite: 0,
                                  total: use.cost ?? 1,
                              },
                          }),
                },
                stopReason: "stop",
                timestamp: use.at ?? METER_NOW - MINUTE,
            },
        ],
    } as unknown as EntryRecord);

    return w.next;
}

/** A user entry: read, never counted. */
function userIn(w: MeterWorld, id: number): void {
    w.next += 1;
    w.entries.push({
        id: w.next,
        conversationId: id,
        kind: "pi.user",
        model: [{ role: "user", content: "hi", timestamp: METER_NOW }],
    } as unknown as EntryRecord);
}

/** The fork-aware history of a conversation, as Pi Durable's storage gives it, oldest first. */
function visibleIn(w: MeterWorld, id: number, upper = Infinity): EntryRecord[] {
    const conversation = w.conversations.find((each) => each.id === id);

    assert(conversation, `conversation ${String(id)} exists`);

    const own = w.entries.filter((entry) => entry.conversationId === id && entry.id <= upper);
    const inherited =
        conversation.parent === undefined
            ? []
            : visibleIn(
                  w,
                  conversation.parent.conversationId,
                  Math.min(upper, conversation.parent.at),
              );

    return [...inherited, ...own].sort((a, b) => a.id - b.id);
}

/** 1 commit that only reads, over the fake store: it counts its table reads. */
function meterRead(w: MeterWorld): MeterDeps["read"] {
    return async <T>(fn: (tx: MeterTx) => Promise<T>): Promise<T> => {
        let reads = 0;
        const tx = {
            scanEntries: async (
                query: {
                    conversationId: number;
                    minEntryId?: number;
                    maxEntryId?: number;
                    order?: string;
                },
                limit: number,
            ) => {
                reads += 1;
                w.scans.push(query.conversationId);

                if (w.failing.has(query.conversationId)) {
                    throw new Error("the storage read failed");
                }

                const list = visibleIn(w, query.conversationId).filter(
                    (entry) =>
                        entry.id >= (query.minEntryId ?? 0) &&
                        entry.id <= (query.maxEntryId ?? Infinity),
                );

                if ((query.order ?? "descending") === "descending") {
                    list.reverse();
                }

                const items = copy(list.slice(0, limit));

                w.onRead?.("entries", query.conversationId);

                return list.length > limit ? { items, next: { more: true } } : { items };
            },
            scanConversations: async (
                _query: unknown,
                limit: number,
                cursor?: { after?: number },
            ) => {
                reads += 1;

                const list = [...w.conversations]
                    .sort((a, b) => a.id - b.id)
                    .filter((each) => each.id > (cursor?.after ?? 0));
                const items = copy(list.slice(0, limit));

                w.onRead?.("conversations");

                return list.length > limit
                    ? { items, next: { after: items[items.length - 1]?.id ?? 0 } }
                    : { items };
            },
        } as unknown as MeterTx;
        const value = await fn(tx);

        w.commits.push(reads);

        return value;
    };
}

/** The meter's deps over the fake store: the ledger only, unless the test gives a reader. */
function meterDeps(w: MeterWorld, patch: Partial<MeterDeps> = {}): MeterDeps {
    return {
        state: emptyMeterState(),
        ledger: emptyMeterLedger(),
        settings: LEDGER_ONLY,
        readProvider: async () => assert.fail("no provider read"),
        read: meterRead(w),
        ...patch,
    };
}

/** The ledger's sums over every bucket. */
function ledgerSums(state: MeterState): { entries: number; cost: number; unknownCost: number } {
    const sums = { entries: 0, cost: 0, unknownCost: 0 };

    for (const byProvider of Object.values(state.buckets)) {
        for (const byModel of Object.values(byProvider)) {
            for (const bucket of Object.values(byModel)) {
                sums.entries += bucket.entries;
                sums.cost += bucket.cost;
                sums.unknownCost += bucket.unknownCost;
            }
        }
    }

    return sums;
}

/** A Response for the fake fetch. */
const respond = (status: number, body: string): Response => new Response(body, { status });

/** A fake fetch that answers only when its signal aborts: then it throws the signal's reason, as fetch does. */
const hangingFetch = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;

        if (signal.aborted) {
            reject(signal.reason);
        }

        signal.addEventListener("abort", () => reject(signal.reason));
    })) as unknown as typeof fetch;

describe("the subscription meter's step", () => {
    test("a parent and a fork: the fork's inherited answers count once, in the parent; a second pass adds none", async () => {
        const w = meterWorld();

        meterConversation(w, 1);
        answerIn(w, 1, { cost: 1 });
        const fork = answerIn(w, 1, { cost: 2 });

        userIn(w, 1);
        meterConversation(w, 2, 1, fork);
        answerIn(w, 2, { cost: 4 });
        meterConversation(w, 3);

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        assert.deepEqual(ledgerSums(deps.state), { entries: 3, cost: 7, unknownCost: 0 });
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 3,
            total: 3,
        });
        assert.deepEqual({ ...deps.ledger.high }, { 1: 3, 2: 4, 3: 0 });
        assert.equal(deps.ledger.sweep, undefined, "the backfill ended");

        await meterPass(deps, METER_NOW + PASS_MS);
        assert.deepEqual(ledgerSums(deps.state), { entries: 3, cost: 7, unknownCost: 0 });
        assert.ok(
            w.commits.every((reads) => reads <= METER_READS),
            "no commit reads more than 25 times",
        );
    });

    test("the backfill stops at the first answer older than 8 days; no cost is unknown; other kinds and bad answers count nothing", async () => {
        const w = meterWorld();

        meterConversation(w, 1);
        answerIn(w, 1, { at: METER_NOW - 9 * DAY, cost: 50 });
        answerIn(w, 1, { at: METER_NOW - 2 * DAY, cost: null });
        answerIn(w, 1, { kind: "pi.other", cost: 20 });
        answerIn(w, 1, { provider: "", cost: 30 });
        answerIn(w, 1, { at: METER_NOW - HOUR, cost: 3 });

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        assert.deepEqual(ledgerSums(deps.state), { entries: 2, cost: 3, unknownCost: 1 });
    });

    test("answers that arrive during the backfill count once: between its pages, and between passes", async () => {
        const w = meterWorld();

        meterConversation(w, 1);

        for (let index = 0; index < 450; index += 1) {
            answerIn(w, 1, { at: METER_NOW - 30 * MINUTE, cost: 1 });
        }

        let added = false;

        w.onRead = (kind, id) => {
            // After the backfill's first page: 2 new answers, above its first entry.
            if (kind === "entries" && id === 1 && !added) {
                added = true;
                answerIn(w, 1, { cost: 10 });
                answerIn(w, 1, { cost: 10 });
            }
        };

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        assert.deepEqual(ledgerSums(deps.state), { entries: 450, cost: 450, unknownCost: 0 });
        assert.equal(deps.ledger.high["1"], 450, "the backfill's first entry");

        // The conversation has recent answers: the next pass reads it up from its first entry.
        await meterPass(deps, METER_NOW + PASS_MS);
        assert.deepEqual(ledgerSums(deps.state), { entries: 452, cost: 470, unknownCost: 0 });

        answerIn(w, 1, { cost: 100 });
        await meterPass(deps, METER_NOW + 2 * PASS_MS);
        assert.deepEqual(ledgerSums(deps.state), { entries: 453, cost: 570, unknownCost: 0 });

        await meterPass(deps, METER_NOW + 3 * PASS_MS);
        assert.deepEqual(ledgerSums(deps.state), { entries: 453, cost: 570, unknownCost: 0 });
    });

    test("the sweep spends at most 20 s by the pass's clock; the next pass goes on from its cursors, also within a backfill", async () => {
        const w = meterWorld();
        let clock = METER_NOW;

        meterConversation(w, 1);

        for (let index = 0; index < 650; index += 1) {
            answerIn(w, 1, { at: METER_NOW - 2 * HOUR });
        }

        meterConversation(w, 2);
        answerIn(w, 2, { at: METER_NOW - 2 * HOUR });
        meterConversation(w, 3);
        answerIn(w, 3, { at: METER_NOW - 2 * HOUR });

        // Each table read takes 6 s: the list and 3 pages, then the 4th check is at 24 s.
        w.onRead = () => {
            clock += 6_000;
        };

        const deps = meterDeps(w, { now: () => clock });

        await meterPass(deps, clock);
        assert.deepEqual(ledgerSums(deps.state).entries, 600);
        assert.deepEqual({ ...deps.ledger.downs }, { 1: 50 }, "the backfill's entry cursor");
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 0,
            total: 3,
        });
        assert.equal(
            meterView(deps.state, LEDGER_ONLY, clock, METER_ZONE).providers[0]?.ledger.partial,
            true,
        );

        await meterPass(deps, clock);
        assert.deepEqual(ledgerSums(deps.state).entries, 652);
        assert.deepEqual({ ...deps.ledger.downs }, {});
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 3,
            total: 3,
        });
        assert.equal(
            meterView(deps.state, LEDGER_ONLY, clock, METER_ZONE).providers[0]?.ledger.partial,
            false,
        );
        assert.equal(
            meterStatusLine(
                meterView(deps.state, LEDGER_ONLY, clock, METER_ZONE),
                clock,
                METER_ZONE,
            ),
            "Meter: provider reads off; ledger complete since Thu 5 Nov 21:56; hold off",
        );
    });

    test("a run that lasts 3 passes: its answers count in each pass, each once; it goes after a read that starts after its end", async () => {
        const w = meterWorld();
        let clock = METER_NOW;
        const old = { at: METER_NOW - 2 * HOUR };

        meterConversation(w, 5);
        answerIn(w, 5, old);

        const deps = meterDeps(w, { now: () => clock });

        await meterPass(deps, clock);
        assert.equal(ledgerSums(deps.state).entries, 1);

        // `run.started`: the desk's listener adds it.
        deps.ledger.active.add(5);
        answerIn(w, 5, old);
        answerIn(w, 5, old);
        clock += PASS_MS;
        await meterPass(deps, clock);
        assert.equal(ledgerSums(deps.state).entries, 3);

        // `run.ended`, after this pass's read starts: it stays active.
        deps.ledger.ended.set(5, clock + PASS_MS + 500);
        answerIn(w, 5, old);
        answerIn(w, 5, old);
        clock += PASS_MS;
        await meterPass(deps, clock);
        assert.equal(ledgerSums(deps.state).entries, 5);
        assert.equal(deps.ledger.active.has(5), true);

        // The next read starts after the end: it counts the last answer, and the conversation goes.
        answerIn(w, 5, old);
        clock += PASS_MS;
        await meterPass(deps, clock);
        assert.equal(ledgerSums(deps.state).entries, 6);
        assert.equal(deps.ledger.active.has(5), false);
        assert.equal(deps.ledger.ended.has(5), false);

        // Not active, and no answer in the last hour: the next sweep reads it.
        answerIn(w, 5, old);
        clock += PASS_MS;
        await meterPass(deps, clock);
        assert.equal(ledgerSums(deps.state).entries, 6);
    });

    test("a new sweep starts at the 12th pass after the last one started, and leaves the coverage as it is", async () => {
        const w = meterWorld();
        const old = { at: METER_NOW - 2 * HOUR };

        meterConversation(w, 1);
        answerIn(w, 1, old);

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        meterConversation(w, 9);
        answerIn(w, 9, old);

        for (let pass = 2; pass <= 12; pass += 1) {
            await meterPass(deps, METER_NOW + (pass - 1) * PASS_MS);
            assert.equal(ledgerSums(deps.state).entries, 1, `pass ${String(pass)}`);
        }

        await meterPass(deps, METER_NOW + 12 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 2);
        assert.equal(deps.ledger.passes, 13);
        assert.equal(deps.ledger.sweeps, 2);
        assert.equal(deps.ledger.sweepStartedPass, 13);
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 1,
            total: 1,
        });
    });

    test("a failed read: in the backfill the conversation becomes a gap and the sweep goes on; the retry clears it; a later sweep skips a failed one; an active one waits for the next pass", async () => {
        const w = meterWorld();
        const old = { at: METER_NOW - 2 * HOUR };

        for (const id of [1, 2, 3]) {
            meterConversation(w, id);
            answerIn(w, id, old);
        }

        w.failing.add(2);

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        assert.equal(ledgerSums(deps.state).entries, 1, "the reads before the failure count");
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 1,
            total: 3,
        });
        assert.deepEqual({ ...deps.ledger.gaps }, { 2: 1 });
        assert.deepEqual(deps.ledger.sweep?.queue, [3], "the sweep goes on without it");

        // The retry fails again; the sweep reads 3 and ends; a gap keeps the coverage not complete.
        await meterPass(deps, METER_NOW + PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 2);
        assert.equal(deps.ledger.sweep, undefined, "the backfill sweep ended");
        assert.equal(deps.ledger.backfillDone, true);
        assert.deepEqual({ ...deps.ledger.gaps }, { 2: 2 });
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 2,
            total: 3,
        });

        // The retry works: the gap goes, it counts as done, and the coverage is complete.
        w.failing.clear();
        await meterPass(deps, METER_NOW + 2 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 3);
        assert.deepEqual({ ...deps.ledger.gaps }, {});
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 3,
            total: 3,
        });

        // A later sweep (the 12th pass after the backfill started) skips a conversation whose read fails, and ends.
        meterConversation(w, 4);
        answerIn(w, 4, old);
        w.failing.add(4);

        for (let pass = 4; pass <= 13; pass += 1) {
            await meterPass(deps, METER_NOW + (pass - 1) * PASS_MS);
        }

        assert.equal(deps.ledger.sweeps, 2);
        assert.equal(deps.ledger.sweep, undefined, "the later sweep ended");
        assert.equal(deps.ledger.high["4"], undefined, "the skipped conversation is not read");
        assert.deepEqual({ ...deps.ledger.gaps }, {}, "a later sweep makes no gap");
        assert.equal(ledgerSums(deps.state).entries, 3);
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 3,
            total: 3,
        });

        // 2 active conversations: 3 fails, 1 is read.
        w.failing.clear();
        w.failing.add(3);
        deps.ledger.active.add(1);
        deps.ledger.active.add(3);
        answerIn(w, 1, old);
        await meterPass(deps, METER_NOW + 13 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 4);
        assert.equal(deps.ledger.active.has(3), true);

        w.failing.clear();
        answerIn(w, 3, old);
        await meterPass(deps, METER_NOW + 14 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 5);
    });

    test("a backfill conversation that always fails, of 150: every page is listed and counted, the backfill ends, the coverage stays not complete, the retries stop after 3, and the hourly sweep starts at the 12th pass", async () => {
        const w = meterWorld();
        const old = { at: METER_NOW - 2 * HOUR };

        for (let id = 1; id <= 150; id += 1) {
            meterConversation(w, id);
            answerIn(w, id, old);
        }

        w.failing.add(1);

        const deps = meterDeps(w);
        const triesOf1 = () => w.scans.filter((id) => id === 1).length;

        await meterPass(deps, METER_NOW);
        assert.equal(ledgerSums(deps.state).entries, 0);
        assert.deepEqual({ ...deps.ledger.gaps }, { 1: 1 });
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 0,
            total: 100,
        });

        // The retry fails; the sweep reads 2 to 100, lists the second page, reads 101 to 150, and ends.
        await meterPass(deps, METER_NOW + PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 149);
        assert.equal(deps.ledger.high["150"], 150);
        assert.equal(deps.ledger.sweep, undefined, "the backfill sweep ended");
        assert.equal(deps.ledger.backfillDone, true);
        assert.deepEqual({ ...deps.ledger.gaps }, { 1: 2 });
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 149,
            total: 150,
        });

        await meterPass(deps, METER_NOW + 2 * PASS_MS);
        assert.deepEqual({ ...deps.ledger.gaps }, { 1: 3 });
        assert.equal(triesOf1(), 3, "the backfill's read and 2 retries");

        // No more retries after 3 failures, and no sweep before the 12th pass after the backfill started.
        for (let pass = 4; pass <= 12; pass += 1) {
            await meterPass(deps, METER_NOW + (pass - 1) * PASS_MS);
        }

        assert.equal(triesOf1(), 3);
        assert.equal(deps.ledger.sweeps, 1);
        assert.equal(deps.state.coverage.complete, false);

        // The 12th pass after the backfill started: the hourly sweep starts, and tries conversation 1 again.
        await meterPass(deps, METER_NOW + 12 * PASS_MS);
        assert.equal(deps.ledger.passes, 13);
        assert.equal(deps.ledger.sweeps, 2);
        assert.equal(deps.ledger.sweepStartedPass, 13);
        assert.equal(triesOf1(), 4);
        assert.deepEqual({ ...deps.ledger.gaps }, { 1: 3 }, "a later sweep adds no try");
        assert.equal(ledgerSums(deps.state).entries, 149);
        assert.equal(deps.state.coverage.complete, false);

        // A later read that works (here as an active conversation) clears the gap: the coverage is complete.
        w.failing.clear();
        deps.ledger.active.add(1);
        await meterPass(deps, METER_NOW + 13 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 150);
        assert.deepEqual({ ...deps.ledger.gaps }, {});
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 150,
            total: 150,
        });
    });

    test("a backfill conversation of 150 that fails once within its backfill: the retry goes on from its cursor, the coverage completes, and each answer counts once", async () => {
        const w = meterWorld();
        const old = { at: METER_NOW - 2 * HOUR };

        meterConversation(w, 1);

        for (let index = 0; index < 250; index += 1) {
            answerIn(w, 1, old);
        }

        for (let id = 2; id <= 150; id += 1) {
            meterConversation(w, id);
            answerIn(w, id, old);
        }

        let armed = false;

        // After the first page of conversation 1, its next read fails.
        w.onRead = (kind, id) => {
            if (kind === "entries" && id === 1 && !armed) {
                armed = true;
                w.failing.add(1);
            }
        };

        const deps = meterDeps(w);

        await meterPass(deps, METER_NOW);
        assert.equal(ledgerSums(deps.state).entries, 200, "conversation 1's first page");
        assert.deepEqual(
            { ...deps.ledger.downs },
            { 1: 50 },
            "the backfill keeps its entry cursor",
        );
        assert.deepEqual({ ...deps.ledger.gaps }, { 1: 1 });
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: false,
            done: 0,
            total: 100,
        });

        w.failing.clear();
        await meterPass(deps, METER_NOW + PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 399, "250 + 149, each once");
        assert.deepEqual({ ...deps.ledger.downs }, {});
        assert.deepEqual({ ...deps.ledger.gaps }, {});
        assert.deepEqual(deps.state.coverage, {
            since: METER_NOW - 8 * DAY,
            complete: true,
            done: 150,
            total: 150,
        });

        await meterPass(deps, METER_NOW + 2 * PASS_MS);
        assert.equal(ledgerSums(deps.state).entries, 399);
    });

    test("an abort during a ledger read throws, counts nothing, and the pass's GitHub part does not run", async () => {
        const w = meterWorld();
        const controller = new AbortController();
        const deps = meterDeps(w);
        let commits = 0;

        meterConversation(w, 1);
        answerIn(w, 1);
        w.onRead = () => controller.abort();

        await assert.rejects(
            collectPass({
                readDesk: async () => deskOf([thread("T1", { prs: { "a/b#1": link() } })]),
                readDashboard: async () => fresh(),
                now: () => T0,
                graphql: async () => assert.fail("no GitHub call after an abort"),
                commit: async () => {
                    commits += 1;
                },
                signal: controller.signal,
                meter: deps,
            }),
        );
        assert.equal(commits, 0);
        assert.equal(ledgerSums(deps.state).entries, 0);
    });

    test("the provider read: 200 with the R4 answer, its request, and its timing", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const reader = anthropicReader({
            token: async () => FAKE_TOKEN,
            fetch: (async (url: string, init: RequestInit) => {
                calls.push({ url, init });

                return respond(200, JSON.stringify(R4_BODY));
            }) as unknown as typeof fetch,
            now: () => METER_NOW,
        });
        const deps = meterDeps(meterWorld(), { settings: METER_ON, readProvider: reader });

        await meterPass(deps, METER_NOW);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.url, ANTHROPIC_USAGE_URL);
        assert.equal(
            ANTHROPIC_USAGE_URL,
            "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
        );
        assert.equal(calls[0]?.init.method, "GET");
        assert.equal(calls[0]?.init.redirect, "error");
        assert.deepEqual(calls[0]?.init.headers, {
            authorization: `Bearer ${FAKE_TOKEN}`,
            "anthropic-beta": "oauth-2025-04-20",
            "user-agent": "claude-cli/2.1.280",
            "x-app": "cli",
        });
        assert.ok(calls[0]?.init.signal instanceof AbortSignal);
        assert.equal(
            meterView(deps.state, METER_ON, METER_NOW, METER_ZONE).providers[0]?.line,
            "Anthropic: week 95% used (critical), resets Wed 11:00 (in 4d 13h) · week, Fable 19%",
        );

        // The next read is due 5 minutes later, with 30 s of slack.
        await meterPass(deps, METER_NOW + 4.5 * MINUTE - 1);
        assert.equal(calls.length, 1);
        await meterPass(deps, METER_NOW + 4.5 * MINUTE);
        assert.equal(calls.length, 2);
        assert.equal(nextReadAt(deps.state, "anthropic", METER_ON), METER_NOW + 9.5 * MINUTE);
    });

    test("failures give fixed words: HTTP status, no JSON, network, timeout, no sign-in; the token is in no answer, view, state or log", async () => {
        const logged: string[] = [];
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const saved = methods.map((name) => console[name]);

        for (const name of methods) {
            console[name] = (...args: unknown[]) => {
                logged.push(args.map(String).join(" "));
            };
        }

        try {
            const signal = new AbortController().signal;
            const read = (io: Partial<Parameters<typeof anthropicReader>[0]>) =>
                anthropicReader({
                    token: async () => FAKE_TOKEN,
                    fetch: hangingFetch,
                    ...io,
                })("anthropic", signal);
            const answering = (status: number, body: string) =>
                (async () => respond(status, body)) as unknown as typeof fetch;

            assert.deepEqual(await read({ fetch: answering(401, `bad token ${FAKE_TOKEN}`) }), {
                error: "HTTP 401",
                status: 401,
            });
            assert.deepEqual(await read({ fetch: answering(429, `slow down ${FAKE_TOKEN}`) }), {
                error: "HTTP 429",
                status: 429,
            });
            assert.deepEqual(await read({ fetch: answering(200, `not json ${FAKE_TOKEN}`) }), {
                error: "usage answer is not JSON",
            });
            assert.deepEqual(await read({ fetch: answering(200, "[1, 2]") }), {
                error: "usage answer is not an object",
            });
            assert.deepEqual(
                await read({
                    fetch: (async () => {
                        throw new Error(`connect failed with Bearer ${FAKE_TOKEN}`);
                    }) as unknown as typeof fetch,
                }),
                { error: "network error" },
            );
            // The read's own limit is over: the hanging fetch ends with it.
            assert.deepEqual(
                await read({
                    timeout: () => AbortSignal.abort(new DOMException("over", "TimeoutError")),
                }),
                { error: "timed out after 15 s" },
            );
            assert.deepEqual(
                await read({
                    token: async () => ({ error: "Pi is not signed in to Anthropic" }),
                    fetch: async () => assert.fail("no request without a token"),
                }),
                { error: "Pi is not signed in to Anthropic" },
            );
            assert.deepEqual(
                await read({
                    token: async () => {
                        throw new Error(`the auth file holds ${FAKE_TOKEN}`);
                    },
                }),
                { error: "Pi's sign-in could not be read" },
            );
            // Defence in depth: an error text that holds the token is replaced.
            assert.deepEqual(
                await read({ token: async () => "HTTP 4", fetch: answering(403, "") }),
                { error: "request failed", status: 403 },
            );

            // Through the pass: a 401 is a refused sign-in; nothing the meter keeps or shows holds the token.
            const deps = meterDeps(meterWorld(), {
                settings: METER_ON,
                readProvider: anthropicReader({
                    token: async () => FAKE_TOKEN,
                    fetch: answering(401, `bad token ${FAKE_TOKEN}`),
                }),
            });

            await meterPass(deps, METER_NOW);

            const view = meterView(deps.state, METER_ON, METER_NOW, METER_ZONE);

            assert.equal(
                view.providers[0]?.line,
                "Anthropic: no provider report (sign-in refused, 401)",
            );
            assert.equal(nextReadAt(deps.state, "anthropic", METER_ON), METER_NOW + 30 * MINUTE);
            assert.equal(
                meterStatusLine(view, METER_NOW, METER_ZONE),
                "Meter: provider read never (last attempt: sign-in refused, 401 at 21:56); ledger complete since Thu 5 Nov 21:56; hold off",
            );
            assert.ok(!JSON.stringify(deps.state).includes(FAKE_TOKEN));
            assert.ok(!JSON.stringify(view).includes(FAKE_TOKEN));
        } finally {
            methods.forEach((name, index) => {
                console[name] = saved[index] as never;
            });
        }

        assert.deepEqual(
            logged.filter((line) => line.includes(FAKE_TOKEN)),
            [],
        );
    });

    test("a 429 backs off; an abort of the pass during the read throws, and records no attempt", async () => {
        const deps = meterDeps(meterWorld(), {
            settings: METER_ON,
            readProvider: anthropicReader({
                token: async () => FAKE_TOKEN,
                fetch: (async () => respond(429, "")) as unknown as typeof fetch,
            }),
        });

        await meterPass(deps, METER_NOW);
        assert.equal(nextReadAt(deps.state, "anthropic", METER_ON), METER_NOW + 15 * MINUTE);

        const controller = new AbortController();
        const aborted = meterDeps(meterWorld(), {
            settings: METER_ON,
            signal: controller.signal,
            readProvider: anthropicReader({ token: async () => FAKE_TOKEN, fetch: hangingFetch }),
        });
        const running = meterPass(aborted, METER_NOW);

        controller.abort();
        await assert.rejects(running);
        assert.equal(aborted.state.providers.anthropic?.lastAttempt, undefined);
    });

    test("an abort of the pass during the token, the fetch or the JSON read throws fixed words: the token is in no message, text, stack or cause", async () => {
        const leaks = (error: unknown): boolean => {
            const err = error as Error & { cause?: unknown };

            return [err.message, String(err), err.stack ?? "", String(err.cause ?? "")].some(
                (text) => text.includes(FAKE_TOKEN),
            );
        };

        /** A reader whose `step` aborts the pass, then throws an error that holds the token. */
        const aborting = (step: "token" | "fetch" | "json") => {
            const controller = new AbortController();

            const boom = (): never => {
                controller.abort();

                throw new Error(`request failed with Bearer ${FAKE_TOKEN}`);
            };

            const reader = anthropicReader({
                token: async () => (step === "token" ? boom() : FAKE_TOKEN),
                fetch: (async () => {
                    if (step === "fetch") {
                        return boom();
                    }

                    const response = respond(200, "{}");

                    // The body read aborts the pass, and fails with the token in its text.
                    Object.defineProperty(response, "json", { value: async () => boom() });

                    return response;
                }) as unknown as typeof fetch,
            });

            return { controller, reader };
        };

        for (const step of ["token", "fetch", "json"] as const) {
            const direct = aborting(step);
            const thrown = await direct.reader("anthropic", direct.controller.signal).then(
                () => assert.fail(`${step}: the read must throw`),
                (error: unknown) => error,
            );

            assert.equal((thrown as Error).message, "the meter's read was aborted", step);
            assert.equal((thrown as Error & { cause?: unknown }).cause, undefined, step);
            assert.equal(leaks(thrown), false, step);

            // Through the pass, and through collectPass: the same fixed words.
            const viaPass = aborting(step);
            const deps = meterDeps(meterWorld(), {
                settings: METER_ON,
                signal: viaPass.controller.signal,
                readProvider: viaPass.reader,
            });
            const passError = await meterPass(deps, METER_NOW).then(
                () => assert.fail(`${step}: the pass must throw`),
                (error: unknown) => error,
            );

            assert.equal((passError as Error).message, "the meter's read was aborted", step);
            assert.equal(leaks(passError), false, step);
            assert.equal(deps.state.providers.anthropic?.lastAttempt, undefined, step);

            const viaCollect = aborting(step);
            const collectError = await collectPass({
                readDesk: async () => deskOf([]),
                readDashboard: async () => fresh(),
                now: () => T0,
                graphql: async () => assert.fail("no GitHub call after an abort"),
                commit: async () => undefined,
                signal: viaCollect.controller.signal,
                meter: meterDeps(meterWorld(), {
                    settings: METER_ON,
                    readProvider: viaCollect.reader,
                }),
            }).then(
                () => assert.fail(`${step}: collectPass must throw`),
                (error: unknown) => error,
            );

            assert.equal(leaks(collectError), false, step);
        }
    });

    test("collectPass runs the meter step after the usage step and before GitHub; a throwing meter step leaves GitHub to run", async () => {
        const doc = fresh();
        const desk = deskOf([thread("T1", { prs: { "a/b#1": link() } })]);
        const github = fakeGitHub({ prs: { "a/b#1": { state: "OPEN", createdAt: T0 - DAY } } });

        // The first pass fixes the boundary, so the usage step runs.
        await pass(doc, desk, T0, github.graphql);

        const order: string[] = [];
        const run = (meter: MeterDeps, at: number) =>
            collectPass({
                readDesk: async () => copy(desk),
                readDashboard: async () => copy(doc),
                now: () => at,
                graphql: async (query) => {
                    order.push("github");

                    return github.graphql(query);
                },
                commit: async (apply) => apply(doc),
                usage: {
                    readUsage: async () => {
                        order.push("usage");

                        throw new Error("the usage document cannot be read");
                    },
                    readLedger: async () => undefined,
                    commit: async () => false,
                },
                meter,
            });
        const w = meterWorld();

        await run(
            meterDeps(w, {
                settings: METER_ON,
                readProvider: async () => {
                    order.push("meter");

                    return { error: "network error" };
                },
            }),
            T0 + OPEN_REFRESH_MS,
        );
        assert.deepEqual(order, ["usage", "meter", "github"]);

        order.length = 0;
        // A meter whose state is broken throws a TypeError: the GitHub part still runs.
        await run(
            meterDeps(w, {
                settings: METER_ON,
                state: undefined as unknown as MeterState,
            }),
            T0 + 2 * OPEN_REFRESH_MS,
        );
        assert.deepEqual(order, ["usage", "github"]);
        assert.equal(github.calls.length, 3);
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

    if (text.endsWith("desk usage test")) {
        return call("desk", { action: "usage" });
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
        cpSync(join(import.meta.dirname, "_desk-board.ts"), join(dropIns, "_desk-board.ts"));
        cpSync(join(import.meta.dirname, "_desk-meter.ts"), join(dropIns, "_desk-meter.ts"));
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

    test("with meter in desk.json, a pass reads the provider through METER_IO and counts the answers of every conversation; without it, the meter's memory goes", async () => {
        const shared = globalThis as unknown as Record<symbol, unknown>;
        const holder = () => shared[Symbol.for("pi-pocket-team.desk.meter")] as MeterHolder;
        const calls: string[] = [];
        const folder = join(root, "dashboard-meter");

        mkdirSync(folder, { recursive: true });

        const conversation = await newSession(app, folder);

        await say(app, conversation, "hello meter");
        shared[METER_IO] = {
            token: async () => FAKE_TOKEN,
            fetch: async (url: string) => {
                calls.push(url);

                // The real clock: the reset is 4 days after the app's clock, never the fixture's date.
                return respond(200, JSON.stringify(r4ResettingAt(Date.now() + shift + 4 * DAY)));
            },
        };
        writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100, meter: {} }));

        try {
            await stopKind(COLLECTOR_TASK);
            await app.harness.commit(async (tx) => {
                await ensureCollector(tx, Number(conversation), Collector, await collectorLive(tx));
            }, context);
            await until(
                async () =>
                    (await liveTasks(COLLECTOR_TASK)).some(
                        (task) => task.record.state.status === "sleeping",
                    ),
                "the collector's first wait",
            );
            // A restart with the clock past the wait: the collector makes its pass.
            await restartApp(shift + PASS_MS + 60_000);
            await until(
                async () => holder().state?.coverage.complete === true,
                "the meter's backfill",
                20_000,
            );

            // The oracle: every own answer of every conversation, read here with Pi Durable's scans.
            const expected = await app.harness.commit(async (tx) => {
                let answers = 0;
                let cursor: Parameters<Tx["scanConversations"]>[2];

                do {
                    const page = await tx.scanConversations({ order: "ascending" }, 100, cursor);

                    for (const each of page.items) {
                        let entries: Parameters<Tx["scanEntries"]>[2];

                        do {
                            const list = await tx.scanEntries(
                                { conversationId: each.id, order: "ascending" },
                                200,
                                entries,
                            );

                            answers += list.items.filter(
                                (entry) =>
                                    entry.conversationId === each.id &&
                                    entry.kind === "pi.assistant",
                            ).length;
                            entries = list.next;
                        } while (entries !== undefined);
                    }

                    cursor = page.next;
                } while (cursor !== undefined);

                return answers;
            }, context);
            const state = holder().state;

            assert(state !== undefined);
            assert.ok(expected > 0, "the sessions have answers");
            assert.equal(
                Object.values(state.buckets)
                    .flatMap((byProvider) => Object.values(byProvider))
                    .flatMap((byModel) => Object.values(byModel))
                    .reduce((sum, bucket) => sum + bucket.entries, 0),
                expected,
            );
            assert.deepEqual(calls, [ANTHROPIC_USAGE_URL]);
            assert.equal(state.providers.anthropic?.lastSuccess?.windows[0]?.percent, 95);
            assert.ok(!JSON.stringify(state).includes(FAKE_TOKEN));

            // No meter key: the next pass drops the meter's memory, and reads nothing.
            writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
            await restartApp(shift + PASS_MS + 60_000);
            await until(
                async () => holder().state === undefined,
                "the meter's memory to go",
                20_000,
            );
            assert.equal(holder().ledger, undefined);
            assert.deepEqual(calls, [ANTHROPIC_USAGE_URL]);
        } finally {
            await stopKind(COLLECTOR_TASK);
            writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
            delete shared[METER_IO];
            delete holder().state;
            delete holder().ledger;
        }
    });

    test("a fake token is in no desk usage answer, no GET dashboard answer, no console line and no notice: a 401 that holds it, a fetch error that holds it, and the R4 answer", async () => {
        const shared = globalThis as unknown as Record<symbol, unknown>;
        const holder = () =>
            (shared[Symbol.for("pi-pocket-team.desk.meter")] as MeterHolder | undefined) ?? {
                version: 0,
            };
        const logged: string[] = [];
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const saved = methods.map((name) => console[name]);
        let server: ReturnType<typeof createServer> | undefined;
        /** What the fake fetch does at the next provider read. */
        let answerNow: () => Promise<Response> = async () => respond(200, "{}");

        /** Each notice of the app: the desk's `host.notice` reaches `app.notice`, and owner notices `app.ownerNotice`. */
        const watchNotices = () => {
            const target = app as unknown as {
                notice: (level: string, message: string, id?: unknown) => void;
                ownerNotice: (level: string, message: string) => void;
            };
            const notice = target.notice.bind(app);
            const ownerNotice = target.ownerNotice.bind(app);

            target.notice = (level, message, id) => {
                logged.push(message);
                notice(level, message, id);
            };

            target.ownerNotice = (level, message) => {
                logged.push(message);
                ownerNotice(level, message);
            };
        };

        /** `GET dashboard` on a local server of the app now, with the owner's token. */
        const getDashboard = async (): Promise<string> => {
            if (server !== undefined) {
                await new Promise<void>((resolve) => server?.close(() => resolve()));
            }

            server = createServer(
                createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
            );
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

            const response = await fetch(
                `http://127.0.0.1:${String((server.address() as { port: number }).port)}/api/x/desk/dashboard`,
                { headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" } },
            );

            assert.equal(response.status, 200);

            return response.text();
        };

        for (const name of methods) {
            console[name] = (...args: unknown[]) => {
                logged.push(args.map(String).join(" "));
            };
        }

        shared[METER_IO] = {
            token: async () => FAKE_TOKEN,
            fetch: async () => answerNow(),
        };
        writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100, meter: {} }));

        try {
            const folder = join(root, "dashboard-meter-surface");

            mkdirSync(folder, { recursive: true });

            const source = await newSession(app, folder);

            await command(source, "team-agent", "odrade");
            watchNotices();
            await stopKind(COLLECTOR_TASK);
            await app.harness.commit(async (tx) => {
                await ensureCollector(tx, Number(source), Collector, await collectorLive(tx));
            }, context);
            await until(
                async () =>
                    (await liveTasks(COLLECTOR_TASK)).some(
                        (task) => task.record.state.status === "sleeping",
                    ),
                "the collector's first wait",
            );

            /** 1 real collector pass after a restart `by` ms later; then both surfaces, which must not hold the token. */
            const step = async (by: number, attempt: string | true, expected: RegExp) => {
                await restartApp(shift + by);
                watchNotices();
                await until(
                    async () => {
                        const last = holder().state?.providers.anthropic?.lastAttempt;

                        return attempt === true ? last?.ok === true : last?.error === attempt;
                    },
                    `the provider read (${String(attempt)})`,
                    20_000,
                );
                await say(app, source, "desk usage test");

                const usage = (await modelTexts(app, source)).findLast((text) =>
                    text.includes("Meter: provider read"),
                );

                assert(usage !== undefined, "desk usage answered");
                assert.match(usage, expected);
                assert.ok(!usage.includes(FAKE_TOKEN), "desk usage holds no token");

                const dashboard = await getDashboard();

                assert.match(dashboard, /"meter":\{/);
                assert.ok(!dashboard.includes(FAKE_TOKEN), "GET dashboard holds no token");
            };

            // (a) A 401 whose body holds the token.
            answerNow = async () => respond(401, `invalid bearer ${FAKE_TOKEN}`);
            await step(
                PASS_MS + 60_000,
                "sign-in refused, 401",
                /Anthropic: no provider report \(sign-in refused, 401\)/,
            );

            // (b) A fetch that throws with the token in its message: the next read is 30 minutes after the 401.
            answerNow = async () => {
                throw new Error(`connect ECONNRESET with Bearer ${FAKE_TOKEN}`);
            };

            await step(
                31 * 60_000,
                "network error",
                /Anthropic: no provider report \(network error\)/,
            );
            // (c) The R4 answer, with its resets 4 days after the app's clock at the read: this test runs on the real
            // clock, so a dated reset would pass and turn the line into "awaiting".
            answerNow = async () =>
                respond(200, JSON.stringify(r4ResettingAt(Date.now() + shift + 4 * DAY)));
            await step(
                PASS_MS + 60_000,
                true,
                /Anthropic: week 95% used \(critical\), resets \w{3} \d{2}:\d{2} \(in [34]d \d+h\) · week, Fable 19%/,
            );
            assert.ok(
                !JSON.stringify(holder().state).includes(FAKE_TOKEN),
                "the meter's memory holds no token",
            );
        } finally {
            methods.forEach((name, index) => {
                console[name] = saved[index] as never;
            });

            if (server !== undefined) {
                await new Promise<void>((resolve) => server?.close(() => resolve()));
            }

            await stopKind(COLLECTOR_TASK);
            writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
            delete shared[METER_IO];
            delete holder().state;
            delete holder().ledger;
        }

        assert.deepEqual(
            logged.filter((line) => line.includes(FAKE_TOKEN)),
            [],
        );
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
