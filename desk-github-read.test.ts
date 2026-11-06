// The sweep's GitHub read in queries: the chunk plan, the merge of the answers, the aliases GitHub cuts and the 1 read
// again, the PRs a session named (discovery pins), the close guard, and the unread alarm. Pure functions only: a fake
// `ask` stands in for `gh`, and every clock is a number.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    attribute,
    attachTo,
    bindThread,
    buildQuery,
    closeCheck,
    closeUnread,
    cutRepoLines,
    type DeskState,
    githubChunks,
    githubLines,
    githubView,
    type GitHubChunk,
    type GitHubFacts,
    GITHUB_PRS_PER_QUERY,
    GITHUB_REPOS_PER_QUERY,
    GITHUB_RETRY_LIMITS,
    mergeGitHubChunks,
    openListComplete,
    openThread,
    type PrFact,
    readChunkAnswer,
    readGitHubChunks,
    RESOURCE_LIMITS,
    SEEN_PINS_MAX,
    seenPinCandidates,
    spanWords,
    sweepPinnedLinks,
    type Thread,
    UNREAD_MS,
    unreadLine,
    unreadLinks,
    withSeenPins,
} from "./desk.ts";

const VIEWER = "github-viewer";

/** A PR node as GitHub gives it. */
const prNode = (repo: string, number: number, patch: Record<string, unknown> = {}) => ({
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/${repo}/pull/${String(number)}`,
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-11-06T11:21:15Z",
    headRefName: `branch-${String(number)}`,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    author: { login: VIEWER },
    commits: { nodes: [{ commit: { oid: `h${String(number)}`, statusCheckRollup: null } }] },
    ...patch,
});

/** A repository node with its open PRs. */
const repoNode = (repo: string, numbers: number[]) => ({
    nameWithOwner: repo,
    isArchived: false,
    pullRequests: {
        totalCount: numbers.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: numbers.map((number) => prNode(repo, number)),
    },
});

/** A pinned PR node. */
const pinNode = (ref: string) => {
    const [repo, number] = ref.split("#") as [string, string];

    return { nameWithOwner: repo, isArchived: false, pullRequest: prNode(repo, Number(number)) };
};

/**
 * A fake GitHub that answers each query from its aliases, as `buildQuery` writes them. It cuts like GitHub: after
 * `budget` aliases of 1 query, a pinned PR comes back null and a repository's list loses its nodes, with errors of type
 * `RESOURCE_LIMITS_EXCEEDED`, and the call fails with the partial answer. `open` gives each repository's open PRs;
 * `cut` names repositories that are cut in every query; `fail` makes a query that names it fail with no data.
 */
function fakeGitHub(
    setup: {
        budget?: number;
        open?: Record<string, number[]>;
        cut?: string[];
        fail?: string[];
        missing?: string[];
    } = {},
) {
    const queries: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const ask = async (query: string): Promise<unknown> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        queries.push(query);
        await Promise.resolve();
        inFlight -= 1;

        if ((setup.fail ?? []).some((name) => query.includes(name))) {
            throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502: Bad Gateway" });
        }

        const data: Record<string, unknown> = { viewer: { login: VIEWER } };
        const errors: unknown[] = [];
        let count = 0;
        let alias: { name: string; repo: string } | undefined;

        for (const line of query.split("\n")) {
            const start =
                /^ {2}([rpi][0-9]+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(line);

            if (start !== null) {
                alias = { name: start[1]!, repo: `${start[2]!}/${start[3]!}` };
                count += 1;

                if (alias.name.startsWith("r")) {
                    const numbers = setup.open?.[alias.repo] ?? [];
                    const cut =
                        count > (setup.budget ?? Infinity) ||
                        (setup.cut ?? []).includes(alias.repo);

                    if (cut && numbers.length > 0) {
                        const node = repoNode(alias.repo, numbers);

                        node.pullRequests.nodes = numbers.map(() => null) as never;
                        data[alias.name] = node;
                        numbers.forEach((_, index) =>
                            errors.push({
                                type: RESOURCE_LIMITS,
                                path: [alias!.name, "pullRequests", "nodes", index, "number"],
                                message: "Resource limits for this query exceeded.",
                            }),
                        );
                    } else {
                        data[alias.name] = repoNode(alias.repo, numbers);
                    }
                }

                continue;
            }

            const pr = /pullRequest\(number: ([0-9]+)\)/.exec(line);

            if (pr !== null && alias !== undefined) {
                const ref = `${alias.repo}#${pr[1]!}`;

                if ((setup.missing ?? []).includes(ref)) {
                    data[alias.name] = {
                        nameWithOwner: alias.repo,
                        isArchived: false,
                        pullRequest: null,
                    };
                    errors.push({
                        type: "NOT_FOUND",
                        path: [alias.name, "pullRequest"],
                        message: "Could not resolve to a PullRequest.",
                    });
                } else if (count > (setup.budget ?? Infinity)) {
                    data[alias.name] = {
                        nameWithOwner: alias.repo,
                        isArchived: false,
                        pullRequest: null,
                    };
                    errors.push({
                        type: RESOURCE_LIMITS,
                        path: [alias.name, "pullRequest", "number"],
                        message: "Resource limits for this query exceeded.",
                    });
                } else {
                    data[alias.name] = pinNode(ref);
                }
            }
        }

        return errors.length === 0 ? { data } : { data, errors };
    };

    return { ask, queries, maxInFlight: () => maxInFlight };
}

