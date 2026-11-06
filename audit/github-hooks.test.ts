// The GitHub hooks report (audit/github-hooks.mjs): the pure summary on invented documents (the window edges, a failed
// sync, the baseline split, a cut log, absent documents), the Markdown, and 1 run end to end on a temporary database
// made as audit/fixtures/pocket-db.mjs makes it. No network and no wall clock: every time is given.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { HOUR, MINUTE } from "./common.mjs";
import { NOW } from "./fixtures/builders.mjs";
import { createFixtureDb } from "./fixtures/pocket-db.mjs";
import { LOG_MAX, formatMarkdown, main, parseArgs, stats, summarize } from "./github-hooks.mjs";

const SINCE = NOW - 7 * 24 * HOUR;
const UNTIL = NOW;
const window = { since: SINCE, until: UNTIL };
const SECOND = 1000;

describe("the options", () => {
    test("--since is required; ISO or ms; --until defaults to now; a bad value or order is refused", () => {
        assert.throws(() => parseArgs([], NOW), /--since is required/);
        assert.deepEqual(parseArgs(["--since", "2026-10-20T00:00:00Z"], NOW), {
            since: Date.UTC(2026, 9, 20),
            until: NOW,
            json: false,
        });
        assert.deepEqual(parseArgs(["--since", "1000", "--until", "2000", "--json"], NOW), {
            since: 1000,
            until: 2000,
            json: true,
        });
        assert.throws(() => parseArgs(["--since", "yesterday"], NOW), /ISO time or ms/);
        assert.throws(() => parseArgs(["--since"], NOW), /needs a value/);
        assert.throws(() => parseArgs(["--since", "2000", "--until", "1000"], NOW), /after/);
        assert.throws(() => parseArgs(["--since", "1", "--hours", "2"], NOW), /unknown option/);
    });

    test("stats: n, median, P90 by nearest rank, and max, in seconds", () => {
        assert.deepEqual(stats([]), { n: 0 });
        assert.deepEqual(stats([10, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => s * SECOND)), {
            n: 10,
            median: 5.5,
            p90: 9,
            max: 10,
        });
    });
});

