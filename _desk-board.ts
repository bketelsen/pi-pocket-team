/**
 * The goal board: 1 small durable queue of shift rows per supervisor, kept in `board` on `x.desk.threads`. Agents add
 * their own proposals as rows, the supervisor orders and notes them, Brian picks, and a launch request moves the picks
 * to `waiting`; the desk's launch pass then starts each one through Team's `startShift`, under the limits, and staggers
 * what does not fit.
 *
 * This file holds the pure rules: the fields and their bounds, the states and moves, the permissions, the revisions,
 * the times, the claim decision, the pruning and the settings. It reads no clock and no zone of its own: the caller
 * gives `now` and the shift module's clock math (`BoardClock`), so a test can use another zone and a daylight saving
 * date. `desk.ts` loads it with the cache-busting search, as it loads its other `_` helpers; it imports nothing at run
 * time.
 *
 * Stored data: never rename a field or change what it means; add new ones beside them.
 */

// ─── Stored shape ────────────────────────────────────────────────────────────

/** What a row is for: the shift's kind of work. */
export const BOARD_KINDS = ["goal", "hygiene", "grooming", "sweep", "feature", "quality"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/** Where a row is: see `BOARD_MOVES`. */
export type BoardRowState =
    "proposed" | "picked" | "waiting" | "starting" | "launched" | "failed" | "unknown" | "dropped";

/** A shift's PR check, in the shape of `shift.pr_check`: Team checks it in full at the start. */
export type BoardPrCheck = {
    pr?: number;
    repo?: string;
    checks?: "required" | "all" | "none";
    label?: string;
};

/** 1 start attempt. `outcome` is absent while the attempt is in flight (the row is `starting`). */
export type BoardAttempt = {
    n: number;
    at: number;
    outcome?: "started" | "cap" | "refused" | "unknown";
    thread?: string;
    error?: string;
    /**
     * The minutes from the claim to the row's until. Stored data: kept, but it no longer drives the run. The start
     * sends the row's `untilAt` as the shift's absolute stop `until_at`.
     */
    minutes?: number;
};

/** 1 row. Stored data: never rename a field. */
export type BoardRow = {
    id: number;
    /** The supervisor's conversation id. */
    supervisor: number;
    /** Starts at 1; +1 at each edit. */
    rev: number;
    state: BoardRowState;
    /** The roster id that added it, or "brian". */
    by: string;
    at: number;
    changedAt: number;
    // The editable fields.
    agent: string;
    repo?: string;
    title: string;
    task: string;
    objective?: string;
    stopWhen: string;
    max: number;
    until: string;
    start?: string;
    worker?: string;
    prCheck?: BoardPrCheck;
    kind: BoardKind;
    note?: string;
    order: number;
    // Set at the pick.
    /** The rev the pick bound to. */
    pickedRev?: number;
    startAt?: number;
    untilAt?: number;
    attempts: BoardAttempt[];
    thread?: string;
    launchedAt?: number;
    error?: string;
};

/** A replayed call: its key, when, and the text it gave. */
export type BoardKey = { key: string; at: number; text: string };

/**
 * The board on `x.desk.threads`. `keys` is the old place of the replay keys: it is read as a fallback (a key written
 * before `x.desk.board-receipts`), gets no new key, and loses its entries older than `BOARD_KEY_MS` when a commit
 * touches the board. Stored data: never rename it.
 */
export type Board = { next: number; rows: BoardRow[]; keys?: BoardKey[] };

/** 1 board call's receipt in `x.desk.board-receipts`: its key, when, and the text it gave. */
export type BoardReceipt = { key: string; at: number; result: string };

/** 1 supervisor's receipts in `x.desk.board-receipts`. Stored data: never rename a field. */
export type BoardReceiptsState = { receipts: BoardReceipt[] };

// ─── Limits and settings ─────────────────────────────────────────────────────

export const MAX_BOARD_TITLE = 120;
export const MAX_BOARD_TASK = 6000;
export const MAX_BOARD_OBJECTIVE = 3000;
export const MAX_BOARD_STOP = 3000;
export const MAX_BOARD_NOTE = 500;
export const MAX_BOARD_ROUNDS = 100;
/** How long a board call's receipt is kept, by age only (no count limit): 30 days. */
export const BOARD_KEY_MS = 30 * 24 * 3600_000;
/** How far ahead of the server's clock a page key's time may be: 10 minutes. */
export const BOARD_KEY_AHEAD_MS = 10 * 60_000;
/** A row with less time than this left to its until at its claim fails. */
export const BOARD_MIN_LEFT_MS = 10 * 60_000;

export type BoardSettings = { atOnce: number; rounds: number; reserve: number; keep: number };

const SETTING_BOUNDS: Record<keyof BoardSettings, { min: number; max: number; fallback: number }> =
    {
        atOnce: { min: 1, max: 16, fallback: 8 },
        rounds: { min: 1, max: 1000, fallback: 250 },
        reserve: { min: 0, max: 10, fallback: 2 },
        keep: { min: 1, max: 90, fallback: 14 },
    };

/** The defaults: 8 at once, 250 rounds a day, 2 slots kept free, rows kept 14 days. */
export const BOARD_DEFAULTS: BoardSettings = {
    atOnce: SETTING_BOUNDS.atOnce.fallback,
    rounds: SETTING_BOUNDS.rounds.fallback,
    reserve: SETTING_BOUNDS.reserve.fallback,
    keep: SETTING_BOUNDS.keep.fallback,
};

/**
 * The `board` key of `desk.json`: each value an integer in its bounds, else its default with 1 warning. An absent key
 * or value is the default with no warning.
 */
export function boardSettings(raw: unknown): { settings: BoardSettings; warnings: string[] } {
    const settings = { ...BOARD_DEFAULTS };
    const warnings: string[] = [];

    if (raw === undefined || raw === null) {
        return { settings, warnings };
    }

    if (typeof raw !== "object" || Array.isArray(raw)) {
        return {
            settings,
            warnings: ["desk.json board must be an object: the board uses its defaults."],
        };
    }

    for (const name of Object.keys(SETTING_BOUNDS) as (keyof BoardSettings)[]) {
        const value = (raw as Record<string, unknown>)[name];
        const bounds = SETTING_BOUNDS[name];

        if (value === undefined) {
            continue;
        }

        if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= bounds.min &&
            value <= bounds.max
        ) {
            settings[name] = value;
            continue;
        }

        warnings.push(
            `desk.json board.${name} must be a whole number from ${String(bounds.min)} to ${String(bounds.max)}: ${JSON.stringify(value) ?? "?"} is not, so the board uses ${String(bounds.fallback)}.`,
        );
    }

    return { settings, warnings };
}