const explain = (error: unknown) =>
    String((error as { stderr?: unknown }).stderr ?? (error as Error).message);

const repos = (count: number) =>
    Array.from({ length: count }, (_, index) => `frostyard/r${String(index)}`);
const refs = (count: number, repo = "frostyard/test") =>
    Array.from({ length: count }, (_, index) => `${repo}#${String(index + 1)}`);

describe("githubChunks", () => {
    test("a small read is 1 query with every repository and PR", () => {
        const chunks = githubChunks(repos(10), refs(20));

        assert.equal(chunks.length, 1);
        assert.equal(chunks[0]!.repos.length, 10);
        assert.equal(chunks[0]!.prs.length, 20);
        assert.deepEqual(chunks[0]!.issues, []);
    });

    test("at most 10 repositories and 20 PRs in 1 query, in order, with no repeat", () => {
        const chunks = githubChunks([...repos(25), "frostyard/r0"], refs(45));

        assert.deepEqual(
            chunks.map((chunk) => [chunk.repos.length, chunk.prs.length]),
            [
                [10, 20],
                [10, 20],
                [5, 5],
            ],
        );
        assert.equal(chunks[0]!.repos[0], "frostyard/r0");
        assert.equal(chunks[2]!.prs.at(-1), "frostyard/test#45");
        assert.equal(GITHUB_REPOS_PER_QUERY, 10);
        assert.equal(GITHUB_PRS_PER_QUERY, 20);

        for (const chunk of chunks) {
            assert(chunk.repos.length <= GITHUB_REPOS_PER_QUERY);
            assert(chunk.prs.length <= GITHUB_PRS_PER_QUERY);
        }
    });

    test("linked issues have queries of their own", () => {
        const chunks = githubChunks(repos(2), refs(2), refs(3, "frostyard/issues"));

        assert.equal(chunks.length, 2);
        assert.deepEqual(chunks[1], { repos: [], prs: [], issues: refs(3, "frostyard/issues") });
    });

    test("the read again uses smaller queries", () => {
        const chunks = githubChunks(repos(3), refs(6), [], GITHUB_RETRY_LIMITS);

        assert.deepEqual(
            chunks.map((chunk) => [chunk.repos.length, chunk.prs.length]),
            [
                [2, 5],
                [1, 1],
            ],
        );
    });
});

describe("mergeGitHubChunks", () => {
    const part = (chunk: GitHubChunk, facts: Partial<GitHubFacts>) => ({
        chunk,
        facts: { viewer: VIEWER, repos: {}, prs: {}, ...facts } as GitHubFacts,
    });

    test("the facts of every query, each from the query that asked for it", () => {
        const first = readChunkAnswer(
            {
                data: {
                    viewer: { login: VIEWER },
                    r0: repoNode("frostyard/a", [1]),
                    p0: pinNode("frostyard/b#2"),
                },
            },
            { repos: ["frostyard/a"], prs: ["frostyard/b#2"], issues: [] },
        );
        const second = readChunkAnswer(
            {
                data: {
                    viewer: { login: VIEWER },
                    r0: repoNode("frostyard/c", [3]),
                    p0: pinNode("frostyard/d#4"),
                },
            },
            { repos: ["frostyard/c"], prs: ["frostyard/d#4"], issues: [] },
        );
        const merged = mergeGitHubChunks([
            {
                chunk: { repos: ["frostyard/a"], prs: ["frostyard/b#2"], issues: [] },
                facts: first.facts,
            },
            {
                chunk: { repos: ["frostyard/c"], prs: ["frostyard/d#4"], issues: [] },
                facts: second.facts,
            },
        ]);

        assert.equal(merged.viewer, VIEWER);
        assert.deepEqual(Object.keys(merged.repos).sort(), ["frostyard/a", "frostyard/c"]);
        assert.deepEqual(Object.keys(merged.prs).sort(), ["frostyard/b#2", "frostyard/d#4"]);
    });

    test("a query that gives a name another query asked for does not replace that query's facts", () => {
        const asked = { repos: ["frostyard/a"], prs: [], issues: [] };
        const other = { repos: ["frostyard/b"], prs: [], issues: [] };
        const merged = mergeGitHubChunks([
            part(asked, { repos: { "frostyard/a": { archived: false, open: [] } } }),
            part(other, {
                repos: {
                    "frostyard/a": { archived: true, open: [] },
                    "frostyard/b": { archived: false, open: [] },
                },
            }),
        ]);

        assert.equal(merged.repos["frostyard/a"]?.archived, false);
        assert.equal(merged.repos["frostyard/b"]?.archived, false);
    });

    test("the missing refs and the lines of all queries, each once", () => {
        const empty = { repos: [], prs: [], issues: [] };
        const merged = mergeGitHubChunks([
            part(empty, {
                missing: ["frostyard/a#1"],
                incomplete: ["frostyard/a#2: 1 of 2 checks read"],
            }),
            part(empty, {
                missing: ["frostyard/b#1"],
                incomplete: ["frostyard/a#2: 1 of 2 checks read"],
            }),
        ]);

        assert.deepEqual(merged.missing, ["frostyard/a#1", "frostyard/b#1"]);
        assert.deepEqual(merged.incomplete, ["frostyard/a#2: 1 of 2 checks read"]);
    });
});

