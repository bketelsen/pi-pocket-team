#!/usr/bin/env node
// The GitHub hooks report: deliveries by outcome, the delay numbers against the baseline, and the alarm state, in a
// window from the go-live time. Read-only: it opens Pocket's database with `readOnly: true`, and runs no `gh`, no
// `git`, no network, and writes no file. It prints Markdown, or JSON with `--json`.
//
//     node audit/github-hooks.mjs --since <ISO time or ms> [--until <ISO time or ms>] [--json]
//
// Environment: PI_POCKET_DIR (default ~/.pi-pocket). The documents and their fields: docs/modules/github-hooks.md
// ("The documents") and docs/modules/desk.md ("The beacon", "Observed changes"); the types are `DeliveriesState` and
// `AlarmsState` in github-hooks.ts, and `DeskNudgesState` and `DeskObservedState` in desk.ts.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { median } from "./common.mjs";
import { docsOfKind, foldDocument, openPocket } from "./sources.mjs";

const USAGE =
    "usage: node audit/github-hooks.mjs --since <ISO or ms> [--until <ISO or ms>] [--json]";

/** The most entries `x.github-hooks.deliveries` keeps (`LOG_MAX` in github-hooks.ts). */
export const LOG_MAX = 2000;
/** The classes of change (`ChangeClass` in github-hooks.ts, `ObservedClass` in desk.ts). */
export const CLASSES = ["state", "labels", "review", "head", "ci"];
/** The documents the report reads, by their name in `summarize`. */
export const KINDS = {
    deliveries: "x.github-hooks.deliveries",
    nudges: "x.desk.nudges",
    observed: "x.desk.observed",
    alarms: "x.github-hooks.alarms",
};

/** A time as ms: digits only are ms, else an ISO time. Throws on anything else. */
export function parseTime(value, option) {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);

    if (!Number.isFinite(ms)) {
        throw new Error(
            `${option} needs an ISO time or ms, not ${JSON.stringify(value)}. ${USAGE}`,
        );
    }

    return ms;
}

/** Read the command line. `--until` defaults to `now`. Throws an Error with the usage on a bad option. */
export function parseArgs(argv, now) {
    const options = { until: now, json: false };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--since" || arg === "--until") {
            i += 1;

            if (argv[i] === undefined) {
                throw new Error(`${arg} needs a value. ${USAGE}`);
            }

            options[arg.slice(2)] = parseTime(argv[i], arg);
        } else if (arg === "--json") {
            options.json = true;
        } else {
            throw new Error(`unknown option ${arg}. ${USAGE}`);
        }
    }

    if (options.since === undefined) {
        throw new Error(`--since is required (the go-live time). ${USAGE}`);
    }

    if (options.until <= options.since) {
        throw new Error(`--until must be after --since. ${USAGE}`);
    }

    return options;
}

/** n, median, P90 (nearest rank) and max of delays in ms, in seconds with 1 decimal. */
export function stats(delays) {
    const sorted = [...delays].sort((a, b) => a - b);
    const s = (ms) => Math.round(ms / 100) / 10;

    if (sorted.length === 0) {
        return { n: 0 };
    }

    return {
        n: sorted.length,
        median: s(median(sorted)),
        p90: s(sorted[Math.ceil(0.9 * sorted.length) - 1]),
        max: s(sorted[sorted.length - 1]),
    };
}

const count = (counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * The report's numbers from the 4 documents (`docs.deliveries`, `docs.nudges`, `docs.observed`, `docs.alarms`; each
 * may be undefined: absent). The window is `since` (included) to `until` (not included). Pure.
 */