// ─── Times ───────────────────────────────────────────────────────────────────

/** The shift module's zone and clock math: the board has none of its own. */
export type BoardClock = {
    zone: string;
    /** The first instant strictly after `now` at which the clock in `zone` shows `hour:minute`. */
    nextClockTime: (hour: number, minute: number, now: number, zone: string) => number;
    /** Local midnight in `zone` of the day that holds `now`. */
    midnight: (now: number, zone: string) => number;
};

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** `HH:MM` as hour and minute, or undefined. */
export function clockOf(text: string): { hour: number; minute: number } | undefined {
    const match = CLOCK.exec(text);

    return match === null ? undefined : { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The first instant at or after `now` whose local time is `text` (`HH:MM`). */
export function atOrAfter(text: string, now: number, clock: BoardClock): number | undefined {
    const parts = clockOf(text);

    return parts === undefined
        ? undefined
        : clock.nextClockTime(parts.hour, parts.minute, now - 1, clock.zone);
}

/** The times a pick sets, or why the pick is refused. */
export function pickTimes(
    row: Pick<BoardRow, "id" | "until" | "start">,
    now: number,
    clock: BoardClock,
): { untilAt: number; startAt?: number } | { error: string } {
    const untilAt = atOrAfter(row.until, now, clock);

    if (untilAt === undefined) {
        return { error: `Row ${String(row.id)}: until must be a time as HH:MM.` };
    }

    if (row.start === undefined) {
        return { untilAt };
    }

    const startAt = atOrAfter(row.start, now, clock);

    if (startAt === undefined) {
        return { error: `Row ${String(row.id)}: start must be a time as HH:MM.` };
    }

    if (startAt >= untilAt) {
        return {
            error: `Row ${String(row.id)}: start ${row.start} is not before until ${row.until} from now: change start or until, then pick it again.`,
        };
    }

    return { untilAt, startAt };
}

// ─── Fields ──────────────────────────────────────────────────────────────────

/** The fields a person or an agent writes. */
export const BOARD_EDITABLE = [
    "agent",
    "repo",
    "title",
    "task",
    "objective",
    "stopWhen",
    "max",
    "until",
    "start",
    "worker",
    "prCheck",
    "kind",
    "note",
    "order",
] as const;
export type BoardField = (typeof BOARD_EDITABLE)[number];

/** The fields an add needs. The supervisor also names `agent`; an agent's own row takes its id. */
const REQUIRED: BoardField[] = ["title", "task", "stopWhen", "max", "until"];
/** The fields that may be cleared with null in an edit. */
const OPTIONAL: BoardField[] = ["repo", "objective", "start", "worker", "prCheck", "note"];

/** The roster as the board checks it. */
export type BoardMember = { id: string; role: string; repositories: Record<string, string> };

/** Who acts on the board. */
export type BoardActor =
    | { kind: "supervisor"; supervisor: number; by: string }
    | { kind: "agent"; supervisor: number; agent: string };

const flatText = (text: string) => text.replace(/\s+/g, " ").trim();
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LABEL = /^[A-Za-z0-9 ._:/+-]{1,50}$/;

type Checked = Partial<Omit<BoardRow, "prCheck">> & { prCheck?: BoardPrCheck };

/**
 * The fields of 1 add or edit, checked: the values to set, the names to clear (`null` in an edit), or the first
 * problem. A field the actor may not write is refused, with its name.
 */
export function checkFields(
    fields: unknown,
    context: {
        actor: BoardActor;
        roster: readonly BoardMember[];
        models: readonly string[];
        /** The row an edit changes: its agent decides `repo`. */
        row?: BoardRow;
    },
): { set: Checked; clear: BoardField[] } | { error: string } {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
        return { error: "fields must be an object of row fields." };
    }

    const given = fields as Record<string, unknown>;
    const set: Checked = {};
    const clear: BoardField[] = [];
    const adding = context.row === undefined;

    for (const name of Object.keys(given)) {
        if (!(BOARD_EDITABLE as readonly string[]).includes(name)) {
            return {
                error: `${name} is not a row field: use ${BOARD_EDITABLE.join(", ")}.`,
            };
        }
    }

    if (context.actor.kind === "agent") {
        for (const name of ["note", "order"] as const) {
            if (given[name] !== undefined) {
                return { error: `An agent cannot set ${name}: the supervisor sets it.` };
            }
        }

        if (!adding && given.agent !== undefined) {
            return { error: "An agent cannot change agent on a row." };
        }

        if (adding && given.agent !== undefined && given.agent !== context.actor.agent) {
            return {
                error: `An agent adds only its own rows: agent must be ${context.actor.agent}.`,
            };
        }
    }

    const text = (name: BoardField, max: number, min = 1): string | { error: string } => {
        const value = given[name];

        if (typeof value !== "string") {
            return {
                error: `${name} must be text of ${String(min)} to ${String(max)} characters.`,
            };
        }

        const flat = name === "task" ? value.trim() : flatText(value);

        if (flat.length < min || flat.length > max) {
            return {
                error: `${name} must be text of ${String(min)} to ${String(max)} characters.`,
            };
        }

        return flat;
    };

    for (const name of Object.keys(given) as BoardField[]) {
        const value = given[name];

        if (value === null) {
            if (adding || !OPTIONAL.includes(name)) {
                return { error: `${name} cannot be cleared.` };
            }

            clear.push(name);
            continue;
        }

        if (value === undefined) {
            continue;
        }

        switch (name) {
            case "agent": {
                const member = context.roster.find((each) => each.id === value);

                if (member === undefined || member.role !== "agent") {
                    return { error: "agent must be a roster id with role agent." };
                }

                set.agent = member.id;
                break;
            }

            case "repo": {
                if (typeof value !== "string" || !REPO.test(value)) {
                    return { error: "repo must be owner/name." };
                }

                set.repo = value;
                break;
            }

            case "title":
            case "task":
            case "objective":
            case "stopWhen":

            case "note": {
                const max = {
                    title: MAX_BOARD_TITLE,
                    task: MAX_BOARD_TASK,
                    objective: MAX_BOARD_OBJECTIVE,
                    stopWhen: MAX_BOARD_STOP,
                    note: MAX_BOARD_NOTE,
                }[name];
                const checked = text(name, max);

                if (typeof checked !== "string") {
                    return checked;
                }

                set[name] = checked;
                break;
            }

            case "max": {
                if (
                    typeof value !== "number" ||
                    !Number.isInteger(value) ||
                    value < 1 ||
                    value > MAX_BOARD_ROUNDS
                ) {
                    return {
                        error: `max must be a whole number from 1 to ${String(MAX_BOARD_ROUNDS)}.`,
                    };
                }

                set.max = value;
                break;
            }

            case "until":

            case "start": {
                if (typeof value !== "string" || clockOf(value.trim()) === undefined) {
                    return { error: `${name} must be a time as HH:MM, such as 06:45.` };
                }

                set[name] = value.trim();
                break;
            }

            case "worker": {
                if (typeof value !== "string" || !context.models.includes(value)) {
                    return {
                        error: `worker must be on the owner's allowed list for subagents: ${context.models.join(", ") || "none"}.`,
                    };
                }

                set.worker = value;
                break;
            }

            case "prCheck": {
                const checked = prCheckOf(value);

                if ("error" in checked) {
                    return checked;
                }

                set.prCheck = checked.value;
                break;
            }

            case "kind": {
                if (
                    typeof value !== "string" ||
                    !(BOARD_KINDS as readonly string[]).includes(value)
                ) {
                    return { error: `kind must be one of ${BOARD_KINDS.join(", ")}.` };
                }

                set.kind = value as BoardKind;
                break;
            }

            case "order": {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    return { error: "order must be a number." };
                }

                set.order = value;
                break;
            }
        }
    }

    if (adding) {
        for (const name of REQUIRED) {
            if (set[name] === undefined) {
                return { error: `board_add needs ${name}.` };
            }
        }

        if (context.actor.kind === "agent") {
            set.agent = context.actor.agent;
        } else if (set.agent === undefined) {
            return { error: "board_add needs agent: a roster id with role agent." };
        }
    }

    // The repository must be one of the row's agent's, after this change.
    const agent = set.agent ?? context.row?.agent;
    const repo = clear.includes("repo") ? undefined : (set.repo ?? context.row?.repo);

    if (repo !== undefined && agent !== undefined) {
        const member = context.roster.find((each) => each.id === agent);

        if (member === undefined || !Object.hasOwn(member.repositories, repo)) {
            return {
                error: `repo must be one of ${agent}'s repositories: ${Object.keys(member?.repositories ?? {}).join(", ") || "none"}.`,
            };
        }
    }

    return { set, clear };
}

