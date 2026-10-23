#!/usr/bin/env node
// Daily audit: the deterministic part, as a first manual trial. Read-only.
//
// It reads Pocket's database with a read-only SQLite handle, the desk export and Odrade's notes
// with `git` and the file system, and GitHub with `gh` (GET requests and GraphQL queries only).
// It writes nothing outside the output file that you name. See ../daily-audit.md.
//
//     node docs/plans/daily-audit/trial.mjs [--hours 72] [--out /tmp/audit.json]
//
// Environment: PI_POCKET_DIR (default ~/.pi-pocket), ODRADE_DIR (default ~/projects/odrade).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";

const argv = process.argv.slice(2);

const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);

    return at === -1 ? fallback : argv[at + 1];
};

const HOURS = Number(option("hours", "72"));
const OUT = option("out", "");
const NOW = Date.now();
const SINCE = NOW - HOURS * 3600_000;
const POCKET = process.env.PI_POCKET_DIR ?? path.join(os.homedir(), ".pi-pocket");
const ODRADE = process.env.ODRADE_DIR ?? path.join(os.homedir(), "projects/odrade");
const BOT = "frostyard-machines";

const db = new DatabaseSync(path.join(POCKET, "pocket.sqlite"), { readOnly: true });
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const inWindow = (ms) => ms >= SINCE && ms <= NOW;
const findings = [];
const metrics = {};
// A line that looks like a secret is dropped, not masked.
const SECRET = /ghp_|github_pat_|\bsk-|AKIA[0-9A-Z]{8}|-----BEGIN|password=|token=/i;
const finding = (check, severity, text, evidence, lastSeen) =>
    findings.push({
        check,
        severity,
        text,
        evidence: evidence.filter((line) => !SECRET.test(line)),
        ...(lastSeen ? { lastSeen: iso(lastSeen) } : {}),
    });

// When each live module was last written: a finding whose last case is older than its module
// (plus 1 sweep of 10 minutes) may be fixed already.
const installed = Object.fromEntries(
    ["desk.ts", "team.ts", "night-shift.ts"].map((file) => {
        try {
            return [file, iso(fs.statSync(path.join(POCKET, "extensions", file)).mtimeMs)];
        } catch {
            return [file, null];
        }
    }),
);

// ---------- Pocket documents (base revision + deltas, as Pi Durable folds them) ----------

function materialize(id) {
    const base = db
        .prepare(
            "select seq, content from document_revisions where document_id=? and kind='base' order by seq desc limit 1",
        )
        .get(id);

    if (!base) {
        return undefined;
    }

    let value = JSON.parse(base.content);

    for (const row of db
        .prepare(
            "select content from document_revisions where document_id=? and seq>? order by seq",
        )
        .all(id, base.seq)) {
        value = apply(value, JSON.parse(row.content));
    }

    return value;
}

const docsOfKind = (kind) =>
    db
        .prepare("select id, owner_id from documents where kind=? and retired_at is null")
        .all(JSON.stringify(kind));

const deskDoc = docsOfKind("x.desk.threads")[0];
const desk = materialize(deskDoc.id);
const threads = desk.threads;

// The thread document keeps the last 50 events of a thread; the deltas keep all of them.
function allEvents() {
    const out = [];
    const seen = new Set();

    const add = (thread, event) => {
        const id = `${thread}|${event.at}|${event.key}|${event.text}`;

        if (!seen.has(id)) {
            seen.add(id);
            out.push({ thread, ...event });
        }
    };

    for (const row of db
        .prepare(
            "select content from document_revisions where document_id=? and kind='delta' order by seq",
        )
        .all(deskDoc.id)) {
        for (const op of JSON.parse(row.content)) {
            const [kind, at] = op;

            if (kind === "p" && at[0] === "threads" && at[2] === "events") {
                op[4].forEach((event) => add(at[1], event));
            } else if (kind === "s" && at[0] === "threads" && at.length === 2 && op[2]?.events) {
                op[2].events.forEach((event) => add(at[1], event));
            }
        }
    }

    for (const thread of Object.values(threads)) {
        (thread.events ?? []).forEach((event) => add(thread.id, event));
    }

    return out.sort((a, b) => a.at - b.at);
}

const events = allEvents();
const windowEvents = events.filter((event) => inWindow(event.at));
const byThread = new Map();

