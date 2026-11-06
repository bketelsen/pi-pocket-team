/**
 * GitHub webhooks for the desk: a small `node:http` listener on `0.0.0.0:8790` (path `POST /github` only, peers in the
 * `allowFrom` setting only, default `10.0.1.234`) that verifies each delivery with the secret in
 * `~/.config/pi-pocket-team/github-webhook.secret` (and `github-webhook.secret.next` during a rotation), keeps only
 * pattern-checked facts (no title, body, branch name or other free text), and hands them to the desk's `nudge` through
 * `globalThis[Symbol.for("pi-pocket-team.desk")]`. It reads `x.desk.observed` (read only) for its coverage alarm, and
 * writes only its own documents: `x.github-hooks.seen`, `x.github-hooks.deliveries`, `x.github-hooks.pending`,
 * `x.github-hooks.alarms`, `x.github-hooks.coverage` and `x.github-hooks.receiver`. The owner runs `/github-hooks start`
 * once: it starts the durable receiver task `x.github-hooks.receiver`, which does the commits for the listener.
 *
 * Life cycle. The load binds nothing: a timer binds after the load returns, and `EADDRINUSE` retries every second for up
 * to 30 seconds (a reloaded module starts before the old version's cleanups free the port). A dispose closes the
 * listener, ends idle sockets at once and destroys open ones after 2 seconds.
 *
 * The receiver. Its phase `receive` runs for a long time and waits in-phase for jobs from the listener: 1 commit for each
 * delivery (the dedupe entry, the log entry, the fact and its pending marker, all or nothing), then 1 commit that hands
 * the pending markers to `nudge` and deletes them. At a reload, the old phase ends with a commit when a newer version is
 * live (`Symbol.for("pi-pocket-team.github-hooks.version")`), and the next invocation runs the new code. With the module
 * turned off, no newer version is live: the old phase then waits in memory, with no commit, until the module is on again
 * or the server restarts. (Pi Durable keeps a running task on its old code when its definition goes, so a phase that
 * ended at once would run again at once, in a loop.)
 *
 * Other modules: the desk (optional; with it off or older, facts are recorded and nothing else). No import of `desk.ts`.
 * The design is the plan T1013 (docs/modules/github-hooks.md).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
    defineDoc,
    defineExtension,
    defineTask,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

// ─── Limits ──────────────────────────────────────────────────────────────────

/** The listener's port and address. */
export const HOOKS_PORT = 8790;
export const HOOKS_HOST = "0.0.0.0";
/** The default `allowFrom`: caddy's address. */
export const DEFAULT_ALLOW_FROM = "10.0.1.234";
/** The only path. */
export const HOOKS_PATH = "/github";
/** 1 MiB: the body cap, as caddy's `max_size 1MiB`. */
export const MAX_BODY = 1_048_576;

/** The listener's limits: tests lower them. */
export type ListenerLimits = {
    /** Open sockets at once. */
    maxSockets: number;
    /** Requests in progress at once. */
    maxRequests: number;
    /** Request bytes reserved over all requests in progress. */
    bodyBudget: number;
    /** The body cap. */
    maxBody: number;
    /** Headers must come within this time (`408`). */
    headersTimeoutMs: number;
    /** The body must come within this time (`408`). */
    bodyTimeoutMs: number;
    /** The receiver must answer within this time (`503`). */
    jobTimeoutMs: number;
    /** `EADDRINUSE`: try again after this time... */
    bindRetryMs: number;
    /** ...for up to this time, then `bind-failed`. */
    bindLimitMs: number;
    /** A dispose destroys the sockets still open after this time. */
    socketGraceMs: number;
};

export const LIMITS: ListenerLimits = {
    maxSockets: 16,
    maxRequests: 8,
    bodyBudget: 8 * MAX_BODY,
    maxBody: MAX_BODY,
    headersTimeoutMs: 5_000,
    bodyTimeoutMs: 10_000,
    jobTimeoutMs: 5_000,
    bindRetryMs: 1_000,
    bindLimitMs: 30_000,
    socketGraceMs: 2_000,
};

/** How long a delivery id and a body digest stay in `seen`. */
export const SEEN_MS = 72 * 3600_000;
/** The most ids in `seen` within `SEEN_MS`: then `seen-full`, never an early drop. */
export const SEEN_MAX = 20_000;
/** The delivery log keeps the newest entries. */
export const LOG_MAX = 2_000;
/** The most pending markers: then `pending-full`. */
export const PENDING_MAX = 200;
/** The most markers 1 `nudge` call takes (the desk's own limit). */
export const NUDGE_BATCH = 500;
/** The refusals kept in memory until the receiver writes them. */
export const REFUSALS_MAX = 500;
/** Accepted facts kept for the coverage alarm. */
export const RECENT_MS = 48 * 3600_000;
export const RECENT_MAX = 20_000;
/** A repository that sent an accepted fact in this time is covered. */
export const COVERED_MS = 30 * 24 * 3600_000;
/** An observed change this old, and no older than `CHANGE_MAX_AGE_MS`, is checked once. */
export const CHANGE_MIN_AGE_MS = 30 * 60_000;
export const CHANGE_MAX_AGE_MS = 24 * 3600_000;
/** Misses within this time count toward the alarm. */
export const MISS_WINDOW_MS = 24 * 3600_000;
/** The miss log (`AlarmsState.missLog`) keeps the misses of this time, for the report's window. */
export const MISS_LOG_MS = 30 * 24 * 3600_000;
/** The most entries the miss log keeps: the oldest go first. */
export const MISS_LOG_MAX = 2000;
/** This many misses of 1 repository and class raise its alarm. */
export const MISSES_TO_RAISE = 2;
/** The receiver's tick. */
export const TICK_MS = 2_000;
/** Refusals go into the log at most this often. */
export const REFUSAL_FLUSH_MS = 10_000;
/** The coverage alarm is evaluated this often. */
export const COVERAGE_EVERY_MS = 5 * 60_000;
/** After a `nudge` that threw, the next try waits this long. */
export const NUDGE_RETRY_MS = 30_000;

const HOUR = 3600_000;
const MINUTE = 60_000;

// ─── Patterns and the event list ─────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;
const OWNERS = new Set(["frostyard", "bketelsen"]);
const TEAM_LABELS = new Set([
    "ready-for-human",
    "risk:high",
    "sweep",
    "agent-queue",
    "agent-urgent",
    "needs-plan",
]);

/** The events the listener takes, and the actions it keeps for each: `undefined` keeps every action. */
export const EVENTS: Record<string, readonly string[] | undefined> = {
    pull_request: [
        "opened",
        "closed",
        "reopened",
        "labeled",
        "unlabeled",
        "synchronize",
        "ready_for_review",
        "converted_to_draft",
    ],
    pull_request_review: ["submitted", "dismissed"],
    check_suite: ["completed"],
    status: undefined,
    issues: ["opened", "closed", "reopened", "labeled", "unlabeled"],
    ping: undefined,
    installation: ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"],
    installation_repositories: ["added", "removed"],
};

const STATUS_STATES = new Set(["pending", "success", "failure", "error"]);
const SUITE_STATUSES = new Set([
    "requested",
    "in_progress",
    "completed",
    "queued",
    "pending",
    "waiting",
]);
const SUITE_CONCLUSIONS = new Set([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    "skipped",
    "startup_failure",
]);
const REVIEW_STATES = new Set(["approved", "changes_requested", "commented", "dismissed"]);

// ─── Facts ───────────────────────────────────────────────────────────────────

/** A class of change, as `x.desk.observed` has it. */
export type ChangeClass = "state" | "labels" | "review" | "head" | "ci";

/**
 * 1 fact of a signed delivery: only pattern-checked fields, no free text. Stored data (in `x.github-hooks.deliveries`
 * and `x.github-hooks.pending`): never rename a field or change what it means.
 */
export type HookFact = {
    /** `X-GitHub-Delivery`, lower case. */
    delivery: string;
    /** When the listener got it, in ms. */
    at: number;
    event: string;
    /** From the event's set (Scope); absent for `status`. */
    action?: string;
    /** "owner/name", owner `frostyard` or `bketelsen`. Absent for installation events. */
    repo?: string;
    /** The PR or issue number; for `check_suite`, the first of `numbers`. */
    number?: number;
    /** `check_suite`: every PR number, at most 20. */
    numbers?: number[];
    /** `open` or `closed` (a PR or an issue); for `status`, the commit state. */
    state?: string;
    merged?: boolean;
    draft?: boolean;
    /** A team label, or `"other"`. */
    label?: string;
    review?: string;
    check?: { status?: string; conclusion?: string; state?: string };
    sha?: string;
    mergeSha?: string;
    /** A login, or `"bot"`. */
    sender?: string;
    /** Only `main` or `master`. */
    branch?: string;
    /** Installation events only. */
    installation?: InstallationFact;
};

/** An installation event's own schema. */
export type InstallationFact = {
    id: number;
    account: string;
    selection?: "all" | "selected";
    /** `installation` `created`: the repositories it holds. */
    repositories?: string[];
    added?: string[];
    removed?: string[];
};