/** A PR check's shape, as `shift.pr_check` takes it. */
function prCheckOf(value: unknown): { value: BoardPrCheck } | { error: string } {
    const problem = {
        error: "prCheck must be { pr?, repo?, checks?, label? }: pr a whole number, repo owner/name, checks required, all or none, label up to 50 letters, digits, spaces and . _ : / + -.",
    };

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return problem;
    }

    const given = value as Record<string, unknown>;
    const out: BoardPrCheck = {};

    for (const name of Object.keys(given)) {
        if (!["pr", "repo", "checks", "label"].includes(name)) {
            return problem;
        }
    }

    if (given.pr !== undefined) {
        if (typeof given.pr !== "number" || !Number.isInteger(given.pr) || given.pr < 1) {
            return problem;
        }

        out.pr = given.pr;
    }

    if (given.repo !== undefined) {
        if (typeof given.repo !== "string" || !REPO.test(given.repo)) {
            return problem;
        }

        out.repo = given.repo;
    }

    if (given.checks !== undefined) {
        if (given.checks !== "required" && given.checks !== "all" && given.checks !== "none") {
            return problem;
        }

        out.checks = given.checks;
    }

    if (given.label !== undefined) {
        if (typeof given.label !== "string" || !LABEL.test(given.label)) {
            return problem;
        }

        out.label = given.label;
    }

    return { value: out };
}