for (const event of events) {
    byThread.set(event.thread, [...(byThread.get(event.thread) ?? []), event]);
}

// A thread session's reports document keeps the last 10; the deltas keep every report.
function allReports(id) {
    const byKey = new Map();

    for (const row of db
        .prepare("select content from document_revisions where document_id=? order by seq")
        .all(id)) {
        const value = JSON.parse(row.content);
        const items = Array.isArray(value)
            ? value.flatMap((op) =>
                  op[1]?.[0] === "reports" && op[1].length === 1
                      ? op[0] === "p"
                          ? op[4]
                          : op[0] === "s"
                            ? op[2]
                            : []
                      : [],
              )
            : (value?.reports ?? []);

        items.forEach((report) => report?.key && byKey.set(report.key, report));
    }

    return [...byKey.values()];
}

// Agent per session, from Team's identity documents.
const agentOf = new Map();

for (const doc of docsOfKind("x.team.identity")) {
    const value = materialize(doc.id);

    if (value?.persona?.id) {
        agentOf.set(doc.owner_id, value.persona.id);
    }
}

const entriesOf = (conversation, kind) =>
    db
        .prepare(
            "select id, record from entries where conversation_id=? and json_extract(record,'$.kind')=? order by id",
        )
        .all(conversation, kind)
        .map((row) => ({ id: row.id, ...JSON.parse(row.record) }));

const textOf = (entry) => {
    const content = entry.model?.[0]?.content;

    return typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
};

// The model spend of a session between 2 times (assistant entries only).
const costBetween = (conversation, from, to) =>
    db
        .prepare(
            `select coalesce(sum(json_extract(record,'$.model[0].usage.cost.total')),0) cost from entries
             where conversation_id=? and json_extract(record,'$.kind')='pi.assistant'
             and json_extract(record,'$.model[0].timestamp') between ? and ?`,
        )
        .get(conversation, from, to).cost;
const dollars = (value) => Math.round(value * 100) / 100;

// ---------- GitHub (read-only) ----------