describe("readChunkAnswer: what GitHub cut", () => {
    const chunk = (patch: Partial<GitHubChunk>): GitHubChunk => ({
        repos: [],
        prs: [],
        issues: [],
        ...patch,
    });

    test("a pinned PR that came back null with a resource error is cut, not missing", () => {
        const read = readChunkAnswer(
            {
                data: {
                    p0: pinNode("frostyard/test#1"),
                    p1: { nameWithOwner: "frostyard/test", isArchived: false, pullRequest: null },
                },
                errors: [
                    { type: RESOURCE_LIMITS, path: ["p1", "pullRequest", "number"], message: "x" },
                ],
            },
            chunk({ prs: ["frostyard/test#1", "frostyard/test#2"] }),
        );

        assert.deepEqual(read.cut.prs, ["frostyard/test#2"]);
        assert.equal(read.facts.missing, undefined);
        assert(read.facts.prs["frostyard/test#1"]);
    });

    test("a null PR with an error deeper than pullRequest is cut, whatever its type", () => {
        const read = readChunkAnswer(
            {
                data: {
                    p0: { nameWithOwner: "frostyard/test", isArchived: false, pullRequest: null },
                },
                errors: [
                    { type: "INTERNAL", path: ["p0", "pullRequest", "commits"], message: "x" },
                ],
            },
            chunk({ prs: ["frostyard/test#1"] }),
        );

        assert.deepEqual(read.cut.prs, ["frostyard/test#1"]);
    });

    test("a PR that GitHub does not have stays missing", () => {
        const read = readChunkAnswer(
            {
                data: {
                    p0: { nameWithOwner: "frostyard/test", isArchived: false, pullRequest: null },
                },
                errors: [{ type: "NOT_FOUND", path: ["p0", "pullRequest"], message: "x" }],
            },
            chunk({ prs: ["frostyard/test#9"] }),
        );

        assert.deepEqual(read.facts.missing, ["frostyard/test#9"]);
        assert.deepEqual(read.cut.prs, []);
    });

    test("an error in a detail of a PR that came keeps its facts, and is no cut", () => {
        const node = pinNode("frostyard/test#1");

        (node.pullRequest as Record<string, unknown>).body = "Fixes frostyard/test#3";
        const read = readChunkAnswer(
            {
                data: { p0: node },
                errors: [
                    {
                        type: "INTERNAL",
                        path: ["p0", "pullRequest", "commits", "nodes", 0],
                        message: "x",
                    },
                ],
            },
            chunk({ prs: ["frostyard/test#1"] }),
        );

        assert.deepEqual(read.cut.prs, []);
        assert.equal(read.facts.prs["frostyard/test#1"]?.state, "OPEN");
        assert.equal(read.facts.prs["frostyard/test#1"]?.body, undefined);
    });

    test("a repository list that lost its nodes is cut, and keeps the repository (regression)", () => {
        // The live answer: `totalCount: 1`, `nodes: [null]`, and 1 resource error at the node's number. The repository
        // left the facts with no line, and a thread that named its PR closed as "completed (no PRs)".
        const node = repoNode("frostyard/hotfix", [2]);

        node.pullRequests.nodes = [null] as never;
        const read = readChunkAnswer(
            {
                data: { r0: node },
                errors: [
                    {
                        type: RESOURCE_LIMITS,
                        path: ["r0", "pullRequests", "nodes", 0, "number"],
                        message: "x",
                    },
                ],
            },
            chunk({ repos: ["frostyard/hotfix"] }),
        );

        assert.deepEqual(read.cut.repos, ["frostyard/hotfix"]);
        assert.deepEqual(read.facts.repos["frostyard/hotfix"]?.open, []);
        assert.equal(read.facts.repos["frostyard/hotfix"]?.page?.totalCount, 1);
    });

    test("a repository whose error ends at its alias is not read, and a line says why", () => {
        const read = readChunkAnswer(
            {
                data: { r0: null, r1: repoNode("frostyard/b", []) },
                errors: [
                    {
                        type: "NOT_FOUND",
                        path: ["r0"],
                        message:
                            "Could not resolve to a Repository with the name 'frostyard/gone'.",
                    },
                ],
            },
            chunk({ repos: ["frostyard/gone", "frostyard/b"] }),
        );

        assert.equal(read.facts.repos["frostyard/gone"], undefined);
        assert(read.facts.repos["frostyard/b"]);
        assert.deepEqual(read.cut.repos, []);
        assert.deepEqual(read.facts.incomplete, [
            "frostyard/gone: not read (Could not resolve to a Repository with the name 'frostyard/gone'.)",
        ]);
    });
});

