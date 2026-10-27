/**
 * Night shift: Pi works on an objective in rounds while you sleep, and stops when it says the stop condition holds
 * (and an optional check command passes), at a round limit, at a deadline, when a person writes, at Stop, or at a
 * spend limit. Then it writes a summary for the morning. Start one with /night-shift.
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
 * - After round 1, `decide` waits while Pi's own subagents still work (`pocket.subagents`): a round sent then would only
 *   hear "still waiting". One poll is a restart-safe wait, and a memo keyed by the round holds the wait's start, so a
 *   restart waits for the rest of the same hour and no round is counted meanwhile.
 *
 * State is one document per conversation, `x.night-shift.goal`. It is stored data: never rename it or change what a
 * field means.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
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
import type { CommandContext, Host, Web } from "./_pocket.d.ts";

// ─── Limits ──────────────────────────────────────────────────────────────────

export const DEFAULT_ROUNDS = 20;
export const MAX_ROUNDS = 100;
/** The longest a deadline can be from now. */
const MAX_HOURS = 24;
const MAX_COMMAND = 2000;
const MAX_TEXT = 3000;
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

/** How often `decide` looks again while Pi's own subagents work. */
export const SUBAGENT_POLL_MS = 15_000;
/** The longest `decide` waits for them before one round: after it, the round goes anyway. */
export const SUBAGENT_WAIT_MS = 60 * 60_000;

const PREFIX = "[night-shift]";
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
    /** The task that drives the goal now; another task that finds this changed stops. */
    driver?: string;
    endedAt?: number;
    /**
     * Set by `team_delegate`: the goal belongs to a linked session, and when it stops the driver reports to the
     * source session of that linked session.
     */
    delegated?: { supervisor: string };
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
};

export type Parsed =
    | { kind: "status" | "stop" | "resume" | "help" }
    | { kind: "set"; goal: GoalRequest }
    | { kind: "error"; message: string };

export const USAGE =
    "/night-shift [start 06:00] [until 07:00 | for 8h] [max 30] [with provider/model] [check `npm test`]: <objective>; stop when <condition>\n" +
    "/night-shift status | stop | resume";

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

/** The next time the clock in `zone` shows `hour:minute`, after `now`. */
export function nextClockTime(hour: number, minute: number, now: number, zone: string): number {
    const today = partsIn(now, zone);
    const at = wallTime(today.year, today.month, today.day, hour, minute, zone);

    if (at > now) {
        return at;
    }

    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));

    return wallTime(
        tomorrow.getUTCFullYear(),
        tomorrow.getUTCMonth() + 1,
        tomorrow.getUTCDate(),
        hour,
        minute,
        zone,
    );
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

/** What the options of `/night-shift` set, and the text after them. */
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
 * Parse what follows `/night-shift`. Options come first, in any order; then an optional `:`, then the objective and
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

    if (objective.length + stop.length > MAX_TEXT) {
        return {
            kind: "error",
            message: `The objective and the stop condition are limited to ${MAX_TEXT} characters.`,
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

/** The fields of `night_shift` in the `team_delegate` tool. */
export type DelegatedFields = {
    objective: string;
    stop_when: string;
    start?: string;
    until?: string;
    for?: string;
    max?: number;
    worker?: string;
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
 * The goal request for a night shift that `team_delegate` starts. Each option comes from its own field, so a field
 * cannot carry a second option: the check never comes from this path (only the owner sets one, with `/night-shift`).
 * The options combine here, so `until` after `start`, `for` from `start`, and one of `until`/`for` hold as usual.
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

    if (objective.length + stop.length > MAX_TEXT) {
        return {
            error: `The objective and the stop condition are limited to ${MAX_TEXT} characters.`,
        };
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
                error: "night_shift.worker must be only a provider/model, such as github-copilot/claude-sonnet-5.5.",
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
                error: `night_shift.${name} must be only ${OPTION_ALONE[name].word}.`,
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
            error:
                "error" in options ? options.error : "night_shift must not carry another option.",
        };
    }

    return {
        objective,
        stop,
        maxRounds: options.maxRounds ?? DEFAULT_ROUNDS,
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
const AUTOMATED = /^\[(?:night-shift\]|via |scheduled\]|subagent |goal\] |background\] )/;

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
              ]),
        "Work toward the objective now. End your answer with one status line: STATUS: DONE, STATUS: CONTINUE, or STATUS: BLOCKED, then the reason.",
    ].join("\n");
}