/** What the builder made of a payload. */
export type BuildOutcome =
    | { kind: "fact"; fact: HookFact }
    | { kind: "ignored"; fact: HookFact }
    | { kind: "unprocessable"; reason: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

const prNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2 ** 31 - 1
        ? value
        : undefined;

const shaOf = (value: unknown): string | undefined =>
    typeof value === "string" && SHA.test(value) ? value : undefined;

/** "owner/name" with an allowed owner, else undefined. */
export function repoOf(value: unknown): string | undefined {
    if (typeof value !== "string" || !REPO.test(value)) {
        return undefined;
    }

    const owner = value.slice(0, value.indexOf("/")).toLowerCase();

    return OWNERS.has(owner) ? value : undefined;
}

const repoList = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
        .map((each) => record(each)?.full_name)
        .filter((name): name is string => typeof name === "string" && REPO.test(name))
        .slice(0, 500);

function senderOf(value: unknown): string | undefined {
    const sender = record(value);
    const login = sender?.login;

    if (typeof login === "string" && LOGIN.test(login)) {
        return login;
    }

    return sender?.type === "Bot" ? "bot" : undefined;
}

/**
 * Build the fact of 1 delivery from its parsed payload: only the fields of the Ingestion table, each checked by its
 * pattern (a field that fails is dropped). No valid repository, or another owner: `unprocessable` (`422`). An action
 * outside the event's set: `ignored`. Installation events use their own schema. Pure.
 */
export function buildFact(
    event: string,
    delivery: string,
    at: number,
    payload: unknown,
): BuildOutcome {
    const body = record(payload);

    if (body === undefined || !Object.hasOwn(EVENTS, event) || event === "ping") {
        return { kind: "unprocessable", reason: "no payload" };
    }

    const fact: HookFact = { delivery: delivery.toLowerCase(), at, event };
    const actions = EVENTS[event];
    const action = body.action;
    const kept =
        typeof action === "string" && actions?.includes(action) === true ? action : undefined;
    const sender = senderOf(body.sender);

    if (event === "installation" || event === "installation_repositories") {
        const installation = record(body.installation);
        const id = installation?.id;
        const account = record(installation?.account)?.login;

        if (
            typeof id !== "number" ||
            !Number.isSafeInteger(id) ||
            id < 1 ||
            typeof account !== "string" ||
            !LOGIN.test(account) ||
            !OWNERS.has(account.toLowerCase())
        ) {
            return { kind: "unprocessable", reason: "installation account" };
        }

        const selection = installation?.repository_selection;
        const facts: InstallationFact = {
            id,
            account: account.toLowerCase(),
            ...(selection === "all" || selection === "selected" ? { selection } : {}),
        };

        if (sender !== undefined) {
            fact.sender = sender;
        }

        if (kept === undefined) {
            fact.installation = facts;

            return { kind: "ignored", fact };
        }

        fact.action = kept;

        if (event === "installation") {
            facts.repositories = repoList(body.repositories);
        } else {
            facts.added = repoList(body.repositories_added);
            facts.removed = repoList(body.repositories_removed);
        }

        fact.installation = facts;

        return { kind: "fact", fact };
    }

    const repo = repoOf(record(body.repository)?.full_name);

    if (repo === undefined) {
        return { kind: "unprocessable", reason: "repository" };
    }

    fact.repo = repo;

    if (sender !== undefined) {
        fact.sender = sender;
    }

    if (event === "status") {
        const state = body.state;

        if (typeof state === "string" && STATUS_STATES.has(state)) {
            fact.state = state;
            fact.check = { state };
        }

        const sha = shaOf(body.sha);

        if (sha !== undefined) {
            fact.sha = sha;
        }

        return { kind: "fact", fact };
    }

    if (kept === undefined) {
        return { kind: "ignored", fact };
    }

    fact.action = kept;

    const pull = record(body.pull_request);
    const issue = record(body.issue);

    if (pull !== undefined) {
        const number = prNumber(pull.number);

        if (number !== undefined) {
            fact.number = number;
        }

        if (pull.state === "open" || pull.state === "closed") {
            fact.state = pull.state;
        }

        if (typeof pull.merged === "boolean") {
            fact.merged = pull.merged;
        }

        if (typeof pull.draft === "boolean") {
            fact.draft = pull.draft;
        }

        const head = shaOf(record(pull.head)?.sha);

        if (head !== undefined) {
            fact.sha = head;
        }

        const merge = shaOf(pull.merge_commit_sha);

        if (merge !== undefined) {
            fact.mergeSha = merge;
        }
    } else if (issue !== undefined) {
        const number = prNumber(issue.number);

        if (number !== undefined) {
            fact.number = number;
        }

        if (issue.state === "open" || issue.state === "closed") {
            fact.state = issue.state;
        }
    }

    if (kept === "labeled" || kept === "unlabeled") {
        const name = record(body.label)?.name;

        if (typeof name === "string") {
            fact.label = TEAM_LABELS.has(name) ? name : "other";
        }
    }

    if (event === "pull_request_review") {
        const state = record(body.review)?.state;
        const lower = typeof state === "string" ? state.toLowerCase() : undefined;

        if (lower !== undefined && REVIEW_STATES.has(lower)) {
            fact.review = lower;
        }
    }

    if (event === "check_suite") {
        const suite = record(body.check_suite);
        const status = suite?.status;
        const conclusion = suite?.conclusion;
        const check: NonNullable<HookFact["check"]> = {};

        if (typeof status === "string" && SUITE_STATUSES.has(status)) {
            check.status = status;
        }

        if (typeof conclusion === "string" && SUITE_CONCLUSIONS.has(conclusion)) {
            check.conclusion = conclusion;
        }

        fact.check = check;

        const head = shaOf(suite?.head_sha);

        if (head !== undefined) {
            fact.sha = head;
        }

        const branch = suite?.head_branch;

        if (branch === "main" || branch === "master") {
            fact.branch = branch;
        }

        const numbers = (Array.isArray(suite?.pull_requests) ? suite.pull_requests : [])
            .map((each) => prNumber(record(each)?.number))
            .filter((number): number is number => number !== undefined)
            .slice(0, 20);

        if (numbers.length > 0) {
            fact.number = numbers[0];
            fact.numbers = numbers;
        }
    }

    return { kind: "fact", fact };
}

/** The class of change of an accepted fact, as the coverage alarm compares it; none for installation events. */
export function factClass(fact: Pick<HookFact, "event" | "action">): ChangeClass | undefined {
    const { event, action } = fact;

    if (event === "pull_request") {
        if (action === "labeled" || action === "unlabeled") {
            return "labels";
        }

        if (action === "synchronize") {
            return "head";
        }

        return action === undefined ? undefined : "state";
    }

    if (event === "pull_request_review") {
        return "review";
    }

    if (event === "check_suite" || event === "status") {
        return "ci";
    }

    if (event === "issues") {
        if (action === "labeled" || action === "unlabeled") {
            return "labels";
        }

        return action === undefined ? undefined : "state";
    }

    return undefined;
}

/** The desk's fact shape (`NudgeFact` in `desk.ts`), declared here: this module never imports `desk.ts`. */
export type NudgeFact = {
    delivery: string;
    at?: number;
    event: string;
    action?: string;
    repo: string;
    number?: number;
    /** `check_suite`: every PR number of the suite (at most 20); `number` is the first. */
    numbers?: number[];
    label?: string;
    sha?: string;
    branch?: string;
};

/**
 * The fact as the desk takes it: no installation event. A `check_suite` fact keeps every PR number of the suite in
 * `numbers` (and the first in `number`, for a desk that knows only `number`): the desk matches a thread that links any
 * of them, not only the first.
 */
export function toNudgeFact(fact: HookFact): NudgeFact | undefined {
    if (fact.repo === undefined || fact.installation !== undefined) {
        return undefined;
    }

    return {
        delivery: fact.delivery,
        at: fact.at,
        event: fact.event,
        ...(fact.action === undefined ? {} : { action: fact.action }),
        repo: fact.repo,
        ...(fact.number === undefined ? {} : { number: fact.number }),
        ...(fact.numbers === undefined || fact.numbers.length === 0
            ? {}
            : { numbers: [...fact.numbers] }),
        ...(fact.label === undefined ? {} : { label: fact.label }),
        ...(fact.sha === undefined ? {} : { sha: fact.sha }),
        ...(fact.branch === undefined ? {} : { branch: fact.branch }),
    };
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** Delivery ids and body digests, with the time each came: pruned only by age. Stored data. */
export type SeenState = { ids: Record<string, number>; digests: Record<string, number> };

/** What happened to a delivery or a refused request. */
export type DeliveryOutcome =
    | "accepted"
    | "ignored"
    | "duplicate"
    | "seen-full"
    | "pending-full"
    | "receiver-gone"
    | "receiver-missing"
    | "receiver-busy"
    | "receiver-timeout"
    | "failed"
    | "unprocessable"
    | "peer-refused"
    | "too-many-sockets"
    | "too-many-requests"
    | "not-found"
    | "unsupported-type"
    | "length-required"
    | "too-large"
    | "busy"
    | "secret-missing"
    | "timeout"
    | "bad-signature"
    | "bad-delivery"
    | "bad-event"
    | "bad-json";

/** 1 log entry: checked fields only. Stored data. */
export type DeliveryEntry = {
    delivery?: string;
    at: number;
    event?: string;
    action?: string;
    repo?: string;
    outcome: DeliveryOutcome;
    /** The HTTP status; 0 when the socket was closed with no answer. */
    status: number;
    peer?: string;
    fact?: HookFact;
};

/** The delivery log and its counters. Stored data. */
export type DeliveriesState = {
    /** Newest last, at most `LOG_MAX`. */
    log: DeliveryEntry[];
    counts: Record<string, number>;
    /** When the last accepted delivery came. */
    last?: number;
    /** Refusals the memory buffer dropped before the receiver wrote them. */
    dropped: number;
};

/** The facts that wait for the desk. Stored data. */
export type PendingState = { markers: Record<string, { fact: NudgeFact; at: number }> };

export type SystemAlarm = "bind-failed" | "secret-missing" | "seen-full" | "receiver-missing";

/** The alarms. Stored data. */
export type AlarmsState = {
    system: Record<string, { raised: number; cleared?: number }>;
    /** By "repo|class" (repo in lower case). */
    coverage: Record<string, { raised: number; misses: number[]; cleared?: number }>;
    /** By "repo|class": the times of the misses in the last 24 hours. */
    misses: Record<string, number[]>;
    /** By the key of an observed change: when it was checked. */
    evaluated: Record<string, number>;
    /**
     * Every miss, for the report (`audit/github-hooks.mjs`): its "repo|class" key and its time (the `seen` time of its
     * change, as in `misses`), in the order the evaluations found them; kept `MISS_LOG_MS`, at most `MISS_LOG_MAX`. `misses` keeps only 24 hours,
     * so it cannot count a 7-day window. Absent: a document stored before this field (the first evaluation adds it).
     */
    missLog?: { key: string; at: number }[];
    /**
     * The log holds every miss at or after this time: the first evaluation that made the log, moved later when an entry
     * goes by age or by the cap.
     */
    missLogFrom?: number;
};

/** 1 accepted fact, as the coverage alarm compares it. */
export type RecentFact = {
    repo: string;
    number?: number;
    numbers?: number[];
    sha?: string;
    class: ChangeClass;
    at: number;
    /**
     * `"status"` for a `status` fact: only such a fact may match a CI change by the observed head sha alone. Absent (an
     * entry stored before this field, or any other event): not a status fact.
     */
    event?: "status";
};

/** Which repositories send events. Stored data. */
export type CoverageState = {
    /** Accepted facts of the last 48 hours, newest last, at most `RECENT_MAX`. */
    recent: RecentFact[];
    /** By installation id. */
    installations: Record<string, { account: string; selection: string; repos: string[] }>;
    /** Repository (lower case) → when its last accepted fact came. */
    repos: Record<string, number>;
    /**
     * When the coverage of a key began: a repository (`owner/name`, lower case), or `account:<owner>` (lower case) for an
     * `all` installation. The coverage alarm counts only a change at or after this time. Absent (a document stored before
     * this field) or a key absent: the evaluation writes it (see `evaluateCoverage`).
     */
    since?: Record<string, number>;
    /**
     * The earliest start each key of `since` ever had: a start that ends (a suspend, a removal, an expiry) keeps its
     * entry here, and a later start never moves it later. The cleanup of stored misses and raised alarms compares only
     * with it: a miss of an earlier coverage stays a miss, and only a matching delivery clears its alarm. Absent (a
     * document stored before this field): it starts as a copy of `since` (`noteBegan`).
     */
    began?: Record<string, number>;
};

/** The receiver task of record. Stored data. */
export type ReceiverState = { task?: string; conversation?: string; started?: number };

const checkpointWhen = (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }) =>
    info.deltasSinceBase >= 64;

export const SeenDoc = defineDoc<SeenState>({
    kind: "x.github-hooks.seen",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({ ids: {}, digests: {} }),
});

export const DeliveriesDoc = defineDoc<DeliveriesState>({
    kind: "x.github-hooks.deliveries",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({ log: [], counts: {}, dropped: 0 }),
});

export const PendingDoc = defineDoc<PendingState>({
    kind: "x.github-hooks.pending",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({ markers: {} }),
});

export const AlarmsDoc = defineDoc<AlarmsState>({
    kind: "x.github-hooks.alarms",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({ system: {}, coverage: {}, misses: {}, evaluated: {} }),
});

export const CoverageDoc = defineDoc<CoverageState>({
    kind: "x.github-hooks.coverage",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({ recent: [], installations: {}, repos: {} }),
});

export const ReceiverDoc = defineDoc<ReceiverState>({
    kind: "x.github-hooks.receiver",
    version: 1,
    scope: "session",
    checkpointWhen,
    initial: () => ({}),
});

/** The desk's observed changes (`DeskObserved` in `desk.ts`), declared here to read them: never written here. */
export type ObservedState = {
    last: Record<string, { head?: string }>;
    changes: {
        repo: string;
        number: number;
        kind: string;
        class: string;
        at: number;
        seen: number;
    }[];
};

export const ObservedRead = defineDoc<ObservedState>({
    kind: "x.desk.observed",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ last: {}, changes: [] }),
});

// ─── The delivery commit (pure) ──────────────────────────────────────────────

/** A delivery the listener checked, for the receiver. */
export type DeliveryJob = {
    delivery: string;
    /** SHA-256 hex of the raw body. */
    digest: string;
    at: number;
    peer?: string;
    /** `ignored`: an action outside the event's set; recorded as seen, no fact, no nudge. */
    ignored: boolean;
    fact: HookFact;
};

/** The documents 1 delivery commit changes. */
export type HookDocs = {
    seen: SeenState;
    deliveries: DeliveriesState;
    pending: PendingState;
    alarms: AlarmsState;
    coverage: CoverageState;
};