describe("readGitHubChunks", () => {
    test("a small read is exactly 1 query", async () => {
        const github = fakeGitHub({ open: { "frostyard/r0": [1] } });
        const read = await readGitHubChunks(github.ask, { repos: repos(3), prs: refs(5) }, explain);

        assert.equal(github.queries.length, 1);
        assert.equal(read.facts?.repos["frostyard/r0"]?.open.length, 1);
        assert.equal(Object.keys(read.facts?.prs ?? {}).length, 5);
        assert.equal(read.facts?.incomplete, undefined);
    });

    test("a big read is several queries, 1 after the other, and every PR is read", async () => {
        // A budget of 30 aliases: 1 query of 39 repositories and 59 PRs is cut, but each chunk fits.
        const github = fakeGitHub({ budget: 30 });
        const read = await readGitHubChunks(
            github.ask,
            { repos: repos(39), prs: refs(59) },
            explain,
        );

        assert.equal(github.queries.length, 4);
        assert.equal(github.maxInFlight(), 1, "never 2 queries at the same time");
        assert.equal(Object.keys(read.facts?.prs ?? {}).length, 59);
        assert.equal(Object.keys(read.facts?.repos ?? {}).length, 39);
        assert.equal(read.facts?.incomplete, undefined);
    });

    test("an alias GitHub cut is read again 1 time, and the second answer replaces the first", async () => {
        // A budget of 22 aliases: the last PRs of the full chunk are cut; the read again (5 a query) fits.
        const github = fakeGitHub({ budget: 22 });
        const read = await readGitHubChunks(
            github.ask,
            { repos: repos(5), prs: refs(20) },
            explain,
        );

        assert.equal(github.queries.length, 2, "1 query, and 1 read again of the 3 cut PRs");
        assert.equal(Object.keys(read.facts?.prs ?? {}).length, 20);
        assert.equal(read.facts?.missing, undefined);
        assert.equal(read.facts?.incomplete, undefined);
    });

    test("a PR still cut after the read again gets a line, and is never missing", async () => {
        const github = fakeGitHub({ budget: 1 });
        const read = await readGitHubChunks(github.ask, { repos: [], prs: refs(3) }, explain);

        // The first query, and 1 read again: no third try.
        assert.equal(github.queries.length, 2);
        // The read again of #2 and #3 has the same budget: #2 comes, #3 is cut again.
        assert.deepEqual(Object.keys(read.facts?.prs ?? {}).sort(), [
            "frostyard/test#1",
            "frostyard/test#2",
        ]);
        assert.equal(read.facts?.missing, undefined);
        assert.deepEqual(read.facts?.incomplete, ["frostyard/test#3: not read (resource limits)"]);
    });

    test("a repository list cut 2 times keeps the repository, and says it is cut", async () => {
        const github = fakeGitHub({ open: { "frostyard/hotfix": [2] }, cut: ["frostyard/hotfix"] });
        const read = await readGitHubChunks(
            github.ask,
            { repos: ["frostyard/hotfix", "frostyard/other"], prs: [] },
            explain,
        );

        assert.equal(github.queries.length, 2);
        assert.deepEqual(read.cutRepos, ["frostyard/hotfix"]);
        assert.deepEqual(read.facts?.repos["frostyard/hotfix"]?.open, []);
        assert.equal(openListComplete(read.facts, "frostyard/other"), true);
    });

    test("a repository cut 2 times with no node gets a line, and holds a thread with no PR there (regression)", async () => {
        // Both answers give the alias null, with a resource error under it: no node of the repository came at all.
        let calls = 0;

        const ask = async (query: string): Promise<unknown> => {
            calls += 1;

            const alias = /^ {2}(r[0-9]+): repository\(owner: "frostyard", name: "hotfix"\)/m.exec(
                query,
            )?.[1];

            return {
                data: { viewer: { login: VIEWER }, [alias ?? "r0"]: null },
                errors: [
                    {
                        type: RESOURCE_LIMITS,
                        path: [alias ?? "r0", "nameWithOwner"],
                        message: "Resource limits for this query exceeded.",
                    },
                ],
            };
        };

        const read = await readGitHubChunks(ask, { repos: ["frostyard/hotfix"], prs: [] }, explain);

        assert.equal(calls, 2, "the first answer, and 1 read again");
        assert.deepEqual(read.cutRepos, ["frostyard/hotfix"]);
        assert.equal(read.facts?.repos["frostyard/hotfix"], undefined);
        assert.deepEqual(read.facts?.incomplete, ["frostyard/hotfix: not read (resource limits)"]);

        // The paging step keeps the line, and adds no second one.
        const after = cutRepoLines(read.facts!, read.cutRepos, new Map());

        assert.deepEqual(after.incomplete, ["frostyard/hotfix: not read (resource limits)"]);
        // The helper alone gives the line too, to facts that lost it.
        assert.deepEqual(
            cutRepoLines({ ...read.facts!, incomplete: [] }, read.cutRepos, new Map()).incomplete,
            ["frostyard/hotfix: not read (resource limits)"],
        );

        const state = deskOf();
        const thread = placed(state, 100, "frostyard/hotfix");

        thread.run = { ...thread.run, busy: false, reportedUserEntry: 5, lastUserEntry: 5 };

        const held = closeUnread(state, 1, { github: after, asked: ["frostyard/hotfix"] });

        assert.deepEqual(held.get(thread.id), [
            "the open PRs of frostyard/hotfix are not all read",
        ]);
        assert.equal(
            closeCheck(thread, { now: 1000, folders: new Set(), unread: held }).close,
            false,
        );
    });

    test("a repository cut 2 times whose count is unknown says how many PRs came", () => {
        const facts: GitHubFacts = {
            viewer: VIEWER,
            repos: { "frostyard/hotfix": { archived: false, open: [] } },
            prs: {},
        };

        assert.deepEqual(cutRepoLines(facts, ["frostyard/hotfix"], new Map()).incomplete, [
            "frostyard/hotfix: 0 open PRs read, and more follow",
        ]);
        // A count that says every PR came: no line.
        assert.equal(
            cutRepoLines(facts, ["frostyard/hotfix"], new Map([["frostyard/hotfix", 0]]))
                .incomplete,
            undefined,
        );
    });

    test("a query that fails with no data fails only its own names", async () => {
        const github = fakeGitHub({ fail: ['name: "r12"'] });
        const read = await readGitHubChunks(
            github.ask,
            { repos: repos(15), prs: refs(25) },
            explain,
        );

        assert.equal(read.error, undefined);
        assert.equal(Object.keys(read.facts?.repos ?? {}).length, 10);
        assert.equal(Object.keys(read.facts?.prs ?? {}).length, 20);
        assert(read.facts?.incomplete?.includes("frostyard/r12: not read (HTTP 502: Bad Gateway)"));
        assert(
            read.facts?.incomplete?.includes("frostyard/test#25: not read (HTTP 502: Bad Gateway)"),
        );
    });

    test("only a read whose every query fails is a failure", async () => {
        const github = fakeGitHub({ fail: ["query"] });
        const read = await readGitHubChunks(github.ask, { repos: repos(15), prs: [] }, explain);

        assert.equal(read.facts, undefined);
        assert.equal(read.error, "HTTP 502: Bad Gateway");
    });

    test("each query carries the detail and watch fields of its own pins", async () => {
        const github = fakeGitHub();

        await readGitHubChunks(
            github.ask,
            { repos: [], prs: refs(25), watched: ["frostyard/test#25"] },
            explain,
        );

        assert.equal(github.queries.length, 2);
        assert.doesNotMatch(github.queries[0]!, /watchLabels/);
        assert.match(github.queries[1]!, /watchLabels/);
        assert.equal(
            github.queries[1],
            buildQuery(
                [],
                [
                    "frostyard/test#21",
                    "frostyard/test#22",
                    "frostyard/test#23",
                    "frostyard/test#24",
                    "frostyard/test#25",
                ],
                [],
                [],
                ["frostyard/test#25"],
            ),
        );
    });
});