describe("summarize", () => {
    test("absent documents: each part says so, and the Markdown says absent 4 times", () => {
        const summary = summarize({}, window);

        for (const part of ["deliveries", "nudges", "observed", "alarms"] as const) {
            assert.deepEqual(summary[part], { absent: true }, part);
        }

        assert.equal(formatMarkdown(summary).match(/^absent$/gm)?.length, 4);
    });

    test("deliveries: the window includes --since and excludes --until; accepted by event; the all-time counters", () => {
        const entry = (at: number, outcome: string, event = "pull_request") => ({
            at,
            outcome,
            event,
            status: 202,
        });
        const summary = summarize(
            {
                deliveries: {
                    log: [
                        entry(SINCE - 1, "accepted"),
                        entry(SINCE, "accepted"),
                        entry(SINCE + HOUR, "accepted", "status"),
                        entry(SINCE + HOUR, "duplicate"),
                        entry(UNTIL - 1, "bad-signature"),
                        entry(UNTIL, "accepted"),
                    ],
                    counts: { accepted: 4, duplicate: 1, "bad-signature": 1 },
                    last: UNTIL,
                    dropped: 2,
                },
            },
            window,
        );

        assert.deepEqual(summary.deliveries, {
            byOutcome: { accepted: 2, duplicate: 1, "bad-signature": 1 },
            acceptedByEvent: { pull_request: 1, status: 1 },
            counts: { accepted: 4, duplicate: 1, "bad-signature": 1 },
            dropped: 2,
            last: UNTIL,
            entries: 6,
            oldest: SINCE - 1,
            cut: false,
        });
    });

    test("a cut log: 2000 entries and the oldest after --since; not cut with fewer, or with an older first entry", () => {
        const log = (first: number, length: number) =>
            Array.from({ length }, (_, index) => ({
                at: first + index,
                outcome: "accepted",
                status: 202,
            }));
        const cut = (first: number, length: number) =>
            (
                summarize(
                    { deliveries: { log: log(first, length), counts: {}, dropped: 0 } },
                    window,
                ).deliveries as { cut: boolean }
            ).cut;

        assert.equal(cut(SINCE + 1, LOG_MAX), true);
        assert.equal(cut(SINCE, LOG_MAX), false);
        assert.equal(cut(SINCE + 1, LOG_MAX - 1), false);
        assert.match(
            formatMarkdown(
                summarize(
                    { deliveries: { log: log(SINCE + 1, LOG_MAX), counts: {}, dropped: 0 } },
                    window,
                ),
            ),
            /The log is cut/,
        );
    });

    test("nudges: syncs that started in the window; a failed sync (committed 0) is counted and gives no delay", () => {
        const sync = (started: number, committed: number, ats: number[]) => ({
            supervisor: 1,
            count: ats.length,
            deliveries: ats.map((at, index) => ({ id: `d${String(index)}`, at })),
            started,
            committed,
        });
        const summary = summarize(
            {
                nudges: {
                    syncs: [
                        sync(SINCE - MINUTE, SINCE, [SINCE - 2 * MINUTE]),
                        sync(SINCE, SINCE + 30 * SECOND, [SINCE - 10 * SECOND, SINCE]),
                        sync(SINCE + HOUR, 0, [SINCE + HOUR - SECOND]),
                        sync(SINCE + 2 * HOUR, SINCE + 2 * HOUR + 60 * SECOND, [SINCE + 2 * HOUR]),
                        sync(UNTIL, UNTIL + SECOND, [UNTIL]),
                    ],
                },
            },
            window,
        );

        assert.deepEqual(summary.nudges, {
            syncs: 3,
            failed: 1,
            deliveries: 3,
            delay: { n: 3, median: 40, p90: 60, max: 60 },
        });
    });

    test("observed: the baseline (seen before --since) and after (seen in the window), by class; at 0 is left out", () => {
        const change = (cls: string, at: number, seen: number) => ({
            repo: "frostyard/x",
            number: 1,
            kind: "pr",
            class: cls,
            at,
            seen,
        });
        const summary = summarize(
            {
                observed: {
                    last: {},
                    changes: [
                        change("state", SINCE - 20 * MINUTE, SINCE - 10 * MINUTE),
                        change("state", SINCE - 5 * MINUTE, SINCE - MINUTE),
                        change("state", SINCE, SINCE + 30 * SECOND),
                        change("labels", 0, SINCE + HOUR),
                        change("ci", UNTIL - MINUTE, UNTIL),
                    ],
                },
            },
            window,
        );
        const observed = summary.observed as {
            changes: number;
            oldestSeen: number;
            baseline: Record<string, { n: number }>;
            after: Record<string, { n: number }>;
        };

        assert.equal(observed.changes, 5);
        assert.equal(observed.oldestSeen, SINCE - 10 * MINUTE);
        assert.deepEqual(observed.baseline.state, {
            n: 2,
            median: 420,
            p90: 600,
            max: 600,
            negative: 0,
        });
        assert.deepEqual(observed.after.state, { n: 1, median: 30, p90: 30, max: 30, negative: 0 });
        assert.deepEqual(observed.after.labels, { n: 0, negative: 0 }, "at 0: no delay");
        assert.deepEqual(observed.after.ci, { n: 0, negative: 0 }, "seen at --until: outside");
    });

    test("observed: a change after the sweep's start (at > seen) is counted apart as negative, out of the median and P90", () => {
        const change = (cls: string, at: number, seen: number) => ({
            repo: "frostyard/x",
            number: 1,
            kind: "pr",
            class: cls,
            at,
            seen,
        });
        const summary = summarize(
            {
                observed: {
                    last: {},
                    changes: [
                        change("head", SINCE + HOUR - MINUTE, SINCE + HOUR),
                        change("head", SINCE + HOUR + 20 * SECOND, SINCE + HOUR),
                        change("head", SINCE + 2 * HOUR + SECOND, SINCE + 2 * HOUR),
                        change("review", SINCE - MINUTE + SECOND, SINCE - MINUTE),
                    ],
                },
            },
            window,
        );
        const observed = summary.observed as {
            baseline: Record<string, unknown>;
            after: Record<string, unknown>;
        };

        assert.deepEqual(observed.after.head, { n: 1, median: 60, p90: 60, max: 60, negative: 2 });
        assert.deepEqual(observed.baseline.review, { n: 0, negative: 1 });

        const markdown = formatMarkdown(summary);

        assert.match(markdown, /\| head \| 0 \| - \| - \| 0 \| 1 \| 60 \| 60 \| 2 \|/);
        assert.match(markdown, /\| review \| 0 \| - \| - \| 1 \| 0 \| - \| - \| 0 \|/);
        assert.match(
            markdown,
            /seen is the sweep's start time: a delay is an estimate, and a change after the start \(negative\) is counted apart\./,
        );
    });

    test("alarms: misses that share 1 time are each counted; the 2 lists merge by the larger count of each time", () => {
        const T = SINCE + HOUR;
        const misses = (fromMisses: number[], fromAlarm: number[]) =>
            (
                summarize(
                    {
                        alarms: {
                            system: {},
                            coverage: { "frostyard/x|ci": { raised: T, misses: fromAlarm } },
                            misses: { "frostyard/x|ci": fromMisses },
                            evaluated: {},
                        },
                    },
                    window,
                ).alarms as { missesInWindow: number }
            ).missesInWindow;

        assert.equal(misses([T, T], [T, T, T]), 3);
        assert.equal(misses([T], [T, T]), 2);
        assert.equal(misses([T, T], []), 2);
        assert.equal(misses([T, T, T + 1], [T, T + 2]), 4);
        assert.equal(misses([T, SINCE - 1, SINCE - 1], [UNTIL, UNTIL]), 1, "outside the window");
    });

    test("alarms: each system and coverage alarm with its times; misses in the window counted once", () => {
        const summary = summarize(
            {
                alarms: {
                    system: {
                        "bind-failed": { raised: SINCE + HOUR, cleared: SINCE + 2 * HOUR },
                        "receiver-missing": { raised: SINCE - HOUR },
                    },
                    coverage: {
                        "frostyard/x|ci": {
                            raised: SINCE + 3 * HOUR,
                            misses: [SINCE + HOUR, SINCE + 3 * HOUR],
                        },
                    },
                    misses: {
                        "frostyard/x|ci": [SINCE + HOUR, SINCE + 3 * HOUR],
                        "frostyard/y|head": [SINCE - HOUR, UNTIL - 1],
                    },
                    evaluated: {},
                },
            },
            window,
        );

        assert.deepEqual(summary.alarms, {
            system: [
                { name: "receiver-missing", raised: SINCE - HOUR },
                { name: "bind-failed", raised: SINCE + HOUR, cleared: SINCE + 2 * HOUR },
            ],
            coverage: [{ name: "frostyard/x|ci", raised: SINCE + 3 * HOUR, misses: 2 }],
            missesInWindow: 3,
            missesComplete: false,
        });

        const markdown = formatMarkdown(summary);

        assert.match(markdown, /system `receiver-missing`: raised [^,]+, not cleared\./);
        assert.match(
            markdown,
            /coverage `frostyard\/x\|ci`: raised [^,]+, not cleared, 2 misses\./,
        );
        assert.match(
            markdown,
            /Coverage misses in the window: at least 3\. The miss log holds every miss only after its first evaluation \(none yet\); before it, only the misses of the last 24 hours and of raised alarms were kept\./,
        );
    });

    test("alarms: the miss log counts every miss of a 7-day window, also those the 24-hour list dropped", () => {
        const UNTIL7 = SINCE + 7 * 24 * HOUR;
        const week = { since: SINCE, until: UNTIL7 };
        const base = {
            system: {},
            coverage: {},
            // The 24-hour list holds only the last day: 1 miss.
            misses: { "frostyard/x|ci": [UNTIL7 - HOUR] },
            evaluated: {},
            missLog: [
                { key: "frostyard/x|ci", at: SINCE - HOUR },
                { key: "frostyard/x|ci", at: SINCE + HOUR },
                { key: "frostyard/x|ci", at: SINCE + HOUR },
                { key: "frostyard/y|head", at: SINCE + 3 * 24 * HOUR },
                { key: "frostyard/x|ci", at: UNTIL7 - HOUR },
                { key: "frostyard/x|ci", at: UNTIL7 },
            ],
        };

        // The log began before the window: the count is exact, from the log alone.
        const complete = summarize({ alarms: { ...base, missLogFrom: SINCE - 2 * HOUR } }, week)
            .alarms as { missesInWindow: number; missesComplete: boolean; missLogFrom: number };

        assert.equal(complete.missesInWindow, 4);
        assert.equal(complete.missesComplete, true);
        assert.match(
            formatMarkdown(summarize({ alarms: { ...base, missLogFrom: SINCE - 2 * HOUR } }, week)),
            /Coverage misses in the window: 4\.\n/,
        );

        // The log began inside the window: the log from then, the 2 old lists before; a lower bound.
        const partial = summarize(
            {
                alarms: {
                    ...base,
                    coverage: {
                        "frostyard/z|state": {
                            raised: SINCE + 2 * HOUR,
                            misses: [SINCE + 30 * 60_000, SINCE + HOUR],
                        },
                    },
                    missLogFrom: SINCE + 2 * 24 * HOUR,
                },
            },
            week,
        );
        const alarms = partial.alarms as { missesInWindow: number; missesComplete: boolean };

        assert.equal(
            alarms.missesInWindow,
            2 + 2,
            "2 logged after its start, 2 from the alarm before it",
        );
        assert.equal(alarms.missesComplete, false);
        assert.match(
            formatMarkdown(partial),
            /Coverage misses in the window: at least 4\. The miss log holds every miss only from 2026-/,
        );
    });
});

