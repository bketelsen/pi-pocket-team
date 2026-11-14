// The "Due: 7 days or more" list: the candidate rule, the owner rules, the actions file and its lines. Every file is
// in a temporary folder: no test reads the real roster or Odrade's folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeFinding } from "./checks.mjs";
import { dayNumber, dueOf, dueOwner, readActions, readRoster } from "./due.mjs";
import { dueLines, renderReport } from "./report.mjs";
import { ctx } from "./fixtures/builders.mjs";

const DATE = "2026-11-20";

const row = (check: string, subject: string | undefined, over: object = {}) => ({
    ...makeFinding({ check, subject, severity: "medium", text: `${check} ${subject ?? ""} text` }),
    repeatDays: 6,
    maybeFixed: false,
    ...over,
});

const agent = (id: string, name: string, repositories: string[] = [], role = "agent") => ({
    id,
    name,
    role,
    repositories,
});

const roster = {
    status: "ok",
    agents: [
        agent("odrade", "Odrade", [], "supervisor"),
        agent("clerk", "Clerk", ["frostyard/core"], "clerk"),
        agent("sheeana", "Sheeana", ["bketelsen/pi-pocket-team"]),
        agent("ghanima", "Ghanima", ["Frostyard/Core"]),
    ],
};

const noActions = { status: "missing", entries: [], refused: [] };

const entry = (id: string, until: string, action = "accepted", reason = "known") => ({
    id,
    action,
    reason,
    until,
});

const okActions = (entries: object[]) => ({ status: "ok", entries, refused: [] });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "audit-due-"));

/** Write an actions file and read it back for the run's date. */
const actionsOf = (value: unknown, date = DATE) => {
    const file = path.join(tmp(), "audit-actions.json");

    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));

    return readActions(file, date);
};

// ---------- The candidate rule ----------

test("a finding in 5 earlier days is not due; in 6 earlier days (7 with today) it is", () => {
    const result = dueOf([row("G1", "late", { repeatDays: 5 }), row("G1", "early")], {
        date: DATE,
        roster,
        actions: noActions,
    });

    assert.deepEqual(
        result.due.map((item) => [item.id, item.days, item.repeatDays]),
        [["G1:early", 7, 6]],
    );
});

test("a maybe-fixed finding is not due, however long it repeats", () => {
    const result = dueOf([row("A1", "T1", { repeatDays: 20, maybeFixed: true })], {
        date: DATE,
        roster,
        actions: noActions,
    });

    assert.deepEqual(result.due, []);
});

test("due is sorted by days, most first, then by id", () => {
    const result = dueOf(
        [row("G1", "b"), row("G1", "a"), row("J1", undefined, { repeatDays: 9 })],
        { date: DATE, roster, actions: noActions },
    );

    assert.deepEqual(
        result.due.map((item) => item.id),
        ["J1", "G1:a", "G1:b"],
    );
});

// ---------- The owner ----------

test("owner rule 1: H1 is Brian's (repository settings), with or without a roster", () => {
    const brian = { id: "brian", name: "Brian", why: "repository settings" };

    assert.deepEqual(dueOwner(row("H1", undefined), roster), brian);
    assert.deepEqual(dueOwner(row("H1", undefined), { status: "missing", agents: [] }), brian);
});

test("owner rule 2: a Q1 repository subject goes to the agent that lists it, case-insensitive", () => {
    assert.deepEqual(dueOwner(row("Q1", "rounds:repo:frostyard/core"), roster), {
        id: "ghanima",
        name: "Ghanima",
        why: "owns frostyard/core",
    });
    assert.equal(dueOwner(row("Q1", "stops:repo:frostyard/core"), roster).id, "ghanima");
    assert.equal(dueOwner(row("Q1", "repo:FROSTYARD/core"), roster).id, "ghanima");
    // A PR ref names its repository too.
    assert.equal(dueOwner(row("H2", "frostyard/core#12"), roster).id, "ghanima");
});