// ─── Discovery pins, the close guard, the alarm ───────────────────────────────

const deskOf = (): DeskState => ({
    next: { T: 1, F: 1 },
    threads: {},
    grants: [],
    seen: {},
    epoch: 0,
});

/** A thread of supervisor 1 in `repo`, open at `at`, with a session. */
const placed = (state: DeskState, at: number, repo = "frostyard/test"): Thread => {
    const opened = openThread(state, {
        key: `k-${String(at)}`,
        supervisor: 1,
        agents: ["duncan"],
        repo,
        cwd: "/work/test",
        title: `At ${String(at)}`,
        at,
    });

    bindThread(state, opened.thread.key, {
        session: 50 + at,
        address: `session-${String(at)}`,
        at,
    });

    return opened.thread;
};

const prFact = (patch: Partial<PrFact> = {}): PrFact => ({
    ref: "frostyard/test#2",
    repo: "frostyard/test",
    number: 2,
    title: "A note",
    url: "https://github.com/frostyard/test/pull/2",
    state: "OPEN",
    author: VIEWER,
    createdAt: 200,
    headRefName: "docs/a-note",
    isDraft: false,
    mergeable: "MERGEABLE",
    review: "",
    checks: "SUCCESS",
    head: "a1b2c3",
    ready: false,
    readyAt: 0,
    headAt: 0,
    feedback: [],
    failing: [],
    archived: false,
    ...patch,
});

