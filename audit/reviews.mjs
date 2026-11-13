// Cross-review records for the daily audit: parsers of reviewer calls and answers, and the joins that Q1's `prRounds`
// and `blockers` read. Pure functions: no I/O. `sources.mjs` and `checks.mjs` both import this module; it imports
// neither of them. No message text leaves it: only refs, numbers, SHAs, item labels and booleans.
import { DAY } from "./common.mjs";

/** The window of `prRounds` and `blockers`, in days. */
export const REVIEW_WINDOW_DAYS = 30;

/**
 * A cross-review reviewer (Brian's cross-review policy): a read-only subagent with exactly the tools `read` and
 * `bash`, whose name or brief says "review". It runs on another model family by design.
 */
export function isCrossReviewSpawn(spawn) {
    const tools = spawn.tools;

    return (
        Array.isArray(tools) &&
        tools.length === 2 &&
        tools.includes("read") &&
        tools.includes("bash") &&
        (spawn.review === true || /review/i.test(`${spawn.name ?? ""} ${spawn.brief ?? ""}`))
    );
}

const byThreadId = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

/**
 * The desk thread of a session at a time: the only thread of that session, or of 2 or more, the one with the latest
 * `startedAt` at or before `at`. Undefined when there is none.
 */
export function threadAt(data, session, at) {
    const list = Object.values(data.threads ?? {}).filter(
        (thread) => thread.session !== undefined && thread.session === session,
    );

    if (list.length <= 1) {
        return list[0];
    }

    return list
        .filter((thread) => typeof thread.startedAt === "number" && thread.startedAt <= at)
        .sort((a, b) => b.startedAt - a.startedAt || byThreadId(a.id, b.id))[0];
}

// ---------- Parsers ----------