export type ApplyResult = {
    outcome: "accepted" | "ignored" | "duplicate" | "seen-full" | "pending-full";
    status: number;
    /** A pending marker was written. */
    marker: boolean;
    /** System alarms this commit raised or cleared. */
    raised: SystemAlarm[];
    cleared: SystemAlarm[];
    /** Coverage alarms ("repo|class") this commit cleared. */
    coverageCleared: string[];
};

const STATUS: Record<ApplyResult["outcome"], number> = {
    accepted: 202,
    ignored: 200,
    duplicate: 200,
    "seen-full": 503,
    "pending-full": 503,
};

/** Prune `seen` by age only. */
export function pruneSeen(seen: SeenState, now: number): void {
    for (const map of [seen.ids, seen.digests]) {
        for (const [key, at] of Object.entries(map)) {
            if (now - at > SEEN_MS) {
                delete map[key];
            }
        }
    }
}

/** A fact for the log: installation repository lists become counts. */
function logFact(fact: HookFact): HookFact {
    if (fact.installation === undefined) {
        return fact;
    }

    const { repositories, added, removed, ...rest } = fact.installation;

    return {
        ...fact,
        installation: {
            ...rest,
            ...(repositories === undefined ? {} : { repositories: [] }),
            ...(added === undefined ? {} : { added: [] }),
            ...(removed === undefined ? {} : { removed: [] }),
        },
    };
}

/** Append log entries and count them. */
export function recordEntries(deliveries: DeliveriesState, entries: DeliveryEntry[]): void {
    for (const entry of entries) {
        deliveries.log.push(entry);
        deliveries.counts[entry.outcome] = (deliveries.counts[entry.outcome] ?? 0) + 1;
    }

    if (deliveries.log.length > LOG_MAX) {
        deliveries.log.splice(0, deliveries.log.length - LOG_MAX);
    }
}

const raisedNow = (alarm: { raised: number; cleared?: number } | undefined) =>
    alarm !== undefined && alarm.cleared === undefined;

/** Raise a system alarm in the document; true when it was not raised. */
export function raiseSystem(alarms: AlarmsState, name: SystemAlarm, at: number): boolean {
    if (raisedNow(alarms.system[name])) {
        return false;
    }

    alarms.system[name] = { raised: at };

    return true;
}

/** Clear a system alarm in the document; true when it was raised. */
export function clearSystem(alarms: AlarmsState, name: SystemAlarm, at: number): boolean {
    const alarm = alarms.system[name];

    if (!raisedNow(alarm)) {
        return false;
    }

    alarm!.cleared = at;

    return true;
}

/** The `since` key of an account with an `all` installation. */
const accountKey = (owner: string) => `account:${owner.toLowerCase()}`;

/** The owner of a repository key (`owner/name`). */
const ownerOf = (repo: string) => repo.slice(0, repo.indexOf("/"));

/**
 * The 1-time migration of a coverage document stored before `since`: when `since` is absent, build it from the evidence
 * in the delivery log (accepted entries only), never later than the evidence proves. An `all` installation: its account
 * starts at the installation's earliest log entry. Each repository of a `selected` installation: the earlier of the
 * installation's earliest entry and the repository's own earliest entry (the installation's alone when the repository has
 * none; `0` when the installation has none). A repository that `repos` covers and no `selected` installation lists: its
 * earliest accepted entry, and no later than the start of its account when an `all` installation covers it (the
 * account's start when it has no entry of its own). No evidence, or a log that dropped entries: `0`, unknown (the change
 * always counts). With `since` present, nothing changes. Returns `since`.
 */
export function ensureSince(
    coverage: CoverageState,
    deliveries: DeliveriesState,
): Record<string, number> {
    if (coverage.since !== undefined) {
        return coverage.since;
    }

    const accepted = deliveries.log.filter((entry) => entry.outcome === "accepted");
    const total = Object.values(deliveries.counts).reduce((sum, count) => sum + count, 0);
    // The log keeps the newest entries only: once it dropped one, its earliest entry proves no start.
    const complete = total <= deliveries.log.length;

    /** The time of the earliest accepted entry that matches; undefined when none does. */
    const first = (match: (entry: DeliveryEntry) => boolean): number | undefined => {
        let found: number | undefined;

        for (const entry of accepted) {
            if (match(entry) && (found === undefined || entry.at < found)) {
                found = entry.at;
            }
        }

        return found;
    };

    const ofRepo = (repo: string) => first((entry) => entry.repo?.toLowerCase() === repo);
    const since: Record<string, number> = {};

    const lower = (key: string, at: number) => {
        since[key] = since[key] === undefined ? at : Math.min(since[key], at);
    };

    for (const [id, installation] of Object.entries(coverage.installations)) {
        const evidence = complete
            ? (first((entry) => String(entry.fact?.installation?.id) === id) ?? 0)
            : 0;

        if (installation.selection === "all") {
            lower(accountKey(installation.account), evidence);
        } else {
            for (const key of installation.repos) {
                const repo = key.toLowerCase();
                const own = ofRepo(repo);

                lower(
                    repo,
                    evidence === 0 || own === undefined ? evidence : Math.min(evidence, own),
                );
            }
        }
    }

    for (const key of Object.keys(coverage.repos)) {
        const repo = key.toLowerCase();

        if (since[repo] !== undefined) {
            continue;
        }

        const at = complete ? (ofRepo(repo) ?? 0) : 0;
        const account = since[accountKey(ownerOf(repo))];

        // No entry of its own (a complete log): the account's start is the only evidence.
        since[repo] = account === undefined ? at : at === 0 ? account : Math.min(at, account);
    }

    coverage.since = since;

    return coverage.since;
}

/**
 * The 1-time migration of a coverage document stored before `began` (run after `ensureSince`, before any start of this
 * commit or evaluation changes): `since` alone does not prove the first coverage (a suspend and unsuspend, or a removal
 * and a new add, under an older version gave a later start), so each key's `began` is never later than the evidence
 * of the accepted delivery log. An account key: the earlier of its start and the earliest entry of an installation of
 * that account. A repository key: the earlier of its start, its own earliest entry, and the earliest installation entry
 * of its owner. No such entry in a complete log: its start. A log that dropped entries proves nothing: `0`, unknown,
 * and nothing is cleared for that key. A coverage that ended before the upgrade (a suspend not yet undone, a removed
 * repository) has no start: each repository of a stored miss or alarm whose repository key and account key have no start
 * gets a `began` for both (the earliest of that evidence; `0` when there is none), so a later start never clears the
 * misses of that coverage. With
 * `began` present, nothing changes. Returns `began`.
 */
export function ensureBegan(
    coverage: CoverageState,
    deliveries: DeliveriesState,
    alarms?: AlarmsState,
): Record<string, number> {
    if (coverage.began !== undefined) {
        return coverage.began;
    }

    const total = Object.values(deliveries.counts).reduce((sum, count) => sum + count, 0);
    const complete = total <= deliveries.log.length;
    const accepted = deliveries.log.filter((entry) => entry.outcome === "accepted");

    /** The time of the earliest accepted entry that matches; undefined when none does. */
    const first = (match: (entry: DeliveryEntry) => boolean): number | undefined => {
        let found: number | undefined;

        for (const entry of accepted) {
            if (match(entry) && (found === undefined || entry.at < found)) {
                found = entry.at;
            }
        }

        return found;
    };

    const ofAccount = (owner: string) =>
        first((entry) => entry.fact?.installation?.account?.toLowerCase() === owner);
    const began: Record<string, number> = {};
    const evidenceOf = (key: string): number[] =>
        (key.startsWith("account:")
            ? [ofAccount(key.slice("account:".length))]
            : [first((entry) => entry.repo?.toLowerCase() === key), ofAccount(ownerOf(key))]
        ).filter((at): at is number => typeof at === "number");

    for (const [key, start] of Object.entries(coverage.since ?? {})) {
        began[key] = complete ? Math.min(start, ...evidenceOf(key)) : 0;
    }

    // The keys of a coverage that ended before the upgrade: the repositories of the stored misses and alarms.
    for (const stored of [
        ...Object.keys(alarms?.coverage ?? {}),
        ...Object.keys(alarms?.misses ?? {}),
    ]) {
        const repo = (stored.split("|")[0] ?? "").toLowerCase();

        if (!REPO.test(repo)) {
            continue;
        }

        const keys = [repo, accountKey(ownerOf(repo))];

        // A repository that a current start already covers (its own, or its account's) keeps that evidence.
        if (keys.some((key) => began[key] !== undefined)) {
            continue;
        }

        for (const key of keys) {
            const evidence = complete ? evidenceOf(key) : [];

            began[key] = evidence.length === 0 ? 0 : Math.min(...evidence);
        }
    }

    coverage.began = began;

    return began;
}

/**
 * Copy each start of `since` into `began`, never later than `began` holds it: the earliest start of each key ever. A
 * document with no `began` is migrated first (`ensureBegan`); with none, `began` starts as a copy of `since`.
 */
export function noteBegan(coverage: CoverageState): void {
    const began = (coverage.began ??= {});

    for (const [key, at] of Object.entries(coverage.since ?? {})) {
        began[key] = began[key] === undefined ? at : Math.min(began[key], at);
    }
}

/**
 * The starts follow the coverage at each delivery that changes it (an installation fact, an accepted repository fact).
 * The covered set is `coveredRepos(coverage, at)`. First each covered key with no start gets one: a repository starts at
 * the earlier of `at` and its account's start when `since` holds that account key (also when this same delivery ends
 * the account: the coverage went on), else at `at`; an account starts at `at`. Then each start of a key that covers no
 * more goes: its coverage ended at this delivery, and a later coverage begins again.
 */
function syncStarts(coverage: CoverageState, at: number): void {
    const since = (coverage.since ??= {});
    const { repos, accounts } = coveredRepos(coverage, at);

    // Before a start ends below: a document stored before `began` keeps the start it had.
    noteBegan(coverage);

    for (const repo of repos) {
        if (since[repo] === undefined) {
            const account = since[accountKey(ownerOf(repo))];

            since[repo] = account === undefined ? at : Math.min(at, account);
        }
    }

    for (const owner of accounts) {
        since[accountKey(owner)] ??= at;
    }

    noteBegan(coverage);

    for (const key of Object.keys(since)) {
        const covers = key.startsWith("account:")
            ? accounts.has(key.slice("account:".length))
            : repos.has(key);

        if (!covers) {
            delete since[key];
        }
    }
}

function updateInstallations(coverage: CoverageState, fact: HookFact): void {
    const facts = fact.installation;

    if (facts === undefined) {
        return;
    }

    const key = String(facts.id);
    const known = coverage.installations[key];

    if (fact.event === "installation") {
        if (fact.action === "deleted" || fact.action === "suspend") {
            delete coverage.installations[key];
            syncStarts(coverage, fact.at);

            return;
        }

        const entry = {
            account: facts.account,
            selection: facts.selection ?? known?.selection ?? "selected",
            repos:
                facts.repositories !== undefined && facts.repositories.length > 0
                    ? facts.repositories.map((repo) => repo.toLowerCase())
                    : (known?.repos ?? []),
        };

        coverage.installations[key] = entry;
        syncStarts(coverage, fact.at);

        return;
    }

    const entry = known ?? { account: facts.account, selection: "selected", repos: [] };

    entry.selection = facts.selection ?? entry.selection;

    const repos = new Set(entry.repos);

    for (const repo of facts.added ?? []) {
        repos.add(repo.toLowerCase());
    }

    for (const repo of facts.removed ?? []) {
        repos.delete(repo.toLowerCase());
    }

    entry.repos = [...repos].sort();
    coverage.installations[key] = entry;
    syncStarts(coverage, fact.at);
}

/**
 * The delivery commit's rules, on the documents (drafts in a commit, plain values in a test): prune `seen` by age; a
 * known id or digest is `duplicate`; a full `seen` is `seen-full`; a full pending set (when the desk takes facts) is
 * `pending-full`, and then only the refusal is recorded; else the id and the digest, the log entry and the count, the
 * coverage records, and the pending marker. `nudge`: the desk has `nudge` now. Pure, apart from the documents it changes.
 */