test("owner rule 2: a Q1 agent subject goes to that agent", () => {
    assert.deepEqual(dueOwner(row("Q1", "agent:ghanima"), roster), {
        id: "ghanima",
        name: "Ghanima",
        why: "the agent of the finding",
    });
    assert.equal(dueOwner(row("Q1", "rounds:agent:sheeana"), roster).id, "sheeana");
});

test("owner rule 2: a repository that no agent lists goes to the supervisor", () => {
    assert.deepEqual(dueOwner(row("Q1", "repo:x/y"), roster), {
        id: "odrade",
        name: "Odrade",
        why: "x/y has no owner in the roster",
    });
});

test("owner rule 3: I3 goes to the agent of the home", () => {
    assert.deepEqual(dueOwner(row("I3", "sheeana"), roster), {
        id: "sheeana",
        name: "Sheeana",
        why: "its own home",
    });
});

test("owner rule 4: a desk or shift check goes to the owner of bketelsen/pi-pocket-team", () => {
    assert.deepEqual(dueOwner(row("A1", "T1"), roster), {
        id: "sheeana",
        name: "Sheeana",
        why: "owns bketelsen/pi-pocket-team (desk.ts)",
    });
    assert.deepEqual(dueOwner(row("F1", "g1"), roster), {
        id: "sheeana",
        name: "Sheeana",
        why: "owns bketelsen/pi-pocket-team (night-shift.ts)",
    });
});

test("owner rule 5: any other check goes to the supervisor, with the table's component", () => {
    for (const [check, why] of [
        ["G1", "Pocket schedules"],
        ["I1", "Odrade's notes"],
        ["H3", "agents' briefs and CI"],
        ["J1", "models and briefs"],
        ["R1", "models and briefs"],
    ] as const) {
        assert.deepEqual(dueOwner(row(check, "x"), roster), { id: "odrade", name: "Odrade", why });
    }
});

test("with no roster, the owner is the fixed table's text", () => {
    for (const status of [
        { status: "missing", agents: [] },
        { status: "error", reason: "x", agents: [] },
    ]) {
        assert.deepEqual(dueOwner(row("A1", "T1"), status), {
            id: null,
            name: "Sheeana (code), Odrade (habit)",
            why: "roster unavailable",
        });
    }

    const result = dueOf([row("G1", "late")], {
        date: DATE,
        roster: { status: "missing", agents: [] },
        actions: noActions,
    });

    assert.ok(dueLines(result).includes("- Roster: missing; owners come from the fixed table."));
    assert.match(dueLines(result)[0]!, /Owner: Odrade \(roster unavailable\)\.$/);
});

test("with no supervisor, a rule whose agent is missing says what was missing", () => {
    const lonely = { status: "ok", agents: [agent("sheeana", "Sheeana")] };

    assert.deepEqual(dueOwner(row("A1", "T1"), lonely), {
        id: null,
        name: "Sheeana (code), Odrade (habit)",
        why: "bketelsen/pi-pocket-team has no owner in the roster, and no supervisor in the roster",
    });
    assert.equal(dueOwner(row("G1", "x"), lonely).why, "no supervisor in the roster");
});

// ---------- The actions ----------

test("an unexpired entry holds the finding, and the held list names it", () => {
    const result = dueOf([row("G1", "late")], {
        date: DATE,
        roster,
        actions: okActions([
            entry("G1:late", "2026-11-25", "issue https://github.com/frostyard/core/issues/7"),
            entry("G1:late", "2026-12-01", "row 4", "the board row"),
        ]),
    });

    assert.deepEqual(result.due, []);
    // The holding entry with the latest until.
    assert.deepEqual(result.held, [
        { id: "G1:late", days: 7, action: "row 4", reason: "the board row", until: "2026-12-01" },
    ]);
    assert.equal(dueLines(result)[1], "- Held by an action: `G1:late` (row 4, until 2026-12-01).");
});

test("an entry holds on its until date, and not the day after: then the finding is due with its last entry", () => {
    const actions = okActions([entry("G1:late", "2026-11-19"), entry("G1:late", "2026-11-20")]);

    assert.equal(
        dueOf([row("G1", "late")], { date: "2026-11-20", roster, actions }).held.length,
        1,
    );

    const after = dueOf([row("G1", "late")], { date: "2026-11-21", roster, actions });

    assert.equal(after.held.length, 0);
    assert.deepEqual(after.due[0]!.lastEntry, { action: "accepted", until: "2026-11-20" });
    assert.match(dueLines(after)[0]!, / Last action: accepted, expired 2026-11-20\.$/);
});