const URL_REF = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const HASH_REF = /(?<![\w./-])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g;
// `OWNER/NAME` that is not a part of a path, then on the same line, in at most 40 characters with no `#`, a PR number.
const NAMED_REF =
    /(?<![\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*?)(?![\w.-]*\/)(?=[\s`'",:;)(]|$)[^\n#]{0,40}?\b(?:PR\s*#?|pull request\s*#)(\d+)\b/gi;
const BARE = /\b(?:PR\s*#?|pull request\s*#)(\d+)\b/gi;

/**
 * The PRs a text names. `refs`: `OWNER/NAME#N`, each once, in text order, from a PR URL, an `OWNER/NAME#N`, or an
 * `OWNER/NAME` with `PR N`, `PR #N` or `pull request #N` after it on the same line. `bare`: the numbers of `PR #N`,
 * `PR N` and `pull request #N` that are not the number of a ref, each once, in text order.
 */
export function prRefsIn(text) {
    const source = String(text ?? "");
    const found = [];

    for (const pattern of [URL_REF, HASH_REF, NAMED_REF]) {
        for (const match of source.matchAll(pattern)) {
            found.push({ ref: `${match[1]}#${match[2]}`, index: match.index });
        }
    }

    found.sort((a, b) => a.index - b.index);

    const refs = [...new Set(found.map((item) => item.ref))];
    const numbers = new Set(refs.map((ref) => Number(ref.split("#")[1])));
    const bare = [...source.matchAll(BARE)]
        .map((match) => Number(match[1]))
        .filter((number) => !numbers.has(number));

    return { refs, bare: [...new Set(bare)] };
}

// Rule 1: `new head`, `current PR head`, `latest HEAD`, then a full SHA within 30 characters on the same line.
const NEW_HEAD =
    /\b(?:new|current|updated|latest)\s+(?:PR\s+)?head\b[^\n]{0,30}?\b([0-9a-f]{40})\b/i;
// Rule 2: `from A to B` (backticks allowed), and the ranges `A..B` and `A...B`.
const FROM_TO = /\bfrom\s+`?([0-9a-f]{40})`?\s+to\s+`?([0-9a-f]{40})\b/i;
const SHA_RANGE = /\b([0-9a-f]{40})\.\.\.?([0-9a-f]{40})\b/i;
// Rule 3: the word `head`, then a full SHA within 30 characters on the same line (a sticky match at its end).
const HEAD = /\bhead\b/gi;
const SHA_AFTER = /[^\n]{0,30}?\b([0-9a-f]{40})\b/iy;
// The word just before `head` on its line.
const WORD_BEFORE = /([a-z]+)[^a-z0-9\n]*$/i;
// A `head` after one of these words names an old head, not the reviewed one.
const OLD_HEAD_WORDS = new Set([
    "previous",
    "prior",
    "old",
    "last",
    "earlier",
    "former",
    "reviewed",
    "base",
]);
// Rule 4: the bare pair `A B`.
const SHA_PAIR = /\b([0-9a-f]{40})\s+([0-9a-f]{40})\b/i;

/**
 * The reviewed head of a call, a full 40-hex SHA, by the first rule that finds one: (1) a SHA within 30 characters
 * after `new`, `current`, `updated` or `latest`, an optional `PR`, and `head`, on the same line; (2) B of
 * `from A to B` (backticks allowed), `A..B` or `A...B`; (3) a SHA within 30 characters after a word `head` on the same
 * line, where the word before `head` is not `previous`, `prior`, `old`, `last`, `earlier`, `former`, `reviewed` or
 * `base` (each `head` in text order); (4) B of the bare pair `A B`. Else null.
 */
export function headIn(text) {
    const source = String(text ?? "");
    const named = NEW_HEAD.exec(source) ?? FROM_TO.exec(source) ?? SHA_RANGE.exec(source);

    if (named) {
        return named[2] ?? named[1];
    }

    for (const match of source.matchAll(HEAD)) {
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const before = WORD_BEFORE.exec(source.slice(lineStart, match.index))?.[1];

        if (before !== undefined && OLD_HEAD_WORDS.has(before.toLowerCase())) {
            continue;
        }

        SHA_AFTER.lastIndex = match.index + match[0].length;

        const after = SHA_AFTER.exec(source);

        if (after) {
            return after[1];
        }
    }

    return SHA_PAIR.exec(source)?.[2] ?? null;
}

// The label of a review item at the start of a line: `1.`, `### 2.`, `**A1 —`, `**A-R1 —`, `- **Finding 3:`.
const ITEM_LABEL =
    /^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*)?(?:Finding\s+)?([A-Z](?:-R)?\d+|\d+)(?:[.):]|\s+[—–-]\s)/;

/**
 * The labels of the blocking points of a reviewer's answer, each once, in text order: a line that says "blocking"
 * and then "yes" belongs to the latest item label above it (or on it). A blocking point with no label is `#1`, `#2`,
 * and so on. "Previously blocking" is not a point.
 */
export function blockingItems(text) {
    const items = [];
    let label = null;
    let unlabeled = 0;

    for (const line of String(text ?? "").split("\n")) {
        const found = ITEM_LABEL.exec(line);

        if (found) {
            label = found[1];
        }

        if (/\bblocking\b\W{0,8}yes\b/i.test(line) && !/previously\s+blocking/i.test(line)) {
            const item = label ?? `#${(unlabeled += 1)}`;

            if (!items.includes(item)) {
                items.push(item);
            }
        }
    }

    return items;
}

/** A reviewer's verdict: false for "Not ready", true for "Ready", else null. */
export const verdictIn = (text) =>
    /\bnot ready\b/i.test(String(text ?? ""))
        ? false
        : /\bready\b/i.test(String(text ?? ""))
          ? true
          : null;

/** A subagent's answer as Pocket delivers it: `[subagent NAME answered …]`, maybe after a `[from: …]` mark. */
export const ANSWER = /^\s*(?:\[from: [^\]\n]*\]\s*)?\[subagent ([^\s\]]+) answered\b/;

// ---------- Joins ----------

const ownerOf = (repo) => /^([\w.-]+)\/[\w.-]+/.exec(String(repo ?? ""))?.[1]?.toLowerCase();