export function applyDelivery(
    docs: HookDocs,
    job: DeliveryJob,
    now: number,
    options: { nudge: boolean },
): ApplyResult {
    const result = (
        outcome: ApplyResult["outcome"],
        extra: Partial<ApplyResult> = {},
    ): ApplyResult => ({
        outcome,
        status: STATUS[outcome],
        marker: false,
        raised: [],
        cleared: [],
        coverageCleared: [],
        ...extra,
    });
    const entry = (outcome: ApplyResult["outcome"], fact?: HookFact): DeliveryEntry => ({
        delivery: job.delivery,
        at: job.at,
        event: job.fact.event,
        ...(job.fact.action === undefined ? {} : { action: job.fact.action }),
        ...(job.fact.repo === undefined ? {} : { repo: job.fact.repo }),
        outcome,
        status: STATUS[outcome],
        ...(job.peer === undefined ? {} : { peer: job.peer }),
        ...(fact === undefined ? {} : { fact: logFact(fact) }),
    });

    pruneSeen(docs.seen, now);

    const full = Object.keys(docs.seen.ids).length >= SEEN_MAX;
    // The set is under its cap again: clear the alarm in every commit, a duplicate's too.
    const cleared: SystemAlarm[] =
        !full && clearSystem(docs.alarms, "seen-full", now) ? ["seen-full"] : [];

    if (docs.seen.ids[job.delivery] !== undefined || docs.seen.digests[job.digest] !== undefined) {
        recordEntries(docs.deliveries, [entry("duplicate")]);

        return result("duplicate", { cleared });
    }

    if (full) {
        recordEntries(docs.deliveries, [entry("seen-full")]);

        return result("seen-full", {
            raised: raiseSystem(docs.alarms, "seen-full", now) ? ["seen-full"] : [],
        });
    }

    const nudgeFact = job.ignored ? undefined : toNudgeFact(job.fact);
    const marker = options.nudge && nudgeFact !== undefined;

    if (marker && Object.keys(docs.pending.markers).length >= PENDING_MAX) {
        recordEntries(docs.deliveries, [entry("pending-full")]);

        return result("pending-full", { cleared });
    }

    docs.seen.ids[job.delivery] = job.at;
    docs.seen.digests[job.digest] = job.at;

    if (job.ignored) {
        recordEntries(docs.deliveries, [entry("ignored")]);

        return result("ignored", { cleared });
    }

    // Migrate a coverage document stored before `since` and `began` from the log as it was, before this commit writes
    // any start.
    ensureSince(docs.coverage, docs.deliveries);
    ensureBegan(docs.coverage, docs.deliveries, docs.alarms);
    recordEntries(docs.deliveries, [entry("accepted", job.fact)]);
    docs.deliveries.last = job.at;

    const coverageCleared: string[] = [];
    const fact = job.fact;

    if (fact.installation !== undefined) {
        updateInstallations(docs.coverage, fact);
    }

    const change = factClass(fact);

    if (fact.repo !== undefined && change !== undefined) {
        const repo = fact.repo.toLowerCase();

        docs.coverage.recent.push({
            repo,
            ...(fact.number === undefined ? {} : { number: fact.number }),
            ...(fact.numbers === undefined ? {} : { numbers: [...fact.numbers] }),
            ...(fact.sha === undefined ? {} : { sha: fact.sha }),
            class: change,
            at: fact.at,
            ...(fact.event === "status" ? { event: "status" as const } : {}),
        });
        docs.coverage.recent = docs.coverage.recent.filter((each) => now - each.at <= RECENT_MS);

        if (docs.coverage.recent.length > RECENT_MAX) {
            docs.coverage.recent.splice(0, docs.coverage.recent.length - RECENT_MAX);
        }

        // First end a start whose coverage expired before this fact (on the coverage before it), then start it again.
        syncStarts(docs.coverage, fact.at);
        docs.coverage.repos[repo] = fact.at;
        syncStarts(docs.coverage, fact.at);

        const key = `${repo}|${change}`;

        if (raisedNow(docs.alarms.coverage[key])) {
            docs.alarms.coverage[key]!.cleared = now;
            docs.alarms.misses[key] = [];
            coverageCleared.push(key);
        }
    }

    if (marker) {
        docs.pending.markers[job.delivery] = { fact: nudgeFact!, at: job.at };
    }

    return result("accepted", { marker, cleared, coverageCleared });
}

// ─── The coverage alarm (pure) ───────────────────────────────────────────────

/** The repositories the hooks cover now, in lower case, and the accounts with an `all` installation. */
export function coveredRepos(
    coverage: CoverageState,
    now: number,
): { repos: Set<string>; accounts: Set<string> } {
    const repos = new Set<string>();
    const accounts = new Set<string>();

    for (const installation of Object.values(coverage.installations)) {
        if (installation.selection === "all") {
            accounts.add(installation.account.toLowerCase());
        } else {
            for (const repo of installation.repos) {
                repos.add(repo.toLowerCase());
            }
        }
    }

    for (const [repo, at] of Object.entries(coverage.repos)) {
        if (now - at <= COVERED_MS) {
            repos.add(repo.toLowerCase());
        }
    }

    return { repos, accounts };
}

/** Add 1 miss to the miss log; above `MISS_LOG_MAX`, the oldest go, and the log is complete only after them. */
function logMiss(alarms: AlarmsState, key: string, at: number): void {
    const log = (alarms.missLog ??= []);

    log.push({ key, at });

    if (log.length > MISS_LOG_MAX) {
        const dropped = log.splice(0, log.length - MISS_LOG_MAX);
        const last = Math.max(...dropped.map((entry) => entry.at));

        alarms.missLogFrom = Math.max(alarms.missLogFrom ?? 0, last + 1);
    }
}

/**
 * Evaluate the coverage alarm (every 5 minutes): each observed change of a covered repository that is 30 minutes to 24
 * hours old, and not checked before, is checked once against the accepted facts. A change before the coverage of its
 * repository began (`since`: the earliest start of its repository key and its account key; `0` is unknown) is no miss.
 * No match is a miss; 2 misses of 1 repository and class within 24 hours raise its alarm. Silence alone raises nothing:
 * no rule looks at the time since the last delivery. First a document stored before `since` is migrated from the
 * delivery log (`ensureSince`), `began` keeps each start (`noteBegan`), and the start of a key that covers no more
 * goes; then the misses before the first coverage (`began`) are dropped, and a raised alarm whose every miss is before
 * it is cleared. A suspend and unsuspend, or a removal and a new add, makes a new start but never a new `began`: the
 * misses of the earlier coverage stay, and only a matching delivery clears their alarm. Returns the keys
 * ("repo|class") it raised. Pure, apart from the documents it changes (never the deliveries).
 */
export function evaluateCoverage(
    observed: ObservedState,
    coverage: CoverageState,
    alarms: AlarmsState,
    now: number,
    deliveries: DeliveriesState,
): string[] {
    const since = ensureSince(coverage, deliveries);
    const { repos, accounts } = coveredRepos(coverage, now);
    const raised: string[] = [];

    ensureBegan(coverage, deliveries, alarms);

    // Before a start ends below: `began` keeps the earliest start of each key.
    noteBegan(coverage);

    // Only here does a start end: the start of a key that covers no more goes, so a later coverage begins again.
    for (const key of Object.keys(since)) {
        const covers = key.startsWith("account:")
            ? accounts.has(key.slice("account:".length))
            : repos.has(key);

        if (!covers) {
            delete since[key];
        }
    }

    /** When the coverage of a repository began: `0` when it is unknown (a covered key with no start) or not covered. */
    const startOf = (repo: string): number => {
        const owner = ownerOf(repo);
        const starts = [
            ...(repos.has(repo) ? [since[repo] ?? 0] : []),
            ...(accounts.has(owner) ? [since[accountKey(owner)] ?? 0] : []),
        ];

        return starts.length === 0 ? 0 : Math.min(...starts);
    };

    /**
     * When the first coverage of a repository began (`began`: the earliest of its repository key and its account key):
     * `0` when neither key has one, or it is unknown. A start that ended does not move it: a later coverage keeps it.
     */
    const beganOf = (repo: string): number => {
        const began = coverage.began ?? {};
        const starts = [began[repo], began[accountKey(ownerOf(repo))]].filter(
            (at): at is number => typeof at === "number",
        );

        return starts.length === 0 ? 0 : Math.min(...starts);
    };

    const timeOf = (change: { at: number; seen: number }) =>
        change.at > 0 ? change.at : change.seen;

    /**
     * A stored miss (the `seen` time of its change) is before the first coverage when the observed changes of that
     * repository and class seen at that time all have their own time before it; with no such change, the miss time itself
     * is compared. Only the first coverage counts (`beganOf`), not the current start: a miss of an earlier coverage that
     * ended (a suspend, a removal) was real, and only a matching delivery clears its alarm.
     */
    const missBefore = (key: string, miss: number): boolean => {
        const [repo = "", change = ""] = key.split("|");
        const start = beganOf(repo);

        if (start === 0) {
            return false;
        }

        const seenThen = (observed.changes ?? []).filter(
            (each) =>
                typeof each?.repo === "string" &&
                each.repo.toLowerCase() === repo &&
                each.class === change &&
                each.seen === miss,
        );

        return seenThen.length === 0
            ? miss < start
            : seenThen.every((each) => timeOf(each) < start);
    };

    for (const [key, at] of Object.entries(alarms.evaluated)) {
        if (now - at > CHANGE_MAX_AGE_MS + HOUR) {
            delete alarms.evaluated[key];
        }
    }

    // The miss log starts with the first evaluation that knows it; then each entry goes by age, the oldest first.
    alarms.missLogFrom ??= now;

    const missLog = (alarms.missLog ??= []);
    const oldest = now - MISS_LOG_MS;

    if (missLog.some((entry) => entry.at < oldest)) {
        alarms.missLog = missLog.filter((entry) => entry.at >= oldest);
        alarms.missLogFrom = Math.max(alarms.missLogFrom, oldest);
    }

    for (const [key, times] of Object.entries(alarms.misses)) {
        const kept = times.filter((at) => now - at <= MISS_WINDOW_MS && !missBefore(key, at));

        if (kept.length === 0) {
            delete alarms.misses[key];
        } else {
            alarms.misses[key] = kept;
        }
    }

    // A raised alarm whose every miss came before the first coverage began is false (a document stored before the
    // starts): it is cleared. An alarm of an earlier coverage that ended stays until a matching delivery.
    for (const [key, alarm] of Object.entries(alarms.coverage)) {
        if (
            raisedNow(alarm) &&
            alarm.misses.length > 0 &&
            alarm.misses.every((at) => missBefore(key, at))
        ) {
            alarm.cleared = now;
        }
    }

    for (const change of observed.changes ?? []) {
        if (typeof change?.repo !== "string" || !REPO.test(change.repo)) {
            continue;
        }

        const repo = change.repo.toLowerCase();
        const owner = ownerOf(repo);
        const age = now - change.seen;

        if (!(repos.has(repo) || accounts.has(owner))) {
            continue;
        }

        if (age < CHANGE_MIN_AGE_MS || age > CHANGE_MAX_AGE_MS) {
            continue;
        }

        const changeKey = `${repo}#${String(change.number)}|${change.class}|${String(change.seen)}|${String(change.at)}`;

        if (alarms.evaluated[changeKey] !== undefined) {
            continue;
        }

        alarms.evaluated[changeKey] = now;

        // A change before the coverage of its repository began: no delivery could exist for it.
        if (timeOf(change) < startOf(repo)) {
            continue;
        }

        const from = (change.at > 0 ? change.at : change.seen - 6 * HOUR) - 5 * MINUTE;
        const to = change.seen + 30 * MINUTE;
        const head = observed.last?.[`${repo}#${String(change.number)}`]?.head;
        const sameNumber = (fact: RecentFact) =>
            fact.number === change.number || fact.numbers?.includes(change.number) === true;
        const matched = coverage.recent.some((fact) => {
            if (fact.repo !== repo || fact.at < from || fact.at > to) {
                return false;
            }

            if (fact.class === change.class) {
                return (
                    sameNumber(fact) ||
                    // By sha alone only a status fact: it has no PR number. A check_suite fact matches by number.
                    (change.class === "ci" &&
                        fact.event === "status" &&
                        head !== undefined &&
                        fact.sha === head)
                );
            }

            // Checks go pending at a new head: a head fact of the same PR covers a CI change.
            return change.class === "ci" && fact.class === "head" && sameNumber(fact);
        });

        if (matched) {
            continue;
        }

        const key = `${repo}|${change.class}`;
        const misses = [...(alarms.misses[key] ?? []), change.seen];

        alarms.misses[key] = misses;
        logMiss(alarms, key, change.seen);

        if (misses.length >= MISSES_TO_RAISE && !raisedNow(alarms.coverage[key])) {
            alarms.coverage[key] = { raised: now, misses: [...misses] };
            raised.push(key);
        }
    }

    return raised;
}

