// Rank, ids, owner and size, "maybe fixed", the day compare, redaction, quote length, and the Markdown.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HOUR, MINUTE, SECRET, iso, money, moneyFine, quote } from "./common.mjs";
import { makeFinding } from "./checks.mjs";
import {
    MAX_OTHER,
    annotate,
    buildJson,
    compareDays,
    isMaybeFixed,
    loadEarlier,
    ownerOf,
    rankOf,
    renderReport,
    repeatDays,
    scrubJson,
    scrubMarkdown,
    summaryText,
    totalsOf,
} from "./report.mjs";
import { NOW, ctx, emptyData } from "./fixtures/builders.mjs";

const finding = (check: string, subject: string | undefined, over: object = {}) =>
    makeFinding({
        check,
        subject,
        severity: "medium",
        text: `${check} ${subject ?? ""} text`,
        evidence: [],
        ...over,
    });

// ---------- Ids and rank ----------

test("an id is <check>:<subject>, or the check alone", () => {
    assert.equal(finding("A1", "T36").id, "A1:T36");
    assert.equal(finding("B1", "frostyard/updex#457").id, "B1:frostyard/updex#457");
    assert.equal(finding("E3", undefined).id, "E3");
});

test("rank = weight × (1 + log2(cases)) + days it repeats + waste / 5", () => {
    assert.equal(rankOf({ severity: "high", cases: 8, waste: 5 }, 2), 3 * 4 + 2 + 1);
    assert.equal(rankOf({ severity: "medium", cases: 1 }), 2);
    assert.equal(rankOf({ severity: "low", cases: 1 }), 1);
    assert.equal(rankOf({ severity: "low", cases: 4 }), 3);
    assert.equal(
        rankOf({ severity: "medium", cases: 2, waste: 16.19 }, 0),
        Math.round((4 + 3.238) * 100) / 100,
    );
    // A finding with 0 cases counts as 1.
    assert.equal(rankOf({ severity: "high", cases: 0 }), 3);
});

test("annotate: the ranked findings come first, highest rank first; ties go by id", () => {
    const rows = annotate(
        [
            finding("A3", "T2", { severity: "low" }),
            finding("A1", "T1", { severity: "high", cases: 4 }),
            finding("A3", "T1", { severity: "low" }),
            finding("C1", "x/y#1", { severity: "medium" }),
        ],
        [],
        {},
    );

    assert.deepEqual(
        rows.map((row: { id: string }) => row.id),
        ["A1:T1", "C1:x/y#1", "A3:T1", "A3:T2"],
    );
    assert.equal(rows[0].rank, 9);
    assert.equal(rows[0].owner, "Sheeana (code), Odrade (habit)");
    assert.equal(rows[0].size, "S");
});

test("annotate: the days a finding repeats come from the earlier days, in a row", () => {
    const day = (date: string, ...idList: string[]) => ({
        date,
        json: { findings: idList.map((id) => ({ id })) },
    });
    const earlier = [
        day("2026-10-20", "A1:T1"),
        day("2026-10-21", "A3:T1"),
        day("2026-10-22", "A1:T1", "A3:T1"),
    ];

    assert.equal(repeatDays("A1:T1", earlier), 1);
    assert.equal(repeatDays("A3:T1", earlier), 2);
    assert.equal(repeatDays("Z9", earlier), 0);

    const rows = annotate([finding("A3", "T1", { severity: "low" })], earlier, {});

    assert.equal(rows[0].repeatDays, 2);
    assert.equal(rows[0].rank, 1 + 2);
});

// ---------- Owner and size ----------

test("the owner and the size come from the fixed table, by check", () => {
    const want: Record<string, [string, string]> = {
        A1: ["Sheeana (code), Odrade (habit)", "S"],
        B1: ["Sheeana (code), Odrade (habit)", "S"],
        D2: ["Sheeana (code), Odrade (habit)", "S"],
        E1: ["Sheeana (code), Odrade (habit)", "S"],
        "E1?": ["Sheeana (code), Odrade (habit)", "S"],
        E3: ["Sheeana, Odrade", "S"],
        F2: ["Sheeana, Odrade", "S"],
        G1: ["Odrade", "S"],
        H1: ["Brian", "S"],
        H2: ["Odrade, the repository's owner", "S–M"],
        H3: ["Odrade, the repository's owner", "S–M"],
        I1: ["Odrade", "S"],
        I3: ["each agent (its own home)", "S"],
        J1: ["Brian decides, Odrade proposes", "M"],
    };

    for (const [check, [owner, size]] of Object.entries(want)) {
        assert.equal(ownerOf(check).owner, owner, check);
        assert.equal(ownerOf(check).size, size, check);
    }

    assert.match(ownerOf("E3").component, /night-shift\.ts/);
    assert.match(ownerOf("H1").component, /repository settings/);
});

