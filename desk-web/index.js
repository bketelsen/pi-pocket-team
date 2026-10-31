// The Desk page: Brian's inbox for the work the team runs in the background. Phone first, one column. Everything here
// is owner-only: the page, its routes, and the rail badge.

import { makeDashboard } from "./dashboard.js";

export const pocketApi = 1;

const LISTENERS = new Set();
let view = null;
let loadError = null;
/** Brian's last look, from the first GET, before the page posts `seen`: the "new" marks use it. */
let seenBefore = null;
let rail = null;
/** The running module's `pocket`: the shared loader is called from effects and events too. */
let app = null;

/** The groups of the page, in the order it shows them. */
/** `plans` holds plan threads with no open ask: the Plans section shows them, so no thread section does. */
const GROUPS = [
    "closed",
    "parked",
    "need",
    "plans",
    "watching",
    "found",
    "stale",
    "review",
    "working",
];

/**
 * The section a thread goes in. First match: closed with no open ask, parked, an open ask (it needs Brian, and neither
 * a watch nor a found origin hides it, nor does a close: an ask filed on a thread that closed in the same step still
 * shows), a plan thread (the Plans section shows it), asleep, found, Brian, stale, the reviewer.
 */
export const groupOf = (thread) => {
    if (thread.state === "closed") {
        return (thread.asks ?? []).length > 0 ? "need" : "closed";
    }

    if (thread.state === "parked") {
        return "parked";
    }

    if ((thread.asks ?? []).length > 0) {
        return "need";
    }

    if (thread.origin === "plan") {
        return "plans";
    }

    if (thread.asleep) {
        return "watching";
    }

    if (thread.origin === "found") {
        return "found";
    }

    if (thread.next === "brian") {
        return "need";
    }

    if (thread.stale) {
        return "stale";
    }

    if (thread.next === "reviewer") {
        return "review";
    }

    return "working";
};

/** Whether a view is still on the page: an answer that comes after it left changes nothing. */
export const stillMounted = (life) => life?.gone !== true;

/** The body of a page answer: the words, and the generation of a plan ask, which the desk checks. */
export const answerBody = (words, gen) => (typeof gen === "number" ? { words, gen } : { words });

/** A plan row's second line: its state with its asks and lead, or its approval. */
export const planRowLine = (plan) => {
    if (plan === undefined || plan === null) {
        return "";
    }

    if (plan.state === "review") {
        return `review · Approve ${String(plan.rev ?? "").slice(0, 7)}`;
    }

    const asks = plan.asks ?? 0;

    return `${plan.state} · ${asks} ask${asks === 1 ? "" : "s"} · lead ${plan.lead}`;
};

/** A plan view's state line: `drafting · rev 3f2a9c1 · lead lucilla · graph v2: 4 tasks`. */
export const planStateLine = (plan) => {
    const graph = plan.graph;
    const tasks = graph === undefined ? 0 : graph.tasks.length;

    return [
        plan.state,
        `rev ${String(plan.rev ?? "").slice(0, 7)}`,
        `lead ${plan.lead}`,
        graph === undefined
            ? "no graph"
            : `graph v${graph.version}: ${tasks} task${tasks === 1 ? "" : "s"}`,
    ].join(" · ");
};

/** The approve button's words: `Approve 3f2a9c1 + graph v2`. */
export const approveLabel = (plan) =>
    `Approve ${String(plan.rev ?? "").slice(0, 7)} + graph v${plan.graph?.version ?? 1}`;

/** 1 ask of a plan section, as the view lists it: its words, its answer, and whether the write came back. */
export const planAskLine = (ask) => {
    if (ask.open) {
        return `${ask.id}: ${ask.text} · open`;
    }

    // The desk ended it: Brian need not answer it, and no write-back waits.
    if (ask.resolved !== undefined) {
        const how = ask.resolved.by === undefined ? "resolved" : "withdrawn";

        return `${ask.id}: ${ask.text} · ${how}: ${ask.resolved.why}`;
    }

    const answer = ask.answer === undefined ? "" : ` → ${ask.answer.words} (${ask.answer.by})`;

    return `${ask.id}: ${ask.text}${answer}${ask.written ? "" : " · not written"}`;
};

// ─── Plan acts: their keys, the marks matrix, and the New plan form ─────────

