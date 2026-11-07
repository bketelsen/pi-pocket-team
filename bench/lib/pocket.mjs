// The desk threads that can become bench tasks, read from Pocket's database (read only, as the daily audit opens it):
// each thread's PRs, its route (Jev's numbers, when the router recorded them), and its brief.
import { homedir } from "node:os";
import { join } from "node:path";
import { docsOfKind, foldDocument, loadDesk, openPocket, textOf } from "../../audit/sources.mjs";

/** Pocket's database: `<PI_POCKET_DIR or ~/.pi-pocket>/pocket.sqlite`. */
export const pocketDb = (env = process.env) =>
    join(env.PI_POCKET_DIR || join(homedir(), ".pi-pocket"), "pocket.sqlite");

/** The line of the delegation wrapper before the task. */
export const TASK_MARK = "Task from the source session:";

/** The end of the delegation wrapper. */
const WRAPPER_END = "</linked-session-message>";

/** The paragraph a night-shift delegation adds after the task. */
const NIGHT_SHIFT_TAIL = "This task runs as a night shift.";

/**
 * The task of a delegation's first message: the text after the line `Task from the source session:` and before
 * `</linked-session-message>`, with a trailing night-shift paragraph taken off. The agent identity block and the
 * wrapper are not part of it (the router's `features()` sees only the task too). Null when the marker is missing or
 * the task is empty.
 */
export function delegationTask(text) {
    const value = String(text ?? "");
    const at = value.indexOf(TASK_MARK);

    if (at < 0) {
        return null;
    }

    let task = value.slice(at + TASK_MARK.length);
    const end = task.lastIndexOf(WRAPPER_END);

    if (end >= 0) {
        task = task.slice(0, end);
    }

    const tail = task.lastIndexOf(`\n${NIGHT_SHIFT_TAIL}`);

    if (tail >= 0) {
        task = task.slice(0, tail);
    }

    task = task.trim();

    return task === "" ? null : task;
}

/** A night-shift goal as a brief: the objective, a blank line, then `Stop when: <stop>`. Null with no objective. */
export function goalBrief(goal) {
    const objective = String(goal?.objective ?? "").trim();

    if (objective === "") {
        return null;
    }

    const stop = String(goal?.stop ?? "").trim();

    return stop === "" ? objective : `${objective}\n\nStop when: ${stop}`;
}

/** The text of the first user message of a conversation, or null. */
export function firstUserText(db, conversation) {
    const row = db
        .prepare(
            "select record from entries where conversation_id=? and json_extract(record,'$.kind')='pi.user' order by id limit 1",
        )
        .get(conversation);

    return row ? textOf(JSON.parse(row.record)) : null;
}

/** Jev's judgments of a stored route, for `features()`; undefined when the route has none. */
export function routeJudgments(route) {
    const numbers = ["complexity", "capability", "deepReasoning"];

    if (
        typeof route?.kind !== "string" ||
        !numbers.every((key) => typeof route[key] === "number" && Number.isFinite(route[key]))
    ) {
        return undefined;
    }

    return {
        kind: route.kind,
        complexity: route.complexity,
        capability: route.capability,
        deepReasoning: route.deepReasoning,
    };
}

/**
 * The threads of the desk, each with `{ id, session, prs: [ref], route, nightShift, brief, briefSource }`. A thread of
 * a night shift (a `x.night-shift.goal` document owned by its session) has its goal as its brief; any other thread
 * has the task of its first user message.
 */
export function loadThreads(db) {
    const { threads } = loadDesk(db);
    const goals = new Map();

    for (const doc of docsOfKind(db, "x.night-shift.goal", { retired: true })) {
        const goal = foldDocument(db, doc.id)?.goal;

        if (goal) {
            goals.set(doc.owner_id, goal);
        }
    }

    return Object.values(threads)
        .map((thread) => {
            const goal = thread.session === undefined ? undefined : goals.get(thread.session);
            const nightShift = goal !== undefined;
            let brief = nightShift ? goalBrief(goal) : null;
            let briefSource = nightShift ? "night-shift" : "delegation";

            if (brief === null && thread.session !== undefined) {
                brief = delegationTask(firstUserText(db, thread.session));
                briefSource = "delegation";
            }

            return {
                id: thread.id,
                session: thread.session ?? null,
                prs: Object.keys(thread.prs ?? {}),
                route: thread.route ?? null,
                nightShift,
                brief,
                briefSource,
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Open the database read-only and load the threads. */
export function readThreads(file = pocketDb()) {
    const db = openPocket(file);

    try {
        return loadThreads(db);
    } finally {
        db.close();
    }
}