// ---------- Maybe fixed ----------

test("maybe fixed: the last case is not newer than the live module's install plus 10 min", () => {
    const install = Date.UTC(2026, 9, 23, 1, 12);
    const installed = { "desk.ts": install, "night-shift.ts": install, "team.ts": null };
    const at = (ms: number) => ({ ...finding("A2", "T11"), lastSeen: iso(ms) });

    assert.equal(isMaybeFixed(at(install - HOUR), installed), true);
    assert.equal(isMaybeFixed(at(install + 10 * MINUTE), installed), true);
    assert.equal(isMaybeFixed(at(install + 11 * MINUTE), installed), false);
});

test("maybe fixed: no lastSeen, no module, or no install time means not fixed; F and E3 follow night-shift.ts", () => {
    const install = Date.UTC(2026, 9, 23, 1, 12);
    const old = iso(install - HOUR);

    assert.equal(isMaybeFixed(finding("A2", "T11"), { "desk.ts": install }), false);
    assert.equal(
        isMaybeFixed({ ...finding("G1", "late"), lastSeen: old }, { "desk.ts": install }),
        false,
    );
    assert.equal(
        isMaybeFixed({ ...finding("A2", "T11"), lastSeen: old }, { "desk.ts": null }),
        false,
    );
    assert.equal(
        isMaybeFixed({ ...finding("F1", "g"), lastSeen: old }, { "desk.ts": install }),
        false,
    );
    assert.equal(
        isMaybeFixed({ ...finding("F1", "g"), lastSeen: old }, { "night-shift.ts": install }),
        true,
    );
    assert.equal(
        isMaybeFixed({ ...finding("E3", undefined), lastSeen: old }, { "night-shift.ts": install }),
        true,
    );
});

test("annotate: a maybe-fixed finding has no rank and goes after the ranked ones", () => {
    const install = Date.UTC(2026, 9, 23, 1, 12);
    const rows = annotate(
        [
            {
                ...finding("A2", "T11", { severity: "high", cases: 15 }),
                lastSeen: iso(install - HOUR),
            },
            finding("A3", "T1", { severity: "low" }),
        ],
        [],
        { "desk.ts": install },
    );

    assert.deepEqual(
        rows.map((row: { id: string }) => row.id),
        ["A3:T1", "A2:T11"],
    );
    assert.equal(rows[1].maybeFixed, true);
    assert.equal(rows[1].rank, undefined);
    assert.equal(rows[1].installedAt, iso(install));
});

test("annotate: a module installed less than 1 h before the run keeps the rank", () => {
    const now = Date.UTC(2026, 9, 24, 10, 30);
    const old = { ...finding("A2", "T11", { severity: "high" }), lastSeen: iso(now - 3 * HOUR) };
    const recent = annotate([old], [], { "desk.ts": now - 7 * MINUTE }, now)[0];
    const older = annotate([old], [], { "desk.ts": now - 2 * HOUR }, now)[0];

    assert.equal(recent.maybeFixed, false);
    assert.equal(recent.installedRecently, true);
    assert.equal(recent.installedAt, iso(now - 7 * MINUTE));
    assert.equal(typeof recent.rank, "number");
    assert.equal(older.maybeFixed, true);
    assert.equal(older.installedRecently, undefined);
    // With no run time, the old behavior stays.
    assert.equal(annotate([old], [], { "desk.ts": now - 7 * MINUTE })[0].maybeFixed, true);
    // A case after the recent install is a plain finding: no mark.
    const after = { ...old, lastSeen: iso(now - 2 * MINUTE) };
    const plain = annotate([after], [], { "desk.ts": now - 30 * MINUTE }, now)[0];

    assert.equal(plain.maybeFixed, false);
    assert.equal(plain.installedRecently, undefined);
    assert.match(
        renderReport(baseReport({ findings: [recent] })),
        /\(installed recently: desk\.ts at 2026-10-24T10:23Z\)/,
    );
});

// ---------- The days before ----------

