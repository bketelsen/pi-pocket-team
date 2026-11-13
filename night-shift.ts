/**
 * Shift: Pi works on an objective in rounds while the people are away, and stops when it says the stop condition holds
 * (and an optional check command passes), at a round limit, at a deadline, when a person writes, at Stop, or at a
 * spend limit. Then it writes a summary for the morning. Start one with /team-shift.
 *
 * How it works. Pocket's own "Done when" (src/server/goals.ts) drives its rounds from an `onYield` hook. A drop-in's
 * hook gets only reads and memos (no commits), and a command cannot start Pi, so this module drives its rounds from a
 * durable task instead, as Pocket's schedules and subagent reporters do: the task sends each round as a message, waits
 * for Pi's answer, reads its STATUS line, runs the check, and decides. Every step is a checkpoint:
 *
 * - A round's message has a request id made of the goal, the round, and the attempt, so a restart that sends it again
 *   finds the first one: one answer never starts two rounds.
 * - The round count goes up in the same commit that moves the task on to send that round.
 * - A check is behind two memos, as in goals.ts: one set before it runs, one with its result. A restart that finds the
 *   first without the second does not run it again; the round says it was cut off.
 * - A `start` time is a restart-safe wait in the task's `wait` phase, before round 1: a restart sleeps again until the
 *   stored start, and a server that was down past it starts round 1 at once. Round 1 starts only in `decide`.
 * - After round 1, `decide` waits while Pi waits for work that will wake it: while Pi runs in the session (a subagent's
 *   report or a background command's end started a run), while its own subagents still work (`pocket.subagents`), and
 *   while a background command that will tell Pi it ended still runs, or is still to tell it (`pocket.background`). A
 *   round sent then would only hear "still waiting". A PR watch does not hold a round: it can last for weeks. One poll
 *   is a restart-safe wait (it ends early when Pi's run ends), and a memo keyed by the round holds the wait's start, so
 *   a restart waits for the rest of the same hour and no round is counted meanwhile.
 *
 * State is one document per conversation, `x.night-shift.goal`. It is stored data: never rename it or change what a
 * field means.
 *
 * The same check failure `SAME_FAILURES` times in a row (by `checkFingerprint`) stops a goal as `blocked`, with a
 * detail: no new stop reason, because the reason is stored data.
 *
 * Names. The user-facing name is "shift": the command `/team-shift` (Pi Pocket requires a `-` in an extension command
 * name), the `team_delegate` argument `shift`, and the round prefix `[shift]`. The goal runs at any hour, not only at
 * night. The file, the folder `night-shift-web/`, the module name `night-shift`, the global symbol
 * `pi-pocket-team.night-shift`, the document kind `x.night-shift.goal`, the task name `x.night-shift.driver`, the
 * request ids and keys `x.night-shift.*` and `p:…:x-night-shift-…`, and the report value `from: "night-shift"` keep the
 * old name "night-shift": they are stored data or live identity. A new module name is a new module in Pi Pocket: it
 * must be turned on again, and a running goal's driver would lose its module. `/night-shift` and `night_shift` stay as
 * aliases, and the readers of the round prefix accept the old `[night-shift]` too, because old entries hold it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    type ConversationId,
    defineDoc,
    defineExtension,
    defineTask,
    type DocumentReader,
    type EntryId,
    InboxDoc,
    LiveDoc,
    section,
    type SettledSubmissionRecord,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import type { Command, CommandContext, Host, Web } from "./_pocket.d.ts";

/** Keep linked-session sends as follow-up work on Pi Pocket 0.28, as they were on 0.27. */
export async function linkedSend(
    host: Host,
    source: ConversationId,
    request: { to: string; message: string },
    key: string,
): Promise<void> {
    const compatible = { ...request, steer: false };

    await host.linkedSessions.send(source, compatible, key);
}

// ─── Watch compatibility ─────────────────────────────────────────────────────

/**
 * Pi Durable 1.5 watch listeners receive `{ kind: "value", value, ops, retired }` calls. Older releases give the
 * plain document value. A failed call carries no document value, so it stays open and this listener does nothing.
 */
export function watchDocumentValue<T>(argument: unknown): T | null | undefined {
    if (typeof argument === "object" && argument !== null) {
        const call = argument as {
            kind?: unknown;
            value?: unknown;
            ops?: unknown;
            retired?: unknown;
        };

        if (call.kind === "failed") {
            return undefined;
        }

        if (
            call.kind === "value" &&
            Object.prototype.hasOwnProperty.call(call, "ops") &&
            Object.prototype.hasOwnProperty.call(call, "retired")
        ) {
            return call.value as T | null;
        }
    }

    return argument as T | null;
}

// ─── Limits ──────────────────────────────────────────────────────────────────

export const DEFAULT_ROUNDS = 20;
export const MAX_ROUNDS = 100;
export const SAME_FAILURES = 3;
/** The longest a deadline can be from now. */
const MAX_HOURS = 24;
const MAX_COMMAND = 2000;

/**
 * The longest shift text: the objective and the stop condition together, each trimmed. The desk's goal board reads it
 * as `textLimit` on the API, so it refuses a row over it at add, edit and pick.
 */
export const SHIFT_TEXT_LIMIT = 3000;
/** How long a check may run. */
const CHECK_TIMEOUT_SECONDS = 600;
/** How much of a failing check's output Pi gets: its end, where the failures usually are. */
const TAIL_CHARS = 3000;
/** Rounds kept in the document, newest last. */
const KEPT_ROUNDS = 30;
/** How many times a round is sent again after the session dropped it (a run before it failed). */
const MAX_ATTEMPTS = 3;
/** How long an ended goal still shows in the status line. */
const SHOW_ENDED_MS = 12 * 3600_000;
/** How long the report to a delegated goal's supervisor session may be. */
const MAX_REPORT = 8000;

/** How often `decide` looks again while Pi waits for work: its run, its subagents, a background command. */
export const SUBAGENT_POLL_MS = 15_000;
/** The longest `decide` waits for that work before one round: after it, the round goes anyway. */
export const SUBAGENT_WAIT_MS = 60 * 60_000;

const PREFIX = "[shift]";
/** The first line of each answer of `/night-shift`, the old name of `/team-shift`. */
const RENAMED = "`/night-shift` is now `/team-shift`.";
/** Where another module finds this one's live API: a global, never an import. */
const API = Symbol.for("pi-pocket-team.night-shift");
/** Where this module finds the desk's live API: a global, never an import. */
const DESK_API = Symbol.for("pi-pocket-team.desk");

// ─── Stored state ────────────────────────────────────────────────────────────

/** Why a goal stopped or paused. */
export type StopReason =
    | "done"
    | "max-rounds"
    | "deadline"
    | "blocked"
    | "person"
    | "plan"
    | "stopped"
    | "spend"
    | "failed";

export type Verdict = "done" | "continue" | "blocked" | "none";

export type CheckResult = { passed: boolean; code: number; tail: string; cutOff?: true };

export type RoundRecord = {
    n: number;
    verdict: Verdict;
    reason: string;
    at: number;
    check?: CheckResult;
    /** The provider/model that executed this round's subagents, when the goal set one. */
    worker?: string;
};

/** The thinking levels a goal's `workerThinking` may hold. */
export const WORKER_THINKING: readonly string[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/** A short, stable summary of a failed check. Times and transient output do not make separate failures. */
export function checkFingerprint(check: CheckResult | undefined): string | undefined {
    if (check === undefined || check.passed || check.cutOff) {
        return undefined;
    }

    const ghRows = check.tail
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => {
            if (parts.length < 4) {
                return false;
            }

            return ["pass", "fail", "pending", "skipping", "cancel"].includes(parts[1]?.trim());
        });

    if (ghRows.length > 0) {
        const failed = ghRows.filter((parts) => ["fail", "cancel"].includes(parts[1]?.trim()));

        if (failed.length > 0) {
            const names = new Set(
                failed
                    .map((parts) => parts[0]?.trim())
                    .filter((name): name is string => name !== undefined && name !== ""),
            );

            return names.size === 0
                ? undefined
                : `checks failed: ${JSON.stringify([...names].sort())}`;
        }

        if (ghRows.some((parts) => parts[1]?.trim() === "pending")) {
            return undefined;
        }
    }

    // Simple normalization: remove timestamps and times, durations, hex ids, and other digit runs.
    const lines = check.tail
        .split("\n")
        .map((line) =>
            line
                .replace(
                    /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi,
                    "",
                )
                .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?\b/g, "")
                .replace(/\b(?:\d+(?:\.\d+)?(?:ms|h|m|s))+\b/gi, "#")
                // A hex id after a word that names one (`commit abcdef1`, `sha=…`), whatever its digits; elsewhere only
                // with 2 digits or more, so a word such as `defaced` stays.
                .replace(
                    /\b(commit|sha|head|ref|rev|revision|oid|hash|id)(\s*[:=#@]?\s*)[0-9a-f]{7,64}\b/gi,
                    "$1$2#",
                )
                .replace(/\b(?=(?:[a-f]*\d){2})[0-9a-f]{7,}\b/gi, "#")
                .replace(/\d+/g, "#")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter((line) => line !== "")
        .slice(-10);

    return `exit ${check.code}: ${lines.join(" / ")}`;
}

/** A failing `gh pr checks` row: the check's name, and its repository, run and job when its URL names them. */
export type FailedCheck = { name: string; repo?: string; run?: number; job?: number };

const MAX_FAILED_CHECKS = 20;
const MAX_CHECK_NAME = 200;
const JOB_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)\/job\/(\d+)/;

/**
 * The failing (`fail` or `cancel`) rows of a check's `gh pr checks` output, read as `checkFingerprint` reads them. `[]`
 * for no check, a passing or cut-off check, or a check with no gh rows.
 */
export function failedChecks(check: CheckResult | undefined): FailedCheck[] {
    if (check === undefined || check.passed || check.cutOff) {
        return [];
    }

    const found = new Map<string, FailedCheck>();

    for (const line of check.tail.split("\n")) {
        const parts = line.split("\t");

        if (parts.length < 4) {
            continue;
        }

        const state = parts[1]?.trim();

        // Of the gh states (pass, fail, pending, skipping, cancel), only the failing ones.
        if (state !== "fail" && state !== "cancel") {
            continue;
        }

        const name = (parts[0] ?? "").trim().slice(0, MAX_CHECK_NAME);

        if (name === "") {
            continue;
        }

        const entry: FailedCheck = { name };
        const url = JOB_URL.exec((parts[3] ?? "").trim());

        if (url !== null) {
            const run = Number(url[2]);
            const job = Number(url[3]);

            entry.repo = url[1];

            if (Number.isSafeInteger(run)) {
                entry.run = run;
            }

            if (Number.isSafeInteger(job)) {
                entry.job = job;
            }
        }

        found.set(JSON.stringify([entry.name, entry.repo, entry.run, entry.job]), entry);
    }

    return [...found.values()]
        .sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : (a.job ?? -1) - (b.job ?? -1),
        )
        .slice(0, MAX_FAILED_CHECKS);
}

export type FailureStreak = { fingerprint: string; count: number; round: number };

/** Update a goal's streak without changing it for a replay or a cut-off check. */
export function nextFailures(
    previous: FailureStreak | undefined,
    check: CheckResult,
    n: number,
): FailureStreak | undefined {
    if (check.cutOff) {
        return previous;
    }

    if (check.passed) {
        return undefined;
    }

    const fingerprint = checkFingerprint(check);

    if (fingerprint === undefined) {
        return undefined;
    }

    if (previous?.round === n) {
        return previous;
    }

    if (previous?.fingerprint === fingerprint) {
        return { fingerprint, count: previous.count + 1, round: n };
    }

    return { fingerprint, count: 1, round: n };
}