// ─── The secret ──────────────────────────────────────────────────────────────

export type SecretStatus = "ok" | "missing" | "short";

/** What the secret files hold now: never logged, stored or shown. */
export type SecretState = { status: SecretStatus; values: string[]; next: boolean };

type SecretFile = { key: string; value?: string; status: SecretStatus; unhide?: () => void };

/**
 * The secret files: `github-webhook.secret` and `github-webhook.secret.next` in `dir`. Each is read at first use and again
 * when its inode, size or mtime changes (1 `stat` per request), trimmed, and hidden with `hide` (the old value's hide ends
 * when the value changes, and at `dispose`). Shorter than 32 or longer than 4096 characters counts as missing (`short`
 * when it is shorter). A file with group or other permission bits gives 1 warning.
 */
export function createSecretSource(
    dir: string,
    deps: { hide: (value: string) => () => void; warn: (message: string) => void },
) {
    const files: Record<string, SecretFile> = {};
    const warned = new Set<string>();

    async function readOne(name: string): Promise<SecretFile> {
        const path = join(dir, name);
        let key = "absent";

        try {
            const info = await stat(path);

            key = `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`;

            if ((info.mode & 0o077) !== 0 && !warned.has(name)) {
                warned.add(name);
                deps.warn(`github-hooks: ${name} can be read by others; make it mode 0600.`);
            }
        } catch {
            key = "absent";
        }

        const known = files[name];

        if (known !== undefined && known.key === key) {
            return known;
        }

        known?.unhide?.();

        let value: string | undefined;
        let status: SecretStatus = "missing";

        if (key !== "absent") {
            try {
                const text = (await readFile(path, "utf8")).trim();

                if (text.length >= 32 && text.length <= 4096) {
                    value = text;
                    status = "ok";
                } else if (text.length > 0 && text.length < 32) {
                    status = "short";
                }
            } catch {
                status = "missing";
            }
        }

        const file: SecretFile = { key, status, ...(value === undefined ? {} : { value }) };

        if (value !== undefined) {
            file.unhide = deps.hide(value);
        }

        files[name] = file;

        return file;
    }

    return {
        async read(): Promise<SecretState> {
            const current = await readOne("github-webhook.secret");
            const next = await readOne("github-webhook.secret.next");

            if (current.status !== "ok") {
                return { status: current.status, values: [], next: next.status === "ok" };
            }

            return {
                status: "ok",
                values: [current.value!, ...(next.value === undefined ? [] : [next.value])],
                next: next.status === "ok",
            };
        },
        dispose(): void {
            for (const file of Object.values(files)) {
                file.unhide?.();
                delete file.unhide;
            }
        },
    };
}

// ─── The listener ────────────────────────────────────────────────────────────

/** What the receiver answers for 1 job. */
export type ReceiverAnswer = {
    /**
     * `receiver-busy`: the inbox holds `INBOX_MAX` jobs already. `cancelled`: the listener gave up on the job before its
     * commit started (nobody reads this answer).
     */
    outcome: ApplyResult["outcome"] | "receiver-gone" | "receiver-busy" | "cancelled" | "failed";
};

/** The receiver as the listener sees it. An abort of `signal` cancels the job while its commit has not started. */
export type ReceiverHandle = {
    taskId: string;
    submit: (job: DeliveryJob, options?: { signal?: AbortSignal }) => Promise<ReceiverAnswer>;
};

/** What the listener reports to its module: a refusal for the log, or a system alarm. */
export type ListenerEvent =
    | { type: "refusal"; entry: DeliveryEntry }
    | { type: "raise"; name: SystemAlarm; message: string }
    | { type: "clear"; name: SystemAlarm };

export type ListenerDeps = {
    port: number;
    host: string;
    allowFrom: () => ReadonlySet<string>;
    secrets: () => Promise<SecretState>;
    receiver: () => ReceiverHandle | undefined;
    now: () => number;
    log: (line: string) => void;
    onEvent: (event: ListenerEvent) => void;
    limits?: Partial<ListenerLimits>;
    /** The timers of the bind, its retries and the socket grace time at `close`: a test injects its own. */
    timers?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
};

export type ListenerStatus = {
    state: "waiting" | "bound" | "retrying" | "failed" | "closed";
    port?: number;
};

/** Every listening server of this module, over all versions (a closed one leaves at once): a test counts them. */
const LISTENERS = Symbol.for("pi-pocket-team.github-hooks.listeners");

export function liveListeners(): Set<Server> {
    const shared = globalThis as unknown as Record<symbol, Set<Server> | undefined>;

    shared[LISTENERS] ??= new Set();

    return shared[LISTENERS];
}

/** A peer address as `allowFrom` holds it: no `::ffff:` prefix, lower case. */
export function normalizePeer(address: string | undefined): string {
    const text = (address ?? "").toLowerCase();

    return text.startsWith("::ffff:") && isIP(text.slice(7)) === 4 ? text.slice(7) : text;
}

/** `allowFrom` from its text: a comma list of IP addresses; an invalid entry is ignored. */
export function parseAllowFrom(text: string): Set<string> {
    return new Set(
        text
            .split(",")
            .map((each) => normalizePeer(each.trim()))
            .filter((each) => isIP(each) !== 0),
    );
}

const ANSWER_STATUS: Record<ReceiverAnswer["outcome"], number> = {
    accepted: 202,
    ignored: 200,
    duplicate: 200,
    "seen-full": 503,
    "pending-full": 503,
    "receiver-gone": 503,
    "receiver-busy": 503,
    cancelled: 503,
    failed: 500,
};

/**
 * The webhook listener: the checks of the plan's "Authentication" in order, each failure ending the request, nothing
 * parsed before the HMAC matched. `start` binds on a timer (after the module's load), `close` stops it.
 */