export function summarize(docs, { since, until }) {
    const inWindow = (at) => typeof at === "number" && at >= since && at < until;
    const out = { since, until };
    const { deliveries, nudges, observed, alarms } = docs;

    if (deliveries === undefined) {
        out.deliveries = { absent: true };
    } else {
        const log = deliveries.log ?? [];
        const byOutcome = {};
        const acceptedByEvent = {};

        for (const entry of log.filter((each) => inWindow(each.at))) {
            count(byOutcome, entry.outcome);

            if (entry.outcome === "accepted") {
                count(acceptedByEvent, entry.event ?? "-");
            }
        }

        out.deliveries = {
            byOutcome,
            acceptedByEvent,
            counts: deliveries.counts ?? {},
            dropped: deliveries.dropped ?? 0,
            ...(deliveries.last === undefined ? {} : { last: deliveries.last }),
            entries: log.length,
            ...(log.length === 0 ? {} : { oldest: log[0].at }),
            // The log keeps the newest LOG_MAX: full, and its oldest entry after `since`, it lost part of the window.
            cut: log.length >= LOG_MAX && log[0].at > since,
        };
    }

    if (nudges === undefined) {
        out.nudges = { absent: true };
    } else {
        const syncs = (nudges.syncs ?? []).filter((sync) => inWindow(sync.started));
        const failed = syncs.filter((sync) => sync.committed === 0);
        const delays = syncs
            .filter((sync) => sync.committed !== 0)
            .flatMap((sync) => (sync.deliveries ?? []).map((one) => sync.committed - one.at));

        out.nudges = {
            syncs: syncs.length,
            failed: failed.length,
            deliveries: delays.length,
            delay: stats(delays),
        };
    }

    if (observed === undefined) {
        out.observed = { absent: true };
    } else {
        const changes = observed.changes ?? [];
        const groups = { baseline: {}, after: {} };

        for (const group of Object.values(groups)) {
            CLASSES.forEach((name) => (group[name] = []));
        }

        // `seen` is the sweep's start time, not the time of its read: a change after the start gives a negative
        // delay. Those are counted apart, and kept out of the median and P90.
        const negative = { baseline: {}, after: {} };

        for (const change of changes.filter((each) => each.at > 0)) {
            const name =
                change.seen < since ? "baseline" : inWindow(change.seen) ? "after" : undefined;

            if (name === undefined || groups[name][change.class] === undefined) {
                continue;
            }

            if (change.seen < change.at) {
                count(negative[name], change.class);
            } else {
                groups[name][change.class].push(change.seen - change.at);
            }
        }

        const withNegative = (name) =>
            Object.fromEntries(
                CLASSES.map((cls) => [
                    cls,
                    { ...stats(groups[name][cls]), negative: negative[name][cls] ?? 0 },
                ]),
            );

        const seen = changes.map((change) => change.seen).filter(Number.isFinite);

        out.observed = {
            changes: changes.length,
            ...(seen.length === 0 ? {} : { oldestSeen: Math.min(...seen) }),
            baseline: withNegative("baseline"),
            after: withNegative("after"),
        };
    }

    if (alarms === undefined) {
        out.alarms = { absent: true };
    } else {
        // The misses: `misses` keeps 24 hours; a coverage alarm keeps the misses that raised it. 1 miss is 1 time in a
        // list, and the changes of 1 sweep share 1 time: `[T, T]` is 2 misses. The 2 lists can hold the same misses, so
        // each repository, class and time counts the larger of its 2 counts, never their sum and never 1 for all.
        const tally = (times) => {
            const counts = new Map();

            (Array.isArray(times) ? times : [])
                .filter(inWindow)
                .forEach((at) => counts.set(at, (counts.get(at) ?? 0) + 1));

            return counts;
        };

        const keys = new Set([
            ...Object.keys(alarms.misses ?? {}),
            ...Object.keys(alarms.coverage ?? {}),
        ]);
        let missesInWindow = 0;

        for (const key of keys) {
            const fromMisses = tally(alarms.misses?.[key]);
            const fromAlarm = tally(alarms.coverage?.[key]?.misses);

            for (const at of new Set([...fromMisses.keys(), ...fromAlarm.keys()])) {
                missesInWindow += Math.max(fromMisses.get(at) ?? 0, fromAlarm.get(at) ?? 0);
            }
        }

        const list = (map) =>
            Object.entries(map ?? {})
                .map(([name, alarm]) => ({
                    name,
                    raised: alarm.raised,
                    ...(alarm.cleared === undefined ? {} : { cleared: alarm.cleared }),
                    ...(Array.isArray(alarm.misses) ? { misses: alarm.misses.length } : {}),
                }))
                .sort((a, b) => a.raised - b.raised);

        out.alarms = {
            system: list(alarms.system),
            coverage: list(alarms.coverage),
            missesInWindow,
        };
    }

    return out;
}

const time = (ms) => (ms === undefined ? "-" : new Date(ms).toISOString().slice(0, 19) + "Z");
const countsLine = (counts) =>
    Object.keys(counts).length === 0
        ? "none"
        : Object.entries(counts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => `${key} ${String(value)}`)
              .join(", ");
const statsCells = (one) =>
    one.n === 0
        ? "0 | - | - | -"
        : `${String(one.n)} | ${String(one.median)} | ${String(one.p90)} | ${String(one.max)}`;