/** A new key for 1 act: letters, digits and "-", as the desk's routes take it. */
export const newKey = (act) =>
    `${String(act).replace(/[^A-Za-z0-9_-]/g, "-")}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

/**
 * The key of 1 act in 1 view: made the first time, and the same at each tap after it, so the desk acts once. `keys` is
 * the view's own store.
 */
export const keyFor = (keys, act, make = newKey) => {
    keys[act] ??= make(act);

    return keys[act];
};

/**
 * The key of a form's act: the same while the form holds the same values, and a new one when a value changed, so a
 * resumed start never goes on with other values under an old key.
 */
export const keyForForm = (keys, act, form, make = newKey) => {
    // A payload's key: the same payload keeps it; another one (Brian changed a field after a failed send) gets a new key.
    const values = JSON.stringify(form);
    const known = keys[act];

    if (known === undefined || known.values !== values) {
        keys[act] = { values, key: make(act) };
    }

    return keys[act].key;
};

/** The act is done: its next tap is a new act, with a new key. */
export const forgetKey = (keys, act) => {
    delete keys[act];
};

/** Whether a refusal says that the page read an older state: the page then loads the view again. */
export const isConflict = (failure) => failure?.status === 409;

/** A refusal's words on the screen: a 409 says that the view was loaded again. */
export const refusalText = (failure) =>
    isConflict(failure) ? `${failure.message} The view is loaded again.` : failure.message;

/**
 * 1 act of the Desk page, with the API call and the view's load given: the call, and after a refusal that is a 409 (or
 * any refusal of an OK, which goes stale with the desk) a GET of the view, so the page shows the newer state. The error
 * comes back after the load, so it stays on the screen.
 */
export const deskAct = async (call, load, path, body) => {
    try {
        return { ok: true, next: await call(path, body) };
    } catch (failure) {
        const reloaded = path === "grant" || isConflict(failure) ? await load() : undefined;

        return {
            ok: false,
            error: failure.message,
            ...(reloaded === undefined ? {} : { reloaded }),
        };
    }
};

/**
 * The plan view's Drop, with the API call and the plan's load given: after a 409 the plan loads again, and the error
 * says so and stays.
 */
export const dropPlanAct = async (call, loadPlan, id, reason) => {
    try {
        await call(`threads/${id}/drop`, { reason });

        return { ok: true };
    } catch (failure) {
        // A load that fails keeps the view that is there: the error stays either way.
        const reloaded = isConflict(failure) ? await loadPlan().catch(() => undefined) : undefined;

        return {
            ok: false,
            error: refusalText(failure),
            ...(reloaded === undefined ? {} : { reloaded }),
        };
    }
};

/** A scope change in force, in 1 line: who, why, and the tasks it stopped. */
export const revisingLine = (revising) =>
    `Under revision (${revising.by}): ${revising.why} · stopped: ${revising.tasks.join(", ") || "none"}`;

/**
 * The key of an ask's local drafts (its answer, why and marks): the ask id and its generation, `T5a:0`. A draft of
 * another generation is never shown or sent.
 */
export const draftKey = (ask) => `${ask.id}:${ask.gen ?? 0}`;

/**
 * The marks the matrix shows: Brian's draft of this generation, else the stored marks. A save sends these, so a save
 * with no edit keeps the stored marks.
 */
export const shownMarks = (drafts, ask) =>
    ask.open ? (drafts?.[draftKey(ask)] ?? ask.marks ?? {}) : (ask.marks ?? {});

/**
 * The text a field holds after its send: empty when it still holds the text that was sent, else what Brian typed
 * after the send.
 */
export const clearIfSent = (now, sent) => ((now ?? "").trim() === sent ? "" : now);

/** Whether a form holds the same values as when it was sent. */
export const sameForm = (now, sent) => JSON.stringify(now) === JSON.stringify(sent);

/** The page's drafts without 1 ask's: a new object. */
export const withoutAsk = (drafts, id) => {
    const next = { ...(drafts ?? {}) };

    delete next[id];

    return next;
};

/** An ask's earlier answers, oldest first: `Earlier: TPM (Brian) · A file (Brian)`. */
export const historyLine = (ask) =>
    `Earlier: ${(ask.history ?? []).map((each) => `${each.answer.words} (${each.answer.by})`).join(" · ")}`;

/** A marks cell's key: `<option index>/<criterion id>`. */
export const markKey = (option, criterion) => `${option}/${criterion}`;

/** The next value of a 3-way cell: blank, yes, partly, no, and blank again. */
export const nextMark = (mark) =>
    mark === undefined ? "yes" : mark === "yes" ? "partly" : mark === "partly" ? "no" : undefined;

/** Marks with 1 cell set, or cleared when the mark is blank: a new object. */
export const withMark = (marks, key, mark) => {
    const next = { ...(marks ?? {}) };

    if (mark === undefined) {
        delete next[key];
    } else {
        next[key] = mark;
    }

    return next;
};

/** A cell's words: the mark, or a dot for blank. */
export const markText = (mark) => mark ?? "·";

/** The body of a plan answer: the words, the generation, and Brian's why and marks when there are any. */
export const planAnswerBody = (words, gen, why, marks) => ({
    words,
    gen,
    ...((why ?? "").trim() === "" ? {} : { why: why.trim() }),
    ...(marks === undefined ? {} : { marks }),
});

/** Whether a reopen of a settled ask is a scope change: after the approval it needs a why and the tasks it stops. */
export const reopenIsScope = (plan) => ["approved", "building", "verifying"].includes(plan?.state);

/** A task list with 1 id in or out. */
export const toggleTask = (tasks, id) =>
    tasks.includes(id) ? tasks.filter((each) => each !== id) : [...tasks, id];

/**
 * Whether New plan can start, and from which supervisor conversation: the newest one unless Brian picked another, or
 * why it is off.
 */
export const newPlanState = (info, picked) => {
    if (info === null || info === undefined) {
        return { off: "Reading the roster." };
    }

    if (!info.startPlan) {
        return {
            off: "The Team module is off or older than the desk: New plan needs both from 1 checkout.",
        };
    }

    if ((info.supervisors ?? []).length === 0) {
        return {
            off: "New plan needs the supervisor's conversation: the desk knows it after her first delegation.",
        };
    }

    if (info.plans.open >= info.plans.max) {
        return {
            off: `${info.plans.open} plans are open (plans.max ${info.plans.max}): a plan must finish or be dropped first.`,
        };
    }

    if ((info.leads ?? []).length === 0) {
        return { off: "No roster agent with role agent and a home can lead a plan." };
    }

    const supervisor = info.supervisors.includes(picked) ? picked : info.supervisors[0];

    return { supervisor, pick: info.supervisors.length > 1 };
};

/** The New plan form's body, or why it cannot go yet. */
export const newPlanBody = (form, key) => {
    const title = (form.title ?? "").trim();
    const idea = (form.idea ?? "").trim();
    const model = (form.model ?? "").trim();

    if (title === "" || title.length > 120) {
        return { error: "A title is 1 to 120 characters." };
    }

    if (idea === "" || idea.length > 200) {
        return { error: "The idea is 1 line of 1 to 200 characters." };
    }

    if ((form.lead ?? "") === "") {
        return { error: "Choose a lead." };
    }

    return { body: { title, idea, lead: form.lead, key, ...(model === "" ? {} : { model }) } };
};

/** 1 attempt of a task, in 1 line: its thread, how it ended, its PRs (with the merged head), and a no-change reason. */
export const attemptLine = (attempt) =>
    [
        attempt.thread,
        attempt.end?.how ?? "open",
        ...(attempt.prs ?? []).map((pr) =>
            pr.head === undefined ? pr.ref : `${pr.ref} at ${String(pr.head).slice(0, 7)}`,
        ),
        ...(attempt.end?.noChange === undefined
            ? []
            : [`no change: ${attempt.end.noChange.reason}`]),
    ].join(" · ");

/** 1 task of a graph, in 1 line: its agent and repository, its state, its deps, and a carried task's reason. */
export const taskLine = (task) =>
    [
        task.agent,
        task.repo,
        task.state,
        `deps: ${(task.deps ?? []).join(", ") || "none"}`,
        task.carried === undefined ? "" : `carried: ${task.carried.why}`,
    ]
        .filter(Boolean)
        .join(" · ");

/** The Tasks fold's summary: `Tasks (graph v2: 4 tasks, 1 done)`. */
export const tasksSummary = (graph) => {
    const count = graph.tasks.length;
    const done = graph.tasks.filter((task) => task.state === "done").length;

    return `Tasks (graph v${graph.version}: ${count} task${count === 1 ? "" : "s"}, ${done} done)`;
};

/** 1 whole-plan round, in 1 line: passed or failed, the reviewer, and the failed tasks. */
export const roundLine = (round) => {
    const failed = (round.tasks ?? []).filter((each) => !each.pass).map((each) => each.task);

    return `${round.pass ? "passed" : "failed"} · ${round.reviewer}${failed.length === 0 ? "" : ` · failed: ${failed.join(", ")}`}`;
};

/** 1 comment, in 1 line: its id, who wrote it, its text, and how it ended. */
export const commentLine = (comment) => {
    const how =
        comment.state === "open"
            ? ""
            : comment.state === "done"
              ? ` · settled by rev ${String(comment.settled?.rev ?? "").slice(0, 7)}`
              : " · dismissed";

    return `${comment.id} ${comment.by}: ${comment.text}${how}`;
};

/** How a consult ended with no finding, in a few words. */
const consultEndText = (end) =>
    end === undefined
        ? ""
        : end.why === "timeout"
          ? "no finding after 60 min"
          : end.why === "stopped"
            ? `stopped by ${end.by ?? "Brian"}`
            : end.why === "plan"
              ? "the plan ended"
              : "did not start";

/** 1 consult, in 1 line: its id, its agent, its state, its ask, its age, and its finding or end. */
export const consultLine = (consult) =>
    [
        `${consult.id} ${consult.agent}`,
        consult.state,
        consult.ask === undefined ? "" : `on ${consult.ask}`,
        `${Math.max(0, Math.round((consult.age ?? 0) / 60000))} min`,
        consult.finding === undefined ? "" : `finding ${consult.finding}`,
        consultEndText(consult.end),
    ]
        .filter((part) => part !== "")
        .join(" · ");

/** The findings on 1 ask, in 1 line: "Findings: lucilla supports · teg objects", or "" with none. */
export const findingsLine = (findings) =>
    (findings ?? []).length === 0
        ? ""
        : `Findings: ${findings.map((finding) => `${finding.agent} ${finding.stance}`).join(" · ")}`;

/** 1 line of a diff, as the Changes fold shows it. */
export const diffText = (line) => `${line.op} ${line.text}`;

/**
 * The rail badge: the threads that need Brian, and the PRs ready to merge. A thread that is not parked counts when it
 * has an open ask, also when it is asleep or closed; else it counts when it is not closed or asleep and it needs Brian or
 * is stale. Each PR in `ready` counts 1, so a thread that counts only because it needs Brian does not count again when it
 * holds 1 of those PRs: the same PR may be on 2 threads, and `ready` has 1 row for it. A missing `ready` is no PR: an
 * older view works as before.
 */
export const badgeOf = (next) => {
    if (next === null || next === undefined) {
        return 0;
    }

    const ready = next.ready ?? [];
    const refs = new Set(ready.map((pr) => pr.ref.toLowerCase()));

    /** Whether the thread holds 1 of the PRs in `ready`: that PR counts, so the thread does not count. */
    const holds = (thread) =>
        (thread.prs ?? []).some(
            (pr) =>
                pr.ready === true && pr.state === "OPEN" && refs.has(String(pr.ref).toLowerCase()),
        );

    return (
        ready.length +
        next.threads.filter((thread) => {
            if (thread.state === "parked") {
                return false;
            }

            if ((thread.asks ?? []).length > 0) {
                return true;
            }

            const needsBrian = thread.next === "brian";

            // Its PR is a row of Ready to merge: the PR counts, and the thread does not count again.
            if (needsBrian && !thread.stale && holds(thread)) {
                return false;
            }

            return thread.state !== "closed" && !thread.asleep && (needsBrian || thread.stale);
        }).length
    );
};

const publish = (next) => {
    view = next;
    loadError = null;

    if (rail !== null) {
        rail.update({ badge: badgeOf(next) || null });
    }

    for (const listener of LISTENERS) {
        listener();
    }
};

const load = async () => {
    try {
        const next = await app.api("threads");

        if (seenBefore === null) {
            seenBefore = next.seen ?? 0;
        }

        publish(next);

        return next;
    } catch (failure) {
        loadError = failure.message;

        for (const listener of LISTENERS) {
            listener();
        }

        return null;
    }
};

/**
 * The queue's read status, for the page: its words, and whether it is a warning. A queue that is turned off is a short
 * muted line, not a failure. Null when a good read has nothing to say.
 */
export const queueStatus = (queue, clock) => {
    if (queue === null || queue === undefined) {
        return null;
    }

    if (queue.off) {
        return { text: "queue read is off", warn: false };
    }

    if (!queue.ok) {
        return {
            text: `queue read failed at ${clock(queue.at)}${queue.error ? `: ${queue.error}` : ""}`,
            warn: true,
        };
    }

    return (queue.incomplete ?? []).length > 0
        ? { text: `queue read incomplete: ${queue.incomplete.join(", ")}`, warn: true }
        : null;
};

export default function setup(pocket) {
    const { html, useEffect, useRef, useState, Loader } = pocket;

    app = pocket;
    pocket.style("desk.css");

    // The owner-only Dashboard view: the page is owner-only, and so is its route.
    const Dashboard = makeDashboard(pocket);

    const time = (at) => new Date(at).toLocaleString();

    /** A clock time, as the queue's "read 19:02" shows it. */
    const clock = (at) =>
        new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    /** How long ago, in 1 short word group: "5 h ago". */
    const ago = (at) => {
        const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));

        if (minutes < 60) {
            return `${minutes} min ago`;
        }

        return minutes < 2880
            ? `${Math.round(minutes / 60)} h ago`
            : `${Math.round(minutes / 1440)} d ago`;
    };

    /** A GitHub link that is safe to open: http(s) only. */
    const webUrl = (url) => (/^https?:\/\/\S+$/.test(url ?? "") ? url : undefined);

    /** A watch's date as people read it: "2026-10-26", or "2026-10-26 09:00" when it has a time. */
    const watchWhen = (watch) =>
        watch.checkTime ? `${watch.checkOn} ${watch.checkTime}` : watch.checkOn;

    /** One line about a thread's watch, for the detail view. */
    const watchLine = (watch) =>
        [
            watchWhen(watch),
            watch.check,
            `set by ${watch.setBy}`,
            watch.due ? "due" : "",
            watch.result
                ? `${watch.result.pass ? "passed" : "failed"} by ${watch.result.by}: ${watch.result.text}`
                : "",
        ]
            .filter(Boolean)
            .join(" · ");

    /**
     * 1 plan: its sections with their asks and comments, the changes since the approval, its tasks and checks, and
     * Brian's acts. Each act's key is made once in this view, so a second tap sends the same key and the desk acts once.
     * A 409 means the page read an older plan: the view loads again, and the error stays.
     */
    function PlanDetail({ id, onBack, onChanged, onOpenThread }) {
        const [plan, setPlan] = useState(null);
        const [error, setError] = useState("");
        const [busy, setBusy] = useState(false);
        // The view's own key store: 1 key for each act, until the act is done.
        const [keys] = useState(() => ({}));
        // The view's life: an answer that comes after Brian went back changes nothing, and closes no other page.
        const [life] = useState(() => ({ gone: false }));
        const [dropping, setDropping] = useState(false);
        const [dropWhy, setDropWhy] = useState("");
        const [commentFor, setCommentFor] = useState(null);
        const [commentText, setCommentText] = useState("");
        const [changesOpen, setChangesOpen] = useState(false);
        const [changesText, setChangesText] = useState("");
        const [changesSection, setChangesSection] = useState("");
        const [reviseOpen, setReviseOpen] = useState(false);
        const [reviseWhy, setReviseWhy] = useState("");
        const [reviseTasks, setReviseTasks] = useState([]);
        const [reopenFor, setReopenFor] = useState(null);
        const [reopenWhy, setReopenWhy] = useState("");
        const [reopenTasks, setReopenTasks] = useState([]);
        // Drafts by `draftKey` (ask id and generation): a draft of another generation is never shown or sent.
        const [answers, setAnswers] = useState({});
        const [whys, setWhys] = useState({});
        const [marks, setMarks] = useState({});
        // What the fields hold now, for after a send: only the text that was sent is cleared.
        const [live] = useState(() => ({ comment: "", changes: "" }));

        const openPlan = async () => {
            const answer = await pocket.api(`plans/${id}`);

            if (stillMounted(life)) {
                setPlan(answer);
            }

            return answer;
        };

        useEffect(() => {
            const abort = new AbortController();

            pocket
                .api(`plans/${id}`, undefined, { signal: abort.signal })
                .then(setPlan, (failure) => {
                    if (!abort.signal.aborted) {
                        setError(failure.message);
                    }
                });

            return () => {
                abort.abort();
                life.gone = true;
            };
        }, [id]);

        /**
         * 1 act: its route, its body, and the act's name for its key. A done act forgets its key; a refused one keeps it,
         * so a second tap is the same act. The view loads again either way: after a 409 it is the newer plan.
         */
        const run = async (act, path, body) => {
            setBusy(true);
            setError("");

            let done = false;

            try {
                await pocket.api(path, body);

                if (!stillMounted(life)) {
                    return false;
                }

                if (act !== undefined) {
                    forgetKey(keys, act);
                }

                done = true;
                await onChanged();
            } catch (failure) {
                if (stillMounted(life)) {
                    setError(
                        isConflict(failure)
                            ? `${failure.message} The view is loaded again.`
                            : failure.message,
                    );
                }
            } finally {
                if (stillMounted(life)) {
                    try {
                        await openPlan();
                    } catch {
                        // The error above stays, and the view that is there stays too.
                    }

                    setBusy(false);
                }
            }

            return done;
        };

        const approve = () =>
            run("approve", `plans/${id}/approve`, {
                rev: plan.rev,
                graph: plan.graph?.version,
                key: keyForForm(keys, "approve", { rev: plan.rev, graph: plan.graph?.version }),
            });

        /** Drop the plan: the desk refuses it while an ask is open, and says so. A 409 loads the plan again. */
        const drop = async () => {
            setBusy(true);
            setError("");

            const done = await dropPlanAct(pocket.api, openPlan, id, dropWhy.trim());

            // Brian went back while the drop ran: the page he is on now must not close.
            if (!stillMounted(life)) {
                return;
            }

            if (!done.ok) {
                setError(done.error);
                setBusy(false);

                return;
            }

            await onChanged();

            if (stillMounted(life)) {
                onBack();
            }
        };

        const answerAsk = async (ask, words) => {
            const text = (words ?? "").trim();

            if (text === "") {
                return;
            }

            const draft = draftKey(ask);
            const why = (whys[draft] ?? "").trim();
            const done = await run(
                undefined,
                `asks/${ask.id}/answer`,
                planAnswerBody(text, ask.gen, why, marks[draft]),
            );

            if (done) {
                // Only what was sent goes: words typed after the send stay.
                setAnswers((now) => ({ ...now, [draft]: clearIfSent(now[draft], text) }));
                setWhys((now) => ({ ...now, [draft]: clearIfSent(now[draft], why) }));
                // The marks went with the answer: the next view shows the stored ones.
                setMarks((now) => withoutAsk(now, draft));
            }
        };

        // The marks the matrix shows go: with no edit, that is the stored marks, which stay.
        const saveMarks = (ask) =>
            run(undefined, `asks/${ask.id}/marks`, { gen: ask.gen, marks: shownMarks(marks, ask) });

        const reopen = async (ask) => {
            const scope = reopenIsScope(plan);
            const act = `reopen-${ask.id}`;
            // A scope change names the approved graph this view showed: a newer one refuses it with 409.
            const payload = {
                gen: ask.gen,
                ...(scope
                    ? {
                          why: reopenWhy.trim(),
                          tasks: reopenTasks,
                          graph: plan.approvedGraph?.version,
                      }
                    : {}),
            };
            const done = await run(act, `asks/${ask.id}/reopen`, {
                ...payload,
                key: keyForForm(keys, act, payload),
            });

            if (done) {
                setReopenFor(null);
                setReopenWhy("");
                setReopenTasks([]);
            }
        };

        const comment = async (section) => {
            const act = `comment-${section.id}`;
            const text = commentText.trim();
            // The revision this view showed: a newer one refuses the comment with 409.
            const payload = { section: section.id, text, rev: plan.rev };
            // Brian changed the text after a failed send: a new comment, with a new key.
            const done = await run(act, `plans/${id}/comment`, {
                ...payload,
                key: keyForForm(keys, act, payload),
            });

            // Only the text that was sent goes: text typed after the send stays, with its form.
            if (done && clearIfSent(live.comment, text) === "") {
                live.comment = "";
                setCommentFor(null);
                setCommentText("");
            }
        };

        const dismiss = (comment) =>
            run(undefined, `plans/${id}/comments/${comment.id}/dismiss`, {});

        // A stop takes no key: a second tap finds the consult stopped, and the desk gives 409.
        const stopConsult = (consult) =>
            run(undefined, `plans/${id}/consults/${consult.id}/stop`, {});

        const requestChanges = async () => {
            const text = changesText.trim();
            const payload = text === "" ? {} : { text, section: changesSection, rev: plan.rev };
            const done = await run("changes", `plans/${id}/changes`, {
                ...payload,
                key: keyForForm(keys, "changes", payload),
            });

            if (done && clearIfSent(live.changes, text) === "") {
                live.changes = "";
                setChangesOpen(false);
                setChangesText("");
            }
        };

        const revise = async () => {
            // The approved graph this view showed: a newer one refuses it with 409.
            const payload = {
                why: reviseWhy.trim(),
                tasks: reviseTasks,
                graph: plan.approvedGraph?.version,
            };
            const done = await run("revise", `plans/${id}/revise`, {
                ...payload,
                key: keyForForm(keys, "revise", payload),
            });

            if (done) {
                setReviseOpen(false);
                setReviseWhy("");
                setReviseTasks([]);
            }
        };

        /** The approved graph's task ids, as checkboxes: the tasks a scope change stops. */
        const taskChecks = (chosen, setChosen, label) =>
            html`<fieldset class="desk-plan-tasks">
                <legend class="small muted">${label}</legend>
                ${(plan.approvedGraph?.tasks ?? []).map(
                    (task) => html`<label class="desk-plan-check">
                        <input
                            type="checkbox"
                            checked=${chosen.includes(task.id)}
                            onChange=${() => setChosen(toggleTask(chosen, task.id))}
                        />
                        <span>${task.id} ${task.title} · ${task.state}</span>
                    </label>`,
                )}
            </fieldset>`;

        /** The marks matrix: options down, criteria across, 1 3-way cell each. Read-only once the ask is answered. */
        const matrix = (ask) => {
            const criteria = ask.criteria ?? [];
            const options = ask.options ?? [];

            if (criteria.length === 0 || options.length === 0) {
                return null;
            }

            const current = shownMarks(marks, ask);

            return html`<div class="desk-plan-matrix">
                <table>
                    <thead>
                        <tr>
                            <th></th>
                            ${criteria.map((criterion) => html`<th scope="col">${criterion.label}</th>`)}
                        </tr>
                    </thead>
                    <tbody>
                        ${options.map(
                            (option, index) => html`<tr>
                                <th scope="row">${option}</th>
                                ${criteria.map((criterion) => {
                                    const cell = markKey(index, criterion.id);
                                    const mark = current[cell];

                                    return html`<td>
                                        <button
                                            type="button"
                                            class=${`desk-mark ${mark ?? "blank"}`}
                                            disabled=${busy || !ask.open}
                                            aria-label=${`${option}, ${criterion.label}: ${mark ?? "blank"}`}
                                            onClick=${() =>
                                                setMarks({
                                                    ...marks,
                                                    [draftKey(ask)]: withMark(
                                                        current,
                                                        cell,
                                                        nextMark(mark),
                                                    ),
                                                })}
                                        >
                                            ${markText(mark)}
                                        </button>
                                    </td>`;
                                })}
                            </tr>`,
                        )}
                    </tbody>
                </table>
                ${
                    ask.open
                        ? html`<button
                              class="button"
                              disabled=${busy}
                              onClick=${() => void saveMarks(ask)}
                          >
                              Save marks
                          </button>`
                        : null
                }
            </div>`;
        };

        /** 1 ask card: the question, its options and marks, Brian's answer and why, or the answer with Reopen. */
        const askCard = (ask) => html`<div class="desk-plan-ask">
            <div class="small">${planAskLine(ask)}</div>
            ${
                (ask.history ?? []).length === 0
                    ? null
                    : html`<div class="small muted">${historyLine(ask)}</div>`
            }
            ${
                (ask.findings ?? []).length === 0
                    ? null
                    : html`<div class="desk-plan-findings">
                          <div class="small">${findingsLine(ask.findings)}</div>
                          ${ask.findings.map(
                              (finding) =>
                                  html`<div class="small muted">
                                      ${finding.id} ${finding.agent} ${finding.stance}: ${finding.summary}
                                  </div>`,
                          )}
                      </div>`
            }
            ${matrix(ask)}
            ${
                ask.open
                    ? html`${
                          (ask.options ?? []).length === 0
                              ? null
                              : html`<div class="desk-actions">
                                    ${ask.options.map(
                                        (option) => html`<button
                                            class="button"
                                            disabled=${busy}
                                            aria-label=${`Answer ${ask.id}: ${option}`}
                                            onClick=${() => void answerAsk(ask, option)}
                                        >
                                            ${option}
                                        </button>`,
                                    )}
                                </div>`
                      }
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="300"
                          placeholder="Why (optional)"
                          aria-label=${`Why, for ${ask.id}`}
                          value=${whys[draftKey(ask)] ?? ""}
                          disabled=${busy}
                          onInput=${(event) =>
                              setWhys({ ...whys, [draftKey(ask)]: event.currentTarget.value })}
                      />
                      <div class="desk-actions">
                          <input
                              class="desk-reason"
                              type="text"
                              maxlength="1000"
                              placeholder="Your answer"
                              aria-label=${`Your answer to ${ask.id}`}
                              value=${answers[draftKey(ask)] ?? ""}
                              disabled=${busy}
                              onInput=${(event) =>
                                  setAnswers({
                                      ...answers,
                                      [draftKey(ask)]: event.currentTarget.value,
                                  })}
                          />
                          <button
                              class="button"
                              disabled=${busy || (answers[draftKey(ask)] ?? "").trim() === ""}
                              onClick=${() => void answerAsk(ask, answers[draftKey(ask)])}
                          >
                              Answered
                          </button>
                      </div>`
                    : html`${
                          ask.why === undefined
                              ? null
                              : html`<div class="small muted">Why: ${ask.why.text}</div>`
                      }
                      ${
                          ask.answer === undefined ||
                          plan.state === "done" ||
                          plan.state === "dropped"
                              ? null
                              : reopenFor === ask.id
                                ? html`<div class="desk-form">
                                      ${
                                          reopenIsScope(plan)
                                              ? html`<p class="small muted">
                                                        After the approval, a reopen is a scope change: give 1 line why,
                                                        and the tasks it stops.
                                                    </p>
                                                    <input
                                                        class="desk-reason"
                                                        type="text"
                                                        maxlength="300"
                                                        placeholder="Why reopen it?"
                                                        aria-label=${`Why reopen ${ask.id}`}
                                                        value=${reopenWhy}
                                                        onInput=${(event) => setReopenWhy(event.currentTarget.value)}
                                                    />
                                                    ${taskChecks(reopenTasks, setReopenTasks, "Stop these tasks")}`
                                              : null
                                      }
                                      <div class="desk-actions">
                                          <button
                                              class="button"
                                              disabled=${busy || (reopenIsScope(plan) && reopenWhy.trim() === "")}
                                              onClick=${() => void reopen(ask)}
                                          >
                                              Reopen ${ask.id}
                                          </button>
                                          <button class="button" onClick=${() => setReopenFor(null)}>Cancel</button>
                                      </div>
                                  </div>`
                                : html`<div class="desk-actions">
                                      <button
                                          class="button"
                                          disabled=${busy}
                                          aria-label=${`Reopen ${ask.id}`}
                                          onClick=${() => setReopenFor(ask.id)}
                                      >
                                          Reopen
                                      </button>
                                  </div>`
                      }`
            }
        </div>`;

        /** A section's comments, with Dismiss on an open one, and the form that adds one. */
        const commentsOf = (section) => html`${(section.comments ?? []).map(
            (each) => html`<div class="desk-plan-comment small">
                <span>${commentLine(each)}</span>
                ${
                    each.state === "open"
                        ? html`<button
                              class="button"
                              disabled=${busy}
                              aria-label=${`Dismiss ${each.id}`}
                              onClick=${() => void dismiss(each)}
                          >
                              Dismiss
                          </button>`
                        : null
                }
            </div>`,
        )}
        ${
            section.desk || !(plan.state === "drafting" || plan.state === "review")
                ? null
                : commentFor === section.id
                  ? html`<div class="desk-form">
                        <textarea
                            class="desk-reason"
                            maxlength="1000"
                            rows="3"
                            placeholder=${`A comment on ${section.heading}`}
                            aria-label=${`A comment on ${section.heading}`}
                            value=${commentText}
                            onInput=${(event) => {
                                live.comment = event.currentTarget.value;
                                setCommentText(event.currentTarget.value);
                            }}
                        ></textarea>
                        <div class="desk-actions">
                            <button
                                class="button"
                                disabled=${busy || commentText.trim() === ""}
                                onClick=${() => void comment(section)}
                            >
                                Send
                            </button>
                            <button class="button" onClick=${() => setCommentFor(null)}>Cancel</button>
                        </div>
                    </div>`
                  : html`<button
                        class="desk-thread-link"
                        disabled=${busy}
                        onClick=${() => {
                            setCommentFor(section.id);
                            setCommentText("");
                            live.comment = "";
                        }}
                    >
                        + Comment on ${section.heading}
                    </button>`
        }`;

        /** 1 graph's tasks, each with its attempts. */
        const tasksOf = (graph) => html`<ul class="desk-list">
            ${graph.tasks.map(
                (task) => html`<li>
                    <span class="desk-id">${task.id}</span> ${task.title}
                    <div class="small muted">${taskLine(task)}</div>
                    ${(task.attempts ?? []).map(
                        (attempt) => html`<div class="small desk-plan-attempt">
                            <button
                                class="desk-thread-link"
                                onClick=${() => onOpenThread?.(attempt.thread)}
                            >
                                ${attemptLine(attempt)}
                            </button>
                            ${
                                attempt.end?.noChange === undefined
                                    ? null
                                    : html`<pre class="desk-plan-text">${attempt.end.noChange.evidence}</pre>`
                            }
                        </div>`,
                    )}
                </li>`,
            )}
        </ul>`;

        if (plan === null) {
            return html`<div class="desk">
                <div class="desk-bar">
                    <button class="button" aria-label="Back to the desk" onClick=${onBack}>Back</button>
                    <span class="desk-id">${id}</span>
                </div>
                ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
                <${Loader} label="Opening the plan" />
            </div>`;
        }

        const tasksGraph = plan.approvedGraph ?? plan.graph;
        const draftShown =
            plan.graph !== undefined &&
            plan.approvedGraph !== undefined &&
            plan.graph.version !== plan.approvedGraph.version;
        const changes = plan.changes ?? [];
        const writable = plan.sections.filter((section) => !section.desk);

        return html`<div class="desk">
            <div class="desk-bar">
                <button class="button" aria-label="Back to the desk" onClick=${onBack}>Back</button>
                <span class="desk-id">${id}</span>
                ${
                    plan.session !== undefined
                        ? html`<button
                              class="button"
                              aria-label="Chat in the planning session"
                              onClick=${() => pocket.openConversation(plan.session)}
                          >
                              Chat
                          </button>`
                        : null
                }
            </div>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            <article class="desk-thread">
                <h2>${plan.title}</h2>
                <p class="small muted">${planStateLine(plan)}</p>
                ${
                    plan.revising === undefined
                        ? null
                        : html`<p class="small desk-warn">
                              ${revisingLine(plan.revising)}
                          </p>`
                }
                ${
                    plan.waiting.length > 0
                        ? html`<p class="small">Waiting: ${plan.waiting.join(" · ")}</p>`
                        : html`<p class="small muted">Settled.</p>`
                }
                ${
                    plan.preamble === undefined || plan.preamble === ""
                        ? null
                        : html`<pre class="desk-plan-text">${plan.preamble}</pre>`
                }
                ${plan.sections.map((section) => {
                    const open = (section.comments ?? []).filter(
                        (each) => each.state === "open",
                    ).length;

                    return html`<details class="desk-plan-section">
                        <summary>
                            ${section.heading}
                            ${
                                section.asks.length === 0
                                    ? null
                                    : html`<span class="desk-count">${section.asks.length}</span>`
                            }
                            ${open === 0 ? null : html`<span class="desk-count">💬 ${open}</span>`}
                        </summary>
                        <pre class="desk-plan-text">${section.text}</pre>
                        ${section.asks.map(askCard)} ${commentsOf(section)}
                    </details>`;
                })}
                ${
                    (plan.consults ?? []).length === 0
                        ? null
                        : html`<details class="desk-plan-section" open=${plan.consults.some((each) => each.canStop)}>
                              <summary>Consults (${plan.consults.length})</summary>
                              <ul class="desk-list">
                                  ${plan.consults.map((consult) => {
                                      const finding = (plan.findings ?? []).find(
                                          (each) => each.id === consult.finding,
                                      );

                                      return html`<li class="desk-plan-consult">
                                          <div class="small">${consultLine(consult)}</div>
                                          <div class="small muted">${consult.question}</div>
                                          ${
                                              finding === undefined
                                                  ? null
                                                  : html`<div class="small">
                                                        ${finding.stance}: ${finding.summary}
                                                    </div>`
                                          }
                                          ${
                                              consult.canStop
                                                  ? html`<button
                                                        class="button"
                                                        disabled=${busy}
                                                        aria-label=${`Stop ${consult.id}`}
                                                        onClick=${() => void stopConsult(consult)}
                                                    >
                                                        Stop
                                                    </button>`
                                                  : null
                                          }
                                      </li>`;
                                  })}
                              </ul>
                          </details>`
                }
                ${
                    changes.length === 0
                        ? null
                        : html`<details class="desk-plan-section">
                              <summary>Changes since the last approval (${changes.length})</summary>
                              ${changes.map(
                                  (change) => html`<div class="desk-plan-change">
                                      <div class="small">${change.heading} · ${change.how}</div>
                                      <pre class="desk-plan-text desk-diff">${change.lines.map(
                                          (line) =>
                                              html`<span class=${`desk-diff-line ${line.op === "+" ? "add" : line.op === "-" ? "del" : ""}`}
                                                  >${diffText(line)}</span
                                              >`,
                                      )}</pre>
                                      ${change.cut ? html`<div class="small muted">The diff is cut at 200 lines.</div>` : null}
                                  </div>`,
                              )}
                          </details>`
                }
                ${
                    tasksGraph === undefined
                        ? null
                        : html`<details class="desk-plan-section">
                              <summary>${tasksSummary(tasksGraph)}</summary>
                              ${tasksOf(tasksGraph)}
                              ${
                                  draftShown
                                      ? html`<div class="small muted">
                                                Draft graph v${plan.graph.version}, for the next approval:
                                            </div>
                                            ${tasksOf(plan.graph)}`
                                      : null
                              }
                          </details>`
                }
                ${
                    plan.verification === undefined
                        ? null
                        : html`<details class="desk-plan-section">
                              <summary>
                                  Whole-plan check (${plan.budget.failed} of ${plan.budget.max} failed rounds)
                              </summary>
                              <ul class="desk-list">
                                  ${plan.verification.rounds.map(
                                      (round) => html`<li class="small">
                                          ${roundLine(round)}
                                          ${(round.tasks ?? []).map(
                                              (each) =>
                                                  html`<div class="small muted">
                                                      ${each.task} ${each.pass ? "passed" : "failed"}: ${each.evidence}
                                                  </div>`,
                                          )}
                                      </li>`,
                                  )}
                              </ul>
                          </details>`
                }
                ${
                    changesOpen && plan.state === "review"
                        ? html`<div class="desk-form">
                              <p class="small muted">
                                  Request changes: the plan goes back to drafting. Text is optional: with text, it is a
                                  comment on 1 section.
                              </p>
                              <textarea
                                  class="desk-reason"
                                  maxlength="1000"
                                  rows="3"
                                  placeholder="What to change (optional)"
                                  aria-label="What to change"
                                  value=${changesText}
                                  onInput=${(event) => {
                                      live.changes = event.currentTarget.value;
                                      setChangesText(event.currentTarget.value);
                                  }}
                              ></textarea>
                              ${
                                  changesText.trim() === ""
                                      ? null
                                      : html`<select
                                            class="desk-reason"
                                            aria-label="The section it is about"
                                            value=${changesSection}
                                            onChange=${(event) => setChangesSection(event.currentTarget.value)}
                                        >
                                            <option value="">Choose a section</option>
                                            ${writable.map(
                                                (section) =>
                                                    html`<option value=${section.id}>${section.heading}</option>`,
                                            )}
                                        </select>`
                              }
                              <div class="desk-actions">
                                  <button
                                      class="button"
                                      disabled=${busy || (changesText.trim() !== "" && changesSection === "")}
                                      onClick=${() => void requestChanges()}
                                  >
                                      Request changes
                                  </button>
                                  <button class="button" onClick=${() => setChangesOpen(false)}>Cancel</button>
                              </div>
                          </div>`
                        : null
                }
                ${
                    reviseOpen && plan.canRevise
                        ? html`<div class="desk-form">
                              <p class="small muted">
                                  Stop and revise: the plan goes back to drafting. The tasks you check stop; the others go on.
                              </p>
                              <input
                                  class="desk-reason"
                                  type="text"
                                  maxlength="300"
                                  placeholder="Why, in 1 line"
                                  aria-label="Why stop and revise"
                                  value=${reviseWhy}
                                  onInput=${(event) => setReviseWhy(event.currentTarget.value)}
                              />
                              ${taskChecks(reviseTasks, setReviseTasks, "Stop these tasks")}
                              <div class="desk-actions">
                                  <button
                                      class="button"
                                      disabled=${busy || reviseWhy.trim() === ""}
                                      onClick=${() => void revise()}
                                  >
                                      Stop and revise
                                  </button>
                                  <button class="button" onClick=${() => setReviseOpen(false)}>Cancel</button>
                              </div>
                          </div>`
                        : null
                }
                ${
                    plan.state === "done" || plan.state === "dropped"
                        ? null
                        : dropping
                          ? html`<div class="desk-form">
                                <input
                                    class="desk-reason"
                                    type="text"
                                    placeholder="Why drop this plan?"
                                    value=${dropWhy}
                                    maxlength="200"
                                    aria-label="Why drop this plan"
                                    onInput=${(event) => setDropWhy(event.currentTarget.value)}
                                />
                                <div class="desk-actions">
                                    <button
                                        class="button"
                                        disabled=${busy || dropWhy.trim() === ""}
                                        onClick=${() => void drop()}
                                    >
                                        Drop the plan
                                    </button>
                                    <button class="button" onClick=${() => setDropping(false)}>Cancel</button>
                                </div>
                            </div>`
                          : html`<div class="desk-actions">
                                <button class="button" onClick=${() => setDropping(true)}>Drop</button>
                            </div>`
                }
                <div class="desk-plan-bar">
                    ${
                        plan.state === "review" && plan.canApprove
                            ? html`<button
                                  class="button primary"
                                  disabled=${busy}
                                  aria-label=${approveLabel(plan)}
                                  onClick=${() => void approve()}
                              >
                                  ${approveLabel(plan)}
                              </button>`
                            : null
                    }
                    ${
                        plan.state === "review" && !changesOpen
                            ? html`<button
                                  class="button"
                                  disabled=${busy}
                                  onClick=${() => {
                                      setChangesOpen(true);
                                      setChangesSection(writable[0]?.id ?? "");
                                  }}
                              >
                                  Request changes
                              </button>`
                            : null
                    }
                    ${
                        plan.canRevise && !reviseOpen
                            ? html`<button
                                  class="button"
                                  disabled=${busy}
                                  onClick=${() => setReviseOpen(true)}
                              >
                                  Stop and revise
                              </button>`
                            : null
                    }
                    ${
                        plan.state === "review" && plan.canApprove
                            ? null
                            : plan.approveOff
                              ? html`<span class="small muted">${plan.approveOff}</span>`
                              : null
                    }
                </div>
            </article>
        </div>`;
    }

    /**
     * 1 thread's detail. `backLabel` names where Back returns: the desk, or the Dashboard it came from. `focusBack`: the
     * Back button takes the focus when the detail opens (from the Dashboard's drill-down, whose button goes away).
     */
    function Detail({ id, onBack, backLabel = "Back to the desk", focusBack = false }) {
        const [thread, setThread] = useState(null);
        const [reports, setReports] = useState([]);
        const [error, setError] = useState("");
        const back = useRef(null);

        useEffect(() => {
            if (focusBack) {
                back.current?.focus();
            }
        }, []);

        useEffect(() => {
            const abort = new AbortController();

            pocket.api(`threads/${id}`, undefined, { signal: abort.signal }).then(
                (answer) => {
                    setThread(answer.thread);
                    setReports(answer.reports);
                },
                (failure) => {
                    if (!abort.signal.aborted) {
                        setError(failure.message);
                    }
                },
            );

            return () => abort.abort();
        }, [id]);

        return html`<div class="desk">
            <div class="desk-bar">
                <button class="button" ref=${back} aria-label=${backLabel} onClick=${onBack}>Back</button>
                <span class="desk-id">${id}</span>
            </div>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${
                thread === null
                    ? html`<${Loader} label="Opening the thread" />`
                    : html`<article class="desk-thread">
                          <h2>${thread.title}</h2>
                          ${
                              thread.open.length > 0
                                  ? html`<p class="small">Still open: ${thread.open.join("; ")}</p>`
                                  : null
                          }
                          <p class="small muted">
                              ${[
                                  thread.repo,
                                  thread.state,
                                  `next: ${thread.next}`,
                                  thread.asleep ? "asleep" : "",
                                  thread.stale ? "stale" : "",
                              ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </p>
                          ${thread.watch ? html`<p class="small">Watch: ${watchLine(thread.watch)}</p>` : null}
                          ${
                              (thread.issues ?? []).length > 0
                                  ? html`<p class="small">Issues: ${thread.issues.join(", ")}</p>`
                                  : null
                          }
                          <h3>PRs</h3>
                          ${
                              thread.prs.length === 0
                                  ? html`<p class="small muted">No PRs.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.prs.map(
                                            (pr) => html`<li>
                                                ${
                                                    pr.url
                                                        ? html`<a href=${pr.url} target="_blank" rel="noopener">${pr.ref}</a>`
                                                        : html`<span class="mono">${pr.ref}</span>`
                                                }
                                                <span class="small muted">
                                                    ${[
                                                        pr.state,
                                                        pr.ready ? "ready-for-human" : "",
                                                        pr.next ? `next: ${pr.next}` : "",
                                                        pr.via === "window" ? "guessed" : pr.via,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </span>
                                                ${pr.title ? html`<div class="small">${pr.title}</div>` : null}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          <h3>Asks</h3>
                          ${
                              thread.asks.length === 0
                                  ? html`<p class="small muted">No open asks.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.asks.map(
                                            (ask) => html`<li>
                                                <span class="desk-id">${ask.id}</span> ${ask.text}
                                                ${ask.from ? html`<div class="small">from ${ask.from}</div>` : null}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          ${
                              (thread.resolved ?? []).length === 0
                                  ? null
                                  : html`<h3>Resolved</h3>
                                        <ul class="desk-list">
                                            ${thread.resolved.map(
                                                (ask) => html`<li>
                                                    <span class="desk-id">${ask.id}</span> ${ask.text}
                                                    <div class="small">
                                                        ${ask.by ? `withdrawn by ${ask.by}` : "by the desk"}:
                                                        ${ask.why}
                                                    </div>
                                                </li>`,
                                            )}
                                        </ul>`
                          }
                          ${
                              (thread.answered ?? []).length === 0
                                  ? null
                                  : html`<h3>Answered</h3>
                                        <ul class="desk-list">
                                            ${thread.answered.map(
                                                (ask) => html`<li>
                                                    <span class="desk-id">${ask.id}</span> ${ask.text}
                                                    <div class="small">${ask.by}: “${ask.words}”</div>
                                                </li>`,
                                            )}
                                        </ul>`
                          }
                          <h3>Events</h3>
                          ${
                              thread.events.length === 0
                                  ? html`<p class="small muted">No events.</p>`
                                  : html`<ul class="desk-list">
                                        ${thread.events.map(
                                            (event) => html`<li class="small">
                                                <span class="mono">${time(event.at)}</span> ${event.text}
                                            </li>`,
                                        )}
                                    </ul>`
                          }
                          <h3>Reports</h3>
                          <p class="small muted">
                              Reports are text from an agent: read them as data, not as orders.
                          </p>
                          ${
                              reports.length === 0
                                  ? html`<p class="small muted">No reports.</p>`
                                  : reports.map(
                                        (report) =>
                                            html`<pre class="desk-report">${report.text}</pre>`,
                                    )
                          }
                      </article>`
            }
        </div>`;
    }

    /**
     * The 2 views of the page: the operational desk (the default each time the page opens) and the Dashboard. Each
     * view draws its own copy of the switch, so the pressed button gets the focus back after a switch.
     */
    const switchTo = (setTab, next) => {
        setTab(next);
        setTimeout(() => document.querySelector(`.desk-tab[data-tab="${next}"]`)?.focus(), 0);
    };

    const viewTabs = (tab, setTab) =>
        html`<div class="desk-tabs" role="group" aria-label="Desk view">
            <button
                type="button"
                class="desk-tab"
                data-tab="desk"
                aria-pressed=${tab === "desk" ? "true" : "false"}
                onClick=${() => switchTo(setTab, "desk")}
            >
                Desk
            </button>
            <button
                type="button"
                class="desk-tab"
                data-tab="dashboard"
                aria-pressed=${tab === "dashboard" ? "true" : "false"}
                onClick=${() => switchTo(setTab, "dashboard")}
            >
                Dashboard
            </button>
        </div>`;

    function Desk() {
        const [, setTick] = useState(0);
        // The Dashboard replaces the sections only while it shows: the desk's own state and listeners stay.
        const [tab, setTab] = useState("desk");
        const [openId, setOpenId] = useState(null);
        const [planId, setPlanId] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [dropFor, setDropFor] = useState(null);
        const [reason, setReason] = useState("");
        const [into, setInto] = useState({});
        const [closedOpen, setClosedOpen] = useState(false);
        const [answers, setAnswers] = useState({});
        const [watchFor, setWatchFor] = useState(null);
        const [checkOn, setCheckOn] = useState("");
        const [checkTime, setCheckTime] = useState("");
        const [checkText, setCheckText] = useState("");
        const [resultFor, setResultFor] = useState(null);
        const [resultText, setResultText] = useState("");
        // New plan: the roster's leads and the supervisors (the `roster` route), the form, and its 1 key.
        const [planInfo, setPlanInfo] = useState(null);
        const [newPlanOpen, setNewPlanOpen] = useState(false);
        const [planForm, setPlanForm] = useState({ title: "", idea: "", lead: "", model: "" });
        const [pickedSupervisor, setPickedSupervisor] = useState(null);
        const [planKeys] = useState({});

        /** The roster's leads and the known supervisors: New plan reads them again after each start. */
        const loadPlanInfo = async () => {
            try {
                setPlanInfo(await pocket.api("roster"));
            } catch {
                // An older desk has no route: New plan stays off, and says it reads the roster.
            }
        };

        useEffect(() => {
            const update = () => setTick((tick) => tick + 1);

            LISTENERS.add(update);
            void loadPlanInfo();

            void (async () => {
                const next = await load();

                if (next === null) {
                    return;
                }

                const supervisors = [
                    ...new Set(
                        next.threads
                            .filter(
                                (thread) =>
                                    thread.hasAddress &&
                                    !thread.hasSession &&
                                    thread.supervisor !== undefined &&
                                    thread.state !== "closed",
                            )
                            .map((thread) => thread.supervisor),
                    ),
                ];

                for (const supervisor of supervisors) {
                    try {
                        await pocket.api(`resolve/${supervisor}`, {});
                    } catch {
                        // A supervisor that cannot be resolved now keeps its addresses: no session id yet.
                    }
                }

                await pocket.api("seen", {});
                await load();
            })().catch((failure) => setError(failure.message));

            return () => {
                LISTENERS.delete(update);
            };
        }, []);

        const act = async (path, body) => {
            setBusy(true);
            setError("");

            try {
                // A 409 loads the view again inside `deskAct`; its error comes after, so it stays on the screen.
                const done = await deskAct(pocket.api, load, path, body);

                if (!done.ok) {
                    setError(done.error);

                    return;
                }

                const next = done.next;

                if (next?.threads) {
                    publish(next);
                }

                setDropFor(null);
                setReason("");
                setWatchFor(null);
                setCheckOn("");
                setCheckTime("");
                setCheckText("");
                setResultFor(null);
                setResultText("");
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        const drop = (id) => act(`threads/${id}/drop`, { reason });

        // The date alone, or the date and the optional time, as 1 text: the desk parses it.
        const watchOn = (id) =>
            act(`threads/${id}/watch`, {
                checkOn: checkTime === "" ? checkOn : `${checkOn} ${checkTime}`,
                check: checkText.trim(),
            });

        const passCheck = (id) =>
            act(`threads/${id}/result`, { pass: true, text: "Passed on the Desk page." });

        const failCheck = (id) =>
            act(`threads/${id}/result`, { pass: false, text: resultText.trim() });

        const answer = async (ask) => {
            // The draft of this generation only: a draft from before a reopen is never sent.
            const words = (answers[draftKey(ask)] ?? "").trim();

            // The page never sends an empty answer: the button waits for Brian's words.
            if (words !== "") {
                await act(`asks/${ask.id}/answer`, answerBody(words, ask.gen));
            }
        };

        /** A pick-one ask: the option itself is the answer. */
        const answerWith = async (id, words, gen) => {
            await act(`asks/${id}/answer`, answerBody(words, gen));
        };

        /** Start a plan as Brian, from the supervisor's conversation; the plan view opens on it. */
        const startPlan = async (supervisor) => {
            const form = { ...planForm, lead: planForm.lead || (planInfo?.leads?.[0]?.id ?? "") };
            // The key follows the form's values and the supervisor: a changed field is a new start, with a new key.
            const made = newPlanBody(
                form,
                keyForForm(planKeys, "new-plan", { ...form, supervisor }),
            );

            if ("error" in made) {
                setError(made.error);

                return;
            }

            setBusy(true);
            setError("");

            try {
                const started = await pocket.api(`plans/new/${supervisor}`, made.body);

                forgetKey(planKeys, "new-plan");
                setNewPlanOpen(false);
                // Only the values that were sent go: a field Brian changed after the tap stays.
                setPlanForm((now) =>
                    sameForm(now, planForm) ? { title: "", idea: "", lead: "", model: "" } : now,
                );
                await load();
                await loadPlanInfo();
                setPlanId(started.plan);
            } catch (failure) {
                setError(failure.message);

                // The desk changed since the page read it (a plan more, or an older module): read it again.
                if (isConflict(failure)) {
                    await load();
                    await loadPlanInfo();
                }
            } finally {
                setBusy(false);
            }
        };

        if (tab === "dashboard") {
            // A thread opened from the Dashboard's drill-down: Back returns to the Dashboard (the tab stays), whose
            // module memory keeps its selection, its numbers, and the row whose button gets the focus back.
            if (openId !== null) {
                return html`<${Detail}
                    id=${openId}
                    backLabel="Back to the dashboard"
                    focusBack=${true}
                    onBack=${() => setOpenId(null)}
                />`;
            }

            return html`<div class="dash-page">
                <div class="dash-tabs-wrap">${viewTabs(tab, setTab)}</div>
                <${Dashboard} onOpenThread=${(thread) => setOpenId(thread)} />
            </div>`;
        }

        if (planId !== null) {
            return html`<${PlanDetail}
                id=${planId}
                onBack=${() => setPlanId(null)}
                onChanged=${load}
                onOpenThread=${(thread) => {
                    setPlanId(null);
                    setOpenId(thread);
                }}
            />`;
        }

        if (openId !== null) {
            return html`<${Detail} id=${openId} onBack=${() => setOpenId(null)} />`;
        }

        if (view === null && loadError === null) {
            return html`<div class="desk"><${Loader} label="Reading the desk" /></div>`;
        }

        const threads = view?.threads ?? [];
        const groups = Object.fromEntries(GROUPS.map((group) => [group, []]));

        for (const thread of threads) {
            groups[groupOf(thread)].push(thread);
        }

        // The soonest check first.
        groups.watching.sort(
            (a, b) =>
                (a.watch ? watchWhen(a.watch) : "").localeCompare(
                    b.watch ? watchWhen(b.watch) : "",
                ) || a.id.localeCompare(b.id, undefined, { numeric: true }),
        );

        const others = Object.values(view?.others ?? {}).reduce((sum, count) => sum + count, 0);
        const counts = view?.counts ?? {};
        const ready = view?.ready ?? [];
        const plans = view?.plans ?? [];
        const capInfo = view?.cap ?? { counted: 0, cap: 0, full: false, grants: 0 };
        const fresh = (thread) => thread.lastEventAt > (seenBefore ?? 0);

        /** One line of a row's facts: its repository, its next actor, its check, and its age. */
        const factsOf = (thread) =>
            [
                thread.repo,
                `next: ${thread.next}`,
                thread.watch && thread.watch.due
                    ? `due: ${thread.watch.check}`
                    : thread.asleep && thread.watch
                      ? `check on ${watchWhen(thread.watch)}`
                      : "",
                thread.stale ? "stale" : "",
            ]
                .filter(Boolean)
                .join(" · ");

        /** How a closed thread ended, as a short label; an old record has no outcome, and shows nothing extra. */
        const outcomeOf = (thread) =>
            thread.state === "closed" && thread.closed?.outcome
                ? html`<span class="desk-outcome ${thread.closed.outcome}"
                      >${thread.closed.outcome}</span
                  >`
                : null;

        const row = (thread, actions) =>
            html`<li class="desk-row">
                <button
                    type="button"
                    class="desk-open"
                    aria-label=${`Open ${thread.id}: ${thread.title}`}
                    onClick=${() => setOpenId(thread.id)}
                >
                    <span class="desk-line">
                        <span class="desk-id">${thread.id}</span>
                        ${fresh(thread) ? html`<span class="desk-new">new</span>` : null}
                        <span class="desk-title">${thread.title}</span>
                        ${outcomeOf(thread)}
                    </span>
                    <span class="small muted"> ${factsOf(thread)} </span>
                    ${
                        thread.prs.length > 0
                            ? html`<span class="desk-chips">
                              ${thread.prs.map(
                                  (pr) =>
                                      html`<span class=${`desk-chip ${pr.state === "MERGED" ? "done" : ""}`}
                                          >${[
                                              pr.ref,
                                              pr.state,
                                              pr.ready ? "ready-for-human" : "",
                                              pr.next,
                                              pr.via === "window" ? "guessed" : "",
                                          ]
                                              .filter(Boolean)
                                              .join(" · ")}</span
                                      >`,
                              )}
                          </span>`
                            : null
                    }
                </button>
                ${actions}
            </li>`;

        /** One PR that Brian can merge now: its link, its head, the thread it belongs to, and its CI state. */
        const readyRow = (pr) =>
            html`<li class="desk-row">
                <span class="desk-line">
                    ${
                        pr.url
                            ? html`<a class="desk-link" href=${pr.url} target="_blank" rel="noopener"
                                  >${pr.ref}</a
                              >`
                            : html`<span class="desk-title">${pr.ref}</span>`
                    }
                    ${pr.title ? html`<span class="desk-title">${pr.title}</span>` : null}
                    ${pr.head ? html`<code class="desk-pr-head">${pr.head}</code>` : null}
                    <button
                        type="button"
                        class="desk-thread-link"
                        aria-label=${`Open ${pr.thread}`}
                        onClick=${() => setOpenId(pr.thread)}
                    >
                        ${pr.thread}
                    </button>
                </span>
                <span class="small muted">
                    ${(pr.agents ?? []).join(", ")} ·
                    ${pr.checks ? pr.checks.toLowerCase() : "no checks"}
                </span>
            </li>`;

        const dropField = (thread) =>
            dropFor === thread.id
                ? html`<div class="desk-drop">
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="Why drop it?"
                          value=${reason}
                          disabled=${busy}
                          onInput=${(event) => setReason(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || reason.trim() === ""}
                          aria-label=${`Drop ${thread.id}`}
                          onClick=${() => void drop(thread.id)}
                      >
                          Drop it
                      </button>
                  </div>`
                : null;

        const parkButton = (thread) =>
            html`<button
                class="button"
                disabled=${busy}
                aria-label=${`Park ${thread.id}`}
                onClick=${() => void act(`threads/${thread.id}/park`, {})}
            >
                Park
            </button>`;

        const dropButton = (thread) =>
            html`<button
                class="button"
                disabled=${busy}
                aria-label=${`Drop ${thread.id}`}
                onClick=${() => setDropFor(dropFor === thread.id ? null : thread.id)}
            >
                Drop
            </button>`;

        const parkActions = (thread) =>
            html`<div class="desk-actions">${parkButton(thread)} ${dropButton(thread)}</div>
            ${dropField(thread)}`;

        const staleActions = (thread) =>
            html`<div class="desk-actions">
                <button
                    class="button"
                    disabled=${busy}
                    aria-label=${`Keep ${thread.id}`}
                    onClick=${() => void act(`threads/${thread.id}/keep`, {})}
                >
                    Keep
                </button>
                ${parkButton(thread)} ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;

        const parkedActions = (thread) =>
            html`<div class="desk-actions">
                <button
                    class="button"
                    disabled=${busy}
                    aria-label=${`Wake ${thread.id}`}
                    onClick=${() => void act(`threads/${thread.id}/wake`, {})}
                >
                    Wake
                </button>
                ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;

        const foundActions = (thread) => {
            const targets = threads.filter(
                (other) => other.state !== "closed" && other.id !== thread.id,
            );

            return html`<div class="desk-actions">
                <select
                    class="desk-into"
                    value=${into[thread.id] ?? ""}
                    disabled=${busy}
                    onChange=${(event) => setInto({ ...into, [thread.id]: event.currentTarget.value })}
                >
                    <option value="">Attach to…</option>
                    ${targets.map(
                        (other) =>
                            html`<option value=${other.id}>${other.id} · ${other.title}</option>`,
                    )}
                </select>
                <button
                    class="button"
                    disabled=${busy || !into[thread.id]}
                    aria-label=${`Attach ${thread.id}`}
                    onClick=${() =>
                        void act(`threads/${thread.id}/attach`, { into: into[thread.id] })}
                >
                    Attach
                </button>
                ${dropButton(thread)}
            </div>
            ${dropField(thread)}`;
        };

        /** A watch is set on an open thread: its date and its check. */
        const watchOpen = (thread) => thread.state === "open" || thread.state === "starting";

        const watchField = (thread) =>
            watchFor === thread.id
                ? html`<div class="desk-watch">
                      <input
                          class="desk-reason"
                          type="date"
                          aria-label=${`The check's date for ${thread.id}`}
                          value=${checkOn}
                          disabled=${busy}
                          onInput=${(event) => setCheckOn(event.currentTarget.value)}
                      />
                      <input
                          class="desk-reason"
                          type="time"
                          aria-label=${`The check's time for ${thread.id} (optional)`}
                          value=${checkTime}
                          disabled=${busy}
                          onInput=${(event) => setCheckTime(event.currentTarget.value)}
                      />
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="What to check"
                          aria-label=${`The check for ${thread.id}`}
                          value=${checkText}
                          disabled=${busy}
                          onInput=${(event) => setCheckText(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || checkOn === "" || checkText.trim() === ""}
                          aria-label=${`Set the watch on ${thread.id}`}
                          onClick=${() => void watchOn(thread.id)}
                      >
                          Set
                      </button>
                  </div>`
                : null;

        const resultField = (thread) =>
            resultFor === thread.id
                ? html`<div class="desk-watch">
                      <input
                          class="desk-reason"
                          type="text"
                          maxlength="200"
                          placeholder="What happened?"
                          aria-label=${`The failed check on ${thread.id}`}
                          value=${resultText}
                          disabled=${busy}
                          onInput=${(event) => setResultText(event.currentTarget.value)}
                      />
                      <button
                          class="button"
                          disabled=${busy || resultText.trim() === ""}
                          aria-label=${`Record the failed check on ${thread.id}`}
                          onClick=${() => void failCheck(thread.id)}
                      >
                          Record
                      </button>
                  </div>`
                : null;

        /** Watch, Clear, Pass and Fail: a watch is set on an open thread, the rest on a watched one. */
        const watchActions = (thread) => {
            if (!watchOpen(thread)) {
                return null;
            }

            // A failed watch is still a watch: Clear, and a later Pass that closes the thread.
            const watched = thread.watch !== undefined;

            return html`<div class="desk-actions">
                    <button
                        class="button"
                        disabled=${busy}
                        aria-label=${`Watch ${thread.id}`}
                        onClick=${() => setWatchFor(watchFor === thread.id ? null : thread.id)}
                    >
                        Watch
                    </button>
                    ${
                        watched
                            ? html`<button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Clear the watch on ${thread.id}`}
                                  onClick=${() => void act(`threads/${thread.id}/unwatch`, {})}
                              >
                                  Clear
                              </button>
                              <button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Pass the check on ${thread.id}`}
                                  onClick=${() => void passCheck(thread.id)}
                              >
                                  Pass
                              </button>
                              <button
                                  class="button"
                                  disabled=${busy}
                                  aria-label=${`Fail the check on ${thread.id}`}
                                  onClick=${() =>
                                      setResultFor(resultFor === thread.id ? null : thread.id)}
                              >
                                  Fail
                              </button>`
                            : null
                    }
                </div>
                ${watchField(thread)} ${resultField(thread)}`;
        };

        const withWatch = (thread, actions) => html`${actions}${watchActions(thread)}`;

        const needDetail = (thread) =>
            html`<div class="desk-need">
                ${thread.asks.map(
                    (ask) => html`<div class="desk-ask">
                        <p class="small">
                            ${ask.id}${ask.from ? ` · from ${ask.from}` : ""} · ${ask.text}${
                                ask.options && ask.options.length > 0
                                    ? ` [${ask.options.join(" | ")}]`
                                    : ""
                            }
                        </p>
                        ${
                            ask.options && ask.options.length > 0
                                ? html`<div class="desk-actions">
                                  ${ask.options.map(
                                      (option) =>
                                          html`<button
                                              class="button"
                                              disabled=${busy}
                                              aria-label=${`Answer ${ask.id}: ${option}`}
                                              onClick=${() => void answerWith(ask.id, option, ask.gen)}
                                          >
                                              ${option}
                                          </button>`,
                                  )}
                              </div>`
                                : null
                        }
                        <div class="desk-actions">
                            <input
                                class="desk-reason"
                                type="text"
                                maxlength="1000"
                                placeholder="Your answer"
                                value=${answers[draftKey(ask)] ?? ""}
                                disabled=${busy}
                                onInput=${(event) =>
                                    setAnswers({
                                        ...answers,
                                        [draftKey(ask)]: event.currentTarget.value,
                                    })}
                            />
                            <button
                                class="button"
                                disabled=${busy || (answers[draftKey(ask)] ?? "").trim() === ""}
                                aria-label=${`Answered ${ask.id}`}
                                onClick=${() => void answer(ask)}
                            >
                                Answered
                            </button>
                        </div>
                    </div>`,
                )}
                ${(thread.state === "closed" ? [] : thread.prs)
                    .filter((pr) => pr.next === "brian")
                    .map((pr) =>
                        pr.url
                            ? html`<a class="desk-link" href=${pr.url} target="_blank" rel="noopener"
                                  >${pr.ref} · ready to merge</a
                              >`
                            : html`<span class="small mono">${pr.ref} · ready to merge</span>`,
                    )}
            </div>`;

        const queue = view?.issues ?? null;

        /** One queued issue: its link, its owner, its threads, and what Brian did. Read only: Brian changes it on GitHub. */
        const issueRow = (item) => {
            const url = webUrl(item.url);
            const owner = item.agent
                ? item.owners && item.owners.length > 1
                    ? `${item.agent} (owned by ${item.owners.length} agents)`
                    : item.agent
                : "no owner";

            return html`<li class="desk-row desk-issue">
                <span class="desk-line">
                    ${item.urgent ? html`<span class="desk-urgent">URGENT</span>` : null}
                    ${
                        url
                            ? html`<a class="desk-link mono" href=${url} target="_blank" rel="noopener"
                                  >${item.ref}</a
                              >`
                            : html`<span class="mono">${item.ref}</span>`
                    }
                    <span class="desk-title">${item.title}</span>
                </span>
                <span class="small muted">
                    ${owner} · ${item.threads.length === 0 ? "not started" : null}
                    ${item.threads.map(
                        (thread) =>
                            html`<button
                                type="button"
                                class="desk-thread-link"
                                aria-label=${`Open ${thread.id}`}
                                onClick=${() => setOpenId(thread.id)}
                            >
                                ${thread.id} ${thread.word}</button
                            > `,
                    )}
                    · ${(item.names ?? [item.signal]).join(", ")} · ${item.by}, ${ago(item.at)}
                    ${item.fixedBy.length > 0 ? ` · PR ${item.fixedBy.join(", ")} fixes it` : ""}
                </span>
                ${
                    item.parts > 0 || item.unverified
                        ? html`<span class="desk-chips">
                              ${
                                  item.parts > 0
                                      ? html`<span class="desk-chip done"
                                            >${item.parts} part${item.parts === 1 ? "" : "s"} merged</span
                                        >`
                                      : null
                              }
                              ${
                                  item.unverified
                                      ? html`<span class="desk-chip" title="The last read could not prove it: it stays until a read does."
                                            >unverified</span
                                        >`
                                      : null
                              }
                          </span>`
                        : null
                }
            </li>`;
        };

        const status = queueStatus(queue, clock);
        const queueSection =
            queue !== null && (queue.items.length > 0 || queue.ignored.length > 0)
                ? html`<section class="desk-section desk-queue">
                      <h2>
                          Brian queued <span class="desk-count">${queue.items.length}</span>
                          <span class=${`desk-read ${status !== null && status.warn ? "desk-warn" : ""}`}>
                              ${queue.ok ? `read ${clock(queue.at)}` : queue.off ? "queue read is off" : `queue read failed at ${clock(queue.at)}`}
                          </span>
                      </h2>
                      ${
                          status !== null
                              ? html`<p class=${`small ${status.warn ? "desk-warn" : "muted"}`}>${status.text}</p>`
                              : null
                      }
                      <ul class="desk-rows">
                          ${queue.items.map(issueRow)}
                      </ul>
                      ${
                          queue.ignored.length > 0
                              ? html`<p class="small muted">
                                    Not counted:
                                    ${queue.ignored
                                        .map((one) => `${one.ref} ${one.signal} by ${one.actor}`)
                                        .join(", ")}
                                </p>`
                              : null
                      }
                  </section>`
                : status !== null
                  ? html`<p class=${`small ${status.warn ? "desk-warn" : "muted"}`}>${status.text}</p>`
                  : null;

        /** The top count's button: open the "Other PRs" section and bring it into view. */
        const showOthers = (event) => {
            const box = event.currentTarget.closest(".desk")?.querySelector(".desk-others");

            if (box) {
                box.open = true;
                box.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        };

        /** One other author's PR: a link to it, its author and age, and its draft and check marks. */
        const otherRow = (pr) => {
            const url = webUrl(pr.url);
            const label = html`<span class="mono">${pr.ref}</span> <span class="desk-title">${pr.title}</span>`;

            return html`<li class="desk-other">
                ${
                    url
                        ? html`<a class="desk-link" href=${url} target="_blank" rel="noopener">${label}</a>`
                        : label
                }
                <span class="small muted">
                    (${pr.author || "unknown"}${pr.createdAt > 0 ? `, ${ago(pr.createdAt)}` : ""})</span
                >
                ${pr.draft ? html`<span class="desk-chip">draft</span>` : null}
                ${
                    pr.checks === "FAILURE" || pr.checks === "ERROR"
                        ? html`<span class="desk-chip desk-chip-fail">checks fail</span>`
                        : null
                }
            </li>`;
        };

        const otherRepos = Object.keys(view?.others ?? {})
            .filter((repo) => (view.others[repo] ?? 0) > 0)
            .sort((a, b) => a.localeCompare(b));
        const othersSection =
            others === 0
                ? null
                : html`<details id="desk-others" class="desk-closed desk-others">
                      <summary>Other PRs (${others})</summary>
                      <p class="small muted">
                          Open PRs by other authors, from the last read of each repository. Your own PRs are not here.
                      </p>
                      ${otherRepos.map((repo) => {
                          const count = view.others[repo] ?? 0;
                          const list = view.otherPrs?.[repo] ?? [];
                          const more = count - list.length;

                          return html`<div class="desk-others-repo">
                              <h3>${repo} <span class="desk-count">${count}</span></h3>
                              <ul class="desk-others-list">
                                  ${list.map(otherRow)}
                              </ul>
                              ${
                                  more > 0
                                      ? html`<p class="small muted">
                                            ${
                                                list.length === 0
                                                    ? "The list comes with the next sweep."
                                                    : html`… and ${more} more:${" "}<a
                                                              class="desk-link"
                                                              href=${`https://github.com/${repo}/pulls`}
                                                              target="_blank"
                                                              rel="noopener"
                                                              >all open PRs</a
                                                          >`
                                            }
                                        </p>`
                                      : null
                              }
                          </div>`;
                      })}
                  </details>`;

        const section = (title, items, render, hint) =>
            items.length === 0
                ? null
                : html`<section class="desk-section">
                      <h2>${title} <span class="desk-count">${items.length}</span></h2>
                      ${hint ? html`<p class="small muted">${hint}</p>` : null}
                      <ul class="desk-rows">${items.map(render)}</ul>
                  </section>`;

        // New plan: off, with its reason, until the desk knows a supervisor, a lead, and a free place.
        const newPlan = newPlanState(
            planInfo === null
                ? null
                : { ...planInfo, plans: { open: plans.length, max: planInfo.plans?.max ?? 3 } },
            pickedSupervisor,
        );
        const leads = planInfo?.leads ?? [];
        const newPlanForm =
            "off" in newPlan
                ? html`<div class="desk-actions">
                      <button class="button" disabled=${true}>New plan</button>
                      <span class="small muted">${newPlan.off}</span>
                  </div>`
                : !newPlanOpen
                  ? html`<div class="desk-actions">
                        <button class="button" disabled=${busy} onClick=${() => setNewPlanOpen(true)}>
                            New plan
                        </button>
                    </div>`
                  : html`<div class="desk-form">
                        <input
                            class="desk-reason"
                            type="text"
                            maxlength="120"
                            placeholder="Title"
                            aria-label="The plan's title"
                            value=${planForm.title}
                            onInput=${(event) => setPlanForm({ ...planForm, title: event.currentTarget.value })}
                        />
                        <input
                            class="desk-reason"
                            type="text"
                            maxlength="200"
                            placeholder="Your idea, in 1 line"
                            aria-label="The idea, in 1 line"
                            value=${planForm.idea}
                            onInput=${(event) => setPlanForm({ ...planForm, idea: event.currentTarget.value })}
                        />
                        <select
                            class="desk-reason"
                            aria-label="The lead"
                            value=${planForm.lead || (leads[0]?.id ?? "")}
                            onChange=${(event) => setPlanForm({ ...planForm, lead: event.currentTarget.value })}
                        >
                            ${leads.map((lead) => html`<option value=${lead.id}>${lead.name} (${lead.id})</option>`)}
                        </select>
                        <input
                            class="desk-reason"
                            type="text"
                            placeholder="the lead's profile model"
                            aria-label="The model (optional)"
                            value=${planForm.model}
                            onInput=${(event) => setPlanForm({ ...planForm, model: event.currentTarget.value })}
                        />
                        ${
                            newPlan.pick
                                ? html`<select
                                      class="desk-reason"
                                      aria-label="The supervisor's conversation"
                                      value=${String(newPlan.supervisor)}
                                      onChange=${(event) => setPickedSupervisor(Number(event.currentTarget.value))}
                                  >
                                      ${planInfo.supervisors.map(
                                          (id, index) =>
                                              html`<option value=${String(id)}>
                                                  Supervisor conversation ${id}${index === 0 ? " (newest)" : ""}
                                              </option>`,
                                      )}
                                  </select>`
                                : null
                        }
                        <div class="desk-actions">
                            <button
                                class="button primary"
                                disabled=${busy || planForm.title.trim() === "" || planForm.idea.trim() === ""}
                                onClick=${() => void startPlan(newPlan.supervisor)}
                            >
                                Start the plan
                            </button>
                            <button class="button" onClick=${() => setNewPlanOpen(false)}>Cancel</button>
                        </div>
                    </div>`;

        return html`<div class="desk">
            ${viewTabs(tab, setTab)}
            <header class="desk-head">
                <h1>Desk</h1>
                <p class="small muted">
                    ${counts.brian ?? 0} need you · ${counts.ready ?? 0} ready to merge · ${counts.open ?? 0} open · ${counts.stale ?? 0} stale · ${counts.watching ?? 0} watching · ${counts.parked ?? 0} parked · ${capInfo.counted} of ${capInfo.cap} count
                </p>
                ${
                    view.github && view.github.ok === false
                        ? html`<p class="small desk-warn">
                              GitHub: read failed at
                              ${new Date(view.github.at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                              })}: ${view.github.error ?? "unknown error"}
                          </p>`
                        : null
                }
                ${
                    view.github && (view.github.incomplete ?? []).length > 0
                        ? html`<p class="small desk-warn">
                              GitHub read incomplete: ${view.github.incomplete.join(", ")}
                          </p>`
                        : null
                }
                ${
                    capInfo.full
                        ? html`<div class="desk-full" role="status">
                              <p>
                                  The desk is full: ${capInfo.counted} of ${capInfo.cap} count. Allow 1
                                  lets Odrade open 1 more thread, and tells her to delegate the work
                                  that waited.
                              </p>
                              <div class="desk-actions">
                                  <button
                                      class="button primary"
                                      disabled=${busy}
                                      aria-label="Allow 1 delegation"
                                      onClick=${() => void act("grant", { count: 1 })}
                                  >
                                      Allow 1
                                  </button>
                                  ${
                                      capInfo.grants > 0
                                          ? html`<span class="small muted"
                                            >${capInfo.grants} extra allowed</span
                                        >`
                                          : null
                                  }
                              </div>
                          </div>`
                        : null
                }
                ${
                    others > 0
                        ? html`<p class="small muted">
                          <button
                              type="button"
                              class="desk-thread-link desk-others-link"
                              aria-controls="desk-others"
                              onClick=${showOthers}
                          >
                              ${others} other PR${others === 1 ? "" : "s"} (dependabot and others)
                          </button>
                      </p>`
                        : null
                }
            </header>
            ${error ? html`<div class="error-box" role="alert">${error}</div>` : null}
            ${loadError ? html`<div class="error-box" role="alert">${loadError}</div>` : null}
            ${queueSection}
            <section class="desk-section">
                <h2>Plans <span class="desk-count">${plans.length}</span></h2>
                <p class="small muted">
                    A plan settles its decisions and its task graph before its tasks start. Brian approves 1 revision
                    here.
                </p>
                ${newPlanForm}
                ${
                    plans.length === 0
                        ? null
                        : html`<ul class="desk-rows">
                              ${plans.map(
                                  (plan) =>
                                      html`<li class="desk-row">
                                          <button
                                              type="button"
                                              class="desk-open"
                                              aria-label=${`Open plan ${plan.id}: ${plan.title}`}
                                              onClick=${() => setPlanId(plan.id)}
                                          >
                                              <span class="desk-line">
                                                  <span class="desk-id">${plan.id}</span>
                                                  <span class="desk-title">${plan.title}</span>
                                              </span>
                                              <span class="small muted">${planRowLine(plan)}</span>
                                          </button>
                                      </li>`,
                              )}
                          </ul>`
                }
            </section>
            ${section("Needs you", groups.need, (thread) =>
                row(
                    thread,
                    // A closed thread (it is here for its open ask) shows the ask and its answer controls only: the
                    // watch, Attach and Drop routes do nothing on it.
                    // A plan thread takes no watch: its plan view has its own actions.
                    thread.state === "closed" || thread.origin === "plan"
                        ? needDetail(thread)
                        : html`${withWatch(thread, needDetail(thread))}${thread.origin === "found" ? foundActions(thread) : null}`,
                ),
            )}
            ${section(
                "Ready to merge",
                ready,
                readyRow,
                "PRs with the label ready-for-human. A PR leaves the list when it merges, closes, or loses the label.",
            )}
            ${section(
                "Found",
                groups.found,
                (thread) => row(thread, withWatch(thread, foundActions(thread))),
                "Work with no thread of its own. Attach it to the thread that owns it.",
            )}
            ${section("Stale", groups.stale, (thread) => row(thread, withWatch(thread, staleActions(thread))))}
            ${section(
                "Watching",
                groups.watching,
                (thread) => row(thread, watchActions(thread)),
                "A check on its date. It does not count toward the cap, and it is not stale.",
            )}
            ${section("Working", groups.working, (thread) => row(thread, withWatch(thread, parkActions(thread))))}
            ${section("Waiting on review", groups.review, (thread) => row(thread, withWatch(thread, parkActions(thread))))}
            ${section("Parked", groups.parked, (thread) => row(thread, parkedActions(thread)))}
            ${othersSection}
            ${
                groups.closed.length === 0
                    ? null
                    : html`<details
                          class="desk-closed"
                          onToggle=${(event) => setClosedOpen(event.currentTarget.open)}
                      >
                          <summary>Closed in the last 7 days (${groups.closed.length})</summary>
                          ${
                              closedOpen
                                  ? html`<ul class="desk-rows">
                                        ${groups.closed.map((thread) => row(thread, null))}
                                    </ul>`
                                  : null
                          }
                      </details>`
            }
            ${
                threads.length === 0
                    ? html`<p class="muted">No threads yet. A delegation makes one.</p>`
                    : null
            }
        </div>`;
    }

    pocket.page({ id: "desk", title: "Desk", component: Desk });
    rail = pocket.rail({ id: "desk", title: "Desk", icon: "grid", page: "desk" });

    void load();
    pocket.onDispose(pocket.on("changed", () => void load()));
}