export function createHookListener(deps: ListenerDeps) {
    const limits: ListenerLimits = { ...LIMITS, ...deps.limits };
    const sockets = new Set<Socket>();
    let status: ListenerStatus = { state: "waiting" };
    let server: Server | undefined;
    let timer: unknown;
    const timers = deps.timers ?? {
        set: (run: () => void, ms: number) => setTimeout(run, ms),
        clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
    };
    let firstTry = 0;
    let closed = false;
    let inProgress = 0;
    let reserved = 0;

    const stamp = () => new Date(deps.now()).toISOString();

    const refuse = (
        res: ServerResponse | undefined,
        socket: Socket,
        peer: string,
        outcome: DeliveryOutcome,
        code: number,
        known?: { delivery?: string; event?: string },
    ) => {
        deps.log(
            known?.delivery === undefined
                ? `github-hooks: ${stamp()} refused peer=${peer} reason=${outcome} status=${String(code)}`
                : `github-hooks: ${stamp()} delivery=${known.delivery} event=${known.event ?? "-"} action=- repo=- outcome=${outcome} status=${String(code)}`,
        );
        deps.onEvent({
            type: "refusal",
            entry: {
                ...(known?.delivery === undefined ? {} : { delivery: known.delivery }),
                at: deps.now(),
                ...(known?.event === undefined ? {} : { event: known.event }),
                outcome,
                status: code,
                peer,
            },
        });

        if (res === undefined) {
            socket.destroy();

            return;
        }

        if (!res.headersSent) {
            res.writeHead(code, {
                "Content-Type": "text/plain; charset=utf-8",
                Connection: "close",
            });
        }

        res.end(`${outcome}\n`);
    };

    const answer = (res: ServerResponse, code: number, outcome: string) => {
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`${outcome}\n`);
    };

    /** Read the body to a buffer, at most the cap + 1 byte, within the deadline. */
    const readBody = (req: IncomingMessage) =>
        new Promise<{ body?: Buffer; error?: "too-large" | "timeout" | "aborted" }>((resolve) => {
            const chunks: Buffer[] = [];
            let size = 0;
            let done = false;

            const finish = (value: {
                body?: Buffer;
                error?: "too-large" | "timeout" | "aborted";
            }) => {
                if (done) {
                    return;
                }

                done = true;
                clearTimeout(deadline);
                req.removeAllListeners("data");
                resolve(value);
            };

            const deadline = setTimeout(() => finish({ error: "timeout" }), limits.bodyTimeoutMs);

            req.on("data", (chunk: Buffer) => {
                size += chunk.length;

                if (size > limits.maxBody) {
                    req.pause();
                    finish({ error: "too-large" });

                    return;
                }

                chunks.push(chunk);
            });
            req.on("end", () => finish({ body: Buffer.concat(chunks, size) }));
            req.on("aborted", () => finish({ error: "aborted" }));
            req.on("error", () => finish({ error: "aborted" }));
            req.on("close", () => finish({ error: "aborted" }));
        });

    const handle = async (req: IncomingMessage, res: ServerResponse, peer: string) => {
        const socket = req.socket;

        // 2. The route, the content type, the length: before any body byte.
        if (req.method !== "POST" || req.url !== HOOKS_PATH) {
            refuse(res, socket, peer, "not-found", 404);

            return;
        }

        const type = req.headers["content-type"];

        if (typeof type !== "string" || !/^application\/json\s*(;.*)?$/i.test(type)) {
            refuse(res, socket, peer, "unsupported-type", 415);

            return;
        }

        const lengthText = req.headers["content-length"];

        if (typeof lengthText !== "string" || !/^\d{1,15}$/.test(lengthText)) {
            refuse(res, socket, peer, "length-required", 411);

            return;
        }

        const length = Number(lengthText);

        if (length > limits.maxBody) {
            refuse(res, socket, peer, "too-large", 413);

            return;
        }

        // 1. The body budget over all requests: reserve the length before the read.
        if (reserved + length > limits.bodyBudget) {
            refuse(res, socket, peer, "busy", 503);

            return;
        }

        reserved += length;

        try {
            // 3. The secret, before the body.
            const secret = await deps.secrets();

            if (secret.status !== "ok") {
                deps.onEvent({
                    type: "raise",
                    name: "secret-missing",
                    message: `github-hooks: the webhook secret is ${secret.status}: every delivery gets 503.`,
                });
                refuse(res, socket, peer, "secret-missing", 503);

                return;
            }

            deps.onEvent({ type: "clear", name: "secret-missing" });

            // 4. The body.
            const read = await readBody(req);

            if (read.error === "too-large") {
                refuse(res, socket, peer, "too-large", 413);

                return;
            }

            if (read.error === "timeout") {
                refuse(res, socket, peer, "timeout", 408);

                return;
            }

            if (read.body === undefined) {
                socket.destroy();

                return;
            }

            const body = read.body;

            // 5. The signature: format first (equal lengths), then a constant-time compare per secret.
            const signature = req.headers["x-hub-signature-256"];

            if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
                refuse(res, socket, peer, "bad-signature", 401);

                return;
            }

            const given = Buffer.from(signature.slice(7), "hex");
            const matched = secret.values.some((value) =>
                timingSafeEqual(createHmac("sha256", value).update(body).digest(), given),
            );

            if (!matched) {
                refuse(res, socket, peer, "bad-signature", 401);

                return;
            }

            // 6. The delivery id and the event.
            const deliveryHeader = req.headers["x-github-delivery"];

            if (typeof deliveryHeader !== "string" || !UUID.test(deliveryHeader)) {
                refuse(res, socket, peer, "bad-delivery", 400);

                return;
            }

            const delivery = deliveryHeader.toLowerCase();
            const eventHeader = req.headers["x-github-event"];

            if (typeof eventHeader !== "string" || !Object.hasOwn(EVENTS, eventHeader)) {
                refuse(res, socket, peer, "bad-event", 400, { delivery });

                return;
            }

            const event = eventHeader;

            if (event === "ping") {
                deps.log(
                    `github-hooks: ${stamp()} delivery=${delivery} event=ping action=- repo=- outcome=ping status=200`,
                );
                answer(res, 200, "pong");

                return;
            }

            // 7. Only now: parse, then build the fact.
            let payload: unknown;

            try {
                payload = JSON.parse(body.toString("utf8"));
            } catch {
                refuse(res, socket, peer, "bad-json", 400, { delivery, event });

                return;
            }

            const at = deps.now();
            const built = buildFact(event, delivery, at, payload);

            if (built.kind === "unprocessable") {
                refuse(res, socket, peer, "unprocessable", 422, { delivery, event });

                return;
            }

            // 8. The receiver commits it.
            const receiver = deps.receiver();

            if (receiver === undefined) {
                deps.onEvent({
                    type: "raise",
                    name: "receiver-missing",
                    message:
                        "github-hooks: no receiver runs: every delivery gets 503. Run /github-hooks start once.",
                });
                refuse(res, socket, peer, "receiver-missing", 503, { delivery, event });

                return;
            }

            const job: DeliveryJob = {
                delivery,
                digest: createHash("sha256").update(body).digest("hex"),
                at,
                peer,
                ignored: built.kind === "ignored",
                fact: built.fact,
            };
            let timeout: NodeJS.Timeout | undefined;
            const cancel = new AbortController();
            const result = await Promise.race([
                receiver
                    .submit(job, { signal: cancel.signal })
                    .catch((): ReceiverAnswer => ({ outcome: "failed" })),
                new Promise<undefined>((resolve) => {
                    timeout = setTimeout(() => resolve(undefined), limits.jobTimeoutMs);
                }),
            ]);

            clearTimeout(timeout);

            if (result === undefined) {
                // The job leaves the inbox unless its commit started; a commit that started can still land.
                cancel.abort();
                refuse(res, socket, peer, "receiver-timeout", 503, { delivery, event });

                return;
            }

            const code = ANSWER_STATUS[result.outcome];

            if (
                result.outcome === "receiver-gone" ||
                result.outcome === "receiver-busy" ||
                result.outcome === "cancelled" ||
                result.outcome === "failed"
            ) {
                // A job cancelled before it ran is a timeout for the sender.
                const outcome =
                    result.outcome === "cancelled" ? "receiver-timeout" : result.outcome;

                refuse(res, socket, peer, outcome, code, { delivery, event });

                return;
            }

            deps.log(
                `github-hooks: ${stamp()} delivery=${delivery} event=${event} action=${built.fact.action ?? "-"} repo=${built.fact.repo ?? "-"} outcome=${result.outcome} status=${String(code)}`,
            );
            answer(res, code, result.outcome);
        } finally {
            reserved -= length;
        }
    };

    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
        const peer = normalizePeer(req.socket.remoteAddress);

        if (inProgress >= limits.maxRequests) {
            refuse(undefined, req.socket, peer, "too-many-requests", 0);

            return;
        }

        inProgress += 1;

        let ended = false;

        const end = () => {
            if (!ended) {
                ended = true;
                inProgress -= 1;
            }
        };

        res.on("close", end);
        res.on("finish", end);
        handle(req, res, peer).catch(() => {
            if (!res.headersSent) {
                res.writeHead(500, { Connection: "close" });
            }

            res.end();
        });
    };

    const onConnection = (socket: Socket) => {
        const peer = normalizePeer(socket.remoteAddress);

        if (!deps.allowFrom().has(peer)) {
            refuse(undefined, socket, peer, "peer-refused", 0);

            return;
        }

        if (sockets.size >= limits.maxSockets) {
            refuse(undefined, socket, peer, "too-many-sockets", 0);

            return;
        }

        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    };

    const bind = () => {
        timer = undefined;

        if (closed) {
            return;
        }

        if (firstTry === 0) {
            firstTry = deps.now();
        }

        const attempt = createServer({
            headersTimeout: limits.headersTimeoutMs,
            requestTimeout: limits.headersTimeoutMs + limits.bodyTimeoutMs + 1_000,
            connectionsCheckingInterval: Math.max(
                10,
                Math.min(1_000, Math.floor(limits.headersTimeoutMs / 4)),
            ),
        });

        attempt.on("connection", onConnection);
        attempt.on("request", onRequest);
        attempt.once("error", (error: NodeJS.ErrnoException) => {
            if (closed) {
                return;
            }

            if (
                error.code === "EADDRINUSE" &&
                deps.now() - firstTry + limits.bindRetryMs <= limits.bindLimitMs
            ) {
                status = { state: "retrying" };
                timer = timers.set(bind, limits.bindRetryMs);

                return;
            }

            status = { state: "failed" };
            deps.onEvent({
                type: "raise",
                name: "bind-failed",
                message: `github-hooks: port ${String(deps.port)} is in use; the listener gave up after ${String(Math.round(limits.bindLimitMs / 1000))} s.`,
            });
        });
        attempt.listen(deps.port, deps.host, () => {
            if (closed) {
                attempt.close();

                return;
            }

            server = attempt;
            liveListeners().add(attempt);
            attempt.once("close", () => liveListeners().delete(attempt));

            const address = attempt.address();

            status = {
                state: "bound",
                port: typeof address === "object" && address !== null ? address.port : deps.port,
            };
            deps.onEvent({ type: "clear", name: "bind-failed" });
        });
    };

    return {
        /** Bind after the module's load returns: a timer, never during the load. */
        start(): void {
            if (!closed && timer === undefined && server === undefined) {
                timer = timers.set(bind, 0);
            }
        },
        status(): ListenerStatus {
            return { ...status };
        },
        /** Open sockets, requests in progress, and body bytes reserved now. */
        load(): { sockets: number; requests: number; reserved: number } {
            return { sockets: sockets.size, requests: inProgress, reserved };
        },
        /** Stop: cancel a retry, stop new connections, end idle sockets now, destroy the rest after the grace time. */
        close(): void {
            closed = true;
            status = { state: "closed" };

            if (timer !== undefined) {
                timers.clear(timer);
                timer = undefined;
            }

            const current = server;

            server = undefined;

            if (current === undefined) {
                return;
            }

            // It stops listening now: it leaves the set of listening servers at once.
            liveListeners().delete(current);
            current.close();
            current.closeIdleConnections();

            if (sockets.size > 0) {
                const open = [...sockets];
                const grace = timers.set(() => {
                    for (const socket of open) {
                        socket.destroy();
                    }
                }, limits.socketGraceMs);

                // A real timer must not keep the process alive for this.
                (grace as { unref?: () => void } | undefined)?.unref?.();
            }
        },
    };
}

// ─── The receiver's inbox and loop ───────────────────────────────────────────

/** The most jobs the receiver holds at once, the job whose commit runs included: then `receiver-busy`. */
export const INBOX_MAX = 16;

type InboxSlot = {
    job: DeliveryJob;
    resolve: (answer: ReceiverAnswer) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
};

/**
 * The receiver's inbox: at most `max` jobs, the active one included; a job over the bound gets `receiver-busy` at once.
 * A job whose signal aborts before `take` leaves the inbox and never commits. `take` makes a job active: from then on
 * its commit runs, and an abort changes nothing.
 */
export function createInbox(max = INBOX_MAX) {
    const queue: InboxSlot[] = [];
    let active: InboxSlot | undefined;
    let open = true;
    let wake: (() => void) | undefined;

    const detach = (slot: InboxSlot) => {
        if (slot.onAbort !== undefined) {
            slot.signal?.removeEventListener("abort", slot.onAbort);
        }
    };

    return {
        submit(job: DeliveryJob, options: { signal?: AbortSignal } = {}): Promise<ReceiverAnswer> {
            if (!open) {
                return Promise.resolve({ outcome: "receiver-gone" });
            }

            if (options.signal?.aborted === true) {
                return Promise.resolve({ outcome: "cancelled" });
            }

            if (queue.length + (active === undefined ? 0 : 1) >= max) {
                return Promise.resolve({ outcome: "receiver-busy" });
            }

            return new Promise<ReceiverAnswer>((resolve) => {
                const slot: InboxSlot = {
                    job,
                    resolve,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                };

                if (options.signal !== undefined) {
                    slot.onAbort = () => {
                        const index = queue.indexOf(slot);

                        if (index >= 0) {
                            queue.splice(index, 1);
                            resolve({ outcome: "cancelled" });
                        }
                    };

                    options.signal.addEventListener("abort", slot.onAbort, { once: true });
                }

                queue.push(slot);
                wake?.();
            });
        },
        /** The next job, now active: its commit starts, and it can no longer be cancelled. */
        take(): { job: DeliveryJob; resolve: (answer: ReceiverAnswer) => void } | undefined {
            const slot = queue.shift();

            if (slot === undefined) {
                return undefined;
            }

            detach(slot);
            active = slot;

            return {
                job: slot.job,
                resolve: (answer) => {
                    if (active === slot) {
                        active = undefined;
                    }

                    slot.resolve(answer);
                },
            };
        },
        /** Jobs held now: queued, plus the active one. */
        size(): number {
            return queue.length + (active === undefined ? 0 : 1);
        },
        /** Called once at the next submit. */
        onWake(run: (() => void) | undefined): void {
            wake = run;
        },
        /** Take no more jobs; answer each queued one `receiver-gone`. */
        close(): void {
            open = false;

            for (const slot of queue.splice(0)) {
                detach(slot);
                slot.resolve({ outcome: "receiver-gone" });
            }
        },
    };
}

export type Inbox = ReturnType<typeof createInbox>;

export type ReceiverLoopDeps = {
    inbox: Inbox;
    /** The clock of every deadline here. */
    now: () => number;
    tickMs: number;
    /** True once the module's version went or the task aborts. */
    stopped: () => boolean;
    /** Wait up to `ms`, or until a job, the dispose or the abort. */
    wait: (ms: number) => Promise<void>;
    /** The delivery commit; undefined when it failed. */
    deliver: (job: DeliveryJob) => Promise<ApplyResult | undefined>;
    /** After the answer: notices. */
    afterDelivery?: (job: DeliveryJob, result: ApplyResult) => void;
    /** The desk API object now, and whether it has `nudge`. */
    desk: () => unknown;
    hasNudge: (desk: unknown) => boolean;
    /** 1 commit that hands up to `NUDGE_BATCH` markers to `nudge`; the count it handed; it throws when `nudge` threw. */
    handOver: () => Promise<number>;
    /** Write the refusals and system alarms kept in memory. */
    flushMemory: () => Promise<void>;
    /** Evaluate the coverage alarm. */
    evaluate: () => Promise<void>;
};

/**
 * The receiver's loop: 1 job at a time, and after each job and at each tick the maintenance (the desk-change check, the
 * refusal flush every `min(REFUSAL_FLUSH_MS, 5 ticks)`, the coverage alarm every `COVERAGE_EVERY_MS`), so a busy inbox
 * never starves it. Every hand-over of markers obeys the back-off: after a `nudge` that threw, no try before
 * `NUDGE_RETRY_MS` passed.
 */