// ─── Moves ───────────────────────────────────────────────────────────────────

/** The rows of 1 supervisor in launch order: `order`, then `id`. */
export function boardRows(board: Board | undefined, supervisor: number): BoardRow[] {
    return (board?.rows ?? [])
        .filter((row) => row.supervisor === supervisor)
        .sort((a, b) => a.order - b.order || a.id - b.id);
}

/** A board operation's refusal: the words, and the status a route answers with. */
export type BoardRefusal = { error: string; status: 400 | 403 | 409 };

/** The operations on the board, as the tool and the page call them. */
export type BoardOp =
    | { op: "add"; fields: unknown }
    | { op: "edit"; row: unknown; rev?: unknown; fields: unknown }
    | { op: "drop"; row: unknown; rev?: unknown }
    | { op: "pick"; rows: unknown }
    | { op: "unpick"; rows: unknown }
    | { op: "launch"; rows?: unknown }
    | { op: "reopen"; row: unknown; rev?: unknown }
    | { op: "resolve"; row: unknown; rev?: unknown; thread?: unknown };

/** What a board operation needs besides the board: the roster, the allowed models, the clock and the threads. */
export type BoardOpContext = {
    roster: readonly BoardMember[];
    models: readonly string[];
    /** Absent: a pick is refused (the shift module is off or too old). */
    clock?: BoardClock;
    /** The supervisor of a thread on the desk, or undefined when there is no such thread. */
    threadSupervisor: (id: string) => number | undefined;
};

/** The stale-revision refusal. */
export function staleText(row: BoardRow): string {
    return `Row ${String(row.id)} changed (rev ${String(row.rev)} now): read it with desk board, then pick again.`;
}

const refuse = (error: string, status: BoardRefusal["status"] = 400): BoardRefusal => ({
    error,
    status,
});