/** A read whose list of frostyard/test was cut: no PR in it, and the line that says so. */
const cutRead = (
    prs: Record<string, PrFact> = {},
    patch: Partial<GitHubFacts> = {},
): GitHubFacts => ({
    viewer: VIEWER,
    repos: { "frostyard/test": { archived: false, open: [] } },
    prs,
    incomplete: ["frostyard/test: 0 of 1 open PRs read"],
    ...patch,
});

const gitOf = () => ({ supervisor: 1, authors: [], branches: {} });

describe("seenPinCandidates", () => {
    test("the PRs a session named in a repository of the thread whose open list is cut, the newest first", () => {
        const state = deskOf();
        const thread = placed(state, 100);

        thread.run.seenPrs = [
            "frostyard/test#1",
            "frostyard/other#5",
            "frostyard/test#2",
            "frostyard/test#3",
            "frostyard/test#4",
            "not a ref",
        ];

        assert.deepEqual(
            seenPinCandidates(state, 1, cutRead(), { max: SEEN_PINS_MAX }).get(thread.id),
            ["frostyard/test#4", "frostyard/test#3", "frostyard/test#2"],
        );
        // No limit: the close guard reads every one.
        assert.equal(seenPinCandidates(state, 1, cutRead()).get(thread.id)?.length, 4);
    });

    test("never a ref a thread holds, a dropped one, a pinned one, or one in a complete open list", () => {
        const state = deskOf();
        const thread = placed(state, 100);
        const other = placed(state, 200);

        thread.run.seenPrs = [
            "frostyard/test#1",
            "frostyard/test#2",
            "frostyard/test#3",
            "frostyard/test#4",
        ];
        other.prs["Frostyard/Test#1"] = { via: "attached" };
        state.dropped = { "frostyard/test#2": { at: 1, from: "T9" } };

        assert.deepEqual(
            seenPinCandidates(state, 1, cutRead(), { pinned: ["FROSTYARD/test#3"] }).get(thread.id),
            ["frostyard/test#4"],
        );

        const whole: GitHubFacts = {
            viewer: VIEWER,
            repos: { "frostyard/test": { archived: false, open: [] } },
            prs: {},
        };

        assert.equal(
            seenPinCandidates(state, 1, whole).size,
            0,
            "a complete list has no PR to find",
        );
        // A repository that the read did not have: no complete list.
        assert.deepEqual(seenPinCandidates(state, 1, { ...whole, repos: {} }).get(thread.id), [
            "frostyard/test#4",
            "frostyard/test#3",
        ]);
    });

    test("only open threads of the supervisor that are not plans", () => {
        const state = deskOf();
        const closed = placed(state, 100);
        const plan = placed(state, 200);
        const otherSupervisor = placed(state, 300);

        for (const one of [closed, plan, otherSupervisor]) {
            one.run.seenPrs = ["frostyard/test#2"];
        }

        closed.state = "closed";
        plan.origin = "plan";
        otherSupervisor.supervisor = 2;

        assert.equal(seenPinCandidates(state, 1, cutRead()).size, 0);
    });
});

describe("attribute: a discovery pin", () => {
    test("a PR read by number that the session named attaches by seen", () => {
        const state = deskOf();
        const thread = placed(state, 100);

        thread.run.seenPrs = ["frostyard/test#2"];
        attribute(
            state,
            cutRead({ "frostyard/test#2": prFact() }, { seenPins: ["frostyard/test#2"] }),
            gitOf(),
            300,
        );

        assert.equal(thread.prs["frostyard/test#2"]?.via, "seen");
        assert.equal(thread.prs["frostyard/test#2"]?.state, "OPEN");
    });

    test("never by window, and never a found thread", () => {
        const state = deskOf();

        state.epoch = 1;
        const thread = placed(state, 100);

        attribute(
            state,
            cutRead({ "frostyard/test#2": prFact() }, { seenPins: ["frostyard/test#2"] }),
            gitOf(),
            300,
        );

        assert.deepEqual(thread.prs, {});
        assert.equal(Object.keys(state.threads).length, 1, "no found thread");
    });

    test("by branch, when exactly 1 thread has the branch", () => {
        const state = deskOf();
        const thread = placed(state, 100);

        thread.branches = ["docs/a-note"];
        attribute(
            state,
            cutRead(
                { "frostyard/test#2": prFact({ createdAt: 50 }) },
                { seenPins: ["frostyard/test#2"] },
            ),
            gitOf(),
            300,
        );

        assert.equal(thread.prs["frostyard/test#2"]?.via, "branch");
    });

    test("a watch's pin, or another thread's pin, attributes nothing", () => {
        const state = deskOf();

        state.epoch = 1;
        const thread = placed(state, 100);

        thread.run.seenPrs = ["frostyard/test#2"];
        // In `prs`, but not a discovery pin: a `pr:` watch pinned it.
        attribute(state, cutRead({ "frostyard/test#2": prFact() }), gitOf(), 300);

        assert.deepEqual(thread.prs, {});
        assert.equal(Object.keys(state.threads).length, 1);
    });
});

