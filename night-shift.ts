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
 * - A `start` time is a durable sleep in the task's `wait` phase, before round 1: a restart sleeps again until the
 *   stored start, and a server that was down past it starts round 1 at once. Round 1 starts only in `decide`.
 *
 * State is one document per conversation, `x.night-shift.goal`. It is stored data: never rename it or change what a
 * field means.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    type ConversationId,
    defineDoc,
    defineExtension,
    defineTask,
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

const PREFIX = "[night-shift]";

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
};

export const GoalDoc = defineDoc<{ goal?: Goal }>({
    kind: "x.night-shift.goal",
    version: 1,
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
    initial: () => ({ on: false }),
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
};

export type Parsed =
    | { kind: "status" | "stop" | "resume" | "help" }
    | { kind: "set"; goal: GoalRequest }
    | { kind: "error"; message: string };

export const USAGE =
    "/night-shift [start 06:00] [until 07:00 | for 8h] [max 30] [check `npm test`]: <objective>; stop when <condition>\n" +
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
const STOP_WHEN = /\bstop\s+(?:only\s+)?when\b/gi;

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

    let rest = args;
    let maxRounds: number | undefined;
    let start: { hour: number; minute: number } | undefined;
    let until: { hour: number; minute: number } | undefined;
    let forMinutes: number | undefined;
    let check: string | undefined;
    const error = (message: string): Parsed => ({ kind: "error", message });
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
        } else {
            break;
        }

        rest = rest.slice(match[0].length);
    }

    // Times resolve here, after the loop, so that the options can come in any order.
    const startAt =
        start === undefined ? undefined : nextClockTime(start.hour, start.minute, now, zone);

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

    rest = rest.replace(/^\s*:/, "").trim();
    const stops = [...rest.matchAll(STOP_WHEN)];
    const last = stops.at(-1);

    if (last === undefined) {
        return error(`Say when to stop: "…; stop when <condition>".\n${USAGE}`);
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
        return error(`Say what to do before "stop when".\n${USAGE}`);
    }

    if (stop === "") {
        return error(`Say the stop condition after "stop when".\n${USAGE}`);
    }

    if (objective.length + stop.length > MAX_TEXT) {
        return error(`The objective and the stop condition are limited to ${MAX_TEXT} characters.`);
    }

    return {
        kind: "set",
        goal: {
            objective,
            stop,
            maxRounds: maxRounds ?? DEFAULT_ROUNDS,
            ...(check === undefined ? {} : { check }),
            ...(startAt === undefined
                ? {}
                : { start: startAt, startLabel: clockLabel(startAt, zone) }),
            ...(deadline === undefined
                ? {}
                : { deadline, deadlineLabel: clockLabel(deadline, zone) }),
        },
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
 * `[via …]`), schedules, subagent reports, and Done when's checks.
 */
const AUTOMATED = /^\[(?:night-shift\]|via |scheduled\]|subagent |goal\] )/;

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
        "Work toward the objective now. End your answer with one status line: STATUS: DONE, STATUS: CONTINUE, or STATUS: BLOCKED, then the reason.",
    ].join("\n");
}

export function summaryMessage(goal: Goal): string {
    return [
        `${PREFIX} The night shift has stopped: ${goal.why}. It took ${goal.round} of ${goal.maxRounds} rounds.`,
        "Do not start new work. Write the summary for the morning, in three short parts: what you did, what is left, and why the work stopped.",
        "Do not end with a STATUS line.",
    ].join("\n");
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
    | { phase: "summary"; attempt: number };
type Runtime = TaskRuntime<DriverInput, DriverState, null, object>;

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

export default function createNightShift(host: Host, web: Web) {
    const changed = (id: ConversationId) => web.send("changed", { conversation: Number(id) });

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
             * Before round 1: a durable sleep until the goal's start time, if it has one. A restart sleeps again until
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

                        await runtime.sleep(
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

            /** Before each round: a person's message, plan mode, a spend limit, the rounds, and the deadline. */
            decide: async (_task, runtime, context) => {
                const id = runtime.conversationId;
                const queued = await queuedPerson(runtime, context);
                const plan = await planOn(runtime, context);
                const held = host.heldBack(id);
                const seen: { goal?: Goal } = {};

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

                    goal.round += 1;

                    return next({ phase: "round", n: goal.round, attempt: 0 });
                }, context);

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

                    goal.status = "ended";
                    goal.endedAt = runtime.now();
                    delete goal.driver;

                    if (skip !== undefined) {
                        goal.why = `${goal.why}; no summary: ${skip}`;
                    }

                    return finished;
                }, context);
                changed(id);
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

    /** Start (or go on with) a goal's driver, in a commit. */
    async function drive(tx: Tx, ctx: CommandContext, goal: Goal): Promise<void> {
        goal.seen = await newestEntry(tx, ctx.conversationId);
        const task = await tx.createTask(
            Driver,
            { goalId: goal.id },
            {
                ownership: { kind: "conversation" },
                conversationId: ctx.conversationId,
                background: true,
            },
        );

        goal.driver = String(task);
    }

    async function set(request: GoalRequest, ctx: CommandContext) {
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

            await drive(tx, ctx, goal);
            doc.goal = goal;

            return copy(goal);
        });

        changed(ctx.conversationId);

        const begins =
            goal.start === undefined
                ? "Round 1 starts now."
                : `Round 1 starts at ${goal.startLabel}.`;

        return {
            type: "card" as const,
            output: `Night shift set. ${begins}\n${statusCard(goal, Date.now())}`,
        };
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
            await drive(tx, ctx, goal);
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
        args: "[start 06:00] [until 07:00] [max 30] [check `cmd`]: <objective>; stop when <condition> | status | stop | resume",
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
                            "`for` counts from `start` when it is given, else from now.",
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