/** The summary as Markdown. */
export function formatMarkdown(summary) {
    const lines = [
        "# GitHub hooks report",
        "",
        `Window: ${time(summary.since)} to ${time(summary.until)}.`,
        "",
    ];
    const { deliveries, nudges, observed, alarms } = summary;

    lines.push(`## Deliveries (\`${KINDS.deliveries}\`)`, "");

    if (deliveries.absent) {
        lines.push("absent", "");
    } else {
        lines.push(
            `- In the window, by outcome: ${countsLine(deliveries.byOutcome)}.`,
            `- Accepted in the window, by event: ${countsLine(deliveries.acceptedByEvent)}.`,
            `- All time, by outcome: ${countsLine(deliveries.counts)}. Dropped refusals: ${String(deliveries.dropped)}. Last accepted: ${time(deliveries.last)}.`,
            `- The log holds ${String(deliveries.entries)} entries, the oldest at ${time(deliveries.oldest)}.`,
        );

        if (deliveries.cut) {
            lines.push(
                `- The log is cut: it holds ${String(LOG_MAX)} entries and its oldest is after --since. The window counts miss the older entries.`,
            );
        }

        lines.push("");
    }

    lines.push(`## Delay from delivery to sync commit (\`${KINDS.nudges}\`)`, "");

    if (nudges.absent) {
        lines.push("absent", "");
    } else {
        lines.push(
            `- Nudged syncs that started in the window: ${String(nudges.syncs)}, failed: ${String(nudges.failed)}.`,
            "",
            "| n | median s | P90 s | max s |",
            "| - | -------- | ----- | ----- |",
            `| ${statsCells(nudges.delay)} |`,
            "",
        );
    }

    lines.push(`## Delay from GitHub change to sweep (\`${KINDS.observed}\`)`, "");

    if (observed.absent) {
        lines.push("absent", "");
    } else {
        lines.push(
            `- Changes held: ${String(observed.changes)}; the oldest seen: ${time(observed.oldestSeen)}. Baseline: seen before --since; after: seen in the window. Only changes with a GitHub time.`,
            "",
            "| class | baseline n | median s | P90 s | negative | after n | median s | P90 s | negative |",
            "| ----- | ---------- | -------- | ----- | -------- | ------- | -------- | ----- | -------- |",
        );

        for (const name of CLASSES) {
            const cells = (one) =>
                `${one.n === 0 ? "0 | - | -" : `${String(one.n)} | ${String(one.median)} | ${String(one.p90)}`} | ${String(one.negative)}`;

            lines.push(
                `| ${name} | ${cells(observed.baseline[name])} | ${cells(observed.after[name])} |`,
            );
        }

        lines.push(
            "",
            "seen is the sweep's start time: a delay is an estimate, and a change after the start (negative) is counted apart.",
            "",
        );
    }

    lines.push(`## Alarms (\`${KINDS.alarms}\`)`, "");

    if (alarms.absent) {
        lines.push("absent", "");
    } else {
        const alarmLine = (kind) => (alarm) =>
            `- ${kind} \`${alarm.name}\`: raised ${time(alarm.raised)}, ${alarm.cleared === undefined ? "not cleared" : `cleared ${time(alarm.cleared)}`}${alarm.misses === undefined ? "" : `, ${String(alarm.misses)} misses`}.`;

        lines.push(
            ...alarms.system.map(alarmLine("system")),
            ...alarms.coverage.map(alarmLine("coverage")),
        );

        if (alarms.system.length + alarms.coverage.length === 0) {
            lines.push("- No alarm was ever raised.");
        }

        lines.push(`- Coverage misses in the window: ${String(alarms.missesInWindow)}.`, "");
    }

    return lines.join("\n");
}

/** The 4 documents from Pocket's database (read-only); an absent kind is undefined. */
export function readDocs(file) {
    const db = openPocket(file);

    try {
        return Object.fromEntries(
            Object.entries(KINDS).map(([name, kind]) => {
                const doc = docsOfKind(db, kind)[0];

                return [name, doc === undefined ? undefined : foldDocument(db, doc.id)];
            }),
        );
    } finally {
        db.close();
    }
}

/** Run the report. `env`, `now` and `log` are injectable. Returns the summary and the printed text. */
export function main(
    argv = process.argv.slice(2),
    { env = process.env, now = Date.now(), log = console.log } = {},
) {
    const options = parseArgs(argv, now);
    const pocketDir = env.PI_POCKET_DIR ?? path.join(os.homedir(), ".pi-pocket");
    const summary = summarize(readDocs(path.join(pocketDir, "pocket.sqlite")), options);
    const text = options.json ? JSON.stringify(summary, null, 2) : formatMarkdown(summary);

    log(text);

    return { summary, text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 2;
    }
}