function writeDay(parent: string, date: string, ids: string[], extra: object = {}) {
    const dir = path.join(parent, `${date}-daily-audit`);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, "findings.json"),
        JSON.stringify({ findings: ids.map((id) => ({ id })), ...extra }),
    );

    return dir;
}

test("loadEarlier reads the sibling folders with an earlier date, oldest first, and skips the rest", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "audit-days-"));

    writeDay(parent, "2026-10-22", ["B"]);
    writeDay(parent, "2026-10-20", ["A"]);
    writeDay(parent, "2026-10-23", ["TODAY"]);
    writeDay(parent, "2026-10-24", ["FUTURE"]);
    fs.mkdirSync(path.join(parent, "2026-10-21-daily-audit"));
    fs.mkdirSync(path.join(parent, "2026-10-19-daily-audit"));
    fs.writeFileSync(path.join(parent, "2026-10-19-daily-audit", "findings.json"), "not json");
    fs.mkdirSync(path.join(parent, "2026-10-18-priorities"));
    fs.writeFileSync(
        path.join(parent, "2026-10-18-priorities", "findings.json"),
        '{"findings":[]}',
    );
    fs.mkdirSync(path.join(parent, "2026-10-23-daily-audit", "x"), { recursive: true });

    const days = loadEarlier(path.join(parent, "2026-10-23-daily-audit"), "2026-10-23");

    assert.deepEqual(
        days.map((day: { date: string }) => day.date),
        ["2026-10-20", "2026-10-22"],
    );
    assert.deepEqual(days[1].json.findings, [{ id: "B" }]);
    assert.deepEqual(loadEarlier("/nonexistent/a/2026-10-23-daily-audit", "2026-10-23"), []);
});

test("compareDays: new today, repeating 3 days or more, and gone since the last day", () => {
    const day = (date: string, ...ids: string[]) => ({
        date,
        json: { findings: ids.map((id) => ({ id })) },
    });
    const earlier = [
        day("2026-10-20", "R", "G0"),
        day("2026-10-21", "R", "S"),
        day("2026-10-22", "R", "S", "G"),
    ];
    const today = [{ id: "R" }, { id: "S" }, { id: "N" }];
    const result = compareDays(today, earlier);

    assert.equal(result.previous, "2026-10-22");
    assert.deepEqual(result.fresh, ["N"]);
    // R was on the 3 days before; S on 2 (so 3 with today); N is new.
    assert.deepEqual(result.repeating, ["R", "S"]);
    assert.deepEqual(result.gone, ["G"]);
    assert.deepEqual(compareDays(today, []), {
        previous: null,
        fresh: [],
        repeating: [],
        gone: [],
    });
    // A finding on the last 2 days only (not 3 with today) does not repeat.
    assert.deepEqual(
        compareDays([{ id: "S" }], [day("2026-10-21"), day("2026-10-22", "S")]).repeating,
        [],
    );
});

// ---------- Redaction and quotes ----------

test("a quote with a secret is dropped, not masked", () => {
    for (const bad of [
        "ghp_abcdef123456",
        "github_pat_11AAA",
        "use sk-live-123",
        "AKIAABCDEFGH1234",
        "-----BEGIN PRIVATE KEY-----",
        "password=hunter2",
        "TOKEN=abc",
    ]) {
        assert.equal(quote(`see ${bad} here`), undefined, bad);
        assert.ok(SECRET.test(bad), bad);
    }

    assert.equal(quote("a normal line"), "a normal line");
    assert.equal(quote("ask-for-it"), "ask-for-it");
});

test("a quote is at most 80 characters", () => {
    assert.equal(quote("x".repeat(80))!.length, 80);
    assert.equal(quote("x".repeat(81))!.length, 80);
    assert.ok(quote("x".repeat(500))!.endsWith("…"));
    assert.equal(quote("word ".repeat(100), 40)!.length, 40);
});

test("a finding drops an evidence line with a secret", () => {
    const found = finding("A4", "x", {
        evidence: ["fine", "has ghp_123", "token=zzz", "also fine"],
    });

    assert.deepEqual(found.evidence, ["fine", "also fine"]);
});

test("the last guard drops a Markdown line and replaces a JSON string that matches the secret filter", () => {
    assert.equal(scrubMarkdown("one\nthe password=x leaked\ntwo"), "one\ntwo");
    assert.deepEqual(scrubJson({ a: ["ok", "ghp_1"], b: { c: "token=1", d: 3 } }), {
        a: ["ok", "[dropped by the secret filter]"],
        b: { c: "[dropped by the secret filter]", d: 3 },
    });
});