/** An item that names nothing for Brian: "none", "nothing left", "no". */
const NO_ASK_ITEM = /^(?:no|none|nothing)\b/i;

/** An item that only asks for a merge, an install, a tag, or a review, with no choice: `ready-for-human` covers it. */
const ROUTINE_ASK = /\b(?:merge|install|tag|review)\b/i;

/** The words of a choice in an item: a merge request with one of them is still a decision. */
const ASK_CHOICE = /\bor\b|which|whether/i;

/** The words of an `ASKS FOR BRIAN:` line: its items are the label of the block. */
const ASKS_BRIAN_LINE = /^asks\s+for\s+brian\s*:\s*(.*)$/i;

/** The lines of a text without its fenced code: a fence opens on 3 or more backticks or tildes and closes on the same. */
function withoutFences(text: string): string[] {
    const kept: string[] = [];
    let fence: { mark: string; length: number } | undefined;

    for (const line of text.split(/\r\n?|\n/)) {
        if (fence === undefined) {
            const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);

            if (open === null) {
                kept.push(line);
            } else {
                fence = { mark: open[1]![0]!, length: open[1]!.length };
                kept.push("");
            }

            continue;
        }

        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);

        if (close !== null && close[1]![0] === fence.mark && close[1]!.length >= fence.length) {
            fence = undefined;
        }

        kept.push("");
    }

    return kept;
}

/** The options of an item that ends with `[a | b]`: 2 to 6 of 1 to 40 characters each, and its question before them. */
function askOptions(item: string): { question: string; options: string[] } | undefined {
    const bracket = /^(.*?)\[([^\]]*)\]\s*$/.exec(item);

    if (bracket === null) {
        return undefined;
    }

    const question = bracket[1]!.trim();
    const options = bracket[2]!.split("|").map((option) => option.trim());
    const good =
        question !== "" &&
        options.length >= 2 &&
        options.length <= 6 &&
        options.every((option) => option !== "" && option.length <= 40);

    return good ? { question, options } : undefined;
}

/**
 * The asks of the last `ASKS FOR BRIAN:` block in a summary: the rest of that line, then each non-empty line under it up
 * to the first blank line, with its list mark removed. Lines in fenced code are not read. An item that starts with
 * `none`, `nothing`, or `no` is left out, and so is a plain merge, install, tag, or review request with no choice, so
 * `ASKS FOR BRIAN: none` gives []. An item that ends with `[a | b]` gives its options, and the text before them is the
 * question. Undefined when there is no such line, or when there are more than 4 items: the text alone holds the thread
 * then.
 */