describe("end to end", () => {
    test("main reads the 4 documents (a base and a delta) from a read-only database, and changes no file", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-report-"));
        const file = path.join(dir, "pocket.sqlite");

        try {
            createFixtureDb(file, NOW);

            const db = new DatabaseSync(file);

            const add = (id: number, kind: string, base: unknown, deltas: unknown[] = []) => {
                db.prepare(
                    "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) values (?,?,?,?,?,?,?,?)",
                ).run(id, JSON.stringify(kind), 0, "", "session", 0, 1, "{}");
                [base, ...deltas].forEach((content, index) =>
                    db
                        .prepare(
                            "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
                        )
                        .run(
                            id,
                            index + 1,
                            index === 0 ? "base" : "delta",
                            1,
                            JSON.stringify(content),
                        ),
                );
            };

            add(
                901,
                "x.github-hooks.deliveries",
                {
                    log: [{ at: SINCE + HOUR, event: "status", outcome: "accepted", status: 202 }],
                    counts: { accepted: 1 },
                    last: SINCE + HOUR,
                    dropped: 0,
                },
                [[["s", ["dropped"], 4]]],
            );
            add(902, "x.desk.nudges", {
                seen: {},
                pending: {},
                running: {},
                last: {},
                tasks: {},
                syncs: [
                    {
                        supervisor: 10,
                        count: 1,
                        deliveries: [{ id: "a", at: SINCE + HOUR }],
                        started: SINCE + HOUR + 20 * SECOND,
                        committed: SINCE + HOUR + 45 * SECOND,
                    },
                ],
                unmatched: 0,
            });
            add(903, "x.desk.observed", {
                last: {},
                changes: [
                    {
                        repo: "frostyard/x",
                        number: 1,
                        kind: "pr",
                        class: "head",
                        at: SINCE - HOUR,
                        seen: SINCE - HOUR + 5 * MINUTE,
                    },
                ],
            });
            add(904, "x.github-hooks.alarms", {
                system: {},
                coverage: {},
                misses: {},
                evaluated: {},
            });
            db.close();

            const hash = () => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
            const before = hash();
            const files = fs.readdirSync(dir).sort();
            const lines: string[] = [];
            const run = (argv: string[]) =>
                main(argv, {
                    env: { PI_POCKET_DIR: dir },
                    now: UNTIL,
                    log: (line: string) => lines.push(line),
                });

            const { summary } = run(["--since", String(SINCE), "--json"]);

            assert.deepEqual(JSON.parse(lines[0]!), summary);
            assert.equal((summary.deliveries as { dropped: number }).dropped, 4, "the delta");
            assert.deepEqual((summary.deliveries as { byOutcome: unknown }).byOutcome, {
                accepted: 1,
            });
            assert.deepEqual((summary.nudges as { delay: unknown }).delay, {
                n: 1,
                median: 45,
                p90: 45,
                max: 45,
            });
            assert.deepEqual((summary.observed as { baseline: { head: unknown } }).baseline.head, {
                n: 1,
                median: 300,
                p90: 300,
                max: 300,
                negative: 0,
            });
            assert.deepEqual(summary.alarms, {
                system: [],
                coverage: [],
                missesInWindow: 0,
                missesComplete: false,
            });

            const { text } = run(["--since", new Date(SINCE).toISOString()]);

            assert.match(text, /^# GitHub hooks report/);
            assert.match(text, /No alarm was ever raised/);
            assert.equal(hash(), before, "the database is unchanged");
            assert.deepEqual(fs.readdirSync(dir).sort(), files, "no new file");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