test("until exactly 30 days ahead holds; 31 days ahead is refused and the finding stays due", () => {
    const ok = actionsOf({ version: 1, entries: [entry("G1:late", "2026-12-20")] });

    assert.equal(ok.entries.length, 1);
    assert.equal(dueOf([row("G1", "late")], { date: DATE, roster, actions: ok }).held.length, 1);

    const far = actionsOf({ version: 1, entries: [entry("G1:late", "2026-12-21")] });

    assert.deepEqual(far.entries, []);
    assert.deepEqual(far.refused, [
        { index: 0, id: "G1:late", reason: "until is more than 30 days after 2026-11-20" },
    ]);

    const result = dueOf([row("G1", "late")], { date: DATE, roster, actions: far });

    assert.deepEqual(
        result.due.map((item) => item.id),
        ["G1:late"],
    );
    assert.ok(
        dueLines(result).includes(
            "- Actions file: 0 valid entries, 1 refused: `G1:late` (until is more than 30 days after 2026-11-20).",
        ),
    );
});

test("each bad field is refused, and the good entries stay", () => {
    const good = entry("G1:late", "2026-11-30");
    const actions = actionsOf({
        version: 1,
        entries: [
            good,
            entry("A", "2026-11-30", "declined"),
            entry("B", "2026-11-30", "issue https://github.com/frostyard/core/pull/7"),
            entry("C", "2026-11-30", "issue https://github.com/frostyard/core/issues/07"),
            entry("D", "2026-11-30", "row 0"),
            entry("E", "2026-11-30", "row 07"),
            entry("F", "2026-11-30", "accepted", "   "),
            entry("G", "2026-11-30", "accepted", "x".repeat(301)),
            entry("H", "2026-02-30"),
            entry("I", "2026-11-3"),
            { ...good, id: "" },
            "not an object",
            { id: "J", action: "accepted", reason: "known" },
            { ...good, id: "K", until: "2026-11-30", reason: "x".repeat(300) },
        ],
    });

    assert.equal(actions.status, "ok");
    assert.deepEqual(
        actions.entries.map((item: { id: string }) => item.id),
        ["G1:late", "K"],
    );
    assert.deepEqual(
        actions.refused.map((item: { index: number; id: string | null; reason: string }) => [
            item.index,
            item.id,
            item.reason,
        ]),
        [
            [1, "A", "action is not issue <url>, row <n> or accepted"],
            [2, "B", "action has no valid GitHub issue URL"],
            [3, "C", "action has no valid GitHub issue URL"],
            [4, "D", "action is not issue <url>, row <n> or accepted"],
            [5, "E", "action is not issue <url>, row <n> or accepted"],
            [6, "F", "reason is empty"],
            [7, "G", "reason is longer than 300 characters"],
            [8, "H", "until is not a date YYYY-MM-DD"],
            [9, "I", "until is not a date YYYY-MM-DD"],
            [10, null, "id is not a non-empty string"],
            [11, null, "entry is not an object"],
            [12, "J", "until is not a date YYYY-MM-DD"],
        ],
    );

    // The good entry still holds its finding.
    assert.equal(dueOf([row("G1", "late")], { date: DATE, roster, actions }).held.length, 1);
});

test("a missing actions file is 1 line and no entries", () => {
    const actions = readActions(path.join(tmp(), "nothing.json"), DATE);

    assert.deepEqual(actions, { status: "missing", entries: [], refused: [] });

    const lines = dueLines(dueOf([], { date: DATE, roster, actions }));

    assert.deepEqual(lines, [
        "- None.",
        "- Actions file: decisions/audit-actions.json not found: no entries.",
    ]);
});