// ---------- The Markdown ----------

const emptyLlm = {
    used: false,
    model: "deepseek/deepseek-flash",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    reason: "--no-llm",
};
const noComparison = { previous: null, fresh: [], repeating: [], gone: [] };
const baseReport = (over: object = {}) => ({
    date: "2026-10-23",
    ctx,
    findings: [],
    comparison: noComparison,
    metrics: {},
    skipped: {},
    totals: { spend: 391, threadsTouched: 23, botPrs: 41, botMerged: 38, failedShifts: 0 },
    github: { calls: 9, capReached: false },
    llm: emptyLlm,
    ...over,
});
const sections = (markdown: string) => markdown.split("\n").filter((line) => line.startsWith("#"));

test("the report has the design's sections in order, and the first lines of Section 6", () => {
    const markdown = renderReport(baseReport());

    assert.match(
        markdown,
        /^# Audit 2026-10-23 \(24 h to 10:00\)\n\nSpend \$391\.00 · 23 threads · 41 PRs \(38 merged\) · 0 failed shifts\n/,
    );
    assert.deepEqual(sections(markdown), [
        "# Audit 2026-10-23 (24 h to 10:00)",
        "## Summary",
        "## Proposals",
        "## Other findings",
        "## Maybe fixed",
        "## New today · Repeating 3+ days · Gone since yesterday",
        "## Metrics",
        "## Skipped checks",
    ]);
    assert.match(markdown.trimEnd().split("\n").at(-1)!, /^LLM: not used \(--no-llm\)\.$/);
});