/** The lower-case owners of every desk thread's `repo` and of every key of its `prs`. */
export function ownersOf(data) {
    const owners = new Set();

    for (const thread of Object.values(data.threads ?? {})) {
        for (const repo of [thread.repo, ...Object.keys(thread.prs ?? {})]) {
            const owner = ownerOf(repo);

            if (owner) {
                owners.add(owner);
            }
        }
    }

    return owners;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * The PR of 1 review call: the first of its refs whose owner is a desk owner; with no such ref, its first bare number
 * in the repository of its desk thread. `count` is how many such refs it names, and `refs` lists them.
 */
export function callPr(call, data, owners = ownersOf(data)) {
    const refs = [
        ...new Set(
            (Array.isArray(call.refs) ? call.refs : []).filter((ref) => owners.has(ownerOf(ref))),
        ),
    ];

    if (refs.length > 0) {
        return { ref: refs[0], count: refs.length, refs };
    }

    const bare = Array.isArray(call.bare) ? call.bare : [];
    const repo = bare.length > 0 ? threadAt(data, call.c, call.at)?.repo : undefined;

    return {
        ref: typeof repo === "string" && REPO.test(repo) ? `${repo}#${bare[0]}` : null,
        count: 0,
        refs,
    };
}

/**
 * Every loaded review call (all history: the audit loads them with no lower time limit), oldest first, each with `round` (a cross-review spawn, or a
 * send whose name's latest spawn in that session was one), `pr` (`callPr`; a send with no PR of its own takes the PR
 * of the latest earlier call to the same name in the same session), `head` (the call's own) and `reviewedHead` (the
 * call's own head; else the `reviewedHead` of the latest earlier call to the same name in the same session, when that
 * call has the same `pr.ref`; else null). No window filter here: a spawn before the window still sets the round, the
 * PR and the reviewed head of a later send.
 */
function reviewCalls(data) {
    const owners = ownersOf(data);
    const calls = (Array.isArray(data.reviewCalls) ? data.reviewCalls : [])
        .filter((call) => typeof call?.at === "number")
        .map((call, index) => ({ call, index }))
        .sort((a, b) => a.call.at - b.call.at || a.call.id - b.call.id || a.index - b.index)
        .map((item) => item.call);
    const latestSpawn = new Map();
    const latestPr = new Map();
    const latestHead = new Map();

    return calls.map((call) => {
        const key = `${call.c}\u0000${call.name}`;
        let round = false;
        let pr = callPr(call, data, owners);

        if (call.action === "spawn") {
            round = isCrossReviewSpawn(call);
            latestSpawn.set(key, round);
        } else if (call.action === "send") {
            round = latestSpawn.get(key) === true;

            if (pr.ref === null && pr.count === 0 && latestPr.has(key)) {
                pr = latestPr.get(key);
            }
        }

        const head = typeof call.head === "string" ? call.head : null;
        const earlier = latestHead.get(key);
        const reviewedHead = head ?? (earlier?.ref === pr.ref ? earlier.head : null);

        latestPr.set(key, pr);
        latestHead.set(key, { ref: pr.ref, head: reviewedHead });

        return { call, key, round, pr, head, reviewedHead };
    });
}

/**
 * The reviewed heads of the window, oldest first: each round call (a call `at` or after `now` minus
 * `REVIEW_WINDOW_DAYS`) as `{ ref, head, chain, at, session, reviewer, superseded }`. `head` is the call's
 * `reviewedHead`; `chain` is the key of its session and name. A round call is `superseded` when the answers source is
 * usable (`data.reviewAnswers` is an array, and `data.sourceErrors.reviewAnswers` is not set), the next call of its
 * chain is a round with the same PR, and no answer of the chain has a time from the call's to the next call's (both
 * included): the reviewer got the next message in the same run, so the call is no reviewed head of its own. Without a
 * usable answers source, no call is superseded.
 */
export function reviewedHeads(data, ctx) {
    const from = ctx.now - REVIEW_WINDOW_DAYS * DAY;
    const usable = Array.isArray(data.reviewAnswers) && !data.sourceErrors?.reviewAnswers;
    const answersOf = new Map();

    if (usable) {
        for (const answer of data.reviewAnswers) {
            if (typeof answer?.at === "number") {
                const key = `${answer.c}\u0000${answer.name}`;

                answersOf.set(key, [...(answersOf.get(key) ?? []), answer.at]);
            }
        }
    }

    const calls = reviewCalls(data);
    const next = new Map();

    // `calls` is oldest first: walk it from the end to know the next call of each chain.
    for (let index = calls.length - 1, later = new Map(); index >= 0; index -= 1) {
        next.set(calls[index], later.get(calls[index].key));
        later.set(calls[index].key, calls[index]);
    }

    const superseded = (item) => {
        const after = next.get(item);

        return (
            usable &&
            after !== undefined &&
            after.round &&
            after.pr.ref === item.pr.ref &&
            !(answersOf.get(item.key) ?? []).some((at) => at >= item.call.at && at <= after.call.at)
        );
    };

    return calls
        .filter((item) => item.round && item.call.at >= from)
        .map((item) => ({
            ref: item.pr.ref,
            head: item.reviewedHead,
            chain: item.key,
            at: item.call.at,
            session: item.call.c,
            reviewer: item.call.name,
            superseded: superseded(item),
        }));
}

/**
 * The cross-review rounds of the window, oldest first: `{ ref, head, at, session, reviewer }`; `ref` may be null. The
 * earlier calls set the rounds and the PRs, and are not counted.
 */
export function reviewRounds(data, ctx) {
    const from = ctx.now - REVIEW_WINDOW_DAYS * DAY;

    return reviewCalls(data)
        .filter((item) => item.round && item.call.at >= from)
        .map((item) => ({
            ref: item.pr.ref,
            head: item.head,
            at: item.call.at,
            session: item.call.c,
            reviewer: item.call.name,
        }));
}

/**
 * The blocking points of the window's reviewer answers. An answer goes to the latest review call to its name in its
 * session at or before it; that call must be a round (its name's latest spawn is a cross-review spawn), or the
 * answer is skipped. A call that names 2 or more desk-owner refs makes its points `ref: null, ambiguous: true`.
 * Returns `{ answers, unparsed, points }`: `answers` counts the answers that went to a round, `unparsed` those of them
 * that say "Not ready" with no point found. A point is `{ ref, head, item, at, session, reviewer, answer }`.
 */
export function reviewPoints(data, ctx) {
    const from = ctx.now - REVIEW_WINDOW_DAYS * DAY;
    // The answers of the window join to every loaded call, the earlier ones too.
    const calls = reviewCalls(data);
    const answers = (Array.isArray(data.reviewAnswers) ? data.reviewAnswers : []).filter(
        (answer) => typeof answer?.at === "number" && answer.at >= from,
    );
    const points = [];
    let matched = 0;
    let unparsed = 0;

    for (const answer of answers) {
        const key = `${answer.c}\u0000${answer.name}`;
        let call;

        // `calls` is oldest first: the last one that fits is the latest.
        for (const item of calls) {
            if (item.call.at > answer.at) {
                break;
            }

            if (item.key === key) {
                call = item;
            }
        }

        if (!call?.round) {
            continue;
        }

        matched += 1;

        const items = Array.isArray(answer.items) ? answer.items : [];

        if (answer.ready === false && items.length === 0) {
            unparsed += 1;
        }

        for (const item of items) {
            const point = {
                ref: call.pr.count >= 2 ? null : call.pr.ref,
                head: call.head,
                item,
                at: answer.at,
                session: answer.c,
                reviewer: answer.name,
                answer: answer.id,
            };

            if (call.pr.count >= 2) {
                Object.assign(point, { ambiguous: true, refs: call.pr.refs });
            }

            points.push(point);
        }
    }

    points.sort(
        (a, b) =>
            a.at - b.at || String(a.item).localeCompare(String(b.item), "en", { numeric: true }),
    );

    return { answers: matched, unparsed, points };
}

/**
 * The final guard results of earlier days, by `ref@head`, from each day's `metrics.Q1.blockers.points`: the newest
 * day wins.
 */
export function guardCacheOf(earlier) {
    const cache = {};
    const days = (Array.isArray(earlier) ? earlier : [])
        .filter((day) => typeof day?.date === "string")
        .sort((a, b) => a.date.localeCompare(b.date));

    for (const day of days) {
        const points = day.json?.metrics?.Q1?.blockers?.points;

        for (const point of Array.isArray(points) ? points : []) {
            if (
                typeof point?.ref === "string" &&
                typeof point.head === "string" &&
                point.guard?.final === true
            ) {
                cache[`${point.ref}@${point.head}`] = point.guard;
            }
        }
    }

    return cache;
}