export type Goal = {
    id: string;
    objective: string;
    stop: string;
    check?: string;
    maxRounds: number;
    /** Epoch ms. */
    deadline?: number;
    /** The deadline as the person reads it, such as "07:00 EDT". */
    deadlineLabel?: string;
    /** Epoch ms: round 1 waits until then. Without it, round 1 starts at once. */
    start?: number;
    /** The start as the person reads it, such as "06:00 EDT". */
    startLabel?: string;
    /** Why round 1 waits: DeepSeek's peak hours, unless the person gave a start. */
    startWhy?: "deepseek-peak";
    /** The provider/model that executes the work in subagents. */
    worker?: string;
    /**
     * The thinking level of the worker's subagents, set only with `worker`, and only by `team_delegate` when the model
     * router assigned the worker (its tested configuration). Added later; stored data. Absent: the spawn names none.
     */
    workerThinking?: string;
    by: string;
    byName: string;
    setAt: number;
    /** `summary`: stopped, and Pi writes the summary for the morning. `paused` and `ended` can resume. */
    status: "running" | "summary" | "paused" | "ended";
    reason?: StopReason;
    /** Why it stopped, in words. */
    why?: string;
    /** Rounds started. */
    round: number;
    /** The newest entry looked at for people's messages. */
    seen: number;
    rounds: RoundRecord[];
    /**
     * The run of the same failed check (`nextFailures`), kept here because `rounds` keeps only the newest 30. Added
     * later: an older goal has none, and starts a new run. Absent: no run.
     */
    failures?: FailureStreak;
    /**
     * Set only when the same check failure stops the goal (`SAME_FAILURES`): the failing `gh pr checks` rows of the last
     * check (`failedChecks`). Absent for a check with no gh rows, and removed on resume. Added later; stored data.
     */
    stopChecks?: FailedCheck[];
    /** The task that drives the goal now; another task that finds this changed stops. */
    driver?: string;
    endedAt?: number;
    /**
     * Set by `team_delegate`: the goal belongs to a linked session, and when it stops the driver reports to the
     * source session of that linked session. `address` (added later; absent in older goals) is that source session's
     * address, from the linked session's first message, when the goal was set: the round names it for questions.
     */
    delegated?: { supervisor: string; address?: string };
};

export const GoalDoc = defineDoc<{ goal?: Goal }>({
    kind: "x.night-shift.goal",
    version: 1,
    checkpointWhen: () => false,
    scope: "conversation",
    history: "latest",
    // A fork is a new start: it does not take the goal.
    fork: "initial",
    initial: () => ({}),
});

/**
 * Pocket's plan mode, read only. It is Pocket's own document, not public API: when its shape changes, reading it
 * fails, and the goal then relies on Pi to say BLOCKED in plan mode, as the prompt section asks.
 */
const PlanMode = defineDoc<{ on: boolean }>({
    kind: "pocket.plan",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    // The same as Pocket's own base, `rebased` in src/server/docs.ts: not part of the stored meaning.
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => ({ on: false }),
});

/**
 * Pocket's subagents of this conversation, read only: the ones Pi spawned, and their reports on the way to it. It is
 * Pocket's own document, not public API: when its shape changes, reading it fails, and the driver then does not wait
 * for the subagents (a round goes at once, as before). Never write it.
 */
const SubagentsDoc = defineDoc<{
    agents: Record<string, { conversationId: ConversationId }>;
    /** Pocket's reporter task for each message; not read here, but part of the document's shape. */
    reporters: Record<string, string>;
    /** Reports not yet sent to the parent. */
    outbox?: { name: string; text: string }[];
    /** The batch on its way to the parent. */
    sending?: { request: string };
}>({
    kind: "pocket.subagents",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    // The same as Pocket's own base, `rebased` in src/server/docs.ts: not part of the stored meaning.
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => ({ agents: {}, reporters: {} }),
});

/** The fields of one of Pocket's background commands that say whether Pi still hears of it. */
export type BackgroundItem = {
    status: "starting" | "running" | "exited" | "stopped" | "lost";
    notify: boolean;
    untold?: true;
};

/**
 * Pocket's background commands of this conversation (`background.ts`), read only. It is Pocket's own document, not
 * public API: when its shape changes, reading it fails, and the driver then does not wait for them. Never write it.
 */
const BackgroundDoc = defineDoc<{ items: Record<string, BackgroundItem> }>({
    kind: "pocket.background",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    // The same as Pocket's own base, `rebased` in src/server/docs.ts: not part of the stored meaning.
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: () => ({ items: {} }),
});

/**
 * Whether a background command will still wake Pi: it runs (or starts) and tells Pi when it ends (`notify`), or it
 * ended and Pi is still to be told (`untold`). One that Pi stopped itself (`notify: false`) wakes nobody.
 */
export function backgroundWakes(item: BackgroundItem): boolean {
    return (
        item.untold === true ||
        (item.notify === true && (item.status === "starting" || item.status === "running"))
    );
}

// ─── Parsing what people type ────────────────────────────────────────────────

export type GoalRequest = {
    objective: string;
    stop: string;
    check?: string;
    maxRounds: number;
    deadline?: number;
    deadlineLabel?: string;
    /** Epoch ms: round 1 waits until then. */
    start?: number;
    /** The start as the person reads it, such as "06:00 EDT". */
    startLabel?: string;
    /** Why round 1 waits: DeepSeek's peak hours, unless the person gave a start. */
    startWhy?: "deepseek-peak";
    /** The provider/model that executes the work in subagents. */
    worker?: string;
    /** The thinking level of the worker's subagents: only with `worker`, only from `team_delegate` (router v4). */
    workerThinking?: string;
};

export type Parsed =
    | { kind: "status" | "stop" | "resume" | "help" }
    | { kind: "set"; goal: GoalRequest }
    | { kind: "error"; message: string };

export const USAGE =
    "/team-shift [start 06:00] [until 07:00 | for 8h] [max 30] [with provider/model] [check `npm test`]: <objective>; stop when <condition>\n" +
    "/team-shift status | stop | resume";

/** The wall-clock parts of `ms` in `zone`. */
function partsIn(ms: number, zone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).formatToParts(ms);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);

    return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
        second: get("second"),
    };
}

/** How far `zone` is ahead of UTC at `ms`. */
function offsetAt(ms: number, zone: string): number {
    const p = partsIn(ms, zone);

    return (
        Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
        Math.floor(ms / 1000) * 1000
    );
}

/** The instant of a wall-clock time in `zone`. */
function wallTime(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    zone: string,
): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - offsetAt(guess, zone);

    // Again at the result: the offset can differ there, across a daylight saving change.
    return guess - offsetAt(first, zone);
}

/**
 * Every instant of 1 local date and time in `zone`, earliest first: 2 on a fall-back day for a time in the repeated
 * hour, else 1. A time that the zone skips (a spring-forward gap) has none; it gives `wallTime`'s instant, as before.
 */
function wallTimes(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    zone: string,
): number[] {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const found = new Set<number>();

    // The offsets in force a day before and a day after cover both sides of a change on that date.
    for (const probe of [guess - 86_400_000, guess, guess + 86_400_000]) {
        const at = guess - offsetAt(probe, zone);
        const p = partsIn(at, zone);

        if (
            p.year === year &&
            p.month === month &&
            p.day === day &&
            p.hour === hour &&
            p.minute === minute
        ) {
            found.add(at);
        }
    }

    return found.size === 0
        ? [wallTime(year, month, day, hour, minute, zone)]
        : [...found].sort((a, b) => a - b);
}

/**
 * The next time the clock in `zone` shows `hour:minute`, after `now`: the smallest such instant. On a fall-back day a
 * time in the repeated hour has 2 instants, and the second one counts too.
 */
export function nextClockTime(hour: number, minute: number, now: number, zone: string): number {
    const today = partsIn(now, zone);
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    const candidates = [
        ...wallTimes(today.year, today.month, today.day, hour, minute, zone),
        ...wallTimes(
            tomorrow.getUTCFullYear(),
            tomorrow.getUTCMonth() + 1,
            tomorrow.getUTCDate(),
            hour,
            minute,
            zone,
        ),
    ];

    return candidates.find((at) => at > now) ?? (candidates.at(-1) as number);
}

/** Local midnight in `zone` of the day that holds `now`. */
export function localMidnight(now: number, zone: string): number {
    const today = partsIn(now, zone);

    return wallTime(today.year, today.month, today.day, 0, 0, zone);
}

/** DeepSeek's peak hours in UTC: 01:00-04:00 and 06:00-10:00. The end of the window holding `now`, or undefined. */
export function deepseekStart(now: number): number | undefined {
    const at = new Date(now);
    const hour = at.getUTCHours();
    const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

    if (hour >= 1 && hour < 4) {
        return day + 4 * 3600_000;
    }

    if (hour >= 6 && hour < 10) {
        return day + 10 * 3600_000;
    }

    return undefined;
}

/** A deadline as people read it: "07:00 EDT". */
export function clockLabel(ms: number, zone: string): string {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(ms);
}

/** The hour and minute of a match of UNTIL or START; or a message that it is not a time. */
function clockParts(match: RegExpExecArray): { hour: number; minute: number } | { error: string } {
    let hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const half = match[3]?.toLowerCase();

    if (half !== undefined) {
        if (hour < 1 || hour > 12) {
            return { error: `"${match[0]}" is not a time.` };
        }

        hour = (hour % 12) + (half === "pm" ? 12 : 0);
    }

    if (hour > 23 || minute > 59) {
        return { error: `"${match[0]}" is not a time.` };
    }

    return { hour, minute };
}