describe("withSeenPins", () => {
    test("the facts it read, the refs it asked, and the ones GitHub lacks apart from missing", () => {
        const merged = withSeenPins(cutRead(), ["frostyard/test#2", "frostyard/test#3"], {
            facts: {
                viewer: VIEWER,
                repos: {},
                prs: { "frostyard/test#2": prFact() },
                missing: ["frostyard/test#3"],
            },
        });

        assert(merged.prs["frostyard/test#2"]);
        assert.deepEqual(merged.seenPins, ["frostyard/test#2", "frostyard/test#3"]);
        assert.deepEqual(merged.seenMissing, ["frostyard/test#3"]);
        assert.equal(merged.missing, undefined, "no thread holds them: no line lists them");
    });

    test("a read that failed says so for each ref", () => {
        const merged = withSeenPins(cutRead(), ["frostyard/test#2"], { error: "HTTP 502" });

        assert.deepEqual(merged.incomplete, [
            "frostyard/test: 0 of 1 open PRs read",
            "frostyard/test#2: not read (HTTP 502)",
        ]);
    });
});

describe("the close guard", () => {
    const closes = (state: DeskState, thread: Thread, unread: Map<string, string[]>) =>
        closeCheck(thread, { now: 1000, folders: new Set(), unread });

    /** A thread whose every other part is closed: no PR, an idle session that reported. */
    const quiet = (state: DeskState) => {
        const thread = placed(state, 100);

        thread.run = { ...thread.run, busy: false, reportedUserEntry: 5, lastUserEntry: 5 };

        return thread;
    };

    test("closeCheck adds the unread lines of the thread", () => {
        const state = deskOf();
        const thread = quiet(state);

        assert.deepEqual(closes(state, thread, new Map()), { close: true, open: [] });
        assert.deepEqual(
            closes(
                state,
                thread,
                new Map([[thread.id, ["the open PRs of frostyard/test are not all read"]]]),
            ),
            {
                close: false,
                open: ["the open PRs of frostyard/test are not all read"],
            },
        );
    });

    test("a named PR that a cut read did not read holds the thread, and so does its repository", () => {
        const state = deskOf();
        const thread = quiet(state);

        thread.run.seenPrs = ["frostyard/test#2"];

        // The discovery read did not ask for it (it was named after the read began).
        const held = closeUnread(state, 1, { github: cutRead(), asked: ["frostyard/test"] });

        assert.deepEqual(held.get(thread.id), [
            "PR frostyard/test#2 named in its session is not read",
            "the open PRs of frostyard/test are not all read",
        ]);
        assert.equal(closes(state, thread, held).close, false);
    });

    test("a named PR that the read has, or that GitHub lacks, holds nothing", () => {
        const state = deskOf();
        const thread = quiet(state);

        thread.run.seenPrs = ["frostyard/test#2"];
        thread.prs["frostyard/test#9"] = { via: "seen", state: "MERGED" };

        const read = cutRead(
            { "frostyard/test#2": prFact({ state: "MERGED" }) },
            { seenPins: ["frostyard/test#2"] },
        );

        assert.equal(closeUnread(state, 1, { github: read, asked: ["frostyard/test"] }).size, 0);

        const gone = cutRead(
            {},
            { seenPins: ["frostyard/test#2"], seenMissing: ["frostyard/test#2"] },
        );

        assert.equal(closeUnread(state, 1, { github: gone, asked: ["frostyard/test"] }).size, 0);
    });

    test("a failed read holds a thread with no PR of its own; a sweep that asked nothing holds none", () => {
        const state = deskOf();
        const thread = quiet(state);

        assert.deepEqual(
            closeUnread(state, 1, { error: "HTTP 502", asked: ["frostyard/test"] }).get(thread.id),
            ["the open PRs of frostyard/test are not all read"],
        );
        assert.equal(closeUnread(state, 1, { asked: [] }).size, 0);

        // Not asked: a repository outside the read does not hold it.
        assert.equal(
            closeUnread(state, 1, { error: "HTTP 502", asked: ["frostyard/else"] }).size,
            0,
        );

        // A thread with a PR of its own is not held by its repository.
        thread.prs["frostyard/test#9"] = { via: "seen", state: "MERGED" };
        assert.equal(
            closeUnread(state, 1, { error: "HTTP 502", asked: ["frostyard/test"] }).size,
            0,
        );
    });

    test("a complete read holds nothing", () => {
        const state = deskOf();
        const thread = quiet(state);

        thread.run.seenPrs = ["frostyard/test#2"];

        const whole: GitHubFacts = {
            viewer: VIEWER,
            repos: { "frostyard/test": { archived: false, open: [] } },
            prs: {},
        };

        assert.equal(closeUnread(state, 1, { github: whole, asked: ["frostyard/test"] }).size, 0);
    });
});