export function createReceiverLoop(deps: ReceiverLoopDeps) {
    let retryAt = 0;
    let lastDesk: unknown;
    let lastNudge = false;
    let refusalsAt = 0;
    let coverageAt = 0;

    /** Hand the pending markers to the desk, 500 at a time, unless the back-off holds. */
    const flushMarkers = async (): Promise<void> => {
        if (retryAt !== 0 && deps.now() < retryAt) {
            return;
        }

        for (let round = 0; round < 10; round += 1) {
            if (!deps.hasNudge(deps.desk())) {
                return;
            }

            let handed: number;

            try {
                handed = await deps.handOver();
            } catch {
                // The commit rolled back: the markers stay, and the next try waits.
                retryAt = deps.now() + NUDGE_RETRY_MS;

                return;
            }

            retryAt = 0;

            if (handed < NUDGE_BATCH) {
                return;
            }
        }
    };

    const maintain = async (): Promise<void> => {
        const now = deps.now();
        const desk = deps.desk();
        const hasNudge = deps.hasNudge(desk);

        if (
            (desk !== lastDesk && hasNudge) ||
            (hasNudge && !lastNudge) ||
            (retryAt !== 0 && now >= retryAt)
        ) {
            await flushMarkers();
        }

        lastDesk = desk;
        lastNudge = hasNudge;

        if (now - refusalsAt >= Math.min(REFUSAL_FLUSH_MS, deps.tickMs * 5)) {
            refusalsAt = now;
            await deps.flushMemory();
        }

        if (now - coverageAt >= COVERAGE_EVERY_MS) {
            coverageAt = now;

            try {
                await deps.evaluate();
            } catch {
                // The next evaluation tries again.
            }
        }
    };

    return {
        flushMarkers,
        /** When the next hand-over may run after a failure; 0 when none failed. */
        retryAt: () => retryAt,
        async run(): Promise<void> {
            lastDesk = deps.desk();
            lastNudge = deps.hasNudge(lastDesk);
            coverageAt = deps.now();

            if (deps.stopped()) {
                return;
            }

            await flushMarkers();
            await deps.flushMemory();
            refusalsAt = deps.now();

            while (!deps.stopped()) {
                const taken = deps.inbox.take();

                if (taken !== undefined) {
                    let result: ApplyResult | undefined;

                    try {
                        result = await deps.deliver(taken.job);
                    } catch {
                        result = undefined;
                    }

                    taken.resolve({ outcome: result?.outcome ?? "failed" });

                    if (result !== undefined) {
                        deps.afterDelivery?.(taken.job, result);

                        if (result.marker) {
                            await flushMarkers();
                        }
                    }

                    // After each job too: a busy inbox must not starve the maintenance.
                    await maintain();

                    continue;
                }

                await maintain();

                if (deps.stopped()) {
                    return;
                }

                await deps.wait(deps.tickMs);
            }
        },
    };
}

// ─── The module ──────────────────────────────────────────────────────────────

/** The live receiver of this process. */
const RECEIVER = Symbol.for("pi-pocket-team.github-hooks.receiver");
/** The newest loaded version of this module: `id`, and the waiters of a turned-off phase. */
const VERSION = Symbol.for("pi-pocket-team.github-hooks.version");
const DESK = Symbol.for("pi-pocket-team.desk");
/**
 * Test hooks, absent in production (nothing here sets them, and an absent slot changes nothing):
 * - `TEST_FAIL`: a function the delivery commit calls after its changes, inside the commit. A test makes it throw once
 *   to get a real failed commit (a rollback, and `500`).
 * - `PROBE`: counters a test reads instead of waiting for a time: `ticks` (receiver waits), `commits` (receiver commits),
 *   `parked` (phases now in the turn-off wait) and `parks` (turn-off waits entered).
 */
const TEST_FAIL = Symbol.for("pi-pocket-team.github-hooks.test-fail");
const PROBE = Symbol.for("pi-pocket-team.github-hooks.test");

export type HooksProbe = { ticks: number; commits: number; parked: number; parks: number };

const probe = (): HooksProbe | undefined => shared[PROBE] as HooksProbe | undefined;

type VersionSlot = { id: string; waiters: Set<() => void> };
type DeskApi = {
    nudge?: (tx: Tx, facts: NudgeFact[], now?: number) => Promise<unknown>;
};

const shared = globalThis as unknown as Record<symbol, unknown>;

export const receiverHandle = (): ReceiverHandle | undefined =>
    shared[RECEIVER] as ReceiverHandle | undefined;

const deskApi = (): DeskApi | undefined => shared[DESK] as DeskApi | undefined;

const envNumber = (name: string): number | undefined => {
    const text = process.env[name];
    const value = text === undefined || text === "" ? Number.NaN : Number(text);

    return Number.isFinite(value) && value >= 0 ? value : undefined;
};

type ReceiverInput = Record<string, never>;
type ReceiverCheckpoint = { phase: "receive"; generation: number };
type Runtime = TaskRuntime<ReceiverInput, ReceiverCheckpoint, null, object>;