function gh(args) {
    // Read-only: GET requests and GraphQL queries only.
    if (args.some((arg) => /\bmutation\b/.test(arg) || /^(-X|--method)$/.test(arg))) {
        throw new Error("gh: the audit only reads");
    }

    try {
        return execFileSync("gh", args, {
            encoding: "utf8",
            maxBuffer: 64 << 20,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (error) {
        return error.stdout ?? "";
    }
}

function graphqlPrs(refs) {
    const result = new Map();
    const list = [...new Set(refs)];

    for (let start = 0; start < list.length; start += 40) {
        const chunk = list.slice(start, start + 40);
        const parts = chunk.map((ref, index) => {
            const [, owner, name, number] = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);

            return `p${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) {
                state createdAt mergedAt closedAt headRefName author { login } title
                headRef { name }
                commits(first: 50) { totalCount nodes { commit { oid statusCheckRollup { state } } } } } }`;
        });
        const out = gh(["api", "graphql", "-f", `query={ ${parts.join("\n")} }`]);
        const data = JSON.parse(out || "{}").data ?? {};

        chunk.forEach((ref, index) => result.set(ref, data[`p${index}`]?.pullRequest ?? null));
    }

    return result;
}

// ---------- A. Desk lifecycle ----------

// A1: a thread that reopens 2 or more times in 24 hours.
{
    const reopens = windowEvents.filter((event) => event.key.startsWith("reopened"));
    const reasons = {};

    for (const event of reopens) {
        const why = event.text.replace(/[\w.-]+\/[\w.-]+#\d+/, "<ref>");

        reasons[why] = (reasons[why] ?? 0) + 1;
    }

    metrics.reopens = { total: reopens.length, reasons };

    // An empty reopen: between the reopen and the next close there is no PR, ask, branch,
    // dirty-folder or shift event: only busy/idle, reports, and the close.
    let empty = 0;
    let emptyCost = 0;
    const perThread = new Map();

    for (const event of reopens) {
        const later = byThread.get(event.thread).filter((other) => other.at > event.at);
        const close = later.find((other) => other.key.startsWith("closed"));
        const between = later.filter((other) => !close || other.at < close.at);
        const work = between.filter(
            (other) =>
                !/^(busy|report|archived)/.test(other.key) && !other.key.startsWith("closed"),
        );

        if (close && work.length === 0) {
            empty += 1;
            emptyCost += costBetween(threads[event.thread]?.session ?? -1, event.at, close.at);
        }

        perThread.set(event.thread, [...(perThread.get(event.thread) ?? []), event]);
    }

    // What started the turn that reopened the thread: the newest user entry in its session.
    const triggers = {};

    const topic = (text) => {
        const body = text.replace(/^[\s\S]*?<linked-session-message>\s*/, "");

        return /^(Night muster gather|Add to your muster)/.test(body)
            ? "muster gather"
            : /^Review task|review request/i.test(body)
              ? "review task"
              : /after-merge|close-out|after-check|merged/i.test(body.slice(0, 200))
                ? "after-merge step"
                : "new task or question";
    };

    for (const event of reopens) {
        const thread = threads[event.thread];
        const users = thread?.session ? entriesOf(thread.session, "pi.user") : [];
        const last = users.filter((u) => u.model[0].timestamp <= event.at).at(-1);
        const text = last ? textOf(last) : "";
        const from = text.match(/^\[via linked session (session-[\w-]+)\]/)?.[1];
        const kind = !last
            ? "unknown"
            : text.startsWith("[scheduled]")
              ? "its own schedule"
              : from && from === thread.run?.returnAddress
                ? `supervisor: ${topic(text)}`
                : from
                  ? "a message from another agent"
                  : "a person";

        triggers[kind] = (triggers[kind] ?? 0) + 1;
    }

    metrics.reopens.triggers = triggers;
    metrics.reopens.empty = empty;
    metrics.reopens.emptyCost = dollars(emptyCost);

    for (const [id, list] of perThread) {
        const maxIn24h = Math.max(
            ...list.map((a) => list.filter((b) => b.at >= a.at && b.at - a.at < 86_400_000).length),
        );

        if (maxIn24h >= 2) {
            finding(
                "A1",
                maxIn24h >= 4 ? "high" : "medium",
                `${id} reopened ${list.length} times (${maxIn24h} in 24 h): ${[...new Set(list.map((e) => e.text))].join("; ")}`,
                list.map((e) => `${iso(e.at)} ${e.text}`),
                list.at(-1).at,
            );
        }
    }
}

// A2: Odrade's queue continues ("Desk queue: ... T36: silent session").
{
    const supervisors = [...new Set(Object.values(threads).map((thread) => thread.supervisor))];
    const items = [];
    let queueCost = 0;

    for (const supervisor of supervisors) {
        const users = entriesOf(supervisor, "pi.user");

        for (const [index, entry] of users.entries()) {
            const text = textOf(entry);
            const at = entry.model[0].timestamp;

            if (!text.startsWith("Desk queue: these threads wait on you:") || !inWindow(at)) {
                continue;
            }

            queueCost += costBetween(supervisor, at, users[index + 1]?.model[0].timestamp ?? NOW);

            for (const [, id, why] of text.matchAll(/\b([TF]\d+): ([^;.]+)/g)) {
                items.push({ id, why, at });
            }
        }
    }

    const perThread = new Map();

    for (const item of items) {
        perThread.set(item.id, [...(perThread.get(item.id) ?? []), item]);
    }

    // A "silent session" item for work that was already done: the next event on the thread
    // after the item, other than busy/idle and reports, is its close.
    let done = 0;

    for (const item of items.filter((i) => i.why === "silent session")) {
        const next = (byThread.get(item.id) ?? []).find(
            (event) => event.at > item.at && !/^(busy|report)/.test(event.key),
        );

        if (next?.key.startsWith("closed")) {
            done += 1;
        }
    }

    metrics.queue = {
        continues: new Set(items.map((i) => i.at)).size,
        items: items.length,
        silentThenClosed: done,
        cost: dollars(queueCost),
    };

    for (const [id, list] of perThread) {
        if (list.length >= 3) {
            finding(
                "A2",
                list.length >= 6 ? "high" : "medium",
                `${id} was in Odrade's queue ${list.length} times (${list[0].why}) from ${iso(list[0].at)} to ${iso(list.at(-1).at)}`,
                list.map((i) => `${iso(i.at)} ${i.why}`),
                list.at(-1).at,
            );
        }
    }
}

// A3: close-out wake-ups per thread.
{
    const sent = windowEvents.filter((event) => event.text === "close-out wake-up sent");
    const per = {};

    for (const event of sent) {
        per[event.thread] = (per[event.thread] ?? 0) + 1;
    }

    metrics.closeouts = { sent: sent.length, threads: Object.keys(per).length };

    for (const [id, count] of Object.entries(per)) {
        if (count >= 3) {
            finding("A3", "low", `${id} got ${count} close-out wake-ups`, [`desk/${id}.md`]);
        }
    }
}

// A4: desk and team tool errors that repeat (the same message 2 or more times).
{
    const rows = db
        .prepare(
            `select conversation_id c, record from entries where json_extract(record,'$.kind')='pi.tool-result'
             and json_extract(record,'$.model[0].isError')=1
             and json_extract(record,'$.model[0].toolName') in ('desk','team','team_delegate','team_message','team_sessions')`,
        )
        .all();
    const per = {};

    for (const row of rows) {
        const entry = JSON.parse(row.record);
        const at = entry.model[0].timestamp;

        if (!inWindow(at)) {
            continue;
        }

        const message = textOf(entry)
            .replace(/<\/?harness>|\[error\]/g, "")
            .replace(/\bT\d+\b/g, "T<n>")
            .trim()
            .split("\n")[0];
        const key = `${entry.model[0].toolName}: ${message}`;

        per[key] = [...(per[key] ?? []), `${iso(at)} session ${row.c}`];
    }

    metrics.toolErrors = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.length]));

    for (const [key, list] of Object.entries(per)) {
        if (list.length >= 2) {
            finding("A4", "low", `${list.length}× ${key}`, list);
        }
    }
}

