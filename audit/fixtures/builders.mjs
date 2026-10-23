// Invented data for the audit's tests. Nothing here comes from a real database.
import { DAY, HOUR, MINUTE } from "../common.mjs";

/** 2026-10-23 14:00 UTC (10:00 in New York). */
export const NOW = Date.UTC(2026, 9, 23, 14, 0);
export const ctx = { now: NOW, since: NOW - DAY, hours: 24 };

export const ago = (ms) => NOW - ms;

/** A `data` object with every source empty and nothing missing. */
export function emptyData(over = {}) {
    return {
        threads: {},
        grants: [],
        events: [],
        reports: {},
        agentOf: {},
        goals: [],
        schedules: [],
        userEntries: {},
        toolErrors: [],
        costRows: [],
        spawns: [],
        installed: { "desk.ts": null, "team.ts": null, "night-shift.ts": null },
        odrade: { readme: "", reports: [], dirty: [], lastCommitAt: NOW - HOUR },
        github: { botPrs: [], prs: {}, checkRuns: {}, autoDelete: {} },
        sourceErrors: {},
        ...over,
    };
}

export const thread = (id, over = {}) => ({
    id,
    key: `x.team.delegate:${id}`,
    origin: "delegate",
    title: `Invented work ${id}`,
    agents: ["irulan"],
    repo: "acme/widgets",
    supervisor: 10,
    session: 100 + Number(id.slice(1)),
    address: "session-aaa",
    state: "open",
    startedAt: NOW - 3 * DAY,
    lastEventAt: NOW - HOUR,
    prs: {},
    branches: [],
    asks: [],
    run: { returnAddress: "session-aaa" },
    events: [],
    ...over,
});

export const event = (threadId, at, key, text) => ({ thread: threadId, at, key, text });

/** A map of threads by id. */
export const threadMap = (...list) => Object.fromEntries(list.map((item) => [item.id, item]));

export const minutes = (n) => n * MINUTE;
export const hours = (n) => n * HOUR;

/** A bot PR as GraphQL returns it. */
export const pr = (over = {}) => ({
    state: "OPEN",
    createdAt: new Date(NOW - 5 * HOUR).toISOString(),
    updatedAt: new Date(NOW - HOUR).toISOString(),
    mergedAt: null,
    closedAt: null,
    headRefName: "feat/x",
    url: "https://github.com/acme/widgets/pull/1",
    headRef: { name: "feat/x" },
    commits: {
        totalCount: 1,
        nodes: [{ commit: { oid: "abc", statusCheckRollup: { state: "SUCCESS" } } }],
    },
    ...over,
});