/** A row id as a number, or undefined. */
const rowId = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
        ? value
        : typeof value === "string" && /^#?[1-9][0-9]*$/.test(value.trim())
          ? Number(value.trim().replace(/^#/, ""))
          : undefined;

/** `rows` as a list of `{ row, rev }`, or a refusal. */
function rowRevs(value: unknown): { row: number; rev: number }[] | BoardRefusal {
    if (!Array.isArray(value) || value.length === 0) {
        return refuse("rows must be a list of { row, rev }, at least 1.");
    }

    const out: { row: number; rev: number }[] = [];

    for (const each of value) {
        const id = rowId((each as { row?: unknown } | null)?.row);
        const rev = (each as { rev?: unknown } | null)?.rev;

        if (id === undefined || typeof rev !== "number" || !Number.isInteger(rev)) {
            return refuse("rows must be a list of { row, rev }: row a row id, rev a whole number.");
        }

        if (out.some((seen) => seen.row === id)) {
            return refuse(`Row ${String(id)} is in rows twice.`);
        }

        out.push({ row: id, rev });
    }

    return out;
}

/**
 * The row an operation names, checked for its owner, the actor's rights and the revision. An agent acts only on its own
 * `proposed` rows.
 */
function rowFor(
    board: Board,
    actor: BoardActor,
    id: unknown,
    rev: unknown,
): BoardRow | BoardRefusal {
    const number = rowId(id);

    if (number === undefined) {
        return refuse("row must be a row id, such as 3.");
    }

    const row = board.rows.find((each) => each.id === number);

    if (row === undefined || row.supervisor !== actor.supervisor) {
        return refuse(`There is no row ${String(number)} on this board.`, 403);
    }

    if (actor.kind === "agent" && (row.agent !== actor.agent || row.state !== "proposed")) {
        return refuse(
            `Row ${String(row.id)} is not your own proposed row: an agent changes only its own proposed rows.`,
            403,
        );
    }

    if (rev !== undefined && rev !== row.rev) {
        return refuse(staleText(row), 409);
    }

    return row;
}

const wrongState = (row: BoardRow, op: string, from: string): BoardRefusal =>
    refuse(`Row ${String(row.id)} is ${row.state}: ${op} takes a ${from} row.`, 409);

const supervisorOnly = (op: string): BoardRefusal =>
    refuse(`Only the supervisor can ${op} rows.`, 403);

/** Clear what a pick set: an edit, an unpick and a reopen send a row back to `proposed`. */
function backToProposed(row: BoardRow, now: number): void {
    row.state = "proposed";
    delete row.pickedRev;
    delete row.startAt;
    delete row.untilAt;
    row.changedAt = now;
}

/**
 * 1 operation on 1 supervisor's board, in the caller's commit: the rules of every move, the permissions and the
 * revisions. It changes `board` only when it succeeds; a refusal changes nothing. It gives the rows it changed (an add
 * gives its new row), or a refusal with its status.
 */
export function boardOp(
    board: Board,
    actor: BoardActor,
    op: BoardOp,
    context: BoardOpContext,
    now: number,
): { rows: BoardRow[] } | BoardRefusal {
    const agentOps = ["add", "edit", "drop"];

    if (actor.kind === "agent" && !agentOps.includes(op.op)) {
        return supervisorOnly(op.op);
    }

    switch (op.op) {
        case "add": {
            const checked = checkFields(op.fields, {
                actor,
                roster: context.roster,
                models: context.models,
            });

            if ("error" in checked) {
                return refuse(checked.error);
            }

            const id = board.next;
            const set = checked.set;
            const row: BoardRow = {
                id,
                supervisor: actor.supervisor,
                rev: 1,
                state: "proposed",
                by: actor.kind === "agent" ? actor.agent : actor.by,
                at: now,
                changedAt: now,
                agent: set.agent ?? "",
                ...(set.repo === undefined ? {} : { repo: set.repo }),
                title: set.title ?? "",
                task: set.task ?? "",
                ...(set.objective === undefined ? {} : { objective: set.objective }),
                stopWhen: set.stopWhen ?? "",
                max: set.max ?? 1,
                until: set.until ?? "",
                ...(set.start === undefined ? {} : { start: set.start }),
                ...(set.worker === undefined ? {} : { worker: set.worker }),
                ...(set.prCheck === undefined ? {} : { prCheck: set.prCheck }),
                kind: set.kind ?? "goal",
                ...(set.note === undefined ? {} : { note: set.note }),
                order: set.order ?? id * 10,
                attempts: [],
            };

            board.next = id + 1;
            board.rows.push(row);

            return { rows: [row] };
        }

        case "edit": {
            const row = rowFor(board, actor, op.row, op.rev);

            if ("status" in row) {
                return row;
            }

            if (row.state !== "proposed" && row.state !== "picked" && row.state !== "waiting") {
                return wrongState(row, "edit", "proposed, picked or waiting");
            }

            const checked = checkFields(op.fields, {
                actor,
                roster: context.roster,
                models: context.models,
                row,
            });

            if ("error" in checked) {
                return refuse(checked.error);
            }

            const target = row as Record<string, unknown>;

            for (const [name, value] of Object.entries(checked.set)) {
                target[name] = value;
            }

            for (const name of checked.clear) {
                delete target[name];
            }

            row.rev += 1;

            // An edit of a pick or a waiting launch sends the row back: it is picked again at its new revision.
            if (row.state === "picked" || row.state === "waiting") {
                backToProposed(row, now);
            }

            row.changedAt = now;

            return { rows: [row] };
        }

        case "drop": {
            const row = rowFor(board, actor, op.row, op.rev);

            if ("status" in row) {
                return row;
            }

            if (row.state !== "proposed" && row.state !== "picked" && row.state !== "waiting") {
                return refuse(
                    row.state === "starting"
                        ? `Row ${String(row.id)} is starting: it cannot be dropped. Stop its run in its own session (/team-shift stop or Stop).`
                        : `Row ${String(row.id)} is ${row.state}: drop takes a proposed, picked or waiting row.`,
                    409,
                );
            }

            row.state = "dropped";
            row.changedAt = now;

            return { rows: [row] };
        }

        case "pick":
        case "unpick":

        case "launch": {
            const named =
                op.op === "launch" && op.rows === undefined
                    ? boardRows(board, actor.supervisor)
                          .filter((row) => row.state === "picked")
                          .map((row) => ({ row: row.id, rev: row.rev }))
                    : rowRevs(op.rows);

            if (!Array.isArray(named)) {
                return named;
            }

            if (op.op === "pick" && context.clock === undefined) {
                return refuse(
                    "The shift module is off or too old for the board: a pick needs its clock. Brian turns it on or installs the new version.",
                    409,
                );
            }

            const from = op.op === "pick" ? "proposed" : "picked";
            const rows: BoardRow[] = [];
            const times: { untilAt: number; startAt?: number }[] = [];

            // Every row is checked before any changes: 1 refusal refuses the whole call.
            for (const each of named) {
                const row = rowFor(board, actor, each.row, each.rev);

                if ("status" in row) {
                    return row;
                }

                if (row.state !== from) {
                    return wrongState(row, op.op, from);
                }

                if (op.op === "pick" && context.clock !== undefined) {
                    const picked = pickTimes(row, now, context.clock);

                    if ("error" in picked) {
                        return refuse(picked.error);
                    }

                    times.push(picked);
                }

                rows.push(row);
            }

            rows.forEach((row, index) => {
                if (op.op === "pick") {
                    const picked = times[index]!;

                    row.state = "picked";
                    row.pickedRev = row.rev;
                    row.untilAt = picked.untilAt;

                    if (picked.startAt === undefined) {
                        delete row.startAt;
                    } else {
                        row.startAt = picked.startAt;
                    }

                    row.changedAt = now;
                } else if (op.op === "unpick") {
                    backToProposed(row, now);
                } else {
                    row.state = "waiting";
                    row.changedAt = now;
                }
            });

            return { rows };
        }

        case "reopen": {
            const row = rowFor(board, actor, op.row, op.rev);

            if ("status" in row) {
                return row;
            }

            if (row.state !== "failed") {
                return wrongState(row, "reopen", "failed");
            }

            delete row.error;
            backToProposed(row, now);

            return { rows: [row] };
        }

        case "resolve": {
            const row = rowFor(board, actor, op.row, op.rev);

            if ("status" in row) {
                return row;
            }

            if (row.state !== "unknown") {
                return wrongState(row, "resolve", "unknown");
            }

            if (op.thread === undefined || op.thread === null || op.thread === "") {
                row.state = "failed";
                row.error = row.error ?? "resolved as failed";
                row.changedAt = now;

                return { rows: [row] };
            }

            const thread = typeof op.thread === "string" ? op.thread.trim().toUpperCase() : "";
            const owner = context.threadSupervisor(thread);

            if (owner === undefined || owner !== actor.supervisor) {
                return refuse(
                    `There is no thread ${thread || String(op.thread)} of this supervisor on the desk.`,
                );
            }

            row.state = "launched";
            row.thread = thread;
            row.launchedAt = now;
            delete row.error;
            row.changedAt = now;

            return { rows: [row] };
        }
    }
}

// ─── Replay keys ─────────────────────────────────────────────────────────────

/**
 * The text a replayed call gave, or undefined for a new call: its receipt in `x.desk.board-receipts`, else (a key
 * written before that document) its entry in the old `board.keys`.
 */
export function boardReplay(
    receipts: BoardReceiptsState | undefined,
    board: Board | undefined,
    key: string,
): string | undefined {
    return (
        receipts?.receipts.find((each) => each.key === key)?.result ??
        board?.keys?.find((each) => each.key === key)?.text
    );
}

/**
 * Keep a call's receipt, in the commit of its change: the receipts older than `BOARD_KEY_MS` go first. There is no
 * count limit, so a replay after any number of other calls still finds its receipt.
 */
export function keepBoardReceipt(
    receipts: BoardReceiptsState,
    key: string,
    result: string,
    now: number,
): void {
    receipts.receipts = receipts.receipts.filter((each) => now - each.at < BOARD_KEY_MS);
    receipts.receipts.push({ key, at: now, result });
}

/**
 * Keep a call's receipt for its supervisor in `x.desk.board-receipts` (`supervisors`, keyed by the supervisor's
 * conversation id), in the commit of its change. Every supervisor's receipts older than `BOARD_KEY_MS` go first, and a
 * supervisor with none left goes; there is no count limit.
 */
export function keepBoardReceipts(
    supervisors: Record<string, BoardReceiptsState>,
    supervisor: string,
    key: string,
    result: string,
    now: number,
): void {
    for (const [id, receipts] of Object.entries(supervisors)) {
        if (id === supervisor) {
            continue;
        }

        receipts.receipts = receipts.receipts.filter((each) => now - each.at < BOARD_KEY_MS);

        if (receipts.receipts.length === 0) {
            delete supervisors[id];
        }
    }

    supervisors[supervisor] ??= { receipts: [] };
    keepBoardReceipt(supervisors[supervisor], key, result, now);
}

/** Drop the old `board.keys` entries older than `BOARD_KEY_MS`; the field goes when it is empty. */
export function pruneBoardKeys(board: Board, now: number): void {
    if (board.keys === undefined) {
        return;
    }

    board.keys = board.keys.filter((each) => now - each.at < BOARD_KEY_MS);

    if (board.keys.length === 0) {
        delete board.keys;
    }
}

/** The refusal of a page key that is too old to replay, or not made by the Board view. */
export const BOARD_KEY_TOO_OLD = "This request is too old to replay: load the board again.";

/**
 * Whether a page POST's key may act: it starts with the page's time in ms (`<ms>-<random>`), and that time is less
 * than 30 days old and at most `BOARD_KEY_AHEAD_MS` ahead of `now`. Else the 409 refusal, so an expired key never acts
 * again. The age limit is `BOARD_KEY_MS` less `BOARD_KEY_AHEAD_MS`: a key whose time was up to 10 minutes ahead of its
 * receipt's is refused before that receipt is pruned.
 */
export function boardPageKeyRefusal(key: string, now: number): BoardRefusal | undefined {
    const match = /^([0-9]{1,16})-./.exec(key);
    const at = match === null ? NaN : Number(match[1]);

    if (
        !Number.isSafeInteger(at) ||
        now - at >= BOARD_KEY_MS - BOARD_KEY_AHEAD_MS ||
        at - now > BOARD_KEY_AHEAD_MS
    ) {
        return { error: BOARD_KEY_TOO_OLD, status: 409 };
    }

    return undefined;
}

// ─── The launch pass's rules ─────────────────────────────────────────────────

/** A launched row's run still works: the caller reads its thread. */
export type RowRuns = (row: BoardRow) => boolean;

/** How many of the supervisor's rows run now: `starting`, and `launched` whose run still works. */
export function runningCount(board: Board | undefined, supervisor: number, runs: RowRuns): number {
    return boardRows(board, supervisor).filter(
        (row) => row.state === "starting" || (row.state === "launched" && runs(row)),
    ).length;
}

/** The rounds the supervisor's rows took today: the `max` of each row starting, or launched since `midnight`. */
export function roundsToday(
    board: Board | undefined,
    supervisor: number,
    midnight: number,
): number {
    return boardRows(board, supervisor)
        .filter(
            (row) =>
                row.state === "starting" ||
                (row.state === "launched" && (row.launchedAt ?? 0) >= midnight),
        )
        .reduce((sum, row) => sum + row.max, 0);
}

/** What a claim decided for 1 row. */
export type BoardClaim =
    | { claim: "claimed"; n: number; minutes: number }
    | { claim: "full" }
    | { claim: "later" }
    | { claim: "failed"; error: string }
    | { claim: "gone" };

/** The attempt number of a new attempt: the last one's again after a full desk, else 1 more. */
export function nextAttempt(row: BoardRow): number {
    const last = row.attempts.at(-1);

    return last === undefined ? 1 : last.outcome === "cap" ? last.n : last.n + 1;
}

/**
 * The claim of 1 waiting row, in the caller's commit that read the board again: a row with a future `startAt` waits;
 * a row with less than 10 minutes to its until fails; the supervisor at `atOnce` runs stops the pass; a row over the
 * day's round budget fails; else the row is `starting`, with its new attempt.
 */
export function claimRow(
    board: Board,
    rowIdValue: number,
    now: number,
    limits: { settings: BoardSettings; midnight: number; runs: RowRuns },
): BoardClaim {
    const row = board.rows.find((each) => each.id === rowIdValue);

    if (row === undefined || row.state !== "waiting") {
        return { claim: "gone" };
    }

    if (row.startAt !== undefined && row.startAt > now) {
        return { claim: "later" };
    }

    if (row.untilAt === undefined || row.untilAt - now < BOARD_MIN_LEFT_MS) {
        failRow(row, "past its until", now);

        return { claim: "failed", error: "past its until" };
    }

    if (runningCount(board, row.supervisor, limits.runs) >= limits.settings.atOnce) {
        return { claim: "full" };
    }

    if (roundsToday(board, row.supervisor, limits.midnight) + row.max > limits.settings.rounds) {
        failRow(row, "over the day's round budget", now);

        return { claim: "failed", error: "over the day's round budget" };
    }

    const n = nextAttempt(row);
    const minutes = Math.floor((row.untilAt - now) / 60_000);

    // After a full desk the new attempt keeps the number, so its start's key stays the same.
    row.attempts.push({ n, at: now, minutes });
    row.state = "starting";
    delete row.error;
    row.changedAt = now;

    return { claim: "claimed", n, minutes };
}

/** A row that fails, with its error. */
export function failRow(row: BoardRow, error: string, now: number): void {
    row.state = "failed";
    row.error = error;
    row.changedAt = now;
}

/** A start's result, as Team's `startShift` gives it. */
export type BoardStartResult =
    | { thread: string; session: number; address: string; replay: boolean }
    | { error: string; unknown: boolean; deskFull?: true };

/**
 * Record a start's result on its row, in the caller's commit: started → `launched`; a full desk → `waiting` again;
 * a thrown start → `unknown`; a refusal → `failed`. A row that is not `starting` at attempt `n` any more is left as it
 * is. Gives the row's new state, or undefined when nothing changed.
 */
export function recordStart(
    board: Board,
    id: number,
    n: number,
    result: BoardStartResult,
    now: number,
): BoardRowState | undefined {
    const row = board.rows.find((each) => each.id === id);
    const attempt = row?.attempts.at(-1);

    if (row === undefined || row.state !== "starting" || attempt === undefined || attempt.n !== n) {
        return undefined;
    }

    if ("thread" in result) {
        attempt.outcome = "started";
        attempt.thread = result.thread;
        row.state = "launched";
        row.thread = result.thread;
        row.launchedAt = now;
        delete row.error;
    } else if (result.deskFull === true) {
        attempt.outcome = "cap";
        attempt.error = result.error;
        row.state = "waiting";
    } else if (result.unknown) {
        attempt.outcome = "unknown";
        attempt.error = result.error;
        row.state = "unknown";
        row.error = result.error;
    } else {
        attempt.outcome = "refused";
        attempt.error = result.error;
        row.state = "failed";
        row.error = result.error;
    }

    row.changedAt = now;

    return row.state;
}

/** The start's key of a row's attempt. */
export const boardStartKey = (id: number, n: number) => `x.desk.board:${String(id)}:${String(n)}`;

/** The 1 message to the supervisor for a failed or unknown row. */
export const boardNotifyText = (row: BoardRow) =>
    `[desk] board row ${String(row.id)} (${row.agent}) ${row.state}: ${row.error ?? ""}`;

/** Whether a supervisor's board needs its sweeper: a row `waiting`, `starting` or `unknown`. */
export function boardKeepsSweeper(board: Board | undefined, supervisor: number): boolean {
    return (board?.rows ?? []).some(
        (row) =>
            row.supervisor === supervisor &&
            (row.state === "waiting" || row.state === "starting" || row.state === "unknown"),
    );
}

/** Remove the rows `launched`, `failed` or `dropped` for `keep` days since `changedAt`. Gives how many went. */
export function pruneBoard(board: Board | undefined, now: number, keep: number): number {
    if (board === undefined) {
        return 0;
    }

    const before = board.rows.length;
    const limit = keep * 24 * 3600_000;

    board.rows = board.rows.filter(
        (row) =>
            !(
                (row.state === "launched" || row.state === "failed" || row.state === "dropped") &&
                now - row.changedAt >= limit
            ),
    );

    return before - board.rows.length;
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** The limits now, in 1 line. */
export function limitsLine(facts: {
    settings: BoardSettings;
    running: number;
    cap: number;
    counted: number;
    rounds: number;
}): string {
    return `${String(facts.settings.atOnce)} at once, ${String(facts.running)} running · cap ${String(facts.cap)}, ${String(facts.counted)} count, ${String(facts.settings.reserve)} kept free · ${String(facts.rounds)} of ${String(facts.settings.rounds)} rounds today`;
}

/** 1 row on 1 line, for `desk board`. */
export function rowLine(
    row: BoardRow,
    label: (ms: number) => string,
    thread?: { id: string; next: string },
): string {
    const parts = [
        `#${String(row.id)} rev ${String(row.rev)} ${row.state}`,
        row.agent + (row.repo === undefined ? "" : ` ${row.repo}`),
        row.kind,
        `max ${String(row.max)}`,
        `until ${row.until}`,
        ...(row.start === undefined ? [] : [`start ${row.start}`]),
        ...(row.untilAt === undefined ? [] : [`ends ${label(row.untilAt)}`]),
        ...(row.startAt === undefined ? [] : [`starts ${label(row.startAt)}`]),
        ...(row.worker === undefined ? [] : [`worker ${row.worker}`]),
        ...(thread === undefined ? [] : [`${thread.id} (next: ${thread.next})`]),
        ...(row.error === undefined ? [] : [`error: ${row.error}`]),
        `order ${String(row.order)}`,
    ];

    return `${parts.join(" · ")}: ${row.title}${row.note === undefined ? "" : ` (note: ${row.note})`}`;
}