// ---------- B. Repair wake-ups ----------

{
    const repairs = [];

    for (const thread of Object.values(threads)) {
        for (const [key, value] of Object.entries(thread.run?.repairs ?? {})) {
            if (inWindow(value.at)) {
                repairs.push({ thread: thread.id, key, ...value });
            }
        }
    }

    let falseCount = 0;

    for (const repair of repairs) {
        const [, ref, oid, kind] = repair.key.match(/^repair:(.+#\d+):([0-9a-f]+):(\w+)$/) ?? [];

        if (kind !== "FAILURE") {
            continue;
        }

        const [repo] = ref.split("#");
        const runs = JSON.parse(
            gh(["api", `repos/${repo}/commits/${oid}/check-runs?per_page=100`]) || "{}",
        ).check_runs;

        if (!runs) {
            continue;
        }

        // A check name fails only when no run of that name succeeded, and a run of it
        // ended in failure, timed_out or action_required (cancelled and skipped are not faults).
        const names = new Map();

        for (const run of runs) {
            names.set(run.name, [...(names.get(run.name) ?? []), run.conclusion]);
        }

        const failing = [...names].filter(
            ([, conclusions]) =>
                !conclusions.includes("success") &&
                conclusions.some((c) => ["failure", "timed_out", "action_required"].includes(c)),
        );
        const cancelledOnly = [...names]
            .filter(([, c]) => c.includes("cancelled"))
            .map(([name, c]) => `${name} (${c.join(", ")})`);

        if (failing.length === 0) {
            falseCount += 1;
            finding(
                "B1",
                "high",
                `${repair.thread}: repair wake-up to ${repair.to} for ${ref} at ${oid.slice(0, 7)}, but no check failed there; cancelled runs: ${cancelledOnly.join("; ") || "none"}`,
                [`https://github.com/${repo}/commit/${oid}/checks`, `desk/${repair.thread}.md`],
                repair.at,
            );
        }
    }

    metrics.repairs = { total: repairs.length, withoutRealFailure: falseCount };
}

// ---------- C. Attribution ----------

{
    const window = windowEvents.filter((event) => /attached \(window\)$/.test(event.text));
    const moved = [];

    for (const event of window) {
        const ref = event.text.split(" ")[0];
        const later = events.find(
            (other) =>
                other.at >= event.at &&
                other.thread === event.thread &&
                other.text === `detached ${ref}`,
        );

        if (later) {
            const target = events.find(
                (other) =>
                    other.at >= later.at &&
                    other.text === `${ref} attached` &&
                    other.thread !== event.thread,
            );

            moved.push(ref);
            finding(
                "C1",
                "medium",
                `${ref} was attached to ${event.thread} by the window rule, then detached${target ? ` and attached to ${target.thread}` : ""}`,
                [
                    `${iso(event.at)} ${event.thread} ${event.text}`,
                    `${iso(later.at)} ${later.text}`,
                ],
            );
        }
    }

    const vias = {};

    for (const thread of Object.values(threads)) {
        for (const pr of Object.values(thread.prs ?? {})) {
            vias[pr.via] = (vias[pr.via] ?? 0) + 1;
        }
    }

    metrics.attribution = { windowAttaches: window.length, windowMoved: moved.length, vias };
}

// ---------- D. Desk truth against GitHub ----------

const allRefs = [];

for (const thread of Object.values(threads)) {
    allRefs.push(...Object.keys(thread.prs ?? {}));

    for (const ask of thread.asks ?? []) {
        allRefs.push(...refsIn(ask.text, thread.repo));
    }
}

function refsIn(text, repo) {
    const refs = [...text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)/g)].map((m) => `${m[1]}#${m[2]}`);
    const owner = repo?.split("/")[0];

    for (const [, name, number] of text.matchAll(/\b([a-z][\w.-]*)#(\d+)/g)) {
        if (owner && !text.includes(`/${name}#${number}`)) {
            refs.push(`${owner}/${name}#${number}`);
        }
    }

    return [...new Set(refs)];
}

// Bot PRs in the window.
const botPrs = JSON.parse(
    gh([
        "search",
        "prs",
        "--author",
        BOT,
        "--created",
        `>=${new Date(SINCE).toISOString().slice(0, 10)}`,
        "--limit",
        "300",
        "--json",
        "repository,number,url",
    ]) || "[]",
).map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`);
const live = graphqlPrs([...allRefs, ...botPrs]);

{
    // D1: an ask answered "merged": how long until GitHub shows the merge. A finding when it
    // never merged, or merged 15 minutes or more later. D1b: a new ask on the same thread for
    // the same PR in the 10 minutes after the answer (Odrade checked too early).
    let checked = 0;
    const lags = [];

    for (const thread of Object.values(threads)) {
        for (const ask of thread.asks ?? []) {
            const answer = ask.answer;

            if (!answer || !inWindow(answer.at) || !/^merged\b/i.test(answer.words ?? "")) {
                continue;
            }

            for (const ref of refsIn(ask.text, thread.repo)) {
                const pr = live.get(ref);

                if (!pr) {
                    continue;
                }

                checked += 1;

                const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : undefined;

                if (mergedAt) {
                    lags.push(Math.round((mergedAt - answer.at) / 1000));
                }

                if (!mergedAt || mergedAt - answer.at >= 15 * 60_000) {
                    finding(
                        "D1",
                        "high",
                        `${ask.id} answered "${answer.words}" by ${answer.by} at ${iso(answer.at)}, but ${ref} ${mergedAt ? `merged ${Math.round((mergedAt - answer.at) / 60_000)} min later` : `is ${pr.state}`}`,
                        [
                            `desk/${thread.id}.md`,
                            `https://github.com/${ref.replace("#", "/pull/")}`,
                        ],
                        answer.at,
                    );
                }

                const again = (thread.asks ?? []).find(
                    (other) =>
                        other.at > answer.at &&
                        other.at - answer.at < 10 * 60_000 &&
                        refsIn(other.text, thread.repo).includes(ref),
                );

                if (again && mergedAt && mergedAt > answer.at) {
                    finding(
                        "D1b",
                        "medium",
                        `${ask.id} answered "${answer.words}" at ${iso(answer.at)}; GitHub merged ${ref} ${Math.round((mergedAt - answer.at) / 1000)} s later; in between, ${again.id} asked Brian again`,
                        [`desk/${thread.id}.md`, `${again.id}: ${again.text.slice(0, 100)}`],
                        again.at,
                    );
                }
            }
        }
    }

    lags.sort((a, b) => a - b);
    metrics.mergedAnswers = {
        checked,
        lagSeconds: {
            median: lags[Math.floor(lags.length / 2)] ?? null,
            max: lags.at(-1) ?? null,
            mergedBeforeAnswer: lags.filter((lag) => lag <= 0).length,
            mergedAfterAnswer: lags.filter((lag) => lag > 0).length,
        },
    };

    // D2: the desk's PR state against GitHub now (the sweep runs every 10 minutes).
    let drift = 0;

    for (const thread of Object.values(threads)) {
        if (thread.state === "closed") {
            continue;
        }

        for (const [ref, pr] of Object.entries(thread.prs ?? {})) {
            const now = live.get(ref);
            const sweptAt = thread.run?.sweptAt ?? 0;

            if (
                now &&
                pr.state !== now.state &&
                pr.state !== "FROZEN" &&
                NOW - sweptAt < 3600_000
            ) {
                const changed = Date.parse(now.mergedAt ?? now.closedAt ?? 0);

                if (changed && changed < sweptAt) {
                    drift += 1;
                    finding(
                        "D2",
                        "medium",
                        `${thread.id}: desk says ${ref} is ${pr.state}, GitHub says ${now.state} since ${iso(changed)}`,
                        [`desk/${thread.id}.md`],
                    );
                }
            }
        }
    }

    metrics.stateDrift = drift;
}