export default function createGithubHooks(host: Host, web: Web) {
    // This version's id: a disposed phase of an older version ends only when a newer one is live.
    const versionId = randomUUID();
    const slot = (shared[VERSION] ??= { id: versionId, waiters: new Set() }) as VersionSlot;

    slot.id = versionId;

    for (const wake of [...slot.waiters]) {
        wake();
    }

    let disposed = false;
    /** The version id a disposed phase of this version last handed the task to. */
    let handedTo: string | undefined;
    const disposeWaiters = new Set<() => void>();
    const tickMs = envNumber("PI_POCKET_GITHUB_HOOKS_TICK_MS") ?? TICK_MS;

    // ── Settings and the allowed peers ──
    const hasSettings = typeof web.settings === "function";

    if (hasSettings) {
        web.settings([
            {
                name: "allowFrom",
                label: "Allowed peers",
                description:
                    "A comma list of IP addresses that may connect to port 8790 (caddy's address). Empty: nobody.",
                type: "text",
                default: DEFAULT_ALLOW_FROM,
            },
        ]);
    }

    const readAllowFrom = (): Set<string> => {
        const fromEnv = process.env.PI_POCKET_GITHUB_HOOKS_ALLOW_FROM;

        if (fromEnv !== undefined) {
            return parseAllowFrom(fromEnv);
        }

        const value = hasSettings ? web.setting("allowFrom") : undefined;

        return parseAllowFrom(typeof value === "string" ? value : DEFAULT_ALLOW_FROM);
    };

    let allowFrom = readAllowFrom();

    if (hasSettings && typeof web.onSettings === "function") {
        web.onDispose(
            web.onSettings(() => {
                allowFrom = readAllowFrom();
            }),
        );
    }

    // ── Notices and the in-memory events ──
    const noticed = new Set<string>();

    const noticeOnce = (key: string, level: "info" | "warning" | "error", message: string) => {
        if (!noticed.has(key)) {
            noticed.add(key);
            host.notice(level, message);
        }
    };

    /** Refusals and system alarms raised outside a commit, until the receiver writes them. */
    const memory = {
        refusals: [] as DeliveryEntry[],
        dropped: 0,
        /** `unwritten`: a raise that no flush wrote yet, kept when a clear follows it before the flush. */
        system: {} as Partial<
            Record<SystemAlarm, { raised: boolean; at: number; dirty: boolean; unwritten?: number }>
        >,
    };

    const raiseInMemory = (name: SystemAlarm, message: string) => {
        const known = memory.system[name];

        if (known?.raised === true) {
            return;
        }

        memory.system[name] = { raised: true, at: Date.now(), dirty: true };
        host.notice(name === "seen-full" ? "warning" : "error", message);
    };

    const clearInMemory = (name: SystemAlarm) => {
        const known = memory.system[name];

        if (known !== undefined && !known.raised) {
            return;
        }

        memory.system[name] = {
            raised: false,
            at: Date.now(),
            dirty: true,
            ...(known?.raised === true && known.dirty ? { unwritten: known.at } : {}),
        };
    };

    // ── The secret ──
    const secretDir =
        process.env.PI_POCKET_GITHUB_HOOKS_SECRET_DIR ??
        join(homedir(), ".config", "pi-pocket-team");
    const secrets = createSecretSource(secretDir, {
        hide: (value) =>
            typeof host.hide === "function"
                ? host.hide({ value, label: "github webhook secret" })
                : () => {},
        warn: (message) => host.notice("warning", message),
    });
    let lastSecret: SecretState | undefined;

    // ── The listener ──
    const listener = createHookListener({
        port: envNumber("PI_POCKET_GITHUB_HOOKS_PORT") ?? HOOKS_PORT,
        host: process.env.PI_POCKET_GITHUB_HOOKS_HOST ?? HOOKS_HOST,
        allowFrom: () => allowFrom,
        secrets: async () => {
            lastSecret = await secrets.read();

            return lastSecret;
        },
        receiver: receiverHandle,
        now: Date.now,
        log: (line) => console.log(line),
        onEvent: (event) => {
            if (event.type === "refusal") {
                memory.refusals.push(event.entry);

                if (memory.refusals.length > REFUSALS_MAX) {
                    memory.refusals.shift();
                    memory.dropped += 1;
                }
            } else if (event.type === "raise") {
                raiseInMemory(event.name, event.message);
            } else {
                clearInMemory(event.name);
            }
        },
        limits: {
            ...(envNumber("PI_POCKET_GITHUB_HOOKS_BIND_RETRY_MS") === undefined
                ? {}
                : { bindRetryMs: envNumber("PI_POCKET_GITHUB_HOOKS_BIND_RETRY_MS")! }),
        },
    });

    // After the load returns: a reloaded module starts before the old version's cleanups free the port.
    listener.start();

    web.onDispose(() => {
        disposed = true;
        listener.close();
        secrets.dispose();

        for (const wake of [...disposeWaiters]) {
            wake();
        }
    });

    // ── The receiver task ──

    /** Write the in-memory refusals and system alarm changes. */
    const flushMemory = async (runtime: Runtime, context: Context): Promise<void> => {
        const refusals = memory.refusals.splice(0);
        const dropped = memory.dropped;
        const system = Object.entries(memory.system).filter(([, each]) => each.dirty);

        if (refusals.length === 0 && dropped === 0 && system.length === 0) {
            return;
        }

        memory.dropped = 0;

        for (const [, each] of system) {
            each.dirty = false;
        }

        const unwritten = system.map(([, each]) => each.unwritten);

        for (const [, each] of system) {
            delete each.unwritten;
        }

        try {
            await runtime.commit(async (tx) => {
                const deliveries = await tx.doc(DeliveriesDoc);

                recordEntries(deliveries, refusals);
                deliveries.dropped += dropped;

                if (system.length > 0) {
                    const alarms = await tx.doc(AlarmsDoc);

                    for (const [index, [name, each]] of system.entries()) {
                        if (each.raised) {
                            raiseSystem(alarms, name as SystemAlarm, each.at);
                        } else {
                            const raisedAt = unwritten[index];

                            if (raisedAt !== undefined) {
                                raiseSystem(alarms, name as SystemAlarm, raisedAt);
                            }

                            clearSystem(alarms, name as SystemAlarm, each.at);
                        }
                    }
                }

                return undefined;
            }, context);
        } catch {
            // Put them back: the next flush tries again.
            memory.refusals.unshift(...refusals);
            memory.dropped += dropped;

            system.forEach(([, each], index) => {
                each.dirty = true;

                if (unwritten[index] !== undefined) {
                    each.unwritten = unwritten[index];
                }
            });
        }
    };

    /** 1 commit: up to 500 markers to `nudge`, deleted in the same commit. Throws when `nudge` threw (a rollback). */
    const handOver = async (runtime: Runtime, context: Context): Promise<number> => {
        const desk = deskApi();
        let handed = 0;

        if (typeof desk?.nudge !== "function") {
            return 0;
        }

        await runtime.commit(async (tx) => {
            const pending = await tx.doc(PendingDoc);
            const ids = Object.keys(pending.markers).slice(0, NUDGE_BATCH);

            if (ids.length === 0) {
                return undefined;
            }

            const facts = ids.map(
                (id) => JSON.parse(JSON.stringify(pending.markers[id]!.fact)) as NudgeFact,
            );

            await desk.nudge!(tx, facts, runtime.now());

            for (const id of ids) {
                delete pending.markers[id];
            }

            handed = ids.length;

            return undefined;
        }, context);

        return handed;
    };

    let observedFailed = false;

    /** Evaluate the coverage alarm, and give 1 warning for each alarm it raised. */
    const evaluate = async (runtime: Runtime, context: Context): Promise<void> => {
        let observed: ObservedState | undefined;

        try {
            observed = (await runtime.snapshot(ObservedRead, context)) as ObservedState | undefined;
        } catch {
            if (!observedFailed) {
                observedFailed = true;
                host.notice(
                    "warning",
                    "github-hooks: x.desk.observed could not be read; the coverage alarm waits.",
                );
            }

            return;
        }

        if (observed === undefined) {
            return;
        }

        let raised: string[] = [];

        await runtime.commit(async (tx) => {
            raised = evaluateCoverage(
                observed,
                await tx.doc(CoverageDoc),
                await tx.doc(AlarmsDoc),
                runtime.now(),
                await tx.doc(DeliveriesDoc),
            );

            return undefined;
        }, context);

        for (const key of raised) {
            const [repo, change] = key.split("|");

            host.notice(
                "warning",
                `github-hooks: the desk saw 2 changes of class ${change ?? "?"} on ${repo ?? "?"} in 24 hours with no matching webhook delivery.`,
            );
        }
    };

    const Receiver = defineTask<ReceiverInput, ReceiverCheckpoint, null>({
        name: "x.github-hooks.receiver",
        version: 1,
        initial: () => ({ phase: "receive", generation: 0 }),
        phases: {
            receive: async (task, original, context) => {
                // Every commit of this phase counts in the test probe, when a test set one.
                const runtime = new Proxy(original, {
                    get(target, property) {
                        if (property === "commit") {
                            return (...args: Parameters<Runtime["commit"]>) => {
                                const counters = probe();

                                if (counters !== undefined) {
                                    counters.commits += 1;
                                }

                                return target.commit(...args);
                            };
                        }

                        const value = Reflect.get(target, property, target) as unknown;

                        return typeof value === "function" ? value.bind(target) : value;
                    },
                }) as Runtime;
                const generation = task.state.checkpoint.generation;
                const taskId = String(runtime.taskId);
                const signal = runtime.signal;
                const record = await runtime.snapshot(ReceiverDoc, context);

                // Another task is the receiver of record: this one ends.
                if (record?.task !== undefined && record.task !== taskId) {
                    await runtime.commit(
                        () => ({
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        }),
                        context,
                    );

                    return;
                }

                const inbox = createInbox();
                const handle: ReceiverHandle = {
                    taskId,
                    submit: (job, options) => inbox.submit(job, options),
                };

                if (!disposed) {
                    shared[RECEIVER] = handle;
                    clearInMemory("receiver-missing");
                }

                const loop = createReceiverLoop({
                    inbox,
                    now: () => runtime.now(),
                    tickMs,
                    stopped: () => disposed || signal.aborted,
                    // Wait for a job, the tick, the dispose, or the abort.
                    wait: (ms) =>
                        new Promise<void>((resolve) => {
                            let disarm = () => {};

                            const done = () => {
                                inbox.onWake(undefined);
                                disposeWaiters.delete(done);
                                signal.removeEventListener("abort", done);
                                disarm();
                                resolve();
                            };

                            inbox.onWake(done);
                            disposeWaiters.add(done);
                            signal.addEventListener("abort", done, { once: true });
                            disarm = runtime.setTimer(done, ms);

                            const counters = probe();

                            if (counters !== undefined) {
                                counters.ticks += 1;
                            }

                            if (inbox.size() > 0 || disposed || signal.aborted) {
                                done();
                            }
                        }),
                    deliver: async (job) => {
                        let result: ApplyResult | undefined;
                        const nudge = typeof deskApi()?.nudge === "function";

                        try {
                            await runtime.commit(async (tx) => {
                                result = applyDelivery(
                                    {
                                        seen: await tx.doc(SeenDoc),
                                        deliveries: await tx.doc(DeliveriesDoc),
                                        pending: await tx.doc(PendingDoc),
                                        alarms: await tx.doc(AlarmsDoc),
                                        coverage: await tx.doc(CoverageDoc),
                                    },
                                    job,
                                    runtime.now(),
                                    { nudge },
                                );

                                // A test hook only (see `TEST_FAIL`): a throw here rolls the whole commit back.
                                const fail = shared[TEST_FAIL];

                                if (typeof fail === "function") {
                                    (fail as (job: DeliveryJob) => void)(job);
                                }

                                return undefined;
                            }, context);
                        } catch {
                            return undefined;
                        }

                        if (
                            result !== undefined &&
                            result.outcome === "accepted" &&
                            !nudge &&
                            toNudgeFact(job.fact) !== undefined
                        ) {
                            noticeOnce(
                                "desk",
                                "info",
                                "github-hooks: the desk is off or has no nudge: facts are recorded, and the desk gets none.",
                            );
                        }

                        return result;
                    },
                    afterDelivery: (_job, result) => {
                        if (result.raised.includes("seen-full")) {
                            memory.system["seen-full"] = {
                                raised: true,
                                at: Date.now(),
                                dirty: false,
                            };
                            host.notice(
                                "warning",
                                "github-hooks: the dedupe set is full (20000 deliveries in 72 hours): deliveries get 503.",
                            );
                        }

                        if (result.cleared.includes("seen-full")) {
                            memory.system["seen-full"] = {
                                raised: false,
                                at: Date.now(),
                                dirty: false,
                            };
                        }
                    },
                    desk: deskApi,
                    hasNudge: (desk) => typeof (desk as DeskApi | undefined)?.nudge === "function",
                    handOver: () => handOver(runtime, context),
                    flushMemory: () => flushMemory(runtime, context),
                    evaluate: () => evaluate(runtime, context),
                });

                try {
                    await loop.run();
                } finally {
                    inbox.close();

                    if (shared[RECEIVER] === handle) {
                        delete shared[RECEIVER];
                    }
                }

                signal.throwIfAborted();

                // Disposed. A turn-off leaves this version's own id in the slot: no newer version is live, so a phase that
                // ended now would run again at once on this code (Pi Durable keeps a running task on its old definition).
                // Wait in memory, with no commit, until the module is on again or the server restarts. `handedTo`: a load
                // that failed after it set its id leaves that id with no live version; a phase that runs again here after
                // a handover to it waits for another id, so it never commits in a loop.
                const blocked = () => slot.id === versionId || slot.id === handedTo;

                if (blocked()) {
                    const counters = probe();

                    if (counters !== undefined) {
                        counters.parked += 1;
                        counters.parks += 1;
                    }

                    await new Promise<void>((resolve) => {
                        const done = () => {
                            slot.waiters.delete(done);
                            signal.removeEventListener("abort", done);

                            if (counters !== undefined) {
                                counters.parked -= 1;
                            }

                            resolve();
                        };

                        slot.waiters.add(done);
                        signal.addEventListener("abort", done, { once: true });

                        if (!blocked() || signal.aborted) {
                            done();
                        }
                    });
                    signal.throwIfAborted();
                }

                handedTo = slot.id;

                // A newer version is live: end the phase; the next invocation runs its code.
                await runtime.commit(
                    () => ({
                        status: "running",
                        checkpoint: { phase: "receive", generation: generation + 1 },
                    }),
                    context,
                );
            },
        },
        abort: async (_task, runtime, context) => {
            const handle = receiverHandle();

            if (handle?.taskId === String(runtime.taskId)) {
                delete shared[RECEIVER];
            }

            await runtime.commit(async (tx) => {
                const record = await tx.doc(ReceiverDoc);

                if (record.task === String(runtime.taskId)) {
                    delete record.task;
                    delete record.conversation;
                    delete record.started;
                }

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context);
        },
    });

    // ── The command ──

    const liveReceivers = async (tx: Tx) => {
        const live: { id: string; conversation: string }[] = [];
        let cursor: Parameters<Tx["scanTasks"]>[2];

        for (;;) {
            const page = await tx.scanTasks({ kind: "x.github-hooks.receiver" }, 100, cursor);

            for (const item of page.items) {
                if (item.state.status !== "terminal") {
                    live.push({ id: String(item.id), conversation: String(item.conversationId) });
                }
            }

            if (page.next === undefined || page.items.length === 0) {
                return live;
            }

            cursor = page.next;
        }
    };

    const statusCard = async (ctx: {
        snapshot: (token: never, context: Context) => Promise<unknown>;
        context: Context;
    }): Promise<string> => {
        const snap = async <T>(token: unknown) =>
            (await ctx.snapshot(token as never, ctx.context)) as T | undefined;
        const deliveries = await snap<DeliveriesState>(DeliveriesDoc);
        const pending = await snap<PendingState>(PendingDoc);
        const alarms = await snap<AlarmsState>(AlarmsDoc);
        const receiver = await snap<ReceiverState>(ReceiverDoc);
        const listening = listener.status();
        const secret = lastSecret ?? (await secrets.read());
        const live = receiverHandle();
        const lines = [
            "GitHub hooks",
            `Listener: ${listening.state === "bound" ? `bound on port ${String(listening.port)}` : listening.state}`,
            `Receiver: ${
                receiver?.task === undefined
                    ? "none (run /github-hooks start)"
                    : `task ${receiver.task} in session ${receiver.conversation ?? "?"}${live?.taskId === receiver.task ? ", running" : ", not running now"}`
            }`,
            `Secret: ${secret.status}${secret.next ? " (next: present)" : " (next: none)"}`,
            `Deliveries: ${
                Object.entries(deliveries?.counts ?? {})
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([outcome, count]) => `${outcome} ${String(count)}`)
                    .join(", ") || "none"
            }`,
            `Last accepted: ${deliveries?.last === undefined ? "never" : new Date(deliveries.last).toISOString()}`,
            `Pending markers: ${String(Object.keys(pending?.markers ?? {}).length)}`,
        ];
        const raised = [
            ...Object.entries(alarms?.system ?? {})
                .filter(([, alarm]) => raisedNow(alarm))
                .map(([name]) => name),
            ...Object.entries(alarms?.coverage ?? {})
                .filter(([, alarm]) => raisedNow(alarm))
                .map(([key]) => `coverage ${key.replace("|", " ")}`),
        ];

        lines.push(`Alarms: ${raised.length === 0 ? "none" : raised.join(", ")}`);

        return lines.join("\n");
    };

    web.command("github-hooks", {
        description: "GitHub webhooks: status, or start the receiver once",
        args: "[status|start]",
        scope: "global",
        handler: async (args, ctx) => {
            if (ctx.user.role !== "owner") {
                return {
                    type: "toast",
                    level: "error",
                    message: "Only the owner runs /github-hooks.",
                };
            }

            const word = args.trim().toLowerCase() || "status";

            if (word === "start") {
                const started = await ctx.commit(async (tx) => {
                    const live = await liveReceivers(tx);

                    if (live.length > 0) {
                        return { refused: live[0]!, task: undefined };
                    }

                    const task = await tx.createTask(
                        Receiver,
                        {},
                        {
                            ownership: { kind: "conversation" },
                            conversationId: ctx.conversationId,
                            background: true,
                            abandonOnRestart: false,
                        },
                    );
                    const record = await tx.doc(ReceiverDoc);

                    record.task = String(task);
                    record.conversation = String(ctx.conversationId);
                    record.started = Date.now();

                    return { refused: undefined, task: String(task) };
                });

                if (started.refused !== undefined) {
                    return {
                        type: "toast",
                        level: "error",
                        message: `A receiver runs already: task ${started.refused.id} in session ${started.refused.conversation}.`,
                    };
                }

                return {
                    type: "toast",
                    level: "info",
                    message: `The receiver started: task ${started.task}.`,
                };
            }

            if (word !== "status") {
                return {
                    type: "toast",
                    level: "error",
                    message: "Use /github-hooks status or /github-hooks start.",
                };
            }

            return {
                type: "card",
                output: await statusCard({
                    snapshot: (token, context) => ctx.snapshot(token, context),
                    context: ctx.context,
                }),
            };
        },
    });

    return defineExtension({ name: "github-hooks", tasks: [Receiver] });
}