test("without an LLM text the report shows the top findings by rank, and why", () => {
    const rows = annotate(
        Array.from({ length: 8 }, (_, i) =>
            finding("A3", `T${i + 1}`, {
                severity: "low",
                cases: i + 1,
                evidence: [`desk/T${i + 1}.md`],
            }),
        ),
        [],
        {},
    );
    const markdown = renderReport(baseReport({ findings: rows }));

    assert.match(markdown, /None\. LLM text not used: --no-llm/);
    assert.match(markdown, /None written\. The top findings by rank:/);
    // The best 5 are under Proposals, with their evidence; the other 3 are under Other findings.
    const [, proposals = "", others = ""] = markdown.split(/## Proposals|## Other findings/);

    assert.equal((proposals.match(/`A3:T/g) ?? []).length, 5);
    assert.match(proposals, /Evidence: desk\/T8\.md/);
    assert.equal((others.split("## Maybe fixed")[0]!.match(/`A3:T/g) ?? []).length, 3);
});

test("a failed LLM text is named in the report, with the reason", () => {
    const markdown = renderReport(
        baseReport({
            llm: {
                ...emptyLlm,
                used: true,
                failed: true,
                inputTokens: 5,
                outputTokens: 6,
                cost: 0.01,
                reason: "3 proposals cite nothing",
            },
        }),
    );

    assert.match(markdown, /LLM text failed the checks: 3 proposals cite nothing/);
    assert.match(
        markdown,
        /LLM: deepseek\/deepseek-flash, 5 in, 6 out, \$0\.01\. 3 proposals cite nothing/,
    );
});

test("a checked proposal shows its owner and size from the table, its evidence links, and its ids", () => {
    const rows = annotate(
        [
            finding("H1", undefined, {
                severity: "medium",
                cases: 36,
                evidence: [
                    "acme/widgets#1 (b)",
                    "https://github.com/acme/widgets/pull/1",
                    "desk/T9.md",
                ],
            }),
        ],
        [],
        {},
    );
    const markdown = renderReport(
        baseReport({
            findings: rows,
            llm: {
                ...emptyLlm,
                used: true,
                reason: undefined,
                inputTokens: 1000,
                outputTokens: 100,
                cost: 0.0004,
                summary: "36 branches are left.",
                proposals: [
                    {
                        title: "Turn on auto delete",
                        text: "36 merged PRs kept their branch.",
                        cites: ["H1"],
                    },
                ],
            },
        }),
    );

    assert.match(markdown, /36 branches are left\./);
    assert.match(markdown, /1\. \*\*Turn on auto delete\*\* \(repository settings, Brian, S\)/);
    assert.match(
        markdown,
        /Evidence: https:\/\/github\.com\/acme\/widgets\/pull\/1, desk\/T9\.md\./,
    );
    assert.match(markdown, /\[H1\]/);
    assert.match(markdown, /LLM: deepseek\/deepseek-flash, 1000 in, 100 out, \$0\.0004/);
    assert.doesNotMatch(markdown, /None written/);
});

test("other findings list at most 15 lines", () => {
    const rows = annotate(
        Array.from({ length: 30 }, (_, i) => finding("A3", `T${i + 1}`, { severity: "low" })),
        [],
        {},
    );
    const markdown = renderReport(
        baseReport({
            findings: rows,
            llm: {
                ...emptyLlm,
                used: true,
                reason: undefined,
                summary: "",
                proposals: [{ title: "t", text: "x", cites: ["A3:T1"] }],
            },
        }),
    );
    const others = markdown.split("## Other findings")[1]!.split("## Maybe fixed")[0]!;

    assert.equal(MAX_OTHER, 15);
    assert.equal((others.match(/^- `A3:T/gm) ?? []).length, 15);
    assert.match(others, /… and 14 more in findings\.json/);
});

test("maybe fixed findings, the day compare, metrics and skipped checks are in the report", () => {
    const install = Date.UTC(2026, 9, 23, 1, 12);
    const rows = annotate(
        [
            { ...finding("A2", "T11", { severity: "high" }), lastSeen: iso(install - 5 * MINUTE) },
            finding("A3", "T1"),
        ],
        [],
        { "desk.ts": install },
    );
    const markdown = renderReport(
        baseReport({
            findings: rows,
            comparison: {
                previous: "2026-10-22",
                fresh: ["A3:T1"],
                repeating: ["A1:T36"],
                gone: ["A4:x"],
            },
            metrics: {
                A1: { total: 9, empty: 3, emptyCost: 1.5, triggers: { "a person": 1 } },
                J1: { total: 391, median7: null, perAgent: { odrade: 200 } },
            },
            skipped: { B1: "source unavailable: github: disabled by --no-github" },
        }),
    );

    assert.match(
        markdown,
        /- `A2:T11` \(last case 2026-10-23T01:07Z; desk\.ts installed 2026-10-23T01:12Z\)/,
    );
    assert.match(markdown, /- New today: `A3:T1`/);
    assert.match(markdown, /- Repeating 3\+ days: `A1:T36`/);
    assert.match(markdown, /- Gone since 2026-10-22: `A4:x`/);
    assert.match(markdown, /- Reopens: 9, 3 empty \(\$1\.50\)\./);
    assert.match(markdown, /- Spend: \$391\.00\. odrade \$200\.00\./);
    assert.match(markdown, /- B1: source unavailable: github: disabled by --no-github/);
    assert.match(markdown, /GitHub calls: 9\./);
    assert.match(
        renderReport(baseReport({ github: { calls: 40, capReached: true } })),
        /GitHub call cap reached/,
    );
    assert.match(renderReport(baseReport()), /No earlier day to compare\./);
});

test("the metrics note the subagents on another model, and the cross-reviews that are not flagged", () => {
    const markdown = renderReport(
        baseReport({
            metrics: {
                F1: { endings: { "ended: done": 2 } },
                F3: { wrongModelSpawns: 1, reviewerSpawns: 2, peakRounds: 0 },
            },
        }),
    );

    assert.match(markdown, /- Shift endings: ended: done 2\./);
    assert.match(
        markdown,
        /- Subagents on another model than the worker: 1 flagged, cross-reviews: 2 \(another family by design, not flagged\)\./,
    );
    // Without a code version: the line says so.
    assert.match(markdown, /Audit code: unknown\./);
    assert.match(
        renderReport(
            baseReport({ code: { commit: "abc1234", date: "2026-10-23T13:11:11-04:00" } }),
        ),
        /Audit code: abc1234 \(2026-10-23T13:11:11-04:00\)\./,
    );
});

test("the metrics note the routes, with a rate only where a cell has one", () => {
    const cell = (over = {}) => ({
        kind: "implement",
        tier: "high",
        model: "github-copilot/claude-sonnet-5.5",
        status: "shadow",
        used: "deepseek/deepseek-flash",
        count: 10,
        open: 0,
        success: 7,
        notSuccess: 3,
        successRate: 0.7,
        goals: {},
        medianRounds: 4,
        medianCost: 1,
        reopenings: 0,
        ...over,
    });
    const markdown = renderReport(
        baseReport({
            metrics: {
                R1: {
                    routes: 11,
                    cells: [
                        cell({ kind: "implement", count: 10, successRate: 0.7 }),
                        cell({ kind: "plan", count: 1, success: 1, successRate: null }),
                    ],
                },
            },
        }),
    );

    assert.match(
        markdown,
        /- Routes: 11 recorded\. implement\/high github-copilot\/claude-sonnet-5\.5 \(used deepseek\/deepseek-flash\): 10, success 7 of 10, rate 70%; plan\/high github-copilot\/claude-sonnet-5\.5 \(used deepseek\/deepseek-flash\): 1, success 1 of 1\./,
    );
    // At most 5 cells, and no line at all when no route was recorded.
    const many = renderReport(
        baseReport({
            metrics: {
                R1: {
                    routes: 9,
                    cells: ["A", "B", "C", "D", "E", "F", "G"].map((kind) =>
                        cell({ kind, successRate: null }),
                    ),
                },
            },
        }),
    );

    assert.equal(many.split(";").filter((part) => part.includes("/high")).length, 5);

    assert.doesNotMatch(renderReport(baseReport({ metrics: {} })), /- Routes:/);
    assert.doesNotMatch(
        renderReport(baseReport({ metrics: { R1: { routes: 0, cells: [] } } })),
        /- Routes:/,
    );
});

test("buildJson keeps the findings and the metrics, and never the report texts", () => {
    const data = emptyData();
    const json = buildJson({
        date: "2026-10-23",
        ctx,
        installed: { "desk.ts": NOW, "team.ts": null },
        findings: [finding("A3", "T1")],
        metrics: { A3: { sent: 3 } },
        skipped: {},
        totals: totalsOf(data, ctx, {}),
        github: { calls: 0, capReached: false },
        llm: emptyLlm,
    });

    assert.equal(json.version, 1);
    assert.equal(json.date, "2026-10-23");
    assert.deepEqual(json.window, { since: iso(ctx.since), until: iso(ctx.now), hours: 24 });
    assert.deepEqual(json.installed, { "desk.ts": iso(NOW), "team.ts": null });
    assert.equal(json.findings.length, 1);
    assert.equal(json.code, null);
    assert.deepEqual(Object.keys(json).sort(), [
        "code",
        "date",
        "findings",
        "github",
        "installed",
        "llm",
        "metrics",
        "skipped",
        "totals",
        "version",
        "window",
    ]);
});

test("totalsOf counts the threads touched in the window, the bot PRs and the failed shifts", () => {
    const data = emptyData({
        events: [
            { thread: "T1", at: NOW - HOUR, key: "a", text: "a" },
            { thread: "T1", at: NOW - 2 * HOUR, key: "b", text: "b" },
            { thread: "T2", at: NOW - 3 * HOUR, key: "c", text: "c" },
            { thread: "T3", at: NOW - 30 * HOUR, key: "d", text: "d" },
        ],
    });
    const totals = totalsOf(data, ctx, {
        J1: { total: 12.5 },
        H3: { botPrs: 4, states: { MERGED: 3, OPEN: 1 } },
        F1: { endings: { "ended: failed": 2, "ended: done": 5 } },
    });

    assert.deepEqual(totals, {
        spend: 12.5,
        threadsTouched: 2,
        botPrs: 4,
        botMerged: 3,
        failedShifts: 2,
    });
    assert.equal(
        totalsOf(emptyData({ sourceErrors: { desk: "x" } }), ctx, {}).threadsTouched,
        null,
    );
});

test("the metrics lines use the singular for 1", () => {
    const one = renderReport(
        baseReport({
            metrics: {
                E1: { total: 4, duplicates: 1, candidates: 1 },
                A2: { continues: 1, items: 1, silentThenClosed: 0, cost: 0 },
                A3: { sent: 1, threads: 1 },
            },
        }),
    );
    const many = renderReport(
        baseReport({
            metrics: {
                E1: { total: 4, duplicates: 2, candidates: 0 },
                A2: { continues: 2, items: 3, silentThenClosed: 0, cost: 0 },
                A3: { sent: 4, threads: 2 },
            },
        }),
    );

    assert.match(one, /1 sure duplicate, 1 candidate\./);
    assert.match(one, /Queue: 1 continue, 1 item,/);
    assert.match(one, /on 1 thread\./);
    assert.match(many, /2 sure duplicates, 0 candidates\./);
    assert.match(many, /Queue: 2 continues, 3 items,/);
    assert.match(many, /on 2 threads\./);
});

test("money in the report always has 2 decimals", () => {
    const markdown = renderReport(
        baseReport({
            totals: { spend: 486.8, threadsTouched: 1, botPrs: 1, botMerged: 1, failedShifts: 0 },
            metrics: {
                A1: { total: 2, empty: 1, emptyCost: 15.7, triggers: {} },
                A2: { continues: 2, items: 3, silentThenClosed: 0, cost: 9 },
                J1: { total: 486.8, median7: 400, perAgent: { odrade: 200.5, irulan: 3 } },
            },
        }),
    );

    assert.match(markdown, /Spend \$486\.80 ·/);
    assert.match(markdown, /1 empty \(\$15\.70\)/);
    assert.match(markdown, /for done work \(\$9\.00\)/);
    assert.match(
        markdown,
        /Spend: \$486\.80 \(7-day median \$400\.00 a day\)\. odrade \$200\.50, irulan \$3\.00\./,
    );
    assert.doesNotMatch(markdown, /\$\d+\.\d(?!\d)/);
    assert.equal(money(1), "$1.00");
    assert.equal(money(0.005), "$0.01");
    assert.equal(money(1162), "$1162.00");
    // A tiny LLM cost keeps more decimals, and at least 2.
    assert.equal(moneyFine(0.0027), "$0.0027");
    assert.equal(moneyFine(0.01), "$0.01");
    assert.equal(moneyFine(0.125), "$0.125");
});

test("the report names each proposal or summary that the checks dropped, in 1 short line", () => {
    const rows = annotate([finding("I1", undefined, { severity: "low", cases: 6 })], [], {});
    const llm = {
        ...emptyLlm,
        used: true,
        reason: undefined,
        summary: "",
        proposals: [{ title: "Add reports", text: "6 reports are missing.", cites: ["I1"] }],
        dropped: [
            { item: "proposal 5", reason: "the number 42 is in no cited finding" },
            { item: "summary", reason: "has more than 3 sentences" },
        ],
    };
    const markdown = renderReport(baseReport({ findings: rows, llm }));

    assert.match(
        markdown,
        /\nDropped by the checks: proposal 5 \(the number 42 is in no cited finding\); summary \(has more than 3 sentences\)\n/,
    );
    // The kept proposal is shown; a dropped summary shows as none, and the run is not called a failure.
    assert.match(markdown, /1\. \*\*Add reports\*\*/);
    assert.match(
        markdown,
        /## Summary\n\nNone\. The checks dropped the LLM's summary: has more than 3 sentences\.\n/,
    );
    assert.doesNotMatch(markdown, /LLM text failed the checks/);
    assert.doesNotMatch(markdown, /undefined/);
    // Nothing is said when nothing was dropped.
    assert.doesNotMatch(
        renderReport(baseReport({ findings: rows, llm: { ...llm, dropped: [] } })),
        /Dropped by the checks/,
    );
    // A whole failure shows its reason once, not the list.
    assert.doesNotMatch(
        renderReport(
            baseReport({
                llm: {
                    ...emptyLlm,
                    used: true,
                    failed: true,
                    reason: "no proposal passed the checks: x",
                    dropped: llm.dropped,
                },
            }),
        ),
        /Dropped by the checks/,
    );
});

test("summaryText: the summary, or None with the real reason, never undefined", () => {
    const used = { ...emptyLlm, used: true, reason: undefined };

    assert.equal(summaryText({ ...used, summary: "All quiet." }), "All quiet.");
    assert.equal(
        summaryText({ ...used, failed: true, reason: "the answer is not valid JSON" }),
        "None. LLM text failed the checks: the answer is not valid JSON",
    );
    assert.equal(
        summaryText({
            ...used,
            summary: "",
            dropped: [{ item: "summary", reason: "the number 18 is in no finding" }],
        }),
        "None. The checks dropped the LLM's summary: the number 18 is in no finding.",
    );
    assert.equal(summaryText(emptyLlm), "None. LLM text not used: --no-llm");
    // A used run whose answer had no summary at all.
    assert.equal(
        summaryText({ ...used, summary: "", dropped: [] }),
        "None. The LLM wrote no summary.",
    );
    assert.equal(summaryText({ used: false }), "None. LLM text not used.");
});