test("an actions file that is not JSON is 1 line, and none of its entries count", () => {
    const actions = actionsOf("{ not json");

    assert.deepEqual(actions, { status: "invalid", reason: "not JSON", entries: [], refused: [] });
    assert.deepEqual(
        dueLines(dueOf([row("G1", "late")], { date: DATE, roster, actions })).at(-1),
        "- Actions file: decisions/audit-actions.json is not valid (not JSON): no entries.",
    );
});

test("version 2, an array, or entries that are not an array make the whole file invalid", () => {
    const entries = [entry("G1:late", "2026-11-30")];

    for (const [value, reason] of [
        [{ version: 2, entries }, "version is not 1"],
        [entries, "not an object"],
        [{ version: 1, entries: {} }, "entries is not an array"],
    ] as const) {
        const actions = actionsOf(value);

        assert.deepEqual(actions, { status: "invalid", reason, entries: [], refused: [] });
        assert.equal(
            dueOf([row("G1", "late")], { date: DATE, roster, actions }).due.length,
            1,
            reason,
        );
    }
});

test("dayNumber accepts only real calendar dates", () => {
    assert.equal(dayNumber("2026-12-20")! - dayNumber("2026-11-20")!, 30);
    assert.equal(dayNumber("2028-02-29")! - dayNumber("2028-02-28")!, 1);
    assert.equal(dayNumber("2026-02-29"), null);
    assert.equal(dayNumber("2026-13-01"), null);
    assert.equal(dayNumber(20261120), null);
});

// ---------- The roster ----------

test("readRoster reads the profiles like team.ts, and skips other files", () => {
    const dir = tmp();

    fs.writeFileSync(
        path.join(dir, "sheeana.md"),
        [
            "---",
            "role: agent",
            "repositories:",
            "  bketelsen/pi-pocket-team: ~/projects/pi-pocket-team",
            "home: ~/agents/sheeana",
            "---",
            "",
            "# Sheeana",
            "",
        ].join("\n"),
    );
    fs.writeFileSync(
        path.join(dir, "odrade.md"),
        ["---", "role: supervisor", "---", "", "# Odrade", ""].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "nameless.md"), "---\nrole: clerk\n---\n\nNo heading.\n");
    fs.writeFileSync(path.join(dir, "README.txt"), "not a profile");
    fs.writeFileSync(path.join(dir, "Upper.md"), "---\nrole: agent\n---\n");

    assert.deepEqual(readRoster(dir), {
        status: "ok",
        agents: [
            { id: "nameless", name: "nameless", role: "clerk", repositories: [] },
            { id: "odrade", name: "Odrade", role: "supervisor", repositories: [] },
            {
                id: "sheeana",
                name: "Sheeana",
                role: "agent",
                repositories: ["bketelsen/pi-pocket-team"],
            },
        ],
    });
});

test("readRoster on a missing folder is missing, and a file in its place is an error; it never throws", () => {
    const dir = tmp();

    assert.deepEqual(readRoster(path.join(dir, "nothing")), { status: "missing", agents: [] });

    fs.writeFileSync(path.join(dir, "file"), "x");

    const result = readRoster(path.join(dir, "file"));

    assert.equal(result.status, "error");
    assert.match(result.reason!, /ENOTDIR/);
});

// ---------- The report ----------

test("renderReport needs due, and puts its section after the summary", () => {
    const base = {
        date: "2026-10-23",
        ctx,
        findings: [],
        comparison: { previous: null, fresh: [], repeating: [], gone: [] },
        metrics: {},
        skipped: {},
        totals: { spend: 1, threadsTouched: 1, botPrs: 1, botMerged: 1, failedShifts: 0 },
        github: { calls: 0, capReached: false },
        llm: { used: false, reason: "--no-llm" },
    };

    assert.throws(() => renderReport(base), /renderReport needs due/);

    const markdown = renderReport({
        ...base,
        due: dueOf([row("G1", "late")], { date: DATE, roster, actions: noActions }),
    });

    assert.match(
        markdown,
        /## Summary\n\n.+\n\n## Due: 7 days or more\n\n- `G1:late` 7 days, medium: G1 late text\. Owner: Odrade \(Pocket schedules\)\.\n- Actions file: .+\n\n## Proposals/,
    );
});