// ---------- E. Reports and messaging ----------

{
    const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9#._-]{3,}/g) ?? []);

    const jaccard = (a, b) => {
        const both = [...a].filter((w) => b.has(w)).length;

        return both / (a.size + b.size - both || 1);
    };

    let reports = 0;
    let duplicates = 0;
    let candidates = 0;
    let shiftPlusMessage = 0;
    const twins = [];
    const sources = {};

    for (const doc of docsOfKind("x.desk.reports")) {
        const list = allReports(doc.id)
            .filter((r) => inWindow(r.at))
            .sort((a, b) => a.at - b.at);
        const thread = Object.values(threads).find((t) => t.session === doc.owner_id);

        reports += list.length;

        // E3: a night shift's report (filed by the desk) and a team_message from the same
        // session in the 30 minutes around it: the agent reported twice. The LLM step checks
        // whether they carry the same facts.
        for (const shift of list.filter((r) => r.from === "night-shift")) {
            const twin = list.find(
                (r) => r.from === "team_message" && Math.abs(r.at - shift.at) <= 30 * 60_000,
            );

            if (twin) {
                shiftPlusMessage += 1;
                twins.push(
                    `${thread?.id ?? `session ${doc.owner_id}`}: ${Math.round(Math.abs(twin.at - shift.at) / 60_000)} min apart, ${iso(Math.max(shift.at, twin.at))}`,
                );
            }
        }

        list.forEach((r) => (sources[r.from] = (sources[r.from] ?? 0) + 1));

        for (let i = 1; i < list.length; i += 1) {
            const [a, b] = [list[i - 1], list[i]];
            const similar = jaccard(words(a.text), words(b.text));
            const mixed = a.from !== b.from;

            if (b.at - a.at >= 30 * 60_000) {
                continue;
            }

            // 80% or more of the same words is a duplicate. 50 to 80% (30 to 80% for a night
            // shift report beside a team_message) is only a candidate: the LLM step decides.
            if (similar >= 0.8 || similar >= (mixed ? 0.3 : 0.5)) {
                // Two reports about different PRs (#20 and #22) are never sure duplicates.
                const refs = (text) => [...new Set(text.match(/#\d+/g) ?? [])].sort().join(" ");
                const sure = similar >= 0.8 && refs(a.text) === refs(b.text);

                duplicates += sure ? 1 : 0;
                candidates += sure ? 0 : 1;
                finding(
                    sure ? "E1" : "E1?",
                    sure ? "medium" : "low",
                    `${thread?.id ?? `session ${doc.owner_id}`}: 2 reports ${Math.round((b.at - a.at) / 60_000)} min apart (${a.from}, ${b.from}), ${Math.round(similar * 100)}% the same words`,
                    [
                        `${iso(a.at)} ${a.text.slice(0, 80)}…`,
                        `${iso(b.at)} ${b.text.slice(0, 80)}…`,
                    ],
                    b.at,
                );
            }
        }
    }

    metrics.reports = { total: reports, sources, duplicates, candidates, shiftPlusMessage };

    if (twins.length >= 3) {
        finding(
            "E3",
            "medium",
            `${twins.length} of ${sources["night-shift"] ?? 0} night shift reports have a team_message from the same session within 30 min (the agent reported twice)`,
            twins,
        );
    }

    // E2: a report that could not reach its supervisor, or a report that went another way.
    const unreachable = db
        .prepare(
            `select conversation_id c, record from entries where json_extract(record,'$.kind')='pi.tool-result'
             and json_extract(record,'$.model[0].toolName') in ('team_message','team')
             and json_extract(record,'$.model[0].isError')=1`,
        )
        .all()
        .map((row) => ({ c: row.c, entry: JSON.parse(row.record) }))
        .filter(({ entry }) => inWindow(entry.model[0].timestamp));

    for (const { c, entry } of unreachable) {
        const thread = Object.values(threads).find((t) => t.session === c);

        finding(
            "E2",
            /blocked/.test(textOf(entry)) ? "low" : "medium",
            `${thread?.id ?? `session ${c}`} (${agentOf.get(c) ?? "?"}): ${entry.model[0].toolName} failed: ${textOf(
                entry,
            )
                .replace(/<\/?harness>|\[error\]/g, "")
                .trim()}`,
            [`${iso(entry.model[0].timestamp)} entry ${entry.id}`],
            entry.model[0].timestamp,
        );
    }

    metrics.messagingErrors = unreachable.length;
}

// ---------- F. Night and day shifts ----------

{
    const reasons = {};
    let fastRounds = 0;
    const fast = [];

    for (const doc of docsOfKind("x.night-shift.goal")) {
        const goal = materialize(doc.id)?.goal;

        if (!goal || !inWindow(goal.setAt)) {
            continue;
        }

        const key = `${goal.status}${goal.reason ? `: ${goal.reason}` : ""}`;

        reasons[key] = (reasons[key] ?? 0) + 1;

        const rounds = goal.rounds ?? [];
        let quick = 0;

        for (let i = 1; i < rounds.length; i += 1) {
            if (rounds[i].at - rounds[i - 1].at < 60_000 && rounds[i - 1].verdict === "continue") {
                quick += 1;
            }
        }

        fastRounds += quick;

        if (quick >= 2) {
            fast.push(
                `session ${doc.owner_id} (${agentOf.get(doc.owner_id) ?? "?"}): ${quick} of ${rounds.length} rounds under 60 s, max ${goal.maxRounds}`,
            );
        }

        if (goal.reason === "blocked" || goal.reason === "error") {
            finding(
                "F1",
                "low",
                `Shift in session ${doc.owner_id} (${agentOf.get(doc.owner_id) ?? "?"}) ended ${goal.reason}: ${goal.why ?? ""}`.trim(),
                [`${iso(goal.endedAt ?? goal.setAt)}`],
            );
        }
    }

    metrics.shifts = { endings: reasons, roundsUnder60s: fastRounds };

    if (fast.length >= 2) {
        finding(
            "F2",
            "medium",
            `${fast.length} shifts spent 2 or more rounds in under 60 s each (the agent waits on its subagent)`,
            fast,
        );
    }
}

// ---------- G. Schedules ----------

{
    const outcomes = {};

    for (const row of db
        .prepare("select record from tasks where kind=?")
        .all(JSON.stringify("pocket.schedule"))) {
        const task = JSON.parse(row.record);

        if (!inWindow(task.startedAt ?? 0)) {
            continue;
        }

        const key = task.state?.outcome?.status ?? task.state?.status ?? "?";

        outcomes[key] = (outcomes[key] ?? 0) + 1;
    }

    metrics.schedules = outcomes;

    if ((outcomes.failed ?? 0) > 0) {
        finding("G1", "medium", `${outcomes.failed} schedule runs failed`, []);
    }
}

// ---------- H. GitHub ----------

{
    const onDesk = new Set(
        Object.values(threads).flatMap((thread) => Object.keys(thread.prs ?? {})),
    );
    const states = {};
    const branchesLeft = [];
    const notOnDesk = [];
    let redBeforeGreen = 0;

    for (const ref of botPrs) {
        const pr = live.get(ref);

        if (!pr) {
            continue;
        }

        states[pr.state] = (states[pr.state] ?? 0) + 1;

        if (pr.state === "MERGED" && pr.headRef && Date.parse(pr.mergedAt) < NOW - 3600_000) {
            branchesLeft.push(`${ref} (${pr.headRefName})`);
        }

        if (!onDesk.has(ref)) {
            notOnDesk.push(`${ref} ${pr.state}`);
        }

        if (
            pr.commits.nodes.some((node) =>
                ["FAILURE", "ERROR"].includes(node.commit.statusCheckRollup?.state),
            )
        ) {
            redBeforeGreen += 1;
        }
    }

    metrics.github = {
        botPrs: botPrs.length,
        states,
        withAFailingCommit: redBeforeGreen,
        mergedBranchLeft: branchesLeft.length,
        notOnDesk: notOnDesk.length,
    };

    const repos = [...new Set(branchesLeft.map((line) => line.split("#")[0]))];
    const autoDelete = {};

    for (const repo of repos) {
        autoDelete[repo] = gh(["api", `repos/${repo}`, "--jq", ".delete_branch_on_merge"]).trim();
    }

    metrics.github.autoDeleteOff = repos.filter((repo) => autoDelete[repo] === "false");

    if (branchesLeft.length > 0) {
        finding(
            "H1",
            branchesLeft.length >= 5 ? "medium" : "low",
            `${branchesLeft.length} merged bot PRs still have their head branch on GitHub; ${metrics.github.autoDeleteOff.length} of their ${repos.length} repositories have "delete head branches" off`,
            [...branchesLeft, `off in: ${metrics.github.autoDeleteOff.join(", ")}`],
        );
    }

    if (notOnDesk.length > 0) {
        finding("H2", "low", `${notOnDesk.length} bot PRs are on no desk thread`, notOnDesk);
    }
}

// ---------- I. Odrade's notes ----------

{
    const readme = fs.readFileSync(path.join(ODRADE, "README.md"), "utf8");
    const missing = fs
        .readdirSync(path.join(ODRADE, "reports"))
        .filter((name) => !readme.includes(`reports/${name}`));

    metrics.notes = {
        reports: fs.readdirSync(path.join(ODRADE, "reports")).length,
        notInIndex: missing.length,
    };

    if (missing.length > 0) {
        finding(
            "I1",
            "low",
            `${missing.length} reports are not in Odrade's README index`,
            missing.map((name) => `reports/${name}`),
        );
    }

    const dirty = execFileSync("git", ["-C", ODRADE, "status", "--porcelain"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    const commits = execFileSync(
        "git",
        ["-C", ODRADE, "log", `--since=${new Date(SINCE).toISOString()}`, "--format=%cI"],
        { encoding: "utf8" },
    )
        .split("\n")
        .filter(Boolean);

    metrics.notes.uncommitted = dirty.length;
    metrics.notes.commits = commits.length;
}

// ---------- J. Spend ----------

{
    const perAgent = {};
    const perThread = {};
    const sessionThread = new Map(
        Object.values(threads)
            .filter((thread) => thread.session)
            .map((thread) => [thread.session, thread.id]),
    );

    for (const row of db
        .prepare(
            `select conversation_id c, json_extract(record,'$.model[0].timestamp') at,
             json_extract(record,'$.model[0].usage.cost.total') cost
             from entries where json_extract(record,'$.kind')='pi.assistant'`,
        )
        .all()) {
        if (!inWindow(row.at ?? 0) || !row.cost) {
            continue;
        }

        const agent = agentOf.get(row.c) ?? "other";

        perAgent[agent] = (perAgent[agent] ?? 0) + row.cost;

        const thread = sessionThread.get(row.c);

        if (thread) {
            perThread[thread] = (perThread[thread] ?? 0) + row.cost;
        }
    }

    const round = (o) =>
        Object.fromEntries(
            Object.entries(o)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => [k, Math.round(v * 100) / 100]),
        );

    metrics.spend = {
        perAgent: round(perAgent),
        topThreads: Object.fromEntries(Object.entries(round(perThread)).slice(0, 8)),
    };
}

// ---------- Output ----------

const order = { high: 0, medium: 1, low: 2 };

findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));

for (const item of findings) {
    const module = ["A", "B", "C", "D", "E"].includes(item.check[0])
        ? "desk.ts"
        : item.check[0] === "F"
          ? "night-shift.ts"
          : null;

    if (module && item.lastSeen && installed[module]) {
        const fixedBy = Date.parse(installed[module]) + 10 * 60_000;

        item.afterInstall = Date.parse(item.lastSeen) > fixedBy;
    }
}

const result = {
    window: { since: iso(SINCE), until: iso(NOW), hours: HOURS },
    installed,
    metrics,
    findings,
};

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
}

console.log(JSON.stringify(result, null, 2));