const UNTIL = /^until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=[\s:]|$)/i;
const START = /^start\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=[\s:]|$)/i;
const FOR = /^for\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?(?=[\s:]|$)/i;
const MAX = /^max\s+(\d+)(?:\s+rounds?)?(?=[\s:]|$)/i;
const CHECK = /^check\s+`([^`]*)`/i;
// The model part may hold a colon, but not at its end: that colon is the separator before the objective.
const WITH = /^with\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._:-]*[A-Za-z0-9._-])(?=[\s:]|$)/i;
const STOP_WHEN = /\bstop\s+(?:only\s+)?when\b/gi;

/** What the options of `/team-shift` set, and the text after them. */
export type GoalOptions = {
    maxRounds?: number;
    check?: string;
    start?: number;
    startLabel?: string;
    startWhy?: "deepseek-peak";
    deadline?: number;
    deadlineLabel?: string;
    worker?: string;
    /** The text after the options: the objective and the stop condition, or the rest of a delegated field. */
    rest: string;
};

/**
 * Parse the options before the objective: `start`, `until`, `for`, `max`, and `check`. Times resolve after the loop,
 * so that the options can come in any order. `rest` is the text after them, unread here.
 */
export function parseOptions(
    input: string,
    now: number,
    zone: string,
): GoalOptions | { error: string } {
    let rest = input.trim();
    let maxRounds: number | undefined;
    let start: { hour: number; minute: number } | undefined;
    let until: { hour: number; minute: number } | undefined;
    let forMinutes: number | undefined;
    let check: string | undefined;
    let worker: string | undefined;
    const error = (message: string): { error: string } => ({ error: message });
    const deadlineGiven = () => until !== undefined || forMinutes !== undefined;

    for (;;) {
        rest = rest.trimStart();
        let match: RegExpExecArray | null;

        if ((match = START.exec(rest)) !== null) {
            if (start !== undefined) {
                return error("Give one start time.");
            }

            const parts = clockParts(match);

            if ("error" in parts) {
                return error(parts.error);
            }

            start = parts;
        } else if ((match = UNTIL.exec(rest)) !== null) {
            if (deadlineGiven()) {
                return error("Give one deadline: until or for.");
            }

            const parts = clockParts(match);

            if ("error" in parts) {
                return error(parts.error);
            }

            until = parts;
        } else if ((match = FOR.exec(rest)) !== null && (match[1] ?? match[2]) !== undefined) {
            if (deadlineGiven()) {
                return error("Give one deadline: until or for.");
            }

            const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);

            if (minutes < 1 || minutes > MAX_HOURS * 60) {
                return error(`A deadline must be 1 minute to ${MAX_HOURS} hours away.`);
            }

            forMinutes = minutes;
        } else if ((match = MAX.exec(rest)) !== null) {
            maxRounds = Number(match[1]);

            if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
                return error(`max must be 1 to ${MAX_ROUNDS} rounds.`);
            }
        } else if ((match = CHECK.exec(rest)) !== null) {
            check = match[1]!.trim();

            if (check === "") {
                return error("The check command is empty.");
            }

            if (check.length > MAX_COMMAND) {
                return error(`A check command is limited to ${MAX_COMMAND} characters.`);
            }
        } else if ((match = WITH.exec(rest)) !== null) {
            if (worker !== undefined) {
                return error("Give one worker.");
            }

            worker = match[1]!;
        } else {
            break;
        }

        rest = rest.slice(match[0].length);
    }

    // Times resolve here, after the loop, so that the options can come in any order.
    let startAt =
        start === undefined ? undefined : nextClockTime(start.hour, start.minute, now, zone);
    let startWhy: "deepseek-peak" | undefined;

    // DeepSeek's peak hours delay round 1, unless a person gave a start. `for` and `until` count from it.
    if (startAt === undefined && worker?.startsWith("deepseek/") === true) {
        startAt = deepseekStart(now);

        if (startAt !== undefined) {
            startWhy = "deepseek-peak";
        }
    }

    // Across a daylight saving change a day has 25 hours: only then can this happen.
    if (startAt !== undefined && startAt - now > MAX_HOURS * 3600_000) {
        return error("start must be at most 24 hours away.");
    }

    const deadline =
        until !== undefined
            ? nextClockTime(until.hour, until.minute, now, zone)
            : forMinutes === undefined
              ? undefined
              : // `for` counts from `start` when it is given.
                (startAt ?? now) + forMinutes * 60_000;

    if (startAt !== undefined && deadline !== undefined && deadline <= startAt) {
        return error(
            `until ${clockLabel(deadline, zone)} is not after start ${clockLabel(startAt, zone)}.`,
        );
    }

    return {
        ...(maxRounds === undefined ? {} : { maxRounds }),
        ...(check === undefined ? {} : { check }),
        ...(worker === undefined ? {} : { worker }),
        ...(startAt === undefined
            ? {}
            : {
                  start: startAt,
                  startLabel: clockLabel(startAt, zone),
                  ...(startWhy === undefined ? {} : { startWhy }),
              }),
        ...(deadline === undefined ? {} : { deadline, deadlineLabel: clockLabel(deadline, zone) }),
        rest,
    };
}

/**
 * Parse what follows `/team-shift`. Options come first, in any order; then an optional `:`, then the objective and
 * the stop condition, split at the last "stop when" (or "stop only when").
 */
export function parseArgs(input: string, now: number, zone: string): Parsed {
    const args = input.trim();
    const word = args.toLowerCase();

    if (word === "" || word === "help") {
        return { kind: "help" };
    }

    if (word === "status" || word === "stop" || word === "resume") {
        return { kind: word };
    }

    const options = parseOptions(args, now, zone);

    if ("error" in options) {
        return { kind: "error", message: options.error };
    }

    const rest = options.rest.replace(/^\s*:/, "").trim();
    const stops = [...rest.matchAll(STOP_WHEN)];
    const last = stops.at(-1);

    if (last === undefined) {
        return {
            kind: "error",
            message: `Say when to stop: "…; stop when <condition>".\n${USAGE}`,
        };
    }

    const objective = rest
        .slice(0, last.index)
        .trim()
        .replace(/[\s;,.—–-]+$/, "")
        .trim();
    const stop = rest
        .slice(last.index + last[0].length)
        .trim()
        .replace(/^[:,]\s*/, "")
        .trim();

    if (objective === "") {
        return { kind: "error", message: `Say what to do before "stop when".\n${USAGE}` };
    }

    if (stop === "") {
        return { kind: "error", message: `Say the stop condition after "stop when".\n${USAGE}` };
    }

    if (objective.length + stop.length > SHIFT_TEXT_LIMIT) {
        return {
            kind: "error",
            message: `The objective and the stop condition are limited to ${SHIFT_TEXT_LIMIT} characters.`,
        };
    }

    return {
        kind: "set",
        goal: {
            objective,
            stop,
            maxRounds: options.maxRounds ?? DEFAULT_ROUNDS,
            ...(options.check === undefined ? {} : { check: options.check }),
            ...(options.start === undefined
                ? {}
                : {
                      start: options.start,
                      startLabel: options.startLabel,
                      ...(options.startWhy === undefined ? {} : { startWhy: options.startWhy }),
                  }),
            ...(options.deadline === undefined
                ? {}
                : { deadline: options.deadline, deadlineLabel: options.deadlineLabel }),
            ...(options.worker === undefined ? {} : { worker: options.worker }),
        },
    };
}

// ─── A PR check for a delegated shift ───────────────────────────────────────

/**
 * A PR check that `team_delegate` can ask for, in place of a check command. The module builds the command from these
 * values, and the program is always `gh`, read only: no model writes shell that runs unguarded.
 */
export type PrCheck = {
    /** The PR number. Omitted: the PR of the current branch of the linked session's folder. */
    pr?: number;
    /** The repository, `owner/name`, when the folder is not the PR's repository. Needs `pr`. */
    repo?: string;
    /**
     * Which checks must pass: `required` (the default; when the repository requires no checks, all checks), `all`, or
     * `none` with a label.
     */
    checks?: "required" | "all" | "none";
    /** A label the PR must have, such as `ready-for-human`. */
    label?: string;
};

const PR_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** No quotes and no shell characters: the label goes into the command inside single quotes. */
const PR_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:\/+-]{0,49}$/;

/** Printed when the required checks pass. */
export const PR_CHECK_REQUIRED_PASS = "pr_check: the required checks pass.";
/** Printed when the repository requires no checks and all checks pass. */
export const PR_CHECK_ALL_PASS =
    "pr_check: the repository requires no checks, and all checks pass.";
/**
 * The grep pattern (whole line, `grep -x`) for what `gh pr checks --required` writes to stderr when the repository has
 * no required check, for example `no required checks reported on the 'main' branch`. Check rows go to stdout, so a
 * check name never matches.
 */
export const PR_CHECK_NO_REQUIRED = "no required checks reported on the .* branch";

/**
 * The command for a PR check, built from validated values only: `gh pr checks` and `gh pr view`, both read only. Parts
 * are joined with ` && `, so every part must pass. A value that does not fit gives an error, never a command.
 * `required` runs `gh pr checks --required`; only when that exits 1 and its stderr (not its stdout) says the repository
 * has no required checks does it run `gh pr checks` (all checks). A failing or pending required check keeps its exit
 * code. Each pass prints a line that starts with `pr_check: ` (`checkNote` reads it).
 */
export function prCheckCommand(check: PrCheck): string | { error: string } {
    const { pr, repo, label } = check;
    const which = check.checks ?? "required";

    if (pr !== undefined && (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1)) {
        return { error: "shift.pr_check.pr must be a whole number of 1 or more." };
    }

    if (repo !== undefined && (typeof repo !== "string" || !PR_REPO.test(repo))) {
        return {
            error: "shift.pr_check.repo must be owner/name, such as bketelsen/x: letters, digits, . _ and - only.",
        };
    }

    // `gh` reads the current branch's PR only with no `--repo`: with one, it needs the number.
    if (repo !== undefined && pr === undefined) {
        return {
            error: "shift.pr_check.repo needs pr: gh finds the current branch's PR only without a repo.",
        };
    }

    if (which !== "required" && which !== "all" && which !== "none") {
        return { error: 'shift.pr_check.checks must be "required", "all" or "none".' };
    }

    if (label !== undefined && (typeof label !== "string" || !PR_LABEL.test(label))) {
        return {
            error: "shift.pr_check.label must be 1 to 50 characters: a letter or digit first, then letters, digits, spaces and . _ : / + - only.",
        };
    }

    if (which === "none" && label === undefined) {
        return {
            error: 'shift.pr_check.checks "none" needs a label: with neither, there is nothing to check.',
        };
    }

    // The number and the repository are the same in every part: `gh` with no number reads the current branch's PR.
    const where = `${pr === undefined ? "" : ` ${pr}`}${repo === undefined ? "" : ` --repo ${repo}`}`;
    const parts: string[] = [];

    if (which === "required") {
        parts.push(
            `{ { e=$(gh pr checks${where} --required 2>&1 >&3); s=$?; } 3>&1; ` +
                `[ -z "$e" ] || printf '%s\\n' "$e" >&2; ` +
                `if [ "$s" -eq 0 ]; then echo '${PR_CHECK_REQUIRED_PASS}'; ` +
                `elif [ "$s" -eq 1 ] && printf '%s\\n' "$e" | grep -qx '${PR_CHECK_NO_REQUIRED}'; ` +
                `then gh pr checks${where} && echo '${PR_CHECK_ALL_PASS}'; ` +
                `else (exit "$s"); fi; }`,
        );
    }

    if (which === "all") {
        parts.push(`gh pr checks${where}`);
    }

    if (label !== undefined) {
        parts.push(
            `gh pr view${where} --json labels --jq '.labels[].name' | grep -qxF -- '${label}'`,
        );
    }

    const command = parts.join(" && ");

    if (command === "" || command.length > MAX_COMMAND) {
        return {
            error: `shift.pr_check builds a command of 1 to ${MAX_COMMAND} characters: this one is ${command.length}.`,
        };
    }

    return command;
}

/** The last `pr_check: ` line of a passing check, else undefined. */
export function checkNote(check: CheckResult | undefined): string | undefined {
    if (check === undefined || !check.passed) {
        return undefined;
    }

    return check.tail
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("pr_check: "))
        .at(-1);
}

/** The fields of `shift` (alias `night_shift`) in the `team_delegate` tool. */
export type DelegatedFields = {
    objective: string;
    stop_when: string;
    start?: string;
    until?: string;
    for?: string;
    /**
     * The absolute stop, in epoch milliseconds: the goal's deadline is this instant. Only Team's `startShift` (the
     * desk's goal board) sets it; the `team_delegate` tool has no such field. A wait before round 1 never moves it.
     */
    until_at?: number;
    max?: number;
    worker?: string;
    pr_check?: PrCheck;
};

/** What one option alone accepts: its word, and the fields that only it can set. */
const OPTION_ALONE = {
    start: {
        word: "a time, such as 06:00",
        only: (options: GoalOptions) =>
            options.start !== undefined &&
            options.deadline === undefined &&
            options.maxRounds === undefined,
    },
    until: {
        word: "a time, such as 07:00",
        only: (options: GoalOptions) =>
            options.deadline !== undefined &&
            options.start === undefined &&
            options.maxRounds === undefined,
    },
    for: {
        word: "a length of time, such as 8h",
        only: (options: GoalOptions) =>
            options.deadline !== undefined &&
            options.start === undefined &&
            options.maxRounds === undefined,
    },
} as const;

/**
 * The goal request for a shift that `team_delegate` starts. Each option comes from its own field, so a field
 * cannot carry a second option: the free check never comes from this path (only the owner sets one, with
 * `/team-shift`). The 1 exception is `pr_check`, a structured PR check: `prCheckCommand` builds a fixed `gh` command
 * from validated values, so no model-chosen shell runs. The options combine here, so `until` after `start`, `for` from
 * `start`, and one of `until`/`for` hold as usual. `until_at` is an absolute stop in place of `until` or `for`: the
 * deadline is that instant, and a `start` or the DeepSeek peak wait does not move it.
 */
export function delegatedRequest(
    fields: DelegatedFields,
    now: number,
    zone: string,
): GoalRequest | { error: string } {
    const objective = fields.objective.trim();
    const stop = fields.stop_when.trim();

    if (objective === "") {
        return { error: `Say what to do before "stop when".\n${USAGE}` };
    }

    if (stop === "") {
        return { error: `Say the stop condition after "stop when".\n${USAGE}` };
    }

    if (objective.length + stop.length > SHIFT_TEXT_LIMIT) {
        return {
            error: `The objective and the stop condition are limited to ${SHIFT_TEXT_LIMIT} characters.`,
        };
    }

    const untilAt = fields.until_at;

    if (untilAt !== undefined) {
        if (fields.until !== undefined || fields.for !== undefined) {
            return { error: "Give one deadline: until_at, until or for." };
        }

        if (typeof untilAt !== "number" || !Number.isFinite(untilAt)) {
            return { error: "shift.until_at must be a time in epoch milliseconds." };
        }

        if (untilAt <= now) {
            return { error: `shift.until_at ${clockLabel(untilAt, zone)} has passed.` };
        }

        if (untilAt - now > MAX_HOURS * 3600_000) {
            return { error: `A deadline must be 1 minute to ${MAX_HOURS} hours away.` };
        }
    }

    const parts: string[] = [];

    // The worker is one option too: no other option may travel in its field.
    if (fields.worker !== undefined) {
        const options = parseOptions(`with ${fields.worker}`, now, zone);

        if (
            "error" in options ||
            options.rest !== "" ||
            options.check !== undefined ||
            options.deadline !== undefined ||
            options.maxRounds !== undefined ||
            options.worker !== fields.worker.trim()
        ) {
            return {
                error: "shift.worker must be only a provider/model, such as github-copilot/claude-sonnet-5.5.",
            };
        }

        parts.push(`with ${fields.worker.trim()}`);
    }

    for (const name of ["start", "until", "for"] as const) {
        const text = fields[name];

        if (text === undefined) {
            continue;
        }

        const options = parseOptions(`${name} ${text}`, now, zone);

        if (
            "error" in options ||
            options.rest !== "" ||
            options.check !== undefined ||
            !OPTION_ALONE[name].only(options)
        ) {
            return {
                error: `shift.${name} must be only ${OPTION_ALONE[name].word}.`,
            };
        }

        parts.push(`${name} ${text.trim()}`);
    }

    if (fields.max !== undefined) {
        parts.push(`max ${fields.max}`);
    }

    const options = parseOptions(parts.join(" "), now, zone);

    if ("error" in options || options.rest !== "" || options.check !== undefined) {
        return {
            error: "error" in options ? options.error : "shift must not carry another option.",
        };
    }

    // A PR check is the only way this path sets a check: the command is built here, from validated values.
    let check: string | undefined;

    if (fields.pr_check !== undefined) {
        const built = prCheckCommand(fields.pr_check);

        if (typeof built !== "string") {
            return { error: built.error };
        }

        check = built;
    }

    // The absolute stop: no wait before round 1 moves it. A wait that ends at or after it ends the goal with no round.
    const deadline =
        untilAt !== undefined
            ? { deadline: untilAt, deadlineLabel: clockLabel(untilAt, zone) }
            : options.deadline === undefined
              ? {}
              : { deadline: options.deadline, deadlineLabel: options.deadlineLabel };

    return {
        objective,
        stop,
        ...(check === undefined ? {} : { check }),
        maxRounds: options.maxRounds ?? DEFAULT_ROUNDS,
        ...(options.start === undefined
            ? {}
            : {
                  start: options.start,
                  startLabel: options.startLabel,
                  ...(options.startWhy === undefined ? {} : { startWhy: options.startWhy }),
              }),
        ...deadline,
        ...(options.worker === undefined ? {} : { worker: options.worker }),
    };
}

// ─── Reading Pi's answers and the messages in a session ─────────────────────

const STATUS_LINE =
    /^[\s>*_#`-]*STATUS[*_`]*\s*:\s*[*_`]*\s*(DONE|CONTINUE|BLOCKED)\b[*_`]*\s*[—–:.,-]*\s*(.*)$/gim;

/** The last STATUS line of an answer: its verdict and reason. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } {
    const last = [...text.matchAll(STATUS_LINE)].at(-1);

    if (last === undefined) {
        return { verdict: "none", reason: "" };
    }

    return {
        verdict: last[1]!.toLowerCase() as Verdict,
        reason: last[2]!
            .replace(/[*_`]+$/, "")
            .trim()
            .slice(0, 500),
    };
}