describe("the unread alarm", () => {
    const HOUR = 3600_000;
    const NOW = 100 * HOUR;

    test("a link of an open thread with no read for more than 30 minutes, the oldest first", () => {
        const state = deskOf();
        const a = placed(state, NOW - 10 * HOUR);
        const b = placed(state, NOW - 9 * HOUR);

        a.prs["frostyard/test#5"] = { via: "seen", state: "OPEN", readAt: NOW - 6 * HOUR };
        a.prs["frostyard/test#6"] = { via: "seen", state: "OPEN", readAt: NOW - 10 * 60_000 };
        // Never read: from its attach event.
        attachTo(state, "frostyard/test#2", b.id, NOW - 45 * 60_000);

        assert.deepEqual(unreadLinks(state, NOW), [
            { thread: a.id, ref: "frostyard/test#5", age: 6 * HOUR },
            { thread: b.id, ref: "frostyard/test#2", age: 45 * 60_000 },
        ]);
        assert.equal(
            unreadLine(unreadLinks(state, NOW)),
            `Unread: ${a.id} (frostyard/test#5, 6 h), ${b.id} (frostyard/test#2, 45 min)`,
        );
        assert.equal(UNREAD_MS, 30 * 60_000);
    });

    test("a link with no read and no attach event counts from the thread's start", () => {
        const state = deskOf();
        const thread = placed(state, NOW - 2 * HOUR);

        thread.prs["frostyard/test#5"] = { via: "attached" };
        assert.deepEqual(unreadLinks(state, NOW), [
            { thread: thread.id, ref: "frostyard/test#5", age: 2 * HOUR },
        ]);
    });

    test("the scope is the sweep's pins: an open link of a recent done thread, not a merged one", () => {
        const state = deskOf();
        const done = placed(state, NOW - 20 * HOUR);

        done.state = "closed";
        done.closed = { at: NOW - HOUR, why: "done", by: "sweep" };
        done.prs["frostyard/test#5"] = { via: "seen", state: "OPEN", readAt: NOW - 5 * HOUR };
        done.prs["frostyard/test#6"] = { via: "seen", state: "MERGED", readAt: NOW - 5 * HOUR };

        const dropped = placed(state, NOW - 19 * HOUR);

        dropped.state = "closed";
        dropped.closed = { at: NOW - HOUR, why: "dropped", by: "brian" };
        dropped.prs["frostyard/test#7"] = { via: "seen", state: "OPEN", readAt: NOW - 5 * HOUR };

        assert.deepEqual(
            unreadLinks(state, NOW).map((one) => one.ref),
            ["frostyard/test#5"],
        );
        assert.deepEqual(
            sweepPinnedLinks(state, 1, NOW).map((one) => [one.ref, one.scope]),
            [["frostyard/test#5", "recent"]],
        );
    });

    test("at most 10 in the line, then how many more", () => {
        const state = deskOf();
        const thread = placed(state, 0);

        for (let index = 1; index <= 12; index += 1) {
            thread.prs[`frostyard/test#${String(index)}`] = {
                via: "seen",
                state: "OPEN",
                readAt: NOW - index * HOUR,
            };
        }

        const line = unreadLine(unreadLinks(state, NOW)) ?? "";

        assert.match(line, /^Unread: T1 \(frostyard\/test#12, 12 h\), /);
        assert.match(line, /, and 2 more$/);
        assert.equal(line.match(/T1 \(/g)?.length, 10);
    });

    test("githubLines and githubView say it, with a last read older than 30 minutes and a failed sweep", () => {
        const state = deskOf();
        const thread = placed(state, NOW - 10 * HOUR);

        thread.prs["frostyard/test#5"] = { via: "seen", state: "OPEN", readAt: NOW - 6 * HOUR };
        state.github = { at: NOW - 6 * HOUR, ok: true };
        state.sweepErrors = { "1": { at: NOW - HOUR, error: "exit code 1: HTTP 502" } };

        const lines = githubLines(state, NOW);

        assert.deepEqual(lines.slice(0, 2), [
            `Unread: ${thread.id} (frostyard/test#5, 6 h)`,
            `GitHub: last read at ${new Date(NOW - 6 * HOUR).toTimeString().slice(0, 5)}, 6 h ago`,
        ]);
        assert.match(lines[2] ?? "", /^Sweep failed at \d\d:\d\d: exit code 1: HTTP 502$/);
        assert.deepEqual(githubView(state, NOW)?.unread, [
            { thread: thread.id, ref: "frostyard/test#5", age: 6 * HOUR },
        ]);

        // A fresh read of every link: nothing to say.
        thread.prs["frostyard/test#5"]!.readAt = NOW - 60_000;
        state.github = { at: NOW - 60_000, ok: true };
        delete state.sweepErrors;
        assert.deepEqual(githubLines(state, NOW), []);
        assert.equal(githubView(state, NOW)?.unread, undefined);
    });

    test("spanWords", () => {
        assert.equal(spanWords(45 * 60_000), "45 min");
        assert.equal(spanWords(6 * HOUR + 59 * 60_000), "6 h");
        assert.equal(spanWords(72 * HOUR), "3 d");
    });
});