export function asksForBrian(text: string): { question: string; options?: string[] }[] | undefined {
    const lines = withoutFences(text);
    let start: number | undefined;
    let rest = "";

    for (const [index, line] of lines.entries()) {
        const bare = line
            .replace(/^[\s>#*-]+/, "")
            .replace(/\*+/g, "")
            .trim();
        const found = ASKS_BRIAN_LINE.exec(bare);

        if (found !== null) {
            start = index;
            rest = found[1]!.trim();
        }
    }

    if (start === undefined) {
        return undefined;
    }

    const items = rest === "" ? [] : [rest];

    for (const line of lines.slice(start + 1)) {
        if (line.trim() === "") {
            break;
        }

        const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();

        if (item !== "") {
            items.push(item);
        }
    }

    const asks: { question: string; options?: string[] }[] = [];

    for (const item of items) {
        if (NO_ASK_ITEM.test(item) || (ROUTINE_ASK.test(item) && !ASK_CHOICE.test(item))) {
            continue;
        }

        const choice = askOptions(item);

        asks.push(choice ?? { question: item });
    }

    return asks.length > 4 ? undefined : asks;
}

export function summaryMessage(goal: Goal): string {
    const rounds =
        goal.worker === undefined
            ? `It took ${goal.round} of ${goal.maxRounds} rounds.`
            : `It took ${goal.round} of ${goal.maxRounds} rounds, with subagents on ${goal.worker}.`;

    return [
        `${PREFIX} The night shift has stopped: ${goal.why}. ${rounds}`,
        "Do not start new work. Write the summary for the morning, in three short parts: what you did, what is left, and why the work stopped.",
        ...(goal.delegated === undefined
            ? []
            : [
                  `Write it in ASD-STE100 (Simplified Technical English): it goes to ${goal.delegated.supervisor}.`,
                  `This summary is your shift report. It goes to ${goal.delegated.supervisor} by itself: do not send a separate team_message report. Answer a later message from ${goal.delegated.supervisor} as usual.`,
                  'End the summary with a line "ASKS FOR BRIAN:" and 1 line under it for each decision Brian must make, with its options in [a | b] when it is a pick-one. Write "ASKS FOR BRIAN: none" when there is none. A merge or install request is no decision.',
              ]),
        "Do not end with a STATUS line.",
    ].join("\n");
}

/** What a delegated goal sends back to the supervisor session of its linked session when it stops. */
function reportMessage(goal: Goal, text: string): string {
    const progress =
        goal.worker === undefined ? "" : `\nRounds: ${goal.round}, worker: ${goal.worker}.`;

    return `Night shift report from this linked session: stopped at round ${goal.round} of ${goal.maxRounds}: ${goal.why ?? "it stopped"}.${progress}\n\n${text}`;
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

/** Whether `/night-shift resume` can go on with a goal: it stopped, not done, with rounds and time left. */
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
        return `No night shift in this session.\n${USAGE}`;
    }

    const lines = [
        `Night shift: ${standing(goal, now)}.`,
        `Objective: ${goal.objective}`,
        `Stop when: ${goal.stop}`,
        ...(goal.check === undefined ? [] : [`Check: ${goal.check}`]),
        ...(goal.worker === undefined ? [] : [`Worker: ${goal.worker}`]),
        `Set by ${goal.byName}.`,
    ];

    if (goal.rounds.length > 0) {
        lines.push("Rounds:");

        for (const round of goal.rounds.slice(-10)) {
            const check =
                round.check === undefined
                    ? ""
                    : round.check.cutOff
                      ? " · check cut off"
                      : ` · check ${round.check.passed ? "passed" : `failed (exit ${round.check.code})`}`;

            lines.push(
                `  ${round.n}. ${VERDICT_WORD[round.verdict]}${round.reason === "" ? "" : ` ${round.reason}`}${check}`,
            );
        }
    }

    if (waiting(goal, now)) {
        lines.push("/night-shift stop cancels it.");
    } else if (goal.status === "running" || goal.status === "summary") {
        lines.push(
            "/night-shift stop ends it after the current round. Stop ends the current round now.",
        );
    } else if (resumable(goal, now)) {
        lines.push("/night-shift resume goes on.");
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
        case "done":
            return goal.check === undefined
                ? "Pi says the stop condition holds"
                : `Pi says the stop condition holds, and \`${goal.check}\` passes`;
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
    version: 1;
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
            },
        ) => Promise<{ line: string; held?: boolean } | undefined>;
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
            host.notice(
                "warning",
                `Night shift paused: ${goal.why}. /night-shift resume goes on.`,
                id,
            );
        } else if (goal.status === "ended") {
            host.notice(
                goal.reason === "failed" ? "error" : "info",
                `Night shift ended: ${goal.why}.`,
                id,
            );
        } else if (goal.status === "summary") {
            host.notice("info", `Night shift stopped: ${goal.why}. Pi writes the summary.`, id);
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

    /**
     * Sleep until the next look at the subagents, or until the end of this round's wait. A goal that stops or another
     * driver that takes over ends the sleep, as in `wait`.
     */
    async function sleepBeforeLook(
        runtime: Runtime,
        startedAt: number,
        context: Context,
    ): Promise<void> {
        const id = runtime.conversationId;
        const until = Math.min(runtime.now() + SUBAGENT_POLL_MS, startedAt + SUBAGENT_WAIT_MS);
        const controller = new AbortController();
        const watch = await runtime.watchDoc(GoalDoc, id, context);

        try {
            if (watch !== undefined) {
                const look = async (value: Readonly<{ goal?: Goal }> | null) => {
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

            await sleepInPhase(runtime, until, withAbortSignal(controller.signal, context));
        } catch (failure) {
            // The goal stopped, or another driver took over. Any other rejection is not ours to swallow.
            if (!controller.signal.aborted) {
                throw failure;
            }
        } finally {
            await watch?.stop();
        }
    }

    /**
     * While Pi's own subagents work after round 1: the start of this round's wait, from a memo keyed by the round, or
     * undefined when they are done (or before round 2). The memo makes the wait restart-safe: a restart goes on with the
     * same hour, and no round is counted meanwhile. `decide` gives up the wait after `SUBAGENT_WAIT_MS`.
     */
    async function subagentWaitStart(
        runtime: Runtime,
        context: Context,
    ): Promise<number | undefined> {
        const goal = await mine(runtime, context);

        if (goal === undefined || goal.status !== "running" || goal.round === 0) {
            return undefined;
        }

        if (!(await subagentsBusy(runtime, context))) {
            return undefined;
        }

        return runtime.memo<number>(`subagents-${goal.round}`, runtime.now(), context);
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
                const strand = async (live: NonNullable<typeof watch>["value"]) => {
                    if (live !== null && live.run === undefined) {
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
                            const look = async (value: Readonly<{ goal?: Goal }> | null) => {
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
             * 1, Pi's own subagents. While they work, a poll sleeps and looks again; every poll runs the stop checks.
             */
            decide: async (_task, runtime, context) => {
                const id = runtime.conversationId;
                const seen: { goal?: Goal } = {};

                for (;;) {
                    const queued = await queuedPerson(runtime, context);
                    const plan = await planOn(runtime, context);
                    const held = host.heldBack(id);
                    // Read before the commit, which reads documents only through `tx`.
                    const startedAt = await subagentWaitStart(runtime, context);
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

                        // Pi's own subagents still work: no round is counted or sent until they stop, or the cap.
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

                    await sleepBeforeLook(runtime, waiting.start, context);
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

                    // Stopped with /night-shift stop, or another goal: the round's answer is nobody's to count.
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

                    if (!check.passed) {
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
                const found: { address?: string; filed?: { line: string; held?: boolean } } = {};

                await runtime.commit(async (tx) => {
                    found.address = await returnAddress(tx, id);

                    const desk = deskApi();
                    // The summary's own `ASKS FOR BRIAN:` block becomes the desk's asks: 1 to 4 of them. More than
                    // 4 leaves the decisions in the text alone.
                    const asks = asksForBrian(text);

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
                        });
                    }

                    return undefined;
                }, context);

                if (found.address === undefined) {
                    host.notice(
                        "warning",
                        "The night shift could not report: this session has no source session.",
                        id,
                    );
                } else if (report !== undefined && found.filed?.held !== true) {
                    try {
                        await host.linkedSessions.send(
                            id,
                            { to: found.address, message: found.filed?.line ?? report },
                            `x.night-shift.report:${runtime.taskId}`,
                        );
                    } catch (error) {
                        host.notice(
                            "warning",
                            `The night shift report did not go: ${(error as Error).message}`,
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
            throw new Error("A night shift runs here. /night-shift stop ends it first.");
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
            throw new Error(
                "Plan mode is on. Turn it off first: a night shift works, it does not plan.",
            );
        }

        const held = host.heldBack(id);

        if (held !== undefined) {
            throw new Error(`Pi cannot start: ${held}.`);
        }

        const goal: Goal = {
            id: goalId,
            ...request,
            by: who.by,
            byName: who.byName,
            setAt: Date.now(),
            status: "running",
            round: 0,
            seen: 0,
            rounds: [],
            delegated: { supervisor: who.supervisor },
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
                "Plan mode is on. Turn it off first: a night shift works, it does not plan.",
            );
        }

        const goal = await ctx.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, ctx.conversationId);

            if (doc.goal?.status === "running" || doc.goal?.status === "summary") {
                throw web.error(
                    409,
                    "A night shift is running here. /night-shift stop ends it first.",
                );
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
            output: `Night shift set. ${begins}\n${statusCard(goal, Date.now())}`,
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
                `The night shift report did not go: ${(error as Error).message}`,
                ctx.conversationId,
            );

            return;
        }

        if (address === undefined) {
            host.notice(
                "warning",
                "The night shift could not report: this session has no source session.",
                ctx.conversationId,
            );

            return;
        }

        try {
            await host.linkedSessions.send(
                ctx.conversationId,
                {
                    to: address,
                    message: reportMessage(
                        goal,
                        `${ctx.user.name} stopped it with /night-shift stop.`,
                    ),
                },
                `x.night-shift.report:stop:${goal.id}:${goal.round}`,
            );
        } catch (error) {
            host.notice(
                "warning",
                `The night shift report did not go: ${(error as Error).message}`,
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
                message: "No night shift runs here.",
            };
        }

        changed(ctx.conversationId);

        if (goal.delegated !== undefined) {
            await reportFromCommand(ctx, goal);
        }

        if (goal.round === 0) {
            return {
                type: "card" as const,
                output: `Night shift cancelled by ${ctx.user.name} before round 1.`,
            };
        }

        return {
            type: "card" as const,
            output: `Night shift stopped by ${ctx.user.name} at round ${goal.round} of ${goal.maxRounds}. A round that runs now finishes; Stop ends it at once.`,
        };
    }

    async function resume(ctx: CommandContext) {
        const before = await current(ctx);
        const unallowed = workerProblem(before?.worker);

        if (unallowed !== undefined) {
            throw web.error(409, unallowed);
        }

        if (before?.check !== undefined && ctx.user.role !== "owner") {
            throw web.error(403, "Only the owner can resume a night shift with a check command.");
        }

        const held = host.heldBack(ctx.conversationId);

        if (held !== undefined) {
            throw web.error(409, `Pi cannot start: ${held}.`);
        }

        if (await planModeOn(ctx)) {
            throw web.error(
                409,
                "Plan mode is on. Turn it off first: a night shift works, it does not plan.",
            );
        }

        const goal = await ctx.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, ctx.conversationId);
            const goal = doc.goal;

            if (goal === undefined) {
                throw web.error(404, "No night shift here to resume.");
            }

            if (goal.status === "running" || goal.status === "summary") {
                throw web.error(409, "The night shift runs already.");
            }

            if (goal.reason === "done") {
                throw web.error(409, "That night shift is done. Set a new one.");
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

            return copy(goal);
        });

        changed(ctx.conversationId);

        return {
            type: "card" as const,
            output: `Night shift resumed by ${ctx.user.name}.\n${statusCard(goal, Date.now())}`,
        };
    }

    web.command("night-shift", {
        description:
            "Pi works on an objective in rounds until a stop condition, a round limit, or a deadline",
        args: "[start 06:00] [until 07:00] [max 30] [with provider/model] [check `cmd`]: <objective>; stop when <condition> | status | stop | resume",
        scope: "conversation",
        handler: async (args, ctx) => {
            const parsed = parseArgs(args, Date.now(), zone());

            switch (parsed.kind) {
                case "error":
                    throw web.error(400, parsed.message);
                case "help":
                    return {
                        type: "card",
                        output: [
                            USAGE,
                            "Example: /night-shift until 07:00 max 30: migrate the API to v2; stop when all tests pass and the PR is open",
                            "Example: /night-shift start 06:00 until 17:00 max 40: <objective>; stop when <condition>",
                            "Example: /night-shift with github-copilot/claude-sonnet-5.5 until 07:00 max 25: <objective>; stop when <condition>",
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
        version: 1,
        delegatedRequest,
        setDelegated,
        notifyChanged,
        standing,
        zone,
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
                    "This session runs a night shift: you work on the objective below in rounds while the people are away. Each round starts with a message that begins with [night-shift].",
                    `<objective>\n${host.text.defang(goal.objective)}\n</objective>`,
                    `<stop-condition>\n${host.text.defang(goal.stop)}\n</stop-condition>`,
                    `Limits: ${limits}.`,
                    ...(goal.worker === undefined
                        ? []
                        : [
                              `For this goal, give execution to subagents on \`${goal.worker}\`. This replaces the DeepSeek Flash rule for this goal. If \`${goal.worker}\` cannot be used, end with STATUS: BLOCKED. Do not pick another model.`,
                          ]),
                    "End every answer in a round with one status line, the last line of the answer:",
                    "STATUS: DONE: <why the stop condition holds>",
                    "STATUS: CONTINUE: <what is left>",
                    "STATUS: BLOCKED: <what only a person can fix>",
                    `Say DONE only when the stop condition holds.${goal.check === undefined ? "" : ` Then \`${goal.check}\` runs in the working directory, and it must pass too.`}`,
                    "Say BLOCKED when you cannot go on without a person: plan mode is on, Lancet Guard or a person refused a call, or a sign-in or credential is missing. Lancet Guard and plan mode apply as always: never work around them.",
                    "Do not ask questions and wait for an answer: nobody reads them until the morning. Make reasonable choices, and note them.",
                ].join("\n");
            }),
        ],
        tasks: [Driver],
    });
}