const FROM = /^\[from: ([^\]\n]{1,60})\] /;
/**
 * Messages that no person typed: this module's rounds, Pocket's linked sessions, PiP, webhooks and watches (all
 * `[via …]`), schedules, subagent reports, Done when's checks, and the end of a background task (Pocket 0.24's
 * `BACKGROUND_PREFIX`, `[background] `).
 */
const AUTOMATED = /^\[(?:shift\]|night-shift\]|via |scheduled\]|subagent |goal\] |background\] )/;

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    return Array.isArray(content)
        ? content
              .flatMap((part: { type?: string; text?: string }) =>
                  part?.type === "text" ? [part.text ?? ""] : [],
              )
              .join("")
        : "";
}

/**
 * Whether a person typed this message: their name when it says it, "A person" when not; undefined for a message that
 * an agent or the app sent. Anything not known as automated counts as a person's: pausing too often is the safe side.
 */
export function personOf(content: unknown): string | undefined {
    const text = textOf(content).trimStart();
    const from = FROM.exec(text);
    const body = from === null ? text : text.slice(from[0].length);

    return AUTOMATED.test(body) ? undefined : (from?.[1] ?? "A person");
}

/** The first person's message in the session after `seen`, and the newest entry looked at. */
async function peopleSince(
    tx: Tx,
    id: ConversationId,
    seen: number,
): Promise<{ person?: string; seen: number }> {
    let cursor: Parameters<Tx["scanEntries"]>[2];
    let newest = seen;
    let person: string | undefined;

    do {
        const page = await tx.scanEntries(
            { conversationId: id, minEntryId: (seen + 1) as EntryId, order: "ascending" },
            200,
            cursor,
        );

        for (const entry of page.items) {
            newest = Math.max(newest, Number(entry.id));

            if (person === undefined && entry.kind === "pi.user") {
                const message = entry.model?.find((each) => each.role === "user");

                person = message === undefined ? undefined : personOf(message.content);
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return { ...(person === undefined ? {} : { person }), seen: newest };
}

/** The newest entry of a session, so that a goal looks only at what comes after it. */
async function newestEntry(tx: Tx, id: ConversationId): Promise<number> {
    const page = await tx.scanEntries({ conversationId: id, order: "descending" }, 1);

    return Number(page.items[0]?.id ?? 0);
}

const LINKED_ADDRESS = /Message from linked session (session-[0-9a-f-]+)/;

/**
 * The source session's address in a linked session: the first `pi.user` entry is the message that started it, and it
 * names the address to reply to. Undefined in a session that a person started.
 */
async function returnAddress(tx: Tx, id: ConversationId): Promise<string | undefined> {
    let cursor: Parameters<Tx["scanEntries"]>[2];

    do {
        const page = await tx.scanEntries({ conversationId: id, order: "ascending" }, 200, cursor);

        for (const entry of page.items) {
            if (entry.kind !== "pi.user") {
                continue;
            }

            const message = entry.model?.find((each) => each.role === "user");

            return message === undefined
                ? undefined
                : LINKED_ADDRESS.exec(textOf(message.content))?.[1];
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return undefined;
}

// ─── Words ───────────────────────────────────────────────────────────────────

function left(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));

    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function fence(text: string): string {
    return `\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
}

/** What Pi was told about its last round, for the next one. */
function lastRoundWords(goal: Goal): string {
    const last = goal.rounds.at(-1);

    if (last === undefined) {
        return "This is the first round.";
    }

    if (last.check !== undefined && !last.check.passed) {
        if (last.check.cutOff) {
            return `Last round you said DONE, but the check \`${goal.check}\` was cut off by a server restart. It runs again after your next DONE.`;
        }

        const output =
            last.check.tail === ""
                ? "It printed nothing."
                : `The end of its output:\n${fence(last.check.tail)}`;

        return `Last round you said DONE, but the check \`${goal.check}\` failed (exit code ${last.check.code}). ${output}`;
    }

    if (last.verdict === "none") {
        return "Your last answer had no STATUS line. End this one with one.";
    }

    return `Last round you said ${last.verdict.toUpperCase()}${last.reason === "" ? "" : `: ${last.reason}`}`;
}

/**
 * The prompt section's lines about the worker: none without one. With `workerThinking` (a worker the model router
 * assigned), the line names the thinking level next to the model, so each spawn gets the tested configuration.
 */
export function workerLines(goal: Pick<Goal, "worker" | "workerThinking">): string[] {
    if (goal.worker === undefined) {
        return [];
    }

    const thinking =
        goal.workerThinking === undefined ? "" : ` and thinking \`${goal.workerThinking}\``;
    const spawn =
        goal.workerThinking === undefined
            ? ""
            : ` Spawn each worker with model \`${goal.worker}\` and thinking \`${goal.workerThinking}\`.`;

    return [
        `For this goal, give execution to subagents on \`${goal.worker}\`${thinking}. This replaces the DeepSeek Flash rule for this goal.${spawn} If \`${goal.worker}\` cannot be used, end with STATUS: BLOCKED. Do not pick another model.`,
    ];
}

export function roundMessage(goal: Goal, n: number, now: number): string {
    const limit =
        goal.deadline === undefined
            ? ""
            : `, until ${goal.deadlineLabel} (${left(goal.deadline - now)} left)`;

    return [
        `${PREFIX} Round ${n} of ${goal.maxRounds}${limit}.`,
        `Objective: ${goal.objective}`,
        `Stop when: ${goal.stop}`,
        ...(goal.check === undefined
            ? []
            : [`Check: \`${goal.check}\` must pass too. It runs after you say DONE.`]),
        lastRoundWords(goal),
        ...(goal.delegated === undefined
            ? []
            : [
                  `Your shift report goes to ${goal.delegated.supervisor} by itself when the shift stops. Do not send a separate team_message report.`,
                  ...(goal.delegated.address === undefined
                      ? []
                      : [
                            `To ask ${goal.delegated.supervisor} something before then (a decision, or the facts of another desk thread), send team_message to ${goal.delegated.address}.`,
                        ]),
              ]),
        "Work toward the objective now. End your answer with one status line: STATUS: DONE, STATUS: CONTINUE, or STATUS: BLOCKED, then the reason.",
    ].join("\n");
}

export function summaryMessage(goal: Goal): string {
    const rounds =
        goal.worker === undefined
            ? `It took ${goal.round} of ${goal.maxRounds} rounds.`
            : `It took ${goal.round} of ${goal.maxRounds} rounds, with subagents on ${goal.worker}.`;

    return [
        `${PREFIX} The shift has stopped: ${goal.why}. ${rounds}`,
        "Do not start new work. Write the summary for the morning, in three short parts: what you did, what is left, and why the work stopped.",
        ...(goal.delegated === undefined
            ? []
            : [
                  `Write it in ASD-STE100 (Simplified Technical English): it goes to ${goal.delegated.supervisor}.`,
                  `This summary is your shift report. It goes to ${goal.delegated.supervisor} by itself: do not send a separate team_message report. Answer a later message from ${goal.delegated.supervisor} as usual.`,
                  'Before that, write 1 line "PRS:" with each PR you created, changed, reviewed or labelled in this shift, as owner/name#N separated by commas, or "PRS: none", then 1 blank line. The desk puts each PR on your thread.',
                  'End the summary with a line "ASKS FOR BRIAN:" and 1 line under it for each decision Brian must make, with its options in [a | b] when it is a pick-one. Write "ASKS FOR BRIAN: none" when there is none. A merge or install request is no decision.',
              ]),
        "Do not end with a STATUS line.",
    ].join("\n");
}

/** What a delegated goal sends back to the supervisor session of its linked session when it stops. */
function reportMessage(goal: Goal, text: string): string {
    const progress =
        goal.worker === undefined ? "" : `\nRounds: ${goal.round}, worker: ${goal.worker}.`;

    return `Shift report from this linked session: stopped at round ${goal.round} of ${goal.maxRounds}: ${goal.why ?? "it stopped"}.${progress}\n\n${text}`;
}

const VERDICT_WORD: Record<Verdict, string> = {
    done: "DONE",
    continue: "CONTINUE",
    blocked: "BLOCKED",
    none: "(no status)",
};

const REASON_WORD: Record<StopReason, string> = {
    done: "done",
    "max-rounds": "out of rounds",
    deadline: "deadline",
    blocked: "blocked",
    person: "paused",
    plan: "paused",
    stopped: "stopped",
    spend: "spend limit",
    failed: "failed",
};

/** Whether `/team-shift resume` can go on with a goal: it stopped, not done, with rounds and time left. */
export function resumable(goal: Goal, now: number): boolean {
    return (
        (goal.status === "paused" || goal.status === "ended") &&
        goal.reason !== "done" &&
        goal.round < goal.maxRounds &&
        (goal.deadline === undefined || now < goal.deadline)
    );
}

/** Whether a goal waits for its start time: round 1 has not started, and the start is still ahead. */
export function waiting(goal: Goal, now: number): boolean {
    return (
        goal.status === "running" &&
        goal.round === 0 &&
        goal.start !== undefined &&
        now < goal.start
    );
}

/** One line on where a goal stands. */
export function standing(goal: Goal, now: number): string {
    const rounds = goal.round === 0 ? "starting" : `round ${goal.round} of ${goal.maxRounds}`;
    const deadline =
        goal.deadline === undefined
            ? ""
            : goal.deadline > now
              ? `, until ${goal.deadlineLabel} (${left(goal.deadline - now)} left)`
              : `, deadline ${goal.deadlineLabel} passed`;

    if (waiting(goal, now)) {
        const then = goal.deadline === undefined ? "" : `, then until ${goal.deadlineLabel}`;

        if (goal.startWhy === "deepseek-peak") {
            return `waiting until ${goal.startLabel} (after DeepSeek's peak hours; ${left(goal.start! - now)} left)${then}`;
        }

        return `waiting until ${goal.startLabel} (${left(goal.start! - now)})${then}`;
    }

    switch (goal.status) {
        case "running":
            return `running, ${rounds}${deadline}`;
        case "summary":
            return `stopped (${goal.why}); Pi writes the summary`;
        case "paused":
            return `paused at ${rounds}: ${goal.why}`;
        case "ended":
            return `ended at ${rounds}: ${goal.why}`;
    }
}

export function statusCard(goal: Goal | undefined, now: number): string {
    if (goal === undefined) {
        return `No shift in this session.\n${USAGE}`;
    }

    const lines = [
        `Shift: ${standing(goal, now)}.`,
        `Objective: ${goal.objective}`,
        `Stop when: ${goal.stop}`,
        ...(goal.check === undefined ? [] : [`Check: ${goal.check}`]),
        ...(goal.worker === undefined
            ? []
            : [
                  `Worker: ${goal.worker}${goal.workerThinking === undefined ? "" : `, thinking ${goal.workerThinking}`}`,
              ]),
        `Set by ${goal.byName}.`,
    ];

    if (goal.rounds.length > 0) {
        lines.push("Rounds:");

        for (const round of goal.rounds.slice(-10)) {
            const note = checkNote(round.check);
            const check =
                round.check === undefined
                    ? ""
                    : round.check.cutOff
                      ? " · check cut off"
                      : ` · check ${round.check.passed ? `passed${note === undefined ? "" : `: ${note}`}` : `failed (exit ${round.check.code})`}`;

            lines.push(
                `  ${round.n}. ${VERDICT_WORD[round.verdict]}${round.reason === "" ? "" : ` ${round.reason}`}${check}`,
            );
        }
    }

    if (waiting(goal, now)) {
        lines.push("/team-shift stop cancels it.");
    } else if (goal.status === "running" || goal.status === "summary") {
        lines.push(
            "/team-shift stop ends it after the current round. Stop ends the current round now.",
        );
    } else if (resumable(goal, now)) {
        lines.push("/team-shift resume goes on.");
    }

    return lines.join("\n");
}

/** The goal as the browser module shows it. */
export function goalView(goal: Goal | undefined, now: number) {
    if (goal === undefined || (goal.endedAt !== undefined && now - goal.endedAt > SHOW_ENDED_MS)) {
        return null;
    }

    return {
        status: goal.status,
        reason: goal.reason ?? null,
        reasonWord: goal.reason === undefined ? null : REASON_WORD[goal.reason],
        round: goal.round,
        maxRounds: goal.maxRounds,
        waiting: waiting(goal, now),
        start: goal.start ?? null,
        startLabel: goal.startLabel ?? null,
        deadline: goal.deadline ?? null,
        deadlineLabel: goal.deadlineLabel ?? null,
        objective: goal.objective,
        stop: goal.stop,
        check: goal.check ?? null,
        worker: goal.worker ?? null,
        startWhy: goal.startWhy ?? null,
        standing: standing(goal, now),
        card: statusCard(goal, now),
    };
}

// ─── The driver ──────────────────────────────────────────────────────────────

type DriverInput = { goalId: string };
type DriverState =
    | { phase: "wait" }
    | { phase: "decide" }
    | { phase: "round"; n: number; attempt: number }
    | { phase: "check"; n: number }
    | { phase: "summary"; attempt: number }
    | { phase: "report"; text: string };
type Runtime = TaskRuntime<DriverInput, DriverState, null, object>;

/**
 * Wait inside a phase until the Harness clock reaches `until`: recheck the clock after every timer, and reject with the
 * abort reason when the context's signal aborts. This stays in-phase and does not use `runtime.sleepUntil` on purpose:
 * the wait must end at once when the goal stops or another driver takes over. A stop is a document change from a
 * command, and an extension cannot wake or abort a durably sleeping task early.
 */
function sleepInPhase(
    runtime: Pick<Runtime, "now" | "setTimer">,
    until: number,
    context: Context,
): Promise<void> {
    return (async () => {
        const signal = context.abortSignal;

        for (;;) {
            signal?.throwIfAborted();

            const remaining = until - runtime.now();

            if (remaining <= 0) {
                return;
            }

            const delayMs = Math.min(remaining, 2_147_483_647);

            await new Promise<void>((resolve, reject) => {
                let disarm = (): void => {};

                const onAbort = (): void => {
                    disarm();

                    reject(signal?.reason);
                };

                const onTimer = (): void => {
                    signal?.removeEventListener("abort", onAbort);

                    resolve();
                };

                disarm = runtime.setTimer(onTimer, delayMs);

                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    })();
}

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const next = (checkpoint: DriverState) => ({ status: "running", checkpoint }) as const;

/** A check cut off by a restart: it may have done part of its work, so like any unsafe call it is not run again. */
const CUT_OFF: CheckResult = {
    passed: false,
    code: -1,
    tail: "The check was cut off by a server restart and did not run again.",
    cutOff: true,
};

function requestId(goal: Goal, key: string): string {
    // `p:<person>:…` is how Pocket marks a message it sends for a person (src/server/requests.ts, stored with every
    // message): Pi works for the person who set the goal, and Pocket counts the spend as theirs.
    return `p:${goal.by}:x-night-shift-${goal.id}-${key}`;
}

/** A plain copy of a document's draft, to use after its commit. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Keep the round records short: the newest ones. */
function keep(goal: Goal, round: RoundRecord): void {
    const rounds = goal.rounds.filter((each) => each.n !== round.n);

    if (goal.worker !== undefined) {
        round.worker = goal.worker;
    }

    rounds.push(round);
    goal.rounds = rounds.slice(-KEPT_ROUNDS);
}

function stopWords(reason: StopReason, goal: Goal, detail = ""): string {
    switch (reason) {
        case "done": {
            if (goal.check === undefined) {
                return "Pi says the stop condition holds";
            }

            const note = checkNote(goal.rounds.at(-1)?.check);

            return `Pi says the stop condition holds, and \`${goal.check}\` passes${
                note === undefined ? "" : ` (${note.slice("pr_check: ".length)})`
            }`;
        }

        case "max-rounds":
            return `it used all ${goal.maxRounds} rounds`;
        case "deadline":
            return `the deadline ${goal.deadlineLabel} passed`;
        case "blocked":
            return `Pi is blocked${detail === "" ? "" : `: ${detail}`}`;
        case "person":
            return `${detail} wrote in the session`;
        case "plan":
            return "plan mode is on";
        case "stopped":
            return detail === "" ? "someone pressed Stop" : detail;
        case "spend":
            return detail;
        case "failed":
            return `a round got no answer: ${detail}`;
    }
}

/** Reasons that get a summary round: nobody is there to see why it stopped. */
const SUMMARIZED = new Set<StopReason>(["done", "max-rounds", "deadline", "blocked"]);

/** What `team.ts` uses: on `globalThis[Symbol.for("pi-pocket-team.night-shift")]`, so it finds the live version. */
export type NightShiftApi = {
    /**
     * Version 3: `delegatedRequest` takes `until_at` (an absolute stop, from the desk's goal board). Version 4:
     * `setDelegated` keeps the request's `workerThinking`, and the prompt names it next to the worker.
     */
    version: 4;
    delegatedRequest: typeof delegatedRequest;
    setDelegated: (
        tx: Tx,
        conversationId: ConversationId,
        request: GoalRequest,
        who: { by: string; byName: string; supervisor: string },
        key: string,
    ) => Promise<Goal>;
    notifyChanged: (conversationId: ConversationId) => void;
    standing: typeof standing;
    zone: () => string;
    /**
     * The clock math the desk's goal board uses, in this module's zone rules: the next time the clock shows
     * `hour:minute` after `now`, and local midnight of the day that holds `now`. An older module has neither.
     */
    nextClockTime?: typeof nextClockTime;
    localMidnight?: typeof localMidnight;
    /**
     * `SHIFT_TEXT_LIMIT`: the longest objective plus stop condition, each trimmed. An older module has none: the board
     * then leaves the check to the start.
     */
    textLimit?: number;
    /** A goal as the desk's sweep reads it. */
    goal: (
        read: DocumentReader,
        conversationId: ConversationId,
        context: Context,
    ) => Promise<
        { status: Goal["status"]; round: number; maxRounds: number; why?: string } | undefined
    >;
};

export default function createNightShift(host: Host, web: Web) {
    const changed = (id: ConversationId) => web.send("changed", { conversation: Number(id) });
    /** Tell a session's tabs that its goal changed: for another module that set the goal, after its commit. */
    const notifyChanged = (id: ConversationId) => changed(id);

    /**
     * The desk's API, from a global: night-shift.ts must not import desk.ts. A static import would keep a stale copy
     * after a reload.
     */
    type DeskApi = {
        version: number;
        file: (
            tx: Tx,
            session: ConversationId,
            request: {
                to: string;
                key: string;
                from: "team_message" | "night-shift";
                text: string;
                at: number;
                /** The desk puts the report in the supervisor's digest: `held` says it did. */
                digest?: true;
                /** The stop reason: `blocked` and `failed` go at once. */
                reason?: string;
                /** The decisions for Brian that the summary names, 1 to 4: the desk files each as an ask. */
                asks?: { question: string; options?: string[] }[];
                /** The PRs the summary names, as `owner/name#N`: the desk puts each on the thread. */
                prs?: string[];
                /** A PR the desk must not attach, and why: it is an event on the thread. */
                prsRefused?: { ref: string; why: string }[];
                /** The summary has no `PRS:` line: the desk records it, and never fails the report for it. */
                prsMissing?: true;
            },
        ) => Promise<
            | {
                  line: string;
                  held?: boolean;
                  /** What the desk did with the report's PRs, when its desk has them. */
                  prs?: {
                      attached: string[];
                      already: string[];
                      notes: string[];
                      refused: { ref: string; why: string }[];
                  };
              }
            | undefined
        >;
        /**
         * The asks of a summary's `ASKS FOR BRIAN:` block, by the desk's own parser, so the 2 modules cannot drift.
         * Absent in an older desk: the text alone holds the thread then.
         */
        asks?: (text: string) => { question: string; options?: string[] }[] | undefined;
        /**
         * The PRs of a summary's last `PRS:` line, by the desk's own parser: `bad` holds the tokens that are no ref.
         * Absent in an older desk: the PRs stay in the report's text only.
         */
        prs?: (text: string) => { refs: string[]; bad: string[] } | undefined;
        /**
         * Whether GitHub has each reported PR, and its owner is one the team works in: no write, and it never throws.
         * Absent in an older desk: the PRs stay in the report's text only.
         */
        checkPrs?: (
            refs: string[],
        ) => Promise<{ ok: string[]; refused: { ref: string; why: string }[] }>;
        /**
         * Tell the desk page that the desk changed: call it after the commit that used `file` returned, never inside
         * it. Absent in an older desk: skip the call.
         */
        changed?: () => void;
    };

    const deskApi = (): DeskApi | undefined =>
        (globalThis as unknown as Record<symbol, DeskApi | undefined>)[DESK_API];

    /** Stop a goal in a commit's draft: with a summary round when nobody may be there, otherwise at once. */
    function stopIn(goal: Goal, reason: StopReason, detail: string, now: number) {
        goal.reason = reason;
        goal.why = stopWords(reason, goal, detail);

        if (SUMMARIZED.has(reason)) {
            goal.status = "summary";

            return next({ phase: "summary", attempt: 0 });
        }

        goal.status = reason === "person" || reason === "plan" ? "paused" : "ended";
        goal.endedAt = now;
        delete goal.driver;

        // A delegated goal has nobody in its session to read why it stopped: report to the supervisor session.
        if (goal.delegated !== undefined) {
            return next({ phase: "report", text: (goal.why ?? "").slice(0, MAX_REPORT) });
        }

        return finished;
    }

    /** Tell the session's people, after the commit, when the goal stopped or paused. */
    function announce(id: ConversationId, goal: Goal | undefined): void {
        changed(id);

        if (goal === undefined) {
            return;
        }

        if (goal.status === "paused") {
            host.notice("warning", `Shift paused: ${goal.why}. /team-shift resume goes on.`, id);
        } else if (goal.status === "ended") {
            host.notice(
                goal.reason === "failed" ? "error" : "info",
                `Shift ended: ${goal.why}.`,
                id,
            );
        } else if (goal.status === "summary") {
            host.notice("info", `Shift stopped: ${goal.why}. Pi writes the summary.`, id);
        }
    }

    /** The goal this task drives; undefined when it is gone, or another task drives it now. */
    async function mine(runtime: Runtime, context: Context): Promise<Goal | undefined> {
        const goal = (await runtime.snapshot(GoalDoc, runtime.conversationId, context))?.goal;

        return goal?.driver === String(runtime.taskId) ? goal : undefined;
    }

    async function planOn(runtime: Runtime, context: Context): Promise<boolean> {
        try {
            return (await runtime.snapshot(PlanMode, runtime.conversationId, context))?.on === true;
        } catch {
            return false;
        }
    }

    /**
     * Whether Pi's own subagents still work: one whose conversation runs, or a report on its way to this session. Any
     * failure to read Pocket's registry, or a subagent's conversation, means no wait.
     */
    async function subagentsBusy(runtime: Runtime, context: Context): Promise<boolean> {
        try {
            const registry = await runtime.snapshot(SubagentsDoc, runtime.conversationId, context);

            if (registry === undefined) {
                return false;
            }

            if ((registry.outbox?.length ?? 0) > 0 || registry.sending !== undefined) {
                return true;
            }

            for (const agent of Object.values(registry.agents)) {
                const live = await runtime.snapshot(LiveDoc, agent.conversationId, context);

                if (live?.run !== undefined) {
                    return true;
                }
            }

            return false;
        } catch {
            return false;
        }
    }

    /** Whether a background command of this session will still tell Pi that it ended. A failure to read means no. */
    async function backgroundBusy(runtime: Runtime, context: Context): Promise<boolean> {
        try {
            const doc = await runtime.snapshot(BackgroundDoc, runtime.conversationId, context);

            return Object.values(doc?.items ?? {}).some((item) => backgroundWakes(item));
        } catch {
            return false;
        }
    }

    /**
     * Whether Pi runs in this session now: a subagent's report, a background command's end, or another automated input
     * started a run, and a round sent now would only wait behind it. A failure to read means no.
     *
     * Its queue needs no look of its own: Pi Durable queues an input only while a run is on, and places the queue at
     * that run's end in the same commit that starts the next run. Inputs that stay queued with no run belong to a
     * failed run, and nothing wakes Pi for them: the next round places them.
     */
    async function ownRunBusy(runtime: Runtime, context: Context): Promise<boolean> {
        try {
            return (
                (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.run !==
                undefined
            );
        } catch {
            return false;
        }
    }

    /**
     * Whether Pi waits for work that will wake it, so a round sent now would only hear "still waiting": Pi runs now
     * (`run`), or its subagents work, or a background command will tell it that it ended (`work`). Undefined when
     * nothing will wake it. A PR watch does not count: it can last for weeks.
     */
    async function waitsForWork(
        runtime: Runtime,
        context: Context,
    ): Promise<"run" | "work" | undefined> {
        if (await ownRunBusy(runtime, context)) {
            return "run";
        }

        if ((await subagentsBusy(runtime, context)) || (await backgroundBusy(runtime, context))) {
            return "work";
        }

        return undefined;
    }

    /**
     * Sleep until the next look, or until the end of this round's wait. A goal that stops or another driver that takes
     * over ends the sleep, as in `wait`. So does the end of Pi's own run (`running`: it ran at the look, or starts
     * during the sleep): the round then goes at once, not one poll later.
     */
    async function sleepBeforeLook(
        runtime: Runtime,
        startedAt: number,
        running: boolean,
        context: Context,
    ): Promise<void> {
        const id = runtime.conversationId;
        const until = Math.min(runtime.now() + SUBAGENT_POLL_MS, startedAt + SUBAGENT_WAIT_MS);
        const controller = new AbortController();
        const watch = await runtime.watchDoc(GoalDoc, id, context);
        const live = await runtime.watchDoc(LiveDoc, id, context);
        let ran = running;

        try {
            if (watch !== undefined) {
                const look = async (argument: unknown) => {
                    const value = watchDocumentValue<Readonly<{ goal?: Goal }> | null>(argument);

                    if (value === undefined) {
                        return;
                    }

                    if (
                        value?.goal?.driver !== String(runtime.taskId) ||
                        value.goal.status !== "running"
                    ) {
                        controller.abort();
                    }
                };

                await look(watch.value);
                watch.start(look);
            }

            if (live !== undefined) {
                const ended = async (argument: unknown) => {
                    const value = watchDocumentValue<NonNullable<typeof live>["value"]>(argument);

                    if (value === undefined) {
                        return;
                    }

                    if (value?.run !== undefined) {
                        ran = true;
                    } else if (ran) {
                        controller.abort();
                    }
                };

                await ended(live.value);
                live.start(ended);
            }

            await sleepInPhase(runtime, until, withAbortSignal(controller.signal, context));
        } catch (failure) {
            // The goal stopped, another driver took over, or Pi's run ended. Any other rejection is not ours to swallow.
            if (!controller.signal.aborted) {
                throw failure;
            }
        } finally {
            await live?.stop();
            await watch?.stop();
        }
    }

    /**
     * While Pi waits for work after round 1 (`waitsForWork`): the start of this round's wait, from a memo keyed by the
     * round, and whether Pi runs now; or undefined when nothing will wake Pi (or before round 2). The memo keeps its
     * stored name `subagents-<round>`, from when only subagents held a round. It makes the wait restart-safe: a restart
     * goes on with the same hour, and no round is counted meanwhile. `decide` gives up the wait after
     * `SUBAGENT_WAIT_MS`.
     */
    async function subagentWaitStart(
        runtime: Runtime,
        context: Context,
    ): Promise<{ start: number; running: boolean } | undefined> {
        const goal = await mine(runtime, context);

        if (goal === undefined || goal.status !== "running" || goal.round === 0) {
            return undefined;
        }

        const busy = await waitsForWork(runtime, context);

        if (busy === undefined) {
            return undefined;
        }

        return {
            start: await runtime.memo<number>(`subagents-${goal.round}`, runtime.now(), context),
            running: busy === "run",
        };
    }

    /** A person's message waiting in the session's queue. */
    async function queuedPerson(runtime: Runtime, context: Context): Promise<string | undefined> {
        const inbox = await runtime.snapshot(InboxDoc, runtime.conversationId, context);

        for (const item of inbox?.items ?? []) {
            const person = item.mode === "write" ? undefined : personOf(item.content);

            if (person !== undefined) {
                return person;
            }
        }

        return undefined;
    }

    /**
     * Send a message to the session, once for its request id, and wait for its answer. Pi Durable leaves a failed run's
     * queue alone, so a message queued behind it would wait for ever: once the session is idle with it still queued, it
     * is taken back (`withdrawn`). After Pocket's subagent reporters (src/server/extensions/subagents.ts).
     */
    async function deliver(
        runtime: Runtime,
        content: string,
        request: string,
        context: Context,
    ): Promise<{ settled: SettledSubmissionRecord; withdrawn: boolean } | undefined> {
        const id = runtime.conversationId;
        const conversation = await runtime.conversation(id, context);

        if (conversation === undefined) {
            return undefined;
        }

        const submission = await conversation.submit(
            { type: "input", content, whenBusy: "followUp", requestId: request },
            context,
        );
        const watch = await runtime.watchDoc(LiveDoc, id, context);
        let withdrawn = false;
        let withdrawing: Promise<unknown> = Promise.resolve();

        try {
            if (watch !== undefined) {
                const strand = async (argument: unknown) => {
                    const live = watchDocumentValue<NonNullable<typeof watch>["value"]>(argument);

                    if (live !== undefined && live !== null && live.run === undefined) {
                        const abort = submission.abort(context);

                        withdrawing = abort;

                        if ((await abort) === "aborted") {
                            withdrawn = true;
                        }
                    }
                };

                await strand(watch.value);
                watch.start(strand);
            }

            const settled = await submission.wait(context);

            return { settled, withdrawn };
        } finally {
            await watch?.stop();
            await withdrawing.catch(() => {});
        }
    }

    /** Why a message got no answer, in words. */
    function unanswered(settled: SettledSubmissionRecord): string {
        const detail =
            settled.detail === undefined
                ? ""
                : ` (${JSON.stringify(settled.detail).slice(0, 300)})`;

        return `${settled.reason ?? "no answer"}${detail}`;
    }

    async function runCheck(
        runtime: Runtime,
        command: string,
        context: Context,
    ): Promise<CheckResult> {
        const env = await runtime.env(context);

        if (env === undefined) {
            return {
                passed: false,
                code: -1,
                tail: "This session has no shell to run the check in.",
            };
        }

        let output = "";
        const result = await env.exec(
            command,
            {
                timeout: CHECK_TIMEOUT_SECONDS,
                onOutput: (text) => (output = (output + text).slice(-TAIL_CHARS)),
            },
            context,
        );

        if (!result.ok) {
            const why =
                result.error.code === "timeout"
                    ? `It did not finish within ${CHECK_TIMEOUT_SECONDS / 60} minutes.`
                    : result.error.message;

            return { passed: false, code: -1, tail: `${output}\n${why}`.trim().slice(-TAIL_CHARS) };
        }

        return {
            passed: result.value.exitCode === 0,
            code: result.value.exitCode,
            tail: output.trim(),
        };
    }

    const Driver = defineTask<DriverInput, DriverState, null>({
        name: "x.night-shift.driver",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
            /**
             * Before round 1: a restart-safe wait until the goal's start time, if it has one. A restart sleeps again until
             * the stored start; a server that was down past it goes to decide at once. Round 1 starts only in decide,
             * which moves the round count in its commit, so it never starts twice.
             */
            wait: async (_task, runtime, context) => {
                const id = runtime.conversationId;
                const goal = await mine(runtime, context);

                if (goal === undefined || goal.status !== "running") {
                    return runtime.commit(() => finished, context);
                }

                if (goal.round === 0 && goal.start !== undefined && runtime.now() < goal.start) {
                    const controller = new AbortController();
                    const watch = await runtime.watchDoc(GoalDoc, id, context);
                    let cancelled = false;

                    try {
                        if (watch !== undefined) {
                            const look = async (argument: unknown) => {
                                const value = watchDocumentValue<Readonly<{ goal?: Goal }> | null>(
                                    argument,
                                );

                                if (value === undefined) {
                                    return;
                                }

                                if (
                                    value?.goal?.driver !== String(runtime.taskId) ||
                                    value.goal.status !== "running"
                                ) {
                                    controller.abort();
                                }
                            };

                            await look(watch.value);
                            watch.start(look);
                        }

                        await sleepInPhase(
                            runtime,
                            goal.start,
                            withAbortSignal(controller.signal, context),
                        );
                    } catch (failure) {
                        // Stop or another task wakes the sleep. Any other rejection is not ours to swallow.
                        if (!controller.signal.aborted) {
                            throw failure;
                        }

                        cancelled = true;
                    } finally {
                        await watch?.stop();
                    }

                    if (cancelled) {
                        return runtime.commit(() => finished, context);
                    }
                }

                await runtime.commit(async (tx) => {
                    const goal = (await tx.doc(GoalDoc, id)).goal;

                    if (goal?.driver !== String(runtime.taskId) || goal.status !== "running") {
                        return finished;
                    }

                    // Messages that people wrote during the wait must not pause the goal at start.
                    if (goal.round === 0 && goal.start !== undefined) {
                        goal.seen = await newestEntry(tx, id);
                    }

                    return next({ phase: "decide" });
                }, context);

                changed(id);
            },

            /**
             * Before each round: a person's message, plan mode, a spend limit, the rounds, the deadline, and, after round
             * 1, work that will wake Pi (`waitsForWork`). While Pi waits for it, a poll sleeps and looks again; every poll
             * runs the stop checks.
             */
            decide: async (_task, runtime, context) => {
                const id = runtime.conversationId;
                const seen: { goal?: Goal } = {};

                for (;;) {
                    const queued = await queuedPerson(runtime, context);
                    const plan = await planOn(runtime, context);
                    const held = host.heldBack(id);
                    // Read before the commit, which reads documents only through `tx`.
                    const busy = await subagentWaitStart(runtime, context);
                    const startedAt = busy?.start;
                    const waiting: { start?: number } = {};

                    await runtime.commit(async (tx) => {
                        const goal = (await tx.doc(GoalDoc, id)).goal;

                        if (goal?.driver !== String(runtime.taskId) || goal.status !== "running") {
                            return finished;
                        }

                        const now = runtime.now();
                        const people = await peopleSince(tx, id, goal.seen);
                        const person = people.person ?? queued;

                        const stopped = (reason: StopReason, detail = "") => {
                            const state = stopIn(goal, reason, detail, now);

                            seen.goal = copy(goal);

                            return state;
                        };

                        goal.seen = people.seen;

                        if (person !== undefined) {
                            return stopped("person", person);
                        }

                        if (plan) {
                            return stopped("plan");
                        }

                        if (held !== undefined) {
                            return stopped("spend", held);
                        }

                        if (goal.round >= goal.maxRounds) {
                            return stopped("max-rounds");
                        }

                        if (goal.deadline !== undefined && now >= goal.deadline) {
                            return stopped("deadline");
                        }

                        // Pi still waits for work (its run, its subagents, a background command): no round is counted
                        // or sent until it ends, or the cap.
                        if (startedAt !== undefined && now - startedAt < SUBAGENT_WAIT_MS) {
                            waiting.start = startedAt;

                            return undefined;
                        }

                        goal.round += 1;

                        return next({ phase: "round", n: goal.round, attempt: 0 });
                    }, context);

                    if (waiting.start === undefined) {
                        break;
                    }

                    await sleepBeforeLook(runtime, waiting.start, busy?.running === true, context);
                }

                announce(id, seen.goal);
            },

            /** Send round `n`, once, and read Pi's answer. */
            round: async (task, runtime, context) => {
                const id = runtime.conversationId;
                const { n, attempt } = task.state.checkpoint;
                const goal = await mine(runtime, context);

                if (goal === undefined || goal.status !== "running") {
                    return runtime.commit(() => finished, context);
                }

                const delivered = await deliver(
                    runtime,
                    roundMessage(goal, n, runtime.now()),
                    requestId(goal, `${n}-${attempt}`),
                    context,
                );
                const held = host.heldBack(id);
                const seen: { goal?: Goal } = {};

                await runtime.commit(async (tx) => {
                    const goal = (await tx.doc(GoalDoc, id)).goal;

                    // Stopped with /team-shift stop, or another goal: the round's answer is nobody's to count.
                    if (
                        goal?.driver !== String(runtime.taskId) ||
                        goal.status !== "running" ||
                        delivered === undefined
                    ) {
                        return finished;
                    }

                    const now = runtime.now();
                    const { settled, withdrawn } = delivered;

                    const stopped = (reason: StopReason, detail = "") => {
                        const state = stopIn(goal, reason, detail, now);

                        seen.goal = copy(goal);

                        return state;
                    };

                    if (withdrawn) {
                        return attempt + 1 < MAX_ATTEMPTS
                            ? next({ phase: "round", n, attempt: attempt + 1 })
                            : stopped("failed", "the session dropped the round");
                    }

                    if (settled.status === "unanswered") {
                        if (held !== undefined) {
                            return stopped("spend", held);
                        }

                        // Stop withdraws a queued round and aborts a running one.
                        return settled.reason === "aborted"
                            ? stopped("stopped")
                            : stopped("failed", unanswered(settled));
                    }

                    if (settled.type !== "input") {
                        return finished;
                    }

                    const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                        AssistantMessage | undefined;
                    const { verdict, reason } = parseVerdict(textOf(answer?.content));

                    keep(goal, { n, verdict, reason, at: now });

                    if (verdict === "done") {
                        return goal.check === undefined
                            ? stopped("done", reason)
                            : next({ phase: "check", n });
                    }

                    return verdict === "blocked"
                        ? stopped("blocked", reason)
                        : next({ phase: "decide" });
                }, context);

                announce(id, seen.goal);
            },

            /** Pi said DONE: run the check, at most once for this round. */
            check: async (task, runtime, context) => {
                const id = runtime.conversationId;
                const { n } = task.state.checkpoint;
                const goal = await mine(runtime, context);

                if (goal === undefined || goal.status !== "running" || goal.check === undefined) {
                    return runtime.commit(() => finished, context);
                }

                const memo = `check-${n}`;
                let result = await runtime.memo<CheckResult>(memo, context);

                if (result === undefined) {
                    const started =
                        (await runtime.memo<boolean>(`${memo}-started`, context)) === true;

                    if (!started) {
                        await runtime.memo<boolean>(`${memo}-started`, true, context);
                    }

                    const ran = started ? CUT_OFF : await runCheck(runtime, goal.check, context);

                    result = await runtime.memo<CheckResult>(memo, ran, context);
                }

                const check = result;
                const seen: { goal?: Goal } = {};

                await runtime.commit(async (tx) => {
                    const goal = (await tx.doc(GoalDoc, id)).goal;

                    if (goal?.driver !== String(runtime.taskId) || goal.status !== "running") {
                        return finished;
                    }

                    const round = goal.rounds.find((each) => each.n === n);

                    if (round !== undefined) {
                        round.check = check;
                    }

                    const failures = nextFailures(goal.failures, check, n);

                    if (failures === undefined) {
                        delete goal.failures;
                    } else {
                        goal.failures = failures;
                    }

                    if (!check.passed) {
                        if (goal.failures !== undefined && goal.failures.count >= SAME_FAILURES) {
                            const detail =
                                `the same check failure came ${SAME_FAILURES} times in a row: ${goal.failures.fingerprint}`.slice(
                                    0,
                                    300,
                                );
                            const stopChecks = failedChecks(check);

                            if (stopChecks.length > 0) {
                                goal.stopChecks = stopChecks;
                            } else {
                                delete goal.stopChecks;
                            }

                            const state = stopIn(goal, "blocked", detail, runtime.now());

                            seen.goal = copy(goal);

                            return state;
                        }

                        return next({ phase: "decide" });
                    }

                    const state = stopIn(goal, "done", round?.reason ?? "", runtime.now());

                    seen.goal = copy(goal);

                    return state;
                }, context);

                announce(id, seen.goal);
            },

            /** The summary for the morning, unless a person is there by now, or Pi may not start. */
            summary: async (task, runtime, context) => {
                const id = runtime.conversationId;
                const { attempt } = task.state.checkpoint;
                const goal = await mine(runtime, context);

                if (goal === undefined || goal.status !== "summary") {
                    return runtime.commit(() => finished, context);
                }

                // A person who wrote meanwhile reads the answers themselves.
                const found: { person?: string } = {};

                await runtime.commit(async (tx) => {
                    const goal = (await tx.doc(GoalDoc, id)).goal;

                    if (goal?.driver === String(runtime.taskId)) {
                        const people = await peopleSince(tx, id, goal.seen);

                        goal.seen = people.seen;
                        found.person = people.person;
                    }

                    return undefined;
                }, context);

                const person = found.person ?? (await queuedPerson(runtime, context));
                const skip =
                    person === undefined ? host.heldBack(id) : `${person} is in the session`;
                const delivered =
                    skip === undefined
                        ? await deliver(
                              runtime,
                              summaryMessage(goal),
                              requestId(goal, `summary-${attempt}`),
                              context,
                          )
                        : undefined;

                await runtime.commit(async (tx) => {
                    const goal = (await tx.doc(GoalDoc, id)).goal;

                    if (goal?.driver !== String(runtime.taskId) || goal.status !== "summary") {
                        return finished;
                    }

                    if (delivered?.withdrawn === true && attempt + 1 < MAX_ATTEMPTS) {
                        return next({ phase: "summary", attempt: attempt + 1 });
                    }

                    // A delegated goal's report carries Pi's summary answer, or the reason in words.
                    const answered =
                        delivered !== undefined &&
                        delivered.settled.status === "done" &&
                        delivered.settled.type === "input"
                            ? ((await tx.entry(AssistantEntry, delivered.settled.answer))
                                  ?.model?.[0] as AssistantMessage | undefined)
                            : undefined;
                    const spoken = answered === undefined ? "" : textOf(answered.content).trim();
                    const why = goal.why ?? "it stopped";

                    goal.status = "ended";
                    goal.endedAt = runtime.now();
                    delete goal.driver;

                    if (skip !== undefined) {
                        goal.why = `${goal.why}; no summary: ${skip}`;
                    }

                    if (goal.delegated !== undefined) {
                        return next({
                            phase: "report",
                            text: (spoken === "" ? why : spoken).slice(0, MAX_REPORT),
                        });
                    }

                    return finished;
                }, context);
                changed(id);
            },

            /**
             * Tell the supervisor session of a delegated goal that it stopped. The goal's driver is gone, so this does
             * not use mine(). The send's key is the task's: a restart reruns the phase and sends only once. With the
             * desk on, the report is filed on the thread in the same commit, and the supervisor gets its one line; with
             * the digest on, the desk holds the line for the next digest, and this sends nothing.
             */
            report: async (task, runtime, context) => {
                const id = runtime.conversationId;
                const text = task.state.checkpoint.text;
                const goal = (await runtime.snapshot(GoalDoc, id, context))?.goal;
                const report = goal === undefined ? undefined : reportMessage(goal, text);
                const found: {
                    address?: string;
                    filed?: { line: string; held?: boolean };
                } = {};
                const desk = deskApi();
                // The summary's PRs are read before the commit: the check reads GitHub, and no network runs inside a
                // commit. A restart reruns this phase, which is safe: the check only reads, and `file` is replay-safe
                // by its key, so the thread gets each PR and each event once.
                const line = desk?.prs?.(text);
                const missing = line === undefined && desk?.prs !== undefined;

                if (missing) {
                    host.notice(
                        "warning",
                        "The shift summary has no PRS line: its PRs are not attached to the desk thread.",
                        id,
                    );
                }

                const check =
                    line === undefined || line.refs.length === 0 ? undefined : desk?.checkPrs;
                let checked: { ok: string[]; refused: { ref: string; why: string }[] } | undefined;

                if (check !== undefined && line !== undefined) {
                    try {
                        checked = await check(line.refs);
                    } catch (error) {
                        checked = {
                            ok: [],
                            refused: line.refs.map((ref) => ({
                                ref,
                                why: `the desk could not check it: ${(error as Error).message}`,
                            })),
                        };
                    }
                }

                // A token that is no PR ref is refused as one, so nothing the summary named is dropped in silence.
                const refusedPrs = [
                    ...(line?.bad ?? []).map((ref) => ({
                        ref,
                        why: "it is not a PR ref like owner/name#12",
                    })),
                    ...(checked?.refused ?? []),
                ];
                const okPrs = checked?.ok ?? [];

                await runtime.commit(async (tx) => {
                    found.address = await returnAddress(tx, id);

                    // The summary's own `ASKS FOR BRIAN:` block becomes the desk's asks, by the desk's parser: 1 to 4
                    // of them. More than 4 leaves the decisions in the text alone.
                    const asks = desk?.asks?.(text);

                    if (desk !== undefined && found.address !== undefined && report !== undefined) {
                        found.filed = await desk.file(tx, id, {
                            to: found.address,
                            key: `x.night-shift.report:${runtime.taskId}`,
                            from: "night-shift",
                            text: report,
                            at: runtime.now(),
                            digest: true,
                            ...(goal?.reason === undefined ? {} : { reason: goal.reason }),
                            ...(asks === undefined || asks.length === 0 ? {} : { asks }),
                            ...(okPrs.length === 0 ? {} : { prs: okPrs }),
                            ...(refusedPrs.length === 0 ? {} : { prsRefused: refusedPrs }),
                            ...(missing ? { prsMissing: true as const } : {}),
                        });
                    }

                    return undefined;
                }, context);

                // The report, and the asks that came with it, show on the desk page now.
                if (found.filed !== undefined) {
                    deskApi()?.changed?.();
                }

                if (found.address === undefined) {
                    host.notice(
                        "warning",
                        "The shift could not report: this session has no source session.",
                        id,
                    );
                } else if (report !== undefined && found.filed?.held !== true) {
                    try {
                        await linkedSend(
                            host,
                            id,
                            { to: found.address, message: found.filed?.line ?? report },
                            `x.night-shift.report:${runtime.taskId}`,
                        );
                    } catch (error) {
                        host.notice(
                            "warning",
                            `The shift report did not go: ${(error as Error).message}`,
                            id,
                        );
                    }
                }

                await runtime.commit(() => finished, context);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(async (tx) => {
                const goal = (await tx.doc(GoalDoc, runtime.conversationId)).goal;

                if (goal?.driver === String(runtime.taskId)) {
                    goal.status = "ended";
                    goal.reason ??= "stopped";
                    goal.why ??= "its task was stopped";
                    goal.endedAt = runtime.now();
                    delete goal.driver;
                }

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context),
    });

    // ─── Commands ────────────────────────────────────────────────────────────

    const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

    async function planModeOn(ctx: CommandContext): Promise<boolean> {
        try {
            return (await ctx.snapshot(PlanMode, ctx.conversationId, ctx.context))?.on === true;
        } catch {
            return false;
        }
    }

    async function current(ctx: CommandContext): Promise<Goal | undefined> {
        return (await ctx.snapshot(GoalDoc, ctx.conversationId, ctx.context))?.goal;
    }

    /** Why a worker may not be used, or undefined when the owner's allowed list for subagents holds it. */
    function workerProblem(worker: string | undefined): string | undefined {
        if (worker === undefined) {
            return undefined;
        }

        const allowed = host.subagentModels();

        return allowed.includes(worker)
            ? undefined
            : `${worker} is not in the owner's allowed list for subagents. Allowed: ${allowed.join(", ") || "none"}.`;
    }

    /** Start (or go on with) a goal's driver, in a commit. */
    async function drive(tx: Tx, id: ConversationId, goal: Goal): Promise<void> {
        goal.seen = await newestEntry(tx, id);
        const task = await tx.createTask(
            Driver,
            { goalId: goal.id },
            {
                ownership: { kind: "conversation" },
                conversationId: id,
                background: true,
            },
        );

        goal.driver = String(task);
    }

    /**
     * Set a goal for a session that `team_delegate` started, in the caller's commit: the identity and the goal land in
     * one durable step. The key names the goal, so a call that runs again finds it instead of setting a second one.
     */
    async function setDelegated(
        tx: Tx,
        id: ConversationId,
        request: GoalRequest,
        who: { by: string; byName: string; supervisor: string },
        key: string,
    ): Promise<Goal> {
        const doc = await tx.doc(GoalDoc, id);
        const goalId = createHash("sha256").update(key).digest("hex").slice(0, 8);

        // The same key is the same goal: a replay adds no second goal and no second driver.
        if (doc.goal?.id === goalId) {
            return copy(doc.goal);
        }

        if (doc.goal?.status === "running" || doc.goal?.status === "summary") {
            throw new Error("A shift runs here. /team-shift stop ends it first.");
        }

        const unallowed = workerProblem(request.worker);

        if (unallowed !== undefined) {
            throw new Error(unallowed);
        }

        let plan = false;

        try {
            plan = (await tx.doc(PlanMode, id)).on === true;
        } catch {
            plan = false;
        }

        if (plan) {
            throw new Error("Plan mode is on. Turn it off first: a shift works, it does not plan.");
        }

        const held = host.heldBack(id);

        if (held !== undefined) {
            throw new Error(`Pi cannot start: ${held}.`);
        }

        // The supervisor's address, for the rounds: the linked session's first message names it. None: the old words.
        const address = await returnAddress(tx, id).catch(() => undefined);

        // A thinking level goes only with a worker, and only a level Pi knows: anything else is left out, never refused
        // (the linked session runs already).
        const { workerThinking, ...rest } = request;
        const thinking =
            request.worker !== undefined &&
            typeof workerThinking === "string" &&
            WORKER_THINKING.includes(workerThinking)
                ? { workerThinking }
                : {};

        const goal: Goal = {
            id: goalId,
            ...rest,
            ...thinking,
            by: who.by,
            byName: who.byName,
            setAt: Date.now(),
            status: "running",
            round: 0,
            seen: 0,
            rounds: [],
            delegated: {
                supervisor: who.supervisor,
                ...(address === undefined ? {} : { address }),
            },
        };

        await drive(tx, id, goal);
        doc.goal = goal;

        return copy(goal);
    }

    async function set(request: GoalRequest, ctx: CommandContext) {
        const unallowed = workerProblem(request.worker);

        if (unallowed !== undefined) {
            throw web.error(409, unallowed);
        }

        if (request.check !== undefined && ctx.user.role !== "owner") {
            // The check runs unasked after Pi's DONE, with the owner's rights; Lancet Guard does not see it, as it does
            // not see the owner's own `!` commands. So only the owner may set one.
            throw web.error(403, "Only the owner can set a check command.");
        }

        const held = host.heldBack(ctx.conversationId);

        if (held !== undefined) {
            throw web.error(409, `Pi cannot start: ${held}.`);
        }

        if (await planModeOn(ctx)) {
            throw web.error(
                409,
                "Plan mode is on. Turn it off first: a shift works, it does not plan.",
            );
        }

        const goal = await ctx.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, ctx.conversationId);

            if (doc.goal?.status === "running" || doc.goal?.status === "summary") {
                throw web.error(409, "A shift is running here. /team-shift stop ends it first.");
            }

            const goal: Goal = {
                id: randomUUID().slice(0, 8),
                ...request,
                by: ctx.user.id,
                byName: ctx.user.name,
                setAt: Date.now(),
                status: "running",
                round: 0,
                seen: 0,
                rounds: [],
            };

            await drive(tx, ctx.conversationId, goal);
            doc.goal = goal;

            return copy(goal);
        });

        changed(ctx.conversationId);

        const begins =
            goal.start === undefined
                ? "Round 1 starts now."
                : `Round 1 starts at ${goal.startLabel}${goal.startWhy === "deepseek-peak" ? ", after DeepSeek's peak hours" : ""}.`;

        return {
            type: "card" as const,
            output: `Shift set. ${begins}\n${statusCard(goal, Date.now())}`,
        };
    }

    /**
     * Tell the supervisor session that a person stopped its delegated goal: best effort, once for this goal and round.
     */
    async function reportFromCommand(ctx: CommandContext, goal: Goal): Promise<void> {
        let address: string | undefined;

        try {
            address = await ctx.commit(async (tx) => returnAddress(tx, ctx.conversationId));
        } catch (error) {
            host.notice(
                "warning",
                `The shift report did not go: ${(error as Error).message}`,
                ctx.conversationId,
            );

            return;
        }

        if (address === undefined) {
            host.notice(
                "warning",
                "The shift could not report: this session has no source session.",
                ctx.conversationId,
            );

            return;
        }

        try {
            await linkedSend(
                host,
                ctx.conversationId,
                {
                    to: address,
                    message: reportMessage(
                        goal,
                        `${ctx.user.name} stopped it with /team-shift stop.`,
                    ),
                },
                `x.night-shift.report:stop:${goal.id}:${goal.round}`,
            );
        } catch (error) {
            host.notice(
                "warning",
                `The shift report did not go: ${(error as Error).message}`,
                ctx.conversationId,
            );
        }
    }

    async function stop(ctx: CommandContext) {
        const goal = await ctx.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, ctx.conversationId);
            const goal = doc.goal;

            if (goal === undefined || goal.status === "ended") {
                return undefined;
            }

            goal.status = "ended";
            goal.reason = "stopped";
            goal.why = `${ctx.user.name} stopped it`;
            goal.endedAt = Date.now();
            delete goal.driver;

            return copy(goal);
        });

        if (goal === undefined) {
            return {
                type: "toast" as const,
                level: "info" as const,
                message: "No shift runs here.",
            };
        }

        changed(ctx.conversationId);

        if (goal.delegated !== undefined) {
            await reportFromCommand(ctx, goal);
        }

        if (goal.round === 0) {
            return {
                type: "card" as const,
                output: `Shift cancelled by ${ctx.user.name} before round 1.`,
            };
        }

        return {
            type: "card" as const,
            output: `Shift stopped by ${ctx.user.name} at round ${goal.round} of ${goal.maxRounds}. A round that runs now finishes; Stop ends it at once.`,
        };
    }

    async function resume(ctx: CommandContext) {
        const before = await current(ctx);
        const unallowed = workerProblem(before?.worker);

        if (unallowed !== undefined) {
            throw web.error(409, unallowed);
        }

        if (before?.check !== undefined && ctx.user.role !== "owner") {
            throw web.error(403, "Only the owner can resume a shift with a check command.");
        }

        const held = host.heldBack(ctx.conversationId);

        if (held !== undefined) {
            throw web.error(409, `Pi cannot start: ${held}.`);
        }

        if (await planModeOn(ctx)) {
            throw web.error(
                409,
                "Plan mode is on. Turn it off first: a shift works, it does not plan.",
            );
        }

        const goal = await ctx.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, ctx.conversationId);
            const goal = doc.goal;

            if (goal === undefined) {
                throw web.error(404, "No shift here to resume.");
            }

            if (goal.status === "running" || goal.status === "summary") {
                throw web.error(409, "The shift runs already.");
            }

            if (goal.reason === "done") {
                throw web.error(409, "That shift is done. Set a new one.");
            }

            if (goal.round >= goal.maxRounds) {
                throw web.error(409, `It used all ${goal.maxRounds} rounds. Set a new one.`);
            }

            if (goal.deadline !== undefined && Date.now() >= goal.deadline) {
                throw web.error(409, `Its deadline ${goal.deadlineLabel} passed. Set a new one.`);
            }

            // Reads before writes: a commit reads its tables before it writes one.
            await drive(tx, ctx.conversationId, goal);
            goal.status = "running";
            delete goal.reason;
            delete goal.why;
            delete goal.endedAt;
            delete goal.stopChecks;

            return copy(goal);
        });

        changed(ctx.conversationId);

        return {
            type: "card" as const,
            output: `Shift resumed by ${ctx.user.name}.\n${statusCard(goal, Date.now())}`,
        };
    }

    const ARGS =
        "[start 06:00] [until 07:00] [max 30] [with provider/model] [check `cmd`]: <objective>; stop when <condition> | status | stop | resume";

    /** What `/team-shift` does: `/night-shift`, its old name, runs the same handler. */
    const handle: Command["handler"] = async (args, ctx) => {
        const parsed = parseArgs(args, Date.now(), zone());

        switch (parsed.kind) {
            case "error":
                throw web.error(400, parsed.message);
            case "help":
                return {
                    type: "card",
                    output: [
                        USAGE,
                        "Example: /team-shift until 07:00 max 30: migrate the API to v2; stop when all tests pass and the PR is open",
                        "Example: /team-shift start 06:00 until 17:00 max 40: <objective>; stop when <condition>",
                        "Example: /team-shift with github-copilot/claude-sonnet-5.5 until 07:00 max 25: <objective>; stop when <condition>",
                        "`for` counts from `start` when it is given, else from now.",
                        "`with provider/model`: run the work in subagents on that model. It must be in Providers → Models for subagents. With `with deepseek/…` and no start, round 1 waits for the end of DeepSeek's peak hours (01:00–04:00 and 06:00–10:00 UTC).",
                    ].join("\n"),
                };
            case "status":
                return { type: "card", output: statusCard(await current(ctx), Date.now()) };
            case "stop":
                return stop(ctx);
            case "resume":
                return resume(ctx);
            case "set":
                return set(parsed.goal, ctx);
        }
    };

    web.command("team-shift", {
        description:
            "Pi works on an objective in rounds until a stop condition, a round limit, or a deadline",
        args: ARGS,
        scope: "conversation",
        handler: handle,
    });

    // The old name stays as an alias: the same handler, and each answer says the new name first.
    web.command("night-shift", {
        description: "The old name of /team-shift: it does the same, and says the new name",
        args: ARGS,
        scope: "conversation",
        handler: async (args, ctx) => {
            try {
                const result = await handle(args, ctx);

                return result.type === "card"
                    ? { ...result, output: `${RENAMED}\n${result.output}` }
                    : { ...result, message: `${RENAMED}\n${result.message}` };
            } catch (error) {
                const status = (error as { status?: unknown }).status;

                // A refusal made with `web.error` reaches the person with its words: they say the new name too.
                if (typeof status === "number") {
                    throw web.error(status, `${RENAMED}\n${(error as Error).message}`);
                }

                throw error;
            }
        },
    });

    // ─── The browser module: an item in the status line ─────────────────────

    web.client("night-shift-web", { access: "view" });

    web.conversationRoute(
        "GET",
        "goal/:conversation",
        async (request) => ({
            goal: goalView(
                (await request.snapshot(GoalDoc, request.conversation.id, request.context))?.goal,
                Date.now(),
            ),
        }),
        { conversation: "conversation", access: "view" },
    );

    // ─── The extension: the prompt section and the driver ───────────────────

    // Another module finds this version here. A new version sets its own before the old one's cleanup runs.
    const api: NightShiftApi = {
        // Version 3 takes `until_at` in `delegatedRequest`; version 4 keeps `workerThinking`.
        version: 4,
        delegatedRequest,
        setDelegated,
        notifyChanged,
        standing,
        zone,
        nextClockTime,
        localMidnight,
        textLimit: SHIFT_TEXT_LIMIT,
        goal: async (read, conversationId, context) => {
            const goal = (await read.snapshot(GoalDoc, conversationId, context))?.goal;

            return goal === undefined
                ? undefined
                : {
                      status: goal.status,
                      round: goal.round,
                      maxRounds: goal.maxRounds,
                      ...(goal.why === undefined ? {} : { why: goal.why }),
                  };
        },
    };
    const shared = globalThis as unknown as Record<symbol, NightShiftApi | undefined>;

    shared[API] = api;
    web.onDispose(() => {
        if (shared[API] === api) {
            delete shared[API];
        }
    });

    return defineExtension({
        name: "night-shift",
        sections: [
            section("night-shift", async (input, context) => {
                const goal = (await input.read.snapshot(GoalDoc, input.conversationId, context))
                    ?.goal;

                if (goal?.status !== "running" || goal.round === 0) {
                    // Not before round 1: a person can talk to Pi during the wait, and the STATUS-line rules are for
                    // rounds only.
                    return undefined;
                }

                const limits = [
                    `at most ${goal.maxRounds} rounds`,
                    ...(goal.deadline === undefined ? [] : [`until ${goal.deadlineLabel}`]),
                ].join(", ");

                return [
                    "This session runs a shift: you work on the objective below in rounds while the people are away. Each round starts with a message that begins with [shift].",
                    `<objective>\n${host.text.defang(goal.objective)}\n</objective>`,
                    `<stop-condition>\n${host.text.defang(goal.stop)}\n</stop-condition>`,
                    `Limits: ${limits}.`,
                    ...workerLines(goal),
                    "End every answer in a round with one status line, the last line of the answer:",
                    "STATUS: DONE: <why the stop condition holds>",
                    "STATUS: CONTINUE: <what is left>",
                    "STATUS: BLOCKED: <what only a person can fix>",
                    `Say DONE only when the stop condition holds.${goal.check === undefined ? "" : ` Then \`${goal.check}\` runs in the working directory, and it must pass too.`}`,
                    "Say BLOCKED when you cannot go on without a person: plan mode is on, Lancet Guard or a person refused a call, or a sign-in or credential is missing. Lancet Guard and plan mode apply as always: never work around them.",
                    "Do not ask questions and wait for an answer: nobody reads them until the morning. Make reasonable choices, and note them.",
                    "Never call the built-in `ask` tool in a round: its card waits for a person, and the round waits with it, past the deadline. Write each decision for Brian in text instead: in your summary when the shift stops (in its ASKS FOR BRIAN line, when it asks for one), or in the asks of team_message when your task allows it.",
                ].join("\n");
            }),
        ],
        tasks: [Driver],
    });
}
