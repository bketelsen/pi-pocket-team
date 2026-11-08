// The goal board: the pure rules of `_desk-board.ts` (fields, moves, revisions, permissions, times, the claim, the
// pruning and the settings) with an injected clock and zone, then the desk tool and the launch pass on Pi Pocket's test
// harness, with an injected Team (`startShift`), the shift module's clock, and a cap from a test desk.json. No test
// reaches Brian's data, the network or a real model.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import {
    atOrAfter,
    BOARD_DEFAULTS,
    boardKeepsSweeper,
    boardOp,
    boardReplay,
    boardRows,
    boardSettings,
    BOARD_KEY_AHEAD_MS,
    BOARD_KEY_MS,
    BOARD_KEY_TOO_OLD,
    boardPageKeyRefusal,
    claimRow,
    keepBoardReceipt,
    keepBoardReceipts,
    pickTimes,
    pruneBoardKeys,
    pruneBoard,
    recordStart,
    roundsToday,
    staleText,
    type Board,
    type BoardActor,
    type BoardReceiptsState,
    type BoardClock,
    type BoardMember,
    type BoardOpContext,
    type BoardRow,
} from "./_desk-board.ts";
import { localMidnight, nextClockTime } from "./night-shift.ts";
import createDesk, {
    BoardReceipts,
    capView,
    DeskThreads,
    type DeskState,
    openThread,
} from "./desk.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROSTER: BoardMember[] = [
    { id: "odrade", role: "supervisor", repositories: {} },
    { id: "teg", role: "agent", repositories: { "frostyard/teg": "/tmp/teg" } },
    { id: "lucilla", role: "agent", repositories: { "frostyard/lucilla": "/tmp/lucilla" } },
    { id: "clerk", role: "clerk", repositories: {} },
];
const MODELS = ["faux/faux-2", "github-copilot/claude-sonnet-5.5"];

/** The shift module's clock math in a zone. */
const clockIn = (zone: string): BoardClock => ({ zone, nextClockTime, midnight: localMidnight });
const NEW_YORK = clockIn("America/New_York");

const SUPERVISOR: BoardActor = { kind: "supervisor", supervisor: 7, by: "odrade" };
const OTHER: BoardActor = { kind: "supervisor", supervisor: 8, by: "odrade" };
const TEG: BoardActor = { kind: "agent", supervisor: 7, agent: "teg" };

const opContext = (patch: Partial<BoardOpContext> = {}): BoardOpContext => ({
    roster: ROSTER,
    models: MODELS,
    clock: NEW_YORK,
    threadSupervisor: (id) => (id === "T5" ? 7 : id === "T6" ? 8 : undefined),
    ...patch,
});

/** 2026-11-07 23:50 in New York (EST, UTC-5). */
const LATE = Date.UTC(2026, 10, 8, 4, 50);

const FIELDS = {
    agent: "teg",
    title: "Tend frostyard/teg",
    task: "Fix the flaky tests.",
    stopWhen: "CI is green",
    max: 20,
    until: "06:45",
};

const emptyBoard = (): Board => ({ next: 1, rows: [] });

/** Add 1 row as the supervisor, and give it back. */
function added(board: Board, fields: object = FIELDS, actor: BoardActor = SUPERVISOR): BoardRow {
    const done = boardOp(board, actor, { op: "add", fields }, opContext(), LATE);

    assert(!("status" in done), JSON.stringify(done));

    return done.rows[0] ?? assert.fail("a row");
}

const refusal = (result: object): { error: string; status: number } =>
    "status" in result
        ? (result as { error: string; status: number })
        : assert.fail(`refused: ${JSON.stringify(result)}`);

const SETTINGS = { ...BOARD_DEFAULTS };
const MIDNIGHT = localMidnight(LATE, NEW_YORK.zone);
const ALWAYS = () => true;

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe("board rows: fields, bounds and defaults", () => {
    test("an add gets id, rev 1, proposed, kind goal and order id × 10; next moves on", () => {
        const board = emptyBoard();
        const first = added(board);
        const second = added(board, { ...FIELDS, kind: "sweep" });

        assert.equal(first.id, 1);
        assert.equal(first.rev, 1);
        assert.equal(first.state, "proposed");
        assert.equal(first.kind, "goal");
        assert.equal(first.order, 10);
        assert.equal(first.by, "odrade");
        assert.equal(first.supervisor, 7);
        assert.equal(first.at, LATE);
        assert.equal(first.changedAt, LATE);
        assert.deepEqual(first.attempts, []);
        assert.equal(second.id, 2);
        assert.equal(second.order, 20);
        assert.equal(second.kind, "sweep");
        assert.equal(board.next, 3);
    });

    test("each field's bounds: a value outside them is refused with 400, and nothing changes", () => {
        const cases: [object, RegExp][] = [
            [{ title: "" }, /title must be text of 1 to 120/],
            [{ title: "   " }, /title must be text of 1 to 120/],
            [{ title: 7 }, /title must be text of 1 to 120/],
            [{ task: "" }, /task must be text of 1 to 6000/],
            [{ task: " \n " }, /task must be text of 1 to 6000/],
            [{ objective: "" }, /objective must be text of 1 to 3000/],
            [{ note: "" }, /note must be text of 1 to 500/],
            [{ max: "20" }, /max must be a whole number from 1 to 100/],
            [{ until: "" }, /until must be a time as HH:MM/],
            [{ until: "06:60" }, /until must be a time as HH:MM/],
            [{ start: "" }, /start must be a time as HH:MM/],
            [{ worker: "" }, /worker must be on the owner's allowed list/],
            [{ kind: "" }, /kind must be one of goal/],
            [{ order: "1" }, /order must be a number/],
            [{ order: Number.POSITIVE_INFINITY }, /order must be a number/],
            [{ agent: "" }, /agent must be a roster id with role agent/],
            [{ agent: "clerk" }, /agent must be a roster id with role agent/],
            [{ repo: "" }, /repo must be owner\/name/],
            [{ prCheck: "pr 12" }, /prCheck must be/],
            [{ prCheck: [] }, /prCheck must be/],
            [{ prCheck: { pr: 1.5 } }, /prCheck must be/],
            [{ prCheck: { repo: "no-slash" } }, /prCheck must be/],
            [{ prCheck: { label: "" } }, /prCheck must be/],
            [{ prCheck: { label: "x".repeat(51) } }, /prCheck must be/],
            [{ prCheck: { command: "rm -rf /" } }, /prCheck must be/],
            [{ title: "x".repeat(121) }, /title must be text of 1 to 120/],
            [{ task: "x".repeat(6001) }, /task must be text of 1 to 6000/],
            [{ objective: "x".repeat(3001) }, /objective must be text of 1 to 3000/],
            [{ stopWhen: "" }, /stopWhen must be text/],
            [{ stopWhen: "x".repeat(3001) }, /stopWhen must be text of 1 to 3000/],
            [{ max: 0 }, /max must be a whole number from 1 to 100/],
            [{ max: 101 }, /max must be a whole number from 1 to 100/],
            [{ max: 2.5 }, /max must be a whole number/],
            [{ until: "24:00" }, /until must be a time as HH:MM/],
            [{ until: "6:45" }, /until must be a time as HH:MM/],
            [{ start: "7am" }, /start must be a time as HH:MM/],
            [{ worker: "openai/not-allowed" }, /worker must be on the owner's allowed list/],
            [{ prCheck: { checks: "some" } }, /prCheck must be/],
            [{ prCheck: { pr: 0 } }, /prCheck must be/],
            [{ prCheck: { label: "bad;label" } }, /prCheck must be/],
            [
                { kind: "night" },
                /kind must be one of goal, hygiene, grooming, sweep, feature, quality/,
            ],
            [{ note: "x".repeat(501) }, /note must be text of 1 to 500/],
            [{ order: Number.NaN }, /order must be a number/],
            [{ agent: "odrade" }, /agent must be a roster id with role agent/],
            [{ agent: "nobody" }, /agent must be a roster id with role agent/],
            [{ repo: "frostyard/other" }, /repo must be one of teg's repositories: frostyard\/teg/],
            [{ repo: "no-slash" }, /repo must be owner\/name/],
            [{ colour: "red" }, /colour is not a row field/],
        ];

        for (const [patch, words] of cases) {
            // An add and an edit with the bad value, each on a board with 1 row: a refusal changes nothing.
            const board = emptyBoard();

            added(board);

            const before = structuredClone(board);

            for (const op of [
                { op: "add" as const, fields: { ...FIELDS, ...patch } },
                { op: "edit" as const, row: 1, fields: patch },
            ]) {
                const refused = refusal(boardOp(board, SUPERVISOR, op, opContext(), LATE + 1));

                assert.match(refused.error, words, `${op.op} ${JSON.stringify(patch)}`);
                assert.equal(refused.status, 400);
                assert.deepEqual(
                    board,
                    before,
                    `${op.op} ${JSON.stringify(patch)} changes nothing`,
                );
            }
        }
    });

    test("an add needs title, task, stopWhen, max and until; the supervisor names agent", () => {
        for (const name of ["title", "task", "stopWhen", "max", "until", "agent"]) {
            const fields: Record<string, unknown> = { ...FIELDS };

            delete fields[name];

            const board = emptyBoard();

            assert.match(
                refusal(boardOp(board, SUPERVISOR, { op: "add", fields }, opContext(), LATE)).error,
                new RegExp(`board_add needs ${name}`),
            );
            assert.deepEqual(board, emptyBoard(), "a refusal changes nothing");
        }
    });

    test("the largest values and every optional field are kept", () => {
        const row = added(emptyBoard(), {
            ...FIELDS,
            repo: "frostyard/teg",
            title: "t".repeat(120),
            task: "x".repeat(6000),
            objective: "o".repeat(3000),
            stopWhen: "s".repeat(3000),
            max: 100,
            start: "05:00",
            worker: "faux/faux-2",
            prCheck: { pr: 12, repo: "frostyard/teg", checks: "all", label: "ready-for-human" },
            kind: "quality",
            note: "n".repeat(500),
            order: 5.5,
        });

        assert.equal(row.agent, "teg");
        assert.equal(row.repo, "frostyard/teg");
        assert.equal(row.title, "t".repeat(120));
        assert.equal(row.task, "x".repeat(6000));
        assert.equal(row.objective, "o".repeat(3000));
        assert.equal(row.stopWhen, "s".repeat(3000));
        assert.equal(row.max, 100);
        assert.equal(row.until, "06:45");
        assert.equal(row.start, "05:00");
        assert.equal(row.worker, "faux/faux-2");
        assert.deepEqual(row.prCheck, {
            pr: 12,
            repo: "frostyard/teg",
            checks: "all",
            label: "ready-for-human",
        });
        assert.equal(row.kind, "quality");
        assert.equal(row.note, "n".repeat(500));
        assert.equal(row.order, 5.5);

        // The smallest values are kept too.
        const small = added(emptyBoard(), {
            ...FIELDS,
            title: "t",
            task: "x",
            objective: "o",
            stopWhen: "s",
            max: 1,
            until: "00:00",
            start: "23:59",
            note: "n",
            order: -1,
            prCheck: {},
        });

        assert.deepEqual(
            [small.title, small.task, small.objective, small.stopWhen, small.max, small.until],
            ["t", "x", "o", "s", 1, "00:00"],
        );
        assert.deepEqual([small.start, small.note, small.order], ["23:59", "n", -1]);
        assert.deepEqual(small.prCheck, {});
    });
});

describe("board rows: states and moves", () => {
    /** A board with 1 row in `state`. */
    const inState = (state: BoardRow["state"]) => {
        const board = emptyBoard();
        const row = added(board);

        row.state = state;

        if (state === "picked" || state === "waiting") {
            row.pickedRev = row.rev;
            row.untilAt = LATE + 6 * 3600_000;
        }

        return { board, row };
    };

    const ops = {
        pick: (row: BoardRow) => ({ op: "pick" as const, rows: [{ row: row.id, rev: row.rev }] }),
        unpick: (row: BoardRow) => ({
            op: "unpick" as const,
            rows: [{ row: row.id, rev: row.rev }],
        }),
        launch: (row: BoardRow) => ({
            op: "launch" as const,
            rows: [{ row: row.id, rev: row.rev }],
        }),
        drop: (row: BoardRow) => ({ op: "drop" as const, row: row.id }),
        reopen: (row: BoardRow) => ({ op: "reopen" as const, row: row.id }),
        resolve: (row: BoardRow) => ({ op: "resolve" as const, row: row.id, thread: "T5" }),
        edit: (row: BoardRow) => ({ op: "edit" as const, row: row.id, fields: { max: 3 } }),
    };
    const allowed: Record<keyof typeof ops, BoardRow["state"][]> = {
        pick: ["proposed"],
        unpick: ["picked"],
        launch: ["picked"],
        drop: ["proposed", "picked", "waiting"],
        reopen: ["failed"],
        resolve: ["unknown"],
        edit: ["proposed", "picked", "waiting"],
    };
    const to: Record<keyof typeof ops, BoardRow["state"]> = {
        pick: "picked",
        unpick: "proposed",
        launch: "waiting",
        drop: "dropped",
        reopen: "proposed",
        resolve: "launched",
        edit: "proposed",
    };
    const states: BoardRow["state"][] = [
        "proposed",
        "picked",
        "waiting",
        "starting",
        "launched",
        "failed",
        "unknown",
        "dropped",
    ];

    for (const name of Object.keys(ops) as (keyof typeof ops)[]) {
        test(`${name}: from ${allowed[name].join(", ")} only`, () => {
            for (const state of states) {
                const { board, row } = inState(state);
                const result = boardOp(board, SUPERVISOR, ops[name](row), opContext(), LATE + 1);

                if (allowed[name].includes(state)) {
                    assert(
                        !("status" in result),
                        `${name} from ${state}: ${JSON.stringify(result)}`,
                    );
                    assert.equal(row.state, to[name], `${name} from ${state}`);
                    assert.equal(row.changedAt, LATE + 1);
                } else {
                    const refused = refusal(result);

                    assert.equal(refused.status, 409, `${name} from ${state}`);
                    assert.equal(row.state, state, "a refused move changes nothing");
                }
            }
        });
    }

    test("a starting row cannot be dropped: its run stops in its own session", () => {
        const { board, row } = inState("starting");

        assert.match(
            refusal(boardOp(board, SUPERVISOR, ops.drop(row), opContext(), LATE)).error,
            /Row 1 is starting: it cannot be dropped\. Stop its run in its own session \(\/team-shift stop or Stop\)\./,
        );
    });

    test("a pick sets the times and binds the rev; an unpick clears them", () => {
        const { board, row } = inState("proposed");

        assert(!("status" in boardOp(board, SUPERVISOR, ops.pick(row), opContext(), LATE)));
        assert.equal(row.pickedRev, 1);
        assert.equal(typeof row.untilAt, "number");
        assert(!("status" in boardOp(board, SUPERVISOR, ops.unpick(row), opContext(), LATE)));
        assert.equal(row.untilAt, undefined);
        assert.equal(row.pickedRev, undefined);
    });

    test("a launch without rows moves every picked row of the supervisor, and only those", () => {
        const board = emptyBoard();
        const a = added(board);
        const b = added(board);
        const c = added(board);
        const theirs = added(board, FIELDS, OTHER);

        for (const row of [a, b, theirs]) {
            boardOp(board, row === theirs ? OTHER : SUPERVISOR, ops.pick(row), opContext(), LATE);
        }

        const done = boardOp(board, SUPERVISOR, { op: "launch" }, opContext(), LATE);

        assert(!("status" in done));
        assert.deepEqual(
            done.rows.map((row) => row.id),
            [a.id, b.id],
        );
        assert.equal(c.state, "proposed");
        assert.equal(theirs.state, "picked");
    });

    test("resolve: a thread of this supervisor launches the row; none fails it; another's is refused", () => {
        const one = inState("unknown");

        boardOp(one.board, SUPERVISOR, ops.resolve(one.row), opContext(), LATE);
        assert.equal(one.row.state, "launched");
        assert.equal(one.row.thread, "T5");
        assert.equal(one.row.launchedAt, LATE);

        const two = inState("unknown");

        boardOp(two.board, SUPERVISOR, { op: "resolve", row: 1 }, opContext(), LATE);
        assert.equal(two.row.state, "failed");

        const three = inState("unknown");

        assert.match(
            refusal(
                boardOp(
                    three.board,
                    SUPERVISOR,
                    { op: "resolve", row: 1, thread: "T6" },
                    opContext(),
                    LATE,
                ),
            ).error,
            /There is no thread T6 of this supervisor on the desk/,
        );
        assert.equal(three.row.state, "unknown");
    });

    test("1 refused row in a pick refuses the whole call", () => {
        const board = emptyBoard();
        const a = added(board);
        const b = added(board);

        b.state = "launched";
        refusal(
            boardOp(
                board,
                SUPERVISOR,
                {
                    op: "pick",
                    rows: [
                        { row: a.id, rev: 1 },
                        { row: b.id, rev: 1 },
                    ],
                },
                opContext(),
                LATE,
            ),
        );
        assert.equal(a.state, "proposed");
    });
});

describe("board rows: revisions", () => {
    test("an edit adds 1 to rev; an edit of a picked or waiting row sends it back to proposed", () => {
        for (const state of ["proposed", "picked", "waiting"] as const) {
            const board = emptyBoard();
            const row = added(board);

            row.state = state;
            row.untilAt = LATE + 3600_000;
            row.pickedRev = 1;

            const done = boardOp(
                board,
                SUPERVISOR,
                { op: "edit", row: 1, fields: { max: 7, note: "first" } },
                opContext(),
                LATE + 5,
            );

            assert(!("status" in done));
            assert.equal(row.rev, 2);
            assert.equal(row.max, 7);
            assert.equal(row.note, "first");
            assert.equal(row.state, "proposed", state);

            if (state !== "proposed") {
                assert.equal(row.untilAt, undefined, "the pick's times are cleared");
                assert.equal(row.pickedRev, undefined);
            }
        }
    });

    test("an edit can clear an optional field with null, never a required one", () => {
        const board = emptyBoard();
        const row = added(board, { ...FIELDS, note: "a note", start: "05:00" });

        boardOp(
            board,
            SUPERVISOR,
            { op: "edit", row: 1, fields: { note: null, start: null } },
            opContext(),
            LATE,
        );
        assert.equal(row.note, undefined);
        assert.equal(row.start, undefined);
        assert.match(
            refusal(
                boardOp(
                    board,
                    SUPERVISOR,
                    { op: "edit", row: 1, fields: { title: null } },
                    opContext(),
                    LATE,
                ),
            ).error,
            /title cannot be cleared/,
        );
    });

    test("a pick, an unpick and a launch with a stale rev are refused with 409 and the exact words", () => {
        const board = emptyBoard();
        const row = added(board);

        // Client A reads rev 1; client B edits (rev 2); client A picks with rev 1.
        boardOp(board, SUPERVISOR, { op: "edit", row: 1, fields: { max: 3 } }, opContext(), LATE);
        boardOp(board, SUPERVISOR, { op: "edit", row: 1, fields: { max: 4 } }, opContext(), LATE);
        boardOp(board, SUPERVISOR, { op: "edit", row: 1, fields: { max: 5 } }, opContext(), LATE);

        for (const op of ["pick", "unpick", "launch"] as const) {
            const refused = refusal(
                boardOp(board, SUPERVISOR, { op, rows: [{ row: 1, rev: 1 }] }, opContext(), LATE),
            );

            assert.equal(refused.status, 409);
            assert.equal(
                refused.error,
                "Row 1 changed (rev 4 now): read it with desk board, then pick again.",
            );
        }

        assert.equal(
            staleText(row),
            "Row 1 changed (rev 4 now): read it with desk board, then pick again.",
        );
        // A row op with a rev (the page's) is checked the same way.
        assert.equal(
            refusal(boardOp(board, SUPERVISOR, { op: "drop", row: 1, rev: 2 }, opContext(), LATE))
                .status,
            409,
        );
        assert.equal(row.state, "proposed");
    });

    test("the receipts: a receipt replays after 250 later receipts and at 29 days; at 30 days it is pruned", () => {
        const receipts: BoardReceiptsState = { receipts: [] };
        const DAY = 24 * 3600_000;

        keepBoardReceipt(receipts, "x.desk.board:task:first", "first text", 0);

        for (let index = 0; index < 250; index += 1) {
            keepBoardReceipt(
                receipts,
                `x.desk.board:task:${String(index)}`,
                `text ${String(index)}`,
                1 + index,
            );
        }

        // No count limit: every receipt younger than 30 days stays.
        assert.equal(receipts.receipts.length, 251);
        assert.equal(boardReplay(receipts, undefined, "x.desk.board:task:first"), "first text");
        assert.equal(boardReplay(receipts, undefined, "x.desk.board:task:none"), undefined);

        keepBoardReceipt(receipts, "x.desk.board:task:day-29", "day 29", 29 * DAY);
        assert.equal(boardReplay(receipts, undefined, "x.desk.board:task:first"), "first text");

        // The next write at 30 days prunes the first receipt (and only the ones that are 30 days old).
        keepBoardReceipt(receipts, "x.desk.board:task:day-30", "day 30", BOARD_KEY_MS);
        assert.equal(boardReplay(receipts, undefined, "x.desk.board:task:first"), undefined);
        assert.equal(boardReplay(receipts, undefined, "x.desk.board:task:0"), "text 0");
        assert.equal(receipts.receipts.length, 252);
    });

    test("the receipts by supervisor: a write prunes every supervisor's old receipts; an empty supervisor goes", () => {
        const supervisors: Record<string, BoardReceiptsState> = {};

        keepBoardReceipts(supervisors, "7", "x.desk.board:task:a", "a", 0);
        keepBoardReceipts(supervisors, "9", "x.desk.board:task:b", "b", 1000);
        keepBoardReceipts(supervisors, "9", "x.desk.board:task:c", "c", 2000);
        assert.deepEqual(Object.keys(supervisors).sort(), ["7", "9"]);
        assert.equal(boardReplay(supervisors["7"], undefined, "x.desk.board:task:b"), undefined);

        keepBoardReceipts(supervisors, "9", "x.desk.board:task:d", "d", BOARD_KEY_MS + 1000);
        assert.deepEqual(
            Object.keys(supervisors),
            ["9"],
            "supervisor 7's only receipt was 30 days old",
        );
        assert.deepEqual(
            supervisors["9"]?.receipts.map((each) => each.key),
            ["x.desk.board:task:c", "x.desk.board:task:d"],
        );
    });

    test("the old board.keys: still a replay fallback, never written, pruned at 30 days", () => {
        const board: Board = {
            ...emptyBoard(),
            keys: [
                { key: "x.desk.board:task:old", at: 0, text: "old text" },
                { key: "x.desk.board:task:newer", at: 1000, text: "newer text" },
            ],
        };
        const receipts: BoardReceiptsState = { receipts: [] };

        assert.equal(boardReplay(receipts, board, "x.desk.board:task:old"), "old text");
        keepBoardReceipt(receipts, "x.desk.board:task:new", "new text", 5);
        assert.equal(board.keys?.length, 2, "a new receipt goes to x.desk.board-receipts");

        pruneBoardKeys(board, BOARD_KEY_MS);
        assert.deepEqual(
            board.keys?.map((each) => each.key),
            ["x.desk.board:task:newer"],
        );
        pruneBoardKeys(board, BOARD_KEY_MS + 1000);
        assert.equal(board.keys, undefined);
    });

    test("the page key time: <ms>-<random>, less than 30 days old, at most 10 minutes ahead", () => {
        const now = Date.UTC(2026, 10, 7, 20, 0);
        const DAY = 24 * 3600_000;
        const key = (at: number) => `${String(at)}-board-pick-abc12345`;
        const tooOld = { error: BOARD_KEY_TOO_OLD, status: 409 };

        assert.equal(BOARD_KEY_TOO_OLD, "This request is too old to replay: load the board again.");
        assert.equal(boardPageKeyRefusal(key(now), now), undefined);
        assert.equal(boardPageKeyRefusal(key(now - 29 * DAY), now), undefined);
        assert.equal(boardPageKeyRefusal(key(now + BOARD_KEY_AHEAD_MS), now), undefined);
        assert.deepEqual(boardPageKeyRefusal(key(now - 31 * DAY), now), tooOld);
        assert.deepEqual(boardPageKeyRefusal(key(now - BOARD_KEY_MS), now), tooOld);
        assert.deepEqual(boardPageKeyRefusal(key(now + 11 * 60_000), now), tooOld);

        // A key that does not start with the page's time is refused: the old form, and other mistakes.
        for (const odd of [
            "board-pick-abc12345-mh3k2a1b",
            "abc-1234567890",
            `${String(now)}board`,
            `-${String(now)}-x`,
        ]) {
            assert.deepEqual(boardPageKeyRefusal(odd, now), tooOld, odd);
        }
    });
});

describe("board rows: permissions", () => {
    test("an agent adds only its own rows, as proposed, and never note or order", () => {
        const board = emptyBoard();
        const own = added(board, { ...FIELDS, agent: undefined }, TEG);

        assert.equal(own.agent, "teg");
        assert.equal(own.by, "teg");
        assert.equal(own.state, "proposed");
        assert.match(
            refusal(
                boardOp(
                    board,
                    TEG,
                    { op: "add", fields: { ...FIELDS, agent: "lucilla" } },
                    opContext(),
                    LATE,
                ),
            ).error,
            /An agent adds only its own rows: agent must be teg/,
        );

        for (const name of ["note", "order"]) {
            assert.match(
                refusal(
                    boardOp(
                        board,
                        TEG,
                        {
                            op: "add",
                            fields: { ...FIELDS, agent: "teg", [name]: name === "note" ? "x" : 1 },
                        },
                        opContext(),
                        LATE,
                    ),
                ).error,
                new RegExp(`An agent cannot set ${name}`),
            );
        }
    });

    test("an agent changes only its own proposed rows, and not agent, note or order", () => {
        const board = emptyBoard();
        const own = added(board, { ...FIELDS, agent: "teg" }, TEG);
        const theirs = added(board, { ...FIELDS, agent: "lucilla" });

        assert(
            !(
                "status" in
                boardOp(
                    board,
                    TEG,
                    { op: "edit", row: own.id, fields: { max: 2 } },
                    opContext(),
                    LATE,
                )
            ),
        );
        assert.equal(own.max, 2);

        for (const fields of [{ agent: "teg" }, { note: "x" }, { order: 1 }]) {
            refusal(boardOp(board, TEG, { op: "edit", row: own.id, fields }, opContext(), LATE));
        }

        assert.equal(
            refusal(
                boardOp(
                    board,
                    TEG,
                    { op: "edit", row: theirs.id, fields: { max: 2 } },
                    opContext(),
                    LATE,
                ),
            ).status,
            403,
        );
        assert.equal(
            refusal(boardOp(board, TEG, { op: "drop", row: theirs.id }, opContext(), LATE)).status,
            403,
        );

        own.state = "picked";
        assert.equal(
            refusal(boardOp(board, TEG, { op: "drop", row: own.id }, opContext(), LATE)).status,
            403,
        );
        own.state = "proposed";
        assert(!("status" in boardOp(board, TEG, { op: "drop", row: own.id }, opContext(), LATE)));
        assert.equal(own.state, "dropped");
    });

    test("an agent cannot pick, unpick, launch, reopen or resolve", () => {
        const board = emptyBoard();

        added(board, FIELDS, TEG);

        for (const op of [
            { op: "pick" as const, rows: [{ row: 1, rev: 1 }] },
            { op: "unpick" as const, rows: [{ row: 1, rev: 1 }] },
            { op: "launch" as const },
            { op: "reopen" as const, row: 1 },
            { op: "resolve" as const, row: 1 },
        ]) {
            const refused = refusal(boardOp(board, TEG, op, opContext(), LATE));

            assert.equal(refused.status, 403);
            assert.match(refused.error, /Only the supervisor can/);
        }
    });

    test("a second supervisor sees none of the first's rows and changes none", () => {
        const board = emptyBoard();
        const row = added(board);

        assert.deepEqual(boardRows(board, 8), []);
        assert.equal(boardRows(board, 7).length, 1);

        for (const op of [
            { op: "edit" as const, row: 1, fields: { max: 2 } },
            { op: "drop" as const, row: 1 },
            { op: "pick" as const, rows: [{ row: 1, rev: 1 }] },
            { op: "reopen" as const, row: 1 },
            { op: "resolve" as const, row: 1 },
        ]) {
            assert.equal(refusal(boardOp(board, OTHER, op, opContext(), LATE)).status, 403);
        }

        const launch = boardOp(board, OTHER, { op: "launch" }, opContext(), LATE);

        assert(!("status" in launch));
        assert.equal(launch.rows.length, 0);
        assert.equal(row.state, "proposed");
    });
});

describe("board times", () => {
    test("a pick at 23:50 for until 06:45 ends the next morning", () => {
        const times = pickTimes({ id: 1, until: "06:45" }, LATE, NEW_YORK);

        assert(!("error" in times));
        // 2026-11-08 06:45 EST = 11:45 UTC.
        assert.equal(times.untilAt, Date.UTC(2026, 10, 8, 11, 45));
        assert.equal(times.startAt, undefined);
    });

    test("at or after: a pick at the exact minute takes that minute", () => {
        const at = Date.UTC(2026, 10, 8, 11, 45);

        assert.equal(atOrAfter("06:45", at, NEW_YORK), at);
        assert.equal(atOrAfter("06:44", at, NEW_YORK), at + 24 * 3600_000 - 60_000);
    });

    test("across the daylight saving change: 2026-11-01 01:30 EDT to 06:45 EST", () => {
        // 2026-11-01 00:30 EDT (04:30 UTC); clocks go back at 02:00 EDT.
        const pick = Date.UTC(2026, 10, 1, 4, 30);
        const times = pickTimes({ id: 1, until: "06:45", start: "03:00" }, pick, NEW_YORK);

        assert(!("error" in times));
        assert.equal(times.untilAt, Date.UTC(2026, 10, 1, 11, 45), "06:45 EST");
        assert.equal(times.startAt, Date.UTC(2026, 10, 1, 8, 0), "03:00 EST");
    });

    test("a fall-back day: a pick between the 2 instants of 01:30, and a pick during the second hour", () => {
        // 2026-11-01 01:45 EDT (05:45Z): the next 01:30 is 01:30 EST (06:30Z), not the next day.
        const between = pickTimes(
            { id: 1, until: "01:30" },
            Date.UTC(2026, 10, 1, 5, 45),
            NEW_YORK,
        );

        assert(!("error" in between));
        assert.equal(between.untilAt, Date.UTC(2026, 10, 1, 6, 30));

        // 2026-11-01 01:10 EST (06:10Z): start 01:30 is 06:30Z, before until 06:45 EST (11:45Z).
        const second = pickTimes(
            { id: 1, until: "06:45", start: "01:30" },
            Date.UTC(2026, 10, 1, 6, 10),
            NEW_YORK,
        );

        assert(!("error" in second));
        assert.equal(second.startAt, Date.UTC(2026, 10, 1, 6, 30));
        assert.equal(second.untilAt, Date.UTC(2026, 10, 1, 11, 45));
    });

    test("a server zone other than UTC and New York: Asia/Kolkata (+05:30)", () => {
        const kolkata = clockIn("Asia/Kolkata");
        // 2026-11-08 23:50 IST = 18:20 UTC.
        const pick = Date.UTC(2026, 10, 8, 18, 20);
        const times = pickTimes({ id: 1, until: "06:45" }, pick, kolkata);

        assert(!("error" in times));
        assert.equal(times.untilAt, Date.UTC(2026, 10, 9, 1, 15));
        assert.equal(localMidnight(pick, kolkata.zone), Date.UTC(2026, 10, 7, 18, 30));
    });

    test("a start at or after until is refused at the pick", () => {
        const times = pickTimes({ id: 3, until: "06:45", start: "07:00" }, LATE, NEW_YORK);

        assert("error" in times);
        assert.match(times.error, /Row 3: start 07:00 is not before until 06:45/);
    });

    test("the claim gives the run its minutes to untilAt; a future startAt waits; under 10 minutes fails", () => {
        const board = emptyBoard();
        const row = added(board);

        boardOp(board, SUPERVISOR, { op: "pick", rows: [{ row: 1, rev: 1 }] }, opContext(), LATE);
        row.state = "waiting";

        const limits = { settings: SETTINGS, midnight: MIDNIGHT, runs: ALWAYS };
        const claimed = claimRow(board, 1, LATE, limits);

        assert.deepEqual(claimed, { claim: "claimed", n: 1, minutes: 6 * 60 + 55 });
        assert.equal(row.state, "starting");

        const later = added(board, { ...FIELDS, start: "05:00" });

        boardOp(
            board,
            SUPERVISOR,
            { op: "pick", rows: [{ row: later.id, rev: 1 }] },
            opContext(),
            LATE,
        );
        later.state = "waiting";
        assert.deepEqual(claimRow(board, later.id, LATE, limits), { claim: "later" });
        assert.equal(later.state, "waiting");

        const late = added(board);

        boardOp(
            board,
            SUPERVISOR,
            { op: "pick", rows: [{ row: late.id, rev: 1 }] },
            opContext(),
            LATE,
        );
        late.state = "waiting";
        assert.deepEqual(claimRow(board, late.id, (late.untilAt ?? 0) - 9 * 60_000, limits), {
            claim: "failed",
            error: "past its until",
        });
        assert.equal(late.state, "failed");
        assert.equal(late.error, "past its until");
    });
});

describe("the claim and the start's record", () => {
    /** A board with `count` waiting rows of `max` rounds. */
    const waiting = (count: number, max = 20) => {
        const board = emptyBoard();

        for (let index = 0; index < count; index += 1) {
            const row = added(board, { ...FIELDS, max });

            row.state = "waiting";
            row.untilAt = LATE + 6 * 3600_000;
        }

        return board;
    };

    test("atOnce: running rows at the limit stop the claim", () => {
        const board = waiting(3);
        const limits = { settings: { ...SETTINGS, atOnce: 2 }, midnight: MIDNIGHT, runs: ALWAYS };

        assert.equal(claimRow(board, 1, LATE, limits).claim, "claimed");
        assert.equal(claimRow(board, 2, LATE, limits).claim, "claimed");
        assert.deepEqual(claimRow(board, 3, LATE, limits), { claim: "full" });
        assert.equal(board.rows[2]?.state, "waiting");

        // A launched row whose run ended no longer counts.
        recordStart(board, 1, 1, { thread: "T1", session: 1, address: "a", replay: false }, LATE);
        assert.equal(claimRow(board, 3, LATE, { ...limits, runs: () => false }).claim, "claimed");
    });

    test("the day's round budget: a row over it fails", () => {
        const board = waiting(3, 100);
        const limits = { settings: { ...SETTINGS, rounds: 250 }, midnight: MIDNIGHT, runs: ALWAYS };

        assert.equal(claimRow(board, 1, LATE, limits).claim, "claimed");
        assert.equal(claimRow(board, 2, LATE, limits).claim, "claimed");
        assert.equal(roundsToday(board, 7, MIDNIGHT), 200);
        assert.deepEqual(claimRow(board, 3, LATE, limits), {
            claim: "failed",
            error: "over the day's round budget",
        });

        // A row launched before local midnight does not count today.
        const row = board.rows[0]!;

        recordStart(
            board,
            1,
            1,
            { thread: "T1", session: 1, address: "a", replay: false },
            MIDNIGHT - 1,
        );
        assert.equal(row.launchedAt, MIDNIGHT - 1);
        assert.equal(roundsToday(board, 7, MIDNIGHT), 100);
    });

    test("a full desk: back to waiting, attempt cap, and the next claim reuses n", () => {
        const board = waiting(1);
        const limits = { settings: SETTINGS, midnight: MIDNIGHT, runs: ALWAYS };

        assert.equal(claimRow(board, 1, LATE, limits).claim, "claimed");
        assert.equal(
            recordStart(board, 1, 1, { error: "full", unknown: false, deskFull: true }, LATE),
            "waiting",
        );

        const row = board.rows[0]!;

        assert.equal(row.attempts.at(-1)?.outcome, "cap");
        assert.deepEqual(claimRow(board, 1, LATE + 1, limits), {
            claim: "claimed",
            n: 1,
            minutes: Math.floor((6 * 3600_000 - 1) / 60_000),
        });
    });

    test("refused → failed; thrown → unknown; reopen and pick again → attempt n + 1", () => {
        const board = waiting(2);
        const limits = { settings: SETTINGS, midnight: MIDNIGHT, runs: ALWAYS };

        claimRow(board, 1, LATE, limits);
        claimRow(board, 2, LATE, limits);
        assert.equal(
            recordStart(board, 1, 1, { error: "not allowed", unknown: false }, LATE),
            "failed",
        );
        assert.equal(
            recordStart(board, 2, 1, { error: "it threw", unknown: true }, LATE),
            "unknown",
        );
        assert.equal(board.rows[0]?.attempts.at(-1)?.outcome, "refused");
        assert.equal(board.rows[1]?.attempts.at(-1)?.outcome, "unknown");
        assert(boardKeepsSweeper(board, 7), "an unknown row keeps the sweeper");

        // A late record of an attempt that is no longer the row's changes nothing.
        assert.equal(recordStart(board, 1, 1, { error: "again", unknown: false }, LATE), undefined);

        boardOp(board, SUPERVISOR, { op: "reopen", row: 1 }, opContext(), LATE);
        boardOp(board, SUPERVISOR, { op: "pick", rows: [{ row: 1, rev: 1 }] }, opContext(), LATE);
        boardOp(board, SUPERVISOR, { op: "launch", rows: [{ row: 1, rev: 1 }] }, opContext(), LATE);
        assert.equal(claimRow(board, 1, LATE, limits).claim, "claimed");
        assert.equal(board.rows[0]?.attempts.at(-1)?.n, 2);
    });

    test("the sweeper stays for waiting, starting and unknown rows only", () => {
        for (const state of ["proposed", "picked", "launched", "failed", "dropped"] as const) {
            const board = waiting(1);

            board.rows[0]!.state = state;
            assert.equal(boardKeepsSweeper(board, 7), false, state);
        }

        for (const state of ["waiting", "starting", "unknown"] as const) {
            const board = waiting(1);

            board.rows[0]!.state = state;
            assert.equal(boardKeepsSweeper(board, 7), true, state);
            assert.equal(boardKeepsSweeper(board, 8), false, "another supervisor's");
        }
    });
});

describe("board pruning and settings", () => {
    test("launched, failed and dropped rows leave keep days after changedAt; others stay", () => {
        const board = emptyBoard();
        const day = 24 * 3600_000;

        for (const state of [
            "launched",
            "failed",
            "dropped",
            "proposed",
            "waiting",
            "unknown",
        ] as const) {
            const row = added(board);

            row.state = state;
            row.changedAt = LATE;
        }

        assert.equal(pruneBoard(board, LATE + 14 * day - 1, 14), 0);
        assert.equal(pruneBoard(board, LATE + 14 * day, 14), 3);
        assert.deepEqual(
            board.rows.map((row) => row.state),
            ["proposed", "waiting", "unknown"],
        );
    });

    test("defaults, bounds, and 1 warning for each value out of range", () => {
        assert.deepEqual(boardSettings(undefined), { settings: BOARD_DEFAULTS, warnings: [] });
        assert.deepEqual(BOARD_DEFAULTS, { atOnce: 8, rounds: 250, reserve: 2, keep: 14 });
        assert.deepEqual(
            boardSettings({ atOnce: 16, rounds: 1000, reserve: 0, keep: 90 }).settings,
            { atOnce: 16, rounds: 1000, reserve: 0, keep: 90 },
        );
        assert.deepEqual(boardSettings({ atOnce: 1, rounds: 1, reserve: 10, keep: 1 }).settings, {
            atOnce: 1,
            rounds: 1,
            reserve: 10,
            keep: 1,
        });

        const bad = boardSettings({ atOnce: 17, rounds: 0, reserve: 11, keep: 1.5 });

        assert.deepEqual(bad.settings, BOARD_DEFAULTS);
        assert.equal(bad.warnings.length, 4);
        assert.match(
            bad.warnings[0] ?? "",
            /board\.atOnce must be a whole number from 1 to 16: 17 is not, so the board uses 8/,
        );

        const one = boardSettings({ atOnce: 4, keep: "x" });

        assert.equal(one.settings.atOnce, 4);
        assert.equal(one.settings.keep, 14);
        assert.equal(one.warnings.length, 1);
    });
});

// ─── The tool and the launch pass, on Pi Pocket's harness ────────────────────

/** Each run of the launch-pass suite has its own data folder. */
let dataDir = join(root, "data");
const configPath = join(root, "desk.json");
const fixturePath = join(root, "github.json");
const fakeGh = join(root, "fake-gh.sh");
const model = scriptedModel();
let app: App;

type StartRequest = {
    supervisor: number;
    commit: <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>;
    key: string;
    agent: string;
    title: string;
    task: string;
    shift: { stop_when: string; max: number; until_at: number; worker?: string };
    limit: { reserve: number };
};

type DeskOpen = {
    open: (
        tx: Tx,
        request: object,
    ) => Promise<{ thread: { id: string; session?: number; address?: string } }>;
    bind: (tx: Tx, key: string, binding: object) => Promise<unknown>;
};

/** What the injected Team's start does for a key: start (default), refuse, or throw after Pocket may have admitted it. */
const behavior = new Map<string, "refuse" | "unknown">();
/** A start that waits for its gate before it opens its thread: the concurrency tests hold starts open with it. */
let gate: Promise<void> | undefined;
const starts: StartRequest[] = [];
/** The fake linked session of each start key: the same key gives the same session, as Pocket's start does. */
const sessions = new Map<string, number>();
/** The shift status the injected shift module reports for a session. */
const goals = new Map<number, string>();
/** Sessions that carry the supervisor's identity, and those of agents. */
const personas = new Map<number, { id: string; name: string; role: string }>();

const deskApi = () =>
    (globalThis as unknown as Record<symbol, DeskOpen | undefined>)[
        Symbol.for("pi-pocket-team.desk")
    ]!;

/** The injected Team: as `team.ts`'s `startShift`, it opens the thread with the board's limit, then binds a session. */
const fakeTeam = {
    version: 1,
    persona: async (_read: unknown, id: ConversationId) => personas.get(Number(id)),
    roster: async () => ROSTER,
    startShift: async (request: StartRequest) => {
        starts.push(request);
        await gate;

        if (behavior.get(request.key) === "refuse") {
            return {
                error: "openai/not-allowed is not in the owner's allowed list for subagents. Allowed: faux/faux-2.",
                unknown: false,
            };
        }

        let opened: { thread: { id: string; session?: number; address?: string } };

        try {
            opened = await request.commit((tx) =>
                deskApi().open(tx, {
                    key: request.key,
                    supervisor: request.supervisor,
                    agents: [request.agent],
                    title: request.title,
                    task: request.task,
                    at: Date.now(),
                    limit: request.limit,
                }),
            );
        } catch (error) {
            return (error as { deskFull?: boolean }).deskFull === true
                ? { error: (error as Error).message, unknown: false, deskFull: true as const }
                : { error: (error as Error).message, unknown: false };
        }

        if (behavior.get(request.key) === "unknown") {
            return { error: "the linked session start threw", unknown: true };
        }

        if (opened.thread.session !== undefined && opened.thread.address !== undefined) {
            return {
                thread: opened.thread.id,
                session: opened.thread.session,
                address: opened.thread.address,
                replay: true,
            };
        }

        const session =
            sessions.get(request.key) ??
            Number(
                (
                    await request.commit((tx) =>
                        tx.createConversation({ ownership: { kind: "ownerless" } }),
                    )
                ).id,
            );

        sessions.set(request.key, session);
        goals.set(session, "running");
        await request.commit((tx) =>
            deskApi().bind(tx, request.key, {
                session,
                address: `session-board-${String(session)}`,
                at: Date.now(),
            }),
        );

        return {
            thread: opened.thread.id,
            session,
            address: `session-board-${String(session)}`,
            replay: false,
        };
    },
};

/** The injected shift module: its clock math, in New York, and a goal status per session. */
const fakeShift = {
    version: 2,
    zone: () => "America/New_York",
    nextClockTime,
    localMidnight,
    goal: async (_read: unknown, id: ConversationId) => {
        const status = goals.get(Number(id));

        return status === undefined ? undefined : { status, round: 1, maxRounds: 20 };
    },
};

const shared = globalThis as unknown as Record<symbol, unknown>;

/** The desk config: the cap, and the board's limits. */
function config(cap: number, board: object = {}): void {
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap, board }));
}

const stubWeb = {
    conversationRoute() {},
    route() {},
    client() {},
    command() {},
    send() {},
    onDispose() {},
    error: (status: number, message: string) => Object.assign(new Error(message), { status }),
};
const notices: string[] = [];
/** Every tool call's own call id, over every load of the desk: a new call is never a replay of an old one. */
let toolCalls = 0;

/** The desk module on the app's harness: its tool, with an injected host. Its API takes the global place. */
function stubDesk(notes: string[] = notices) {
    const stubHost = {
        requesterOf: () => owner(app).id,
        subagentModels: () => MODELS,
        text: { defang: (value: string) => value, quoted: (value: string) => value },
        notice: (_level: string, message: string) => notes.push(message),
        heldBack: () => undefined,
        linkedSessions: {
            send: async () => {},
            list: async () => [],
            start: async () => {
                throw new Error("the stub starts nothing");
            },
        },
    };
    const extension = createDesk(stubHost as never, stubWeb as never) as unknown as {
        tools: {
            name: string;
            execute: (args: object, api: object, context: unknown) => Promise<unknown>;
        }[];
    };

    const tool = async (session: number, args: object, callId?: string) => {
        toolCalls += 1;

        const result = (await extension.tools
            .find((each) => each.name === "desk")!
            .execute(
                args,
                {
                    conversationId: session,
                    taskId: "task-board",
                    callId: callId ?? `call-${String(toolCalls)}`,
                    snapshot: (...rest: unknown[]) =>
                        Reflect.apply(app.harness.snapshot, app.harness, rest),
                    commit: (change: never, ctx: never) => app.harness.commit(change, ctx),
                },
                context,
            )) as { output: { text: string }[] };

        return result.output.map((each) => each.text).join("\n");
    };

    return { tool };
}

let desk: ReturnType<typeof stubDesk>;
let sessionCount = 100;

/** A new supervisor conversation: its own board. */
async function supervisorSession(): Promise<number> {
    const folder = join(root, `sup-${String((sessionCount += 1))}`);

    mkdirSync(folder, { recursive: true });

    const id = Number(await newSession(app, folder));

    personas.set(id, { id: "odrade", name: "Odrade", role: "supervisor" });

    return id;
}

const deskState = async (): Promise<DeskState> =>
    (await app.harness.snapshot(DeskThreads, context)) ?? assert.fail("the desk state");

const rowsOf = async (supervisor: number) => boardRows((await deskState()).board, supervisor);

/**
 * Close every open thread and drop every row that keeps a supervisor live (each state but `launched` and `dropped`):
 * each test starts from a desk with no counted thread and no live supervisor by its rows.
 */
async function closeAll(): Promise<void> {
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(DeskThreads);

        for (const thread of Object.values(state.threads)) {
            if (thread.state !== "closed") {
                thread.state = "closed";
                thread.closed = { at: Date.now(), why: "dropped", by: "desk" };
            }
        }

        for (const row of state.board?.rows ?? []) {
            if (row.state !== "launched" && row.state !== "dropped") {
                row.state = "dropped";
            }
        }
    }, context);
}

/** Add `count` rows to a supervisor's board, pick them, and give their ids. */
async function picked(supervisor: number, count: number, fields: object = {}): Promise<number[]> {
    const ids: number[] = [];

    for (let index = 0; index < count; index += 1) {
        const text = await desk.tool(supervisor, {
            action: "board_add",
            fields: { ...FIELDS, until: untilSoon(), title: `Row ${String(index)}`, ...fields },
        });

        ids.push(Number(/#(\d+) rev/.exec(text)?.[1]));
    }

    await desk.tool(supervisor, {
        action: "board_pick",
        rows: ids.map((row) => ({ row, rev: 1 })),
    });

    return ids;
}

/** An until 3 hours from now (the suite's controlled clock), in New York, as HH:MM. */
function untilSoon(hours = 3): string {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(Date.now() + hours * 3600_000);
}

/** The notify messages a supervisor's session got. */
async function notified(supervisor: number): Promise<string[]> {
    return (await modelTexts(app, supervisor as ConversationId)).filter((text) =>
        text.includes("[desk] board row"),
    );
}

async function openHarness(): Promise<void> {
    app = await openApp(model, dataDir, () => Date.now());
}

/**
 * The launch-pass suite on 1 controlled clock: `Date` is mocked to a fixed instant for the tool, the tasks and the test,
 * and only `mock.timers.setTime` moves it (a restart past the sweeper's sleep). `untilAt` is the instant the rows' until
 * gives at that instant. Real timers stay, so the harness runs; `waitFor` times out by the monotonic clock.
 */
const launchSuite = (label: string, instant: number, untilAt: number) =>
    describe(`the board on the desk tool, and the launch pass, at ${label}`, () => {
        before(async () => {
            mock.timers.enable({ apis: ["Date"], now: instant });
            dataDir = join(root, `data-${String(instant)}`);
            behavior.clear();
            sessions.clear();
            goals.clear();
            personas.clear();
            starts.length = 0;

            const dropIns = join(dataDir, "extensions");

            mkdirSync(dropIns, { recursive: true });

            for (const file of [
                "desk.ts",
                "_desk-usage.ts",
                "_desk-dashboard.ts",
                "_desk-metrics.ts",
                "_desk-board.ts",
            ]) {
                cpSync(join(import.meta.dirname, file), join(dropIns, file));
            }

            cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), {
                recursive: true,
            });
            writeFileSync(
                fixturePath,
                JSON.stringify({ data: { viewer: { login: "github-viewer" } } }),
            );
            writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`, {
                mode: 0o755,
            });
            process.env.PI_POCKET_DESK_GH = fakeGh;
            process.env.PI_POCKET_DESK_CONFIG = configPath;
            config(100);
            shared[Symbol.for("pi-pocket-team.team")] = fakeTeam;
            shared[Symbol.for("pi-pocket-team.night-shift")] = fakeShift;
            await openHarness();
            await app.setExtensionEnabled(owner(app), "desk.ts", true);
            desk = stubDesk();
        });

        after(async () => {
            await app?.close();
            delete shared[Symbol.for("pi-pocket-team.team")];
            delete shared[Symbol.for("pi-pocket-team.night-shift")];
            mock.timers.reset();
        });

        test("the clock is the suite's fixed instant", () => {
            assert.equal(Date.now(), instant);
        });

        test("the board action lists rows in launch order with rev, state and the limits", async () => {
            await closeAll();
            config(16, { atOnce: 8 });

            const supervisor = await supervisorSession();

            await desk.tool(supervisor, {
                action: "board_add",
                fields: { ...FIELDS, order: 50, title: "Second" },
            });
            await desk.tool(supervisor, {
                action: "board_add",
                fields: { ...FIELDS, order: 5, title: "First" },
            });

            const text = await desk.tool(supervisor, { action: "board" });
            const lines = text.split("\n");

            assert.match(
                lines[0] ?? "",
                /^Board limits: 8 at once, 0 running · cap 16, \d+ count, 2 kept free · 0 of 250 rounds today\.$/,
            );
            assert.match(
                lines[1] ?? "",
                /rev 1 proposed · teg · goal · max 20 · until 06:45 .*: First$/,
            );
            assert.match(lines[2] ?? "", /: Second$/);
        });

        test("a board_add replayed after 250 other board calls gives its first text and adds no row; the receipt is in x.desk.board-receipts", async () => {
            const supervisor = await supervisorSession();
            const first = await desk.tool(
                supervisor,
                { action: "board_add", fields: FIELDS },
                "kept-250",
            );
            const row = (await rowsOf(supervisor))[0]!;

            for (let index = 0; index < 250; index += 1) {
                await desk.tool(supervisor, {
                    action: "board_edit",
                    row: row.id,
                    fields: { title: `Title ${String(index)}` },
                });
            }

            const again = await desk.tool(
                supervisor,
                { action: "board_add", fields: FIELDS },
                "kept-250",
            );

            assert.equal(again, first);
            assert.equal((await rowsOf(supervisor)).length, 1, "no second row");

            const receipts = (await app.harness.snapshot(BoardReceipts, context))?.supervisors[
                String(supervisor)
            ];

            assert.equal(receipts?.receipts.length, 251);
            assert.equal(receipts?.receipts[0]?.key, "x.desk.board:task-board:kept-250");
            assert.equal(receipts?.receipts[0]?.result, first);
            assert.equal(
                (await deskState()).board?.keys?.some(
                    (each) => each.key === "x.desk.board:task-board:kept-250",
                ) ?? false,
                false,
                "no new key in board.keys",
            );

            // A key in the old board.keys (written before x.desk.board-receipts) still replays.
            await app.harness.commit(async (tx) => {
                const board = (await tx.doc(DeskThreads)).board!;

                board.keys = [
                    {
                        key: "x.desk.board:task-board:legacy",
                        at: Date.now(),
                        text: "the legacy text",
                    },
                ];
            }, context);
            assert.equal(
                await desk.tool(supervisor, { action: "board_add", fields: FIELDS }, "legacy"),
                "the legacy text",
            );
            assert.equal((await rowsOf(supervisor)).length, 1, "no row from the legacy replay");
        });

        test("a replayed tool call changes nothing and gives the same text", async () => {
            const supervisor = await supervisorSession();
            const first = await desk.tool(
                supervisor,
                { action: "board_add", fields: FIELDS },
                "same",
            );
            const again = await desk.tool(
                supervisor,
                { action: "board_add", fields: FIELDS },
                "same",
            );

            assert.equal(again, first);
            assert.equal((await rowsOf(supervisor)).length, 1);

            const pick = await desk.tool(
                supervisor,
                {
                    action: "board_pick",
                    rows: [{ row: (await rowsOf(supervisor))[0]!.id, rev: 1 }],
                },
                "pick",
            );

            await desk.tool(supervisor, {
                action: "board_unpick",
                rows: [{ row: (await rowsOf(supervisor))[0]!.id, rev: 1 }],
            });
            assert.equal(
                await desk.tool(
                    supervisor,
                    {
                        action: "board_pick",
                        rows: [{ row: (await rowsOf(supervisor))[0]!.id, rev: 1 }],
                    },
                    "pick",
                ),
                pick,
            );
            assert.equal(
                (await rowsOf(supervisor))[0]?.state,
                "proposed",
                "the replay did not pick again",
            );
        });

        test("2 clients: a pick with a stale rev is refused, from the tool", async () => {
            const supervisor = await supervisorSession();
            const [id] = await picked(supervisor, 1);

            await desk.tool(supervisor, { action: "board_edit", row: id, fields: { max: 3 } });
            await assert.rejects(
                desk.tool(supervisor, { action: "board_pick", rows: [{ row: id, rev: 1 }] }),
                new RegExp(
                    `Row ${String(id)} changed \\(rev 2 now\\): read it with desk board, then pick again\\.`,
                ),
            );
            await desk.tool(supervisor, { action: "board_pick", rows: [{ row: id, rev: 2 }] });
            await desk.tool(supervisor, { action: "board_edit", row: id, fields: { max: 4 } });
            assert.equal(
                (await rowsOf(supervisor))[0]?.state,
                "proposed",
                "an edit sends a pick back",
            );
            await assert.rejects(
                desk.tool(supervisor, { action: "board_launch", rows: [{ row: id, rev: 2 }] }),
                /changed \(rev 3 now\)/,
            );
        });

        test("an agent adds its own row to the 1 supervisor; with 2 supervisors known it is refused with the list", async () => {
            await closeAll();

            mkdirSync(join(root, "teg-session"), { recursive: true });

            const agentSession = Number(await newSession(app, join(root, "teg-session")));

            personas.set(agentSession, { id: "teg", name: "Teg", role: "agent" });

            const saved = await deskState();
            /** The supervisors the desk knows: here by their sweeper records. */
            const knows = (...ids: number[]) =>
                app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);

                    state.sweepers = Object.fromEntries(ids.map((id) => [String(id), "task-test"]));
                    state.clerks = {};

                    for (const thread of Object.values(state.threads)) {
                        thread.supervisor = 4242;
                    }
                }, context);

            await knows(4242, 4243);
            await assert.rejects(
                desk.tool(agentSession, {
                    action: "board_add",
                    fields: { ...FIELDS, agent: undefined },
                }),
                /The desk knows 2 supervisors \(4242, 4243\), so this board call cannot tell whose board it is/,
            );
            await knows(4242);

            try {
                const text = await desk.tool(agentSession, {
                    action: "board_add",
                    fields: { ...FIELDS, agent: undefined },
                });

                assert.match(text, /rev 1 proposed · teg/);
                assert.equal((await rowsOf(4242)).at(-1)?.by, "teg");
                await assert.rejects(
                    desk.tool(agentSession, { action: "board_pick", rows: [{ row: 1, rev: 1 }] }),
                    /Only the supervisor can pick rows/,
                );
            } finally {
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);

                    state.sweepers = saved.sweepers ?? {};
                    state.clerks = saved.clerks ?? {};

                    for (const thread of Object.values(state.threads)) {
                        thread.supervisor =
                            saved.threads[thread.id]?.supervisor ?? thread.supervisor;
                    }
                }, context);
            }
        });

        test("an agent's row binds to the live supervisor: a retired one with only closed threads does not count", async () => {
            await closeAll();

            mkdirSync(join(root, "teg-retired-session"), { recursive: true });

            const agentSession = Number(await newSession(app, join(root, "teg-retired-session")));

            personas.set(agentSession, { id: "teg", name: "Teg", role: "agent" });

            const saved = await deskState();

            // 1745 is retired: every thread is its own (1 more, closed, so it has at least 1), and every thread is
            // closed. 4242 is live by its sweeper record.
            const added = await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);
                const { id } = openThread(state, {
                    key: "board-test:retired-supervisor",
                    supervisor: 1745,
                    agents: ["teg"],
                    title: "A retired supervisor's thread",
                    at: Date.now(),
                }).thread;
                // The stored thread, not the object openThread made: the document keeps its own copy.
                const thread = state.threads[id] ?? assert.fail("the retired supervisor's thread");

                thread.state = "closed";
                thread.closed = { at: Date.now(), why: "done", by: "desk" };
                state.sweepers = { "4242": "task-test" };
                state.clerks = {};

                for (const each of Object.values(state.threads)) {
                    each.supervisor = 1745;
                }

                return thread.id;
            }, context);

            try {
                const text = await desk.tool(agentSession, {
                    action: "board_add",
                    fields: { ...FIELDS, agent: undefined },
                });

                assert.match(text, /rev 1 proposed · teg/);
                assert.equal((await rowsOf(4242)).at(-1)?.by, "teg");
                assert.deepEqual(await rowsOf(1745), [], "the retired supervisor gets no row");
            } finally {
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);

                    delete state.threads[added];
                    state.sweepers = saved.sweepers ?? {};
                    state.clerks = saved.clerks ?? {};

                    for (const thread of Object.values(state.threads)) {
                        thread.supervisor =
                            saved.threads[thread.id]?.supervisor ?? thread.supervisor;
                    }
                }, context);
            }
        });

        test("an agent's row binds to a supervisor live only by a failed or unknown row; beside a second live one it is refused", async () => {
            for (const only of ["failed", "unknown"] as const) {
                await closeAll();

                const folder = join(root, `teg-${only}-row-session`);

                mkdirSync(folder, { recursive: true });

                const agentSession = Number(await newSession(app, folder));

                personas.set(agentSession, { id: "teg", name: "Teg", role: "agent" });

                const saved = await deskState();
                const before = (await rowsOf(5150)).length;

                // 5150 has every thread (all closed), no sweeper and no Clerk, and 1 row in `only`.
                const row = await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);
                    const board = (state.board ??= { next: 1, rows: [] });
                    const id = board.next;

                    board.next += 1;
                    board.rows.push({
                        id,
                        supervisor: 5150,
                        rev: 1,
                        state: only,
                        by: "odrade",
                        at: Date.now(),
                        changedAt: Date.now(),
                        agent: "teg",
                        title: `A ${only} row`,
                        task: "Tend the tests.",
                        stopWhen: "CI is green",
                        max: 2,
                        until: "06:45",
                        kind: "goal",
                        order: id * 10,
                        attempts: [],
                    });
                    state.sweepers = {};
                    state.clerks = {};

                    for (const each of Object.values(state.threads)) {
                        each.supervisor = 5150;
                    }

                    return id;
                }, context);

                try {
                    const text = await desk.tool(agentSession, {
                        action: "board_add",
                        fields: { ...FIELDS, agent: undefined },
                    });

                    assert.match(text, /rev 1 proposed · teg/, only);
                    assert.equal((await rowsOf(5150)).length, before + 2, `${only}: bound to 5150`);

                    // A second live supervisor (a sweeper): 2 known, so the agent's add is refused with the list.
                    await app.harness.commit(async (tx) => {
                        (await tx.doc(DeskThreads)).sweepers = { "4242": "task-test" };
                    }, context);
                    await assert.rejects(
                        desk.tool(agentSession, {
                            action: "board_add",
                            fields: { ...FIELDS, agent: undefined },
                        }),
                        /The desk knows 2 supervisors \(4242, 5150\)/,
                    );
                } finally {
                    await app.harness.commit(async (tx) => {
                        const state = await tx.doc(DeskThreads);

                        state.sweepers = saved.sweepers ?? {};
                        state.clerks = saved.clerks ?? {};

                        for (const each of state.board?.rows ?? []) {
                            if (each.supervisor === 5150 && each.id >= row) {
                                each.state = "dropped";
                            }
                        }

                        for (const thread of Object.values(state.threads)) {
                            thread.supervisor =
                                saved.threads[thread.id]?.supervisor ?? thread.supervisor;
                        }
                    }, context);
                }
            }
        });

        test("an agent's replayed call binds to the supervisor whose receipt holds its key, also after it retired", async () => {
            await closeAll();

            mkdirSync(join(root, "teg-replay-session"), { recursive: true });

            const agentSession = Number(await newSession(app, join(root, "teg-replay-session")));

            personas.set(agentSession, { id: "teg", name: "Teg", role: "agent" });

            const saved = await deskState();
            const call = () =>
                desk.tool(
                    agentSession,
                    { action: "board_add", fields: { ...FIELDS, agent: undefined } },
                    "call-replay-after-retire",
                );

            // Only 1745 is live, by its sweeper record: every thread is closed and no row is open.
            await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);

                state.sweepers = { "1745": "task-test" };
                state.clerks = {};
            }, context);

            try {
                const first = await call();
                const row = (await rowsOf(1745)).at(-1) ?? assert.fail("the agent's row on 1745");

                assert.equal(row.by, "teg");

                // 1745 retires (its row dropped, no sweeper) and 4242 is the 1 live supervisor.
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);
                    const stored = state.board?.rows.find((each) => each.id === row.id);

                    assert(stored !== undefined);
                    stored.state = "dropped";
                    state.sweepers = { "4242": "task-test" };
                }, context);

                const rowsBefore = (await deskState()).board?.rows.length;
                const rows4242 = (await rowsOf(4242)).length;

                assert.equal(await call(), first, "the replay gives the first text");
                assert.equal((await rowsOf(4242)).length, rows4242, "4242 gets no row");
                assert.equal((await deskState()).board?.rows.length, rowsBefore, "no new row");
            } finally {
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);

                    state.sweepers = saved.sweepers ?? {};
                    state.clerks = saved.clerks ?? {};
                }, context);
            }
        });

        test("an agent's call whose key has receipts on 2 boards is refused, and no board changes", async () => {
            await closeAll();

            mkdirSync(join(root, "teg-ambiguous-session"), { recursive: true });

            const agentSession = Number(await newSession(app, join(root, "teg-ambiguous-session")));

            personas.set(agentSession, { id: "teg", name: "Teg", role: "agent" });

            const saved = await deskState();
            const callId = "call-ambiguous-receipts";
            const key = `x.desk.board:task-board:${callId}`;
            const receipt = { key, at: Date.now(), result: "Added: the first try" };
            const savedReceipts = structuredClone(
                (await app.harness.snapshot(BoardReceipts, context))?.supervisors ?? {},
            );

            // Retired 1745 and 1746 both hold the call's receipt; 4242 is the 1 live supervisor.
            await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);
                const receipts = await tx.doc(BoardReceipts);

                state.sweepers = { "4242": "task-test" };
                state.clerks = {};

                for (const id of ["1745", "1746"]) {
                    receipts.supervisors[id] = {
                        receipts: [...(receipts.supervisors[id]?.receipts ?? []), receipt],
                    };
                }
            }, context);

            try {
                const rowsBefore = (await deskState()).board?.rows.length ?? 0;
                const rows4242 = (await rowsOf(4242)).length;

                await assert.rejects(
                    desk.tool(
                        agentSession,
                        { action: "board_add", fields: { ...FIELDS, agent: undefined } },
                        callId,
                    ),
                    /This call's key has receipts on 2 boards \(1745, 1746\), so it is not replayed and changes nothing/,
                );
                assert.equal((await deskState()).board?.rows.length ?? 0, rowsBefore, "no new row");
                assert.equal((await rowsOf(4242)).length, rows4242, "4242 gets no row");
            } finally {
                await app.harness.commit(async (tx) => {
                    const state = await tx.doc(DeskThreads);
                    const receipts = await tx.doc(BoardReceipts);

                    state.sweepers = saved.sweepers ?? {};
                    state.clerks = saved.clerks ?? {};

                    for (const id of ["1745", "1746"]) {
                        const before = savedReceipts[id];

                        if (before === undefined) {
                            delete receipts.supervisors[id];
                        } else {
                            receipts.supervisors[id] = before;
                        }
                    }
                }, context);
            }
        });

        test("the Clerk gets only board", async () => {
            const supervisor = await supervisorSession();

            mkdirSync(join(root, "clerk-session"), { recursive: true });

            const clerkSession = Number(await newSession(app, join(root, "clerk-session")));

            personas.set(clerkSession, { id: "clerk", name: "Clerk", role: "clerk" });
            await app.harness.commit(async (tx) => {
                const state = await tx.doc(DeskThreads);

                state.clerks ??= {};
                state.clerks[String(supervisor)] = {
                    session: clerkSession,
                    address: "session-clerk",
                    agent: "clerk",
                    at: Date.now(),
                } as never;
            }, context);
            await desk.tool(supervisor, { action: "board_add", fields: FIELDS });

            assert.match(
                await desk.tool(clerkSession, { action: "board" }),
                /rev 1 proposed · teg/,
            );

            for (const action of [
                "board_add",
                "board_edit",
                "board_drop",
                "board_pick",
                "board_launch",
            ]) {
                await assert.rejects(
                    desk.tool(clerkSession, {
                        action,
                        row: 1,
                        rows: [{ row: 1, rev: 1 }],
                        fields: FIELDS,
                    }),
                    /The Clerk reads the board with desk board; only the supervisor changes it/,
                );
            }

            await app.harness.commit(async (tx) => {
                delete (await tx.doc(DeskThreads)).clerks?.[String(supervisor)];
            }, context);
        });

        test("atOnce 2 with 3 picks: 2 launched, 1 waiting; the third launches at the first sweep after 1 run ends", async () => {
            await closeAll();
            config(100, { atOnce: 2 });

            const supervisor = await supervisorSession();
            const ids = await picked(supervisor, 3);
            const text = await desk.tool(supervisor, { action: "board_launch" });

            assert.match(text, /Launch pass:/);

            let rows = await rowsOf(supervisor);

            assert.deepEqual(
                rows.map((row) => row.state),
                ["launched", "launched", "waiting"],
            );
            assert.equal(rows[0]?.attempts[0]?.outcome, "started");
            assert.equal(rows[0]?.thread !== undefined, true);
            // The order of the starts is the launch order.
            assert.deepEqual(
                starts.slice(-2).map((each) => each.key),
                [`x.desk.board:${String(ids[0])}:1`, `x.desk.board:${String(ids[1])}:1`],
            );
            // The run stops at untilAt, from the same clock as the pick: the start sends it as the absolute until_at.
            assert.equal(rows[1]?.untilAt, untilAt);
            assert.deepEqual(
                starts.slice(-2).map((each) => each.shift.until_at),
                [untilAt, untilAt],
            );
            assert.equal("for" in starts.at(-1)!.shift, false, "no for");

            // While both runs work, a sweep launches nothing.
            await desk.tool(supervisor, { action: "sync" });
            assert.equal((await rowsOf(supervisor))[2]?.state, "waiting");

            // 1 run ends: the first sweep after it launches row 3.
            goals.set(Number(sessions.get(`x.desk.board:${String(ids[0])}:1`)), "ended");
            await desk.tool(supervisor, { action: "sync" });
            rows = await rowsOf(supervisor);
            assert.equal(rows[2]?.state, "launched");
            assert.equal(rows[2]?.attempts.length, 1);
        });

        test("a waiting row keeps the sweeper with no open thread of its supervisor, and the sweeper launches it after a restart", async () => {
            await closeAll();

            const counted = capView(await deskState(), 100, Date.now()).counted;

            // No room for the board: the reserve keeps the last slot free.
            config(counted + 1, { reserve: 2 });

            const supervisor = await supervisorSession();

            await picked(supervisor, 1);
            await desk.tool(supervisor, { action: "board_launch" });
            assert.equal((await rowsOf(supervisor))[0]?.state, "waiting");
            assert.equal(
                Object.values((await deskState()).threads).filter(
                    (thread) => thread.supervisor === supervisor && thread.state !== "closed",
                ).length,
                0,
                "no open thread of this supervisor",
            );

            // The sweeper's sweep ends in its sleep, not in its end: the waiting row keeps it.
            await waitFor(
                async () => (await sweeperOf(supervisor)) === "sleeping",
                "the sweeper's sleep",
                30_000,
            );
            assert(
                (await deskState()).sweepers?.[String(supervisor)] !== undefined,
                "the record stays",
            );

            // Room again, and a restart that moves the clock past the sleep: the sweeper wakes, and its pass launches the row.
            config(counted + 10, { reserve: 2 });
            await app.close();
            mock.timers.setTime(Date.now() + 11 * 60_000);
            await openHarness();
            desk = stubDesk();
            await waitFor(
                async () => (await rowsOf(supervisor))[0]?.state === "launched",
                "the launch by the sweeper",
                30_000,
            );
            assert.equal(
                (await rowsOf(supervisor))[0]?.attempts.at(-1)?.n,
                1,
                "n is reused after cap",
            );
            config(100);
        });

        test("cap minus reserve: the row waits with attempt cap, the pass stops, the OK stays unused, and n is reused", async () => {
            await closeAll();

            const counted = capView(await deskState(), 100, Date.now()).counted;

            // 1 slot before the cap: the reserve of 2 keeps it free for other work.
            config(counted + 1, { reserve: 2 });

            const supervisor = await supervisorSession();

            await app.harness.commit(async (tx) => {
                (await tx.doc(DeskThreads)).grants.push({
                    key: "grant:test",
                    at: Date.now(),
                    expires: Date.now() + 3600_000,
                    via: "tap",
                    by: "brian",
                } as never);
            }, context);

            const [first, second] = await picked(supervisor, 2);

            await desk.tool(supervisor, { action: "board_launch" });

            let rows = await rowsOf(supervisor);

            assert.equal(rows[0]?.state, "waiting");
            assert.equal(rows[0]?.attempts.at(-1)?.outcome, "cap");
            assert.equal(rows[0]?.attempts.at(-1)?.n, 1);
            assert.equal(rows[1]?.attempts.length, 0, "the pass stopped");
            assert.equal(
                (await deskState()).grants.find((grant) => grant.key === "grant:test")?.usedBy,
                undefined,
                "Brian's OK is unused",
            );
            assert.equal(
                Object.values((await deskState()).threads).filter((thread) =>
                    thread.key.startsWith(`x.desk.board:${String(first)}:`),
                ).length,
                0,
            );

            // An ordinary delegation still uses the last free slot.
            await app.harness.commit(
                (tx) =>
                    deskApi().open(tx, {
                        key: `x.team.delegate:ordinary:${String(first)}`,
                        supervisor,
                        agents: ["teg"],
                        title: "ordinary",
                        at: Date.now(),
                    }),
                context,
            );

            // Room again: the next attempt reuses n.
            config(counted + 10, { reserve: 2 });
            await desk.tool(supervisor, { action: "sync" });
            // The sync's pass or the sweeper's pass launches them: a row the other pass holds is skipped, and stays
            // `starting` until that pass records it (#176).
            await waitFor(async () => {
                const now = await rowsOf(supervisor);

                return (
                    now[0]?.state === "launched" &&
                    now.find((row) => row.id === second)?.state === "launched"
                );
            }, "both rows launched");
            rows = await rowsOf(supervisor);
            assert.equal(rows[0]?.state, "launched");
            assert.equal(rows[0]?.attempts.at(-1)?.n, 1);
            assert.equal(rows[0]?.attempts.at(-1)?.outcome, "started");
            assert.equal(rows.find((row) => row.id === second)?.state, "launched");
            assert(starts.some((each) => each.key === `x.desk.board:${String(first)}:1`));
        });

        test("the day's round budget fails a row, with 1 message", async () => {
            await closeAll();
            config(100, { rounds: 30 });

            const supervisor = await supervisorSession();

            await picked(supervisor, 2);
            await desk.tool(supervisor, { action: "board_launch" });

            const rows = await rowsOf(supervisor);

            assert.equal(rows[0]?.state, "launched");
            assert.equal(rows[1]?.state, "failed");
            assert.equal(rows[1]?.error, "over the day's round budget");
            await waitFor(async () => (await notified(supervisor)).length === 1, "1 message");
            assert.match(
                (await notified(supervisor))[0] ?? "",
                new RegExp(
                    `\\[desk\\] board row ${String(rows[1]?.id)} \\(teg\\) failed: over the day's round budget`,
                ),
            );
        });

        test("2 launch requests, a sweep pass and an ordinary delegation at once: each row claimed once, every limit held", async () => {
            await closeAll();
            config(100, { atOnce: 3 });

            const supervisor = await supervisorSession();
            const ids = await picked(supervisor, 5);
            const before = starts.length;

            let open: () => void = () => {};

            gate = new Promise<void>((resolve) => {
                open = resolve;
            });

            const calls = [
                desk.tool(supervisor, {
                    action: "board_launch",
                    rows: ids.slice(0, 3).map((row) => ({ row, rev: 1 })),
                }),
                desk.tool(supervisor, {
                    action: "board_launch",
                    rows: ids.slice(3).map((row) => ({ row, rev: 1 })),
                }),
                desk.tool(supervisor, { action: "sync" }),
                app.harness.commit(
                    (tx) =>
                        deskApi().open(tx, {
                            key: "x.team.delegate:ordinary:race",
                            supervisor,
                            agents: ["teg"],
                            title: "ordinary",
                            at: Date.now(),
                        }),
                    context,
                ),
            ];

            try {
                await waitFor(() => starts.length - before >= 3, "3 starts held at the gate");
            } finally {
                open();
                gate = undefined;
            }

            await Promise.all(calls);

            const rows = await rowsOf(supervisor);
            const keys = starts.slice(before).map((each) => each.key);

            assert.equal(new Set(keys).size, keys.length, "each start key once");
            assert.equal(rows.filter((row) => row.state === "launched").length, 3, "atOnce held");
            assert.equal(rows.filter((row) => row.state === "waiting").length, 2);
            assert(
                rows.every((row) => row.attempts.length <= 1),
                "each row claimed at most once",
            );
        });

        test("a drop racing a claim: dropped with no start, or launched with its thread", async () => {
            await closeAll();
            config(100);

            const supervisor = await supervisorSession();
            const [id] = await picked(supervisor, 1);

            await app.harness.commit(async (tx) => {
                const row = (await tx.doc(DeskThreads)).board?.rows.find((each) => each.id === id);

                row!.state = "waiting";
            }, context);

            const [dropped, synced] = await Promise.allSettled([
                desk.tool(supervisor, { action: "board_drop", row: id }),
                desk.tool(supervisor, { action: "sync" }),
            ]);
            const row = (await rowsOf(supervisor))[0]!;
            const startedFor = starts.filter((each) =>
                each.key.startsWith(`x.desk.board:${String(id)}:`),
            );

            assert.equal(synced.status, "fulfilled");

            if (row.state === "dropped") {
                assert.equal(dropped.status, "fulfilled");
                assert.equal(startedFor.length, 0, "no start");
            } else {
                assert.equal(dropped.status, "rejected");
                assert.equal(row.state, "launched");
                assert.equal(typeof row.thread, "string");
            }
        });

        test("a restart between the claim and the record: recovered first, 1 session, the same thread, with the cap full and after until", async () => {
            await closeAll();

            const supervisor = await supervisorSession();
            const [id] = await picked(supervisor, 1);
            const key = `x.desk.board:${String(id)}:1`;

            // The claim committed, and Team's start opened and bound the thread; the record never came (a restart).
            await app.harness.commit(async (tx) => {
                const row = (await tx.doc(DeskThreads)).board?.rows.find((each) => each.id === id);

                row!.state = "starting";
                row!.attempts.push({ n: 1, at: Date.now(), minutes: 120 });
            }, context);
            await fakeTeam.startShift({
                supervisor,
                commit: (change) => app.harness.commit(change, context),
                key,
                agent: "teg",
                title: "Row 0",
                task: FIELDS.task,
                shift: { stop_when: "x", max: 20, until_at: Date.now() + 120 * 60_000 },
                limit: { reserve: 0 },
            });

            const thread = Object.values((await deskState()).threads).find(
                (each) => each.key === key,
            );

            assert(thread !== undefined);

            // After the restart: the cap is full and the until is past.
            await app.harness.commit(async (tx) => {
                const row = (await tx.doc(DeskThreads)).board?.rows.find((each) => each.id === id);

                row!.untilAt = Date.now() - 3600_000;
            }, context);
            config(capView(await deskState(), 100, Date.now()).counted, { atOnce: 1 });
            await app.close();
            await openHarness();
            desk = stubDesk();

            const before = sessions.size;
            const startsBefore = starts.length;

            await desk.tool(supervisor, { action: "sync" });

            const row = (await rowsOf(supervisor))[0]!;

            assert.equal(row.state, "launched");
            assert.equal(row.thread, thread.id, "the same thread");
            // The recovered start carries the row's own end, not a new length from a late clock.
            assert.equal(starts.length, startsBefore + 1);
            assert.equal(starts.at(-1)?.key, key);
            assert.equal(starts.at(-1)?.shift.until_at, row.untilAt);
            assert.equal("for" in starts.at(-1)!.shift, false, "no for");
            assert.equal(sessions.size, before, "1 session");
            assert.equal(row.attempts.length, 1);
            assert.equal(row.attempts[0]?.outcome, "started");
            config(100);
        });

        test("a refusal: failed, 1 message", async () => {
            await closeAll();
            config(100);

            const supervisor = await supervisorSession();
            const [id] = await picked(supervisor, 1);

            behavior.set(`x.desk.board:${String(id)}:1`, "refuse");
            await desk.tool(supervisor, { action: "board_launch" });

            const row = (await rowsOf(supervisor))[0]!;

            assert.equal(row.state, "failed");
            assert.equal(row.attempts[0]?.outcome, "refused");
            assert.match(row.error ?? "", /is not in the owner's allowed list for subagents/);
            await waitFor(async () => (await notified(supervisor)).length === 1, "1 message");
            assert.match(
                (await notified(supervisor))[0] ?? "",
                new RegExp(
                    `\\[desk\\] board row ${String(id)} \\(teg\\) failed: openai/not-allowed is not in`,
                ),
            );
        });

        test("unknown: 1 message, no retry by itself, then resolve binds the found thread; reopen and pick give attempt n + 1", async () => {
            await closeAll();
            config(100);

            const supervisor = await supervisorSession();
            const [id] = await picked(supervisor, 1);
            const key = `x.desk.board:${String(id)}:1`;

            behavior.set(key, "unknown");
            await desk.tool(supervisor, { action: "board_launch" });

            let row = (await rowsOf(supervisor))[0]!;

            assert.equal(row.state, "unknown");
            assert.equal(row.attempts[0]?.outcome, "unknown");
            await waitFor(async () => (await notified(supervisor)).length === 1, "1 message");
            assert.match(
                (await notified(supervisor))[0] ?? "",
                new RegExp(
                    `\\[desk\\] board row ${String(id)} \\(teg\\) unknown: the linked session start threw`,
                ),
            );

            const count = starts.filter((each) => each.key === key).length;

            await desk.tool(supervisor, { action: "sync" });
            await desk.tool(supervisor, { action: "sync" });
            assert.equal(
                starts.filter((each) => each.key === key).length,
                count,
                "no retry by itself",
            );
            assert(boardKeepsSweeper((await deskState()).board, supervisor));

            const thread = Object.values((await deskState()).threads).find(
                (each) => each.key === key,
            )!;

            await desk.tool(supervisor, { action: "board_resolve", row: id, thread: thread.id });
            row = (await rowsOf(supervisor))[0]!;
            assert.equal(row.state, "launched");
            assert.equal(row.thread, thread.id);

            // A second row: unknown, resolved as failed, reopened, picked and launched again with a new key.
            const [next] = await picked(supervisor, 1);

            behavior.set(`x.desk.board:${String(next)}:1`, "unknown");
            await desk.tool(supervisor, { action: "board_launch" });
            await desk.tool(supervisor, { action: "board_resolve", row: next });
            assert.equal(
                (await rowsOf(supervisor)).find((each) => each.id === next)?.state,
                "failed",
            );
            await desk.tool(supervisor, { action: "board_reopen", row: next });
            await desk.tool(supervisor, { action: "board_pick", rows: [{ row: next, rev: 1 }] });
            await desk.tool(supervisor, { action: "board_launch" });

            const again = (await rowsOf(supervisor)).find((each) => each.id === next)!;

            assert.equal(again.state, "launched");
            assert.equal(again.attempts.at(-1)?.n, 2);
            assert(starts.some((each) => each.key === `x.desk.board:${String(next)}:2`));
        });

        test("an out-of-range setting falls back with 1 warning at load", async () => {
            const own: string[] = [];

            config(100, { atOnce: 99 });
            stubDesk(own);
            await waitFor(() => own.length > 0, "the warning");
            assert.deepEqual(own, [
                "desk.json board.atOnce must be a whole number from 1 to 16: 99 is not, so the board uses 8.",
            ]);
            config(100);
        });
    });

// A plain afternoon, and the night of a fall-back change: at 2026-10-31 23:30 EDT, 3 hours on is 01:30 EST, and the
// first 01:30 at or after the pick is 01:30 EDT (05:30Z), 2 hours away.
launchSuite("2026-11-10 10:00 EST", Date.UTC(2026, 10, 10, 15, 0), Date.UTC(2026, 10, 10, 18, 0));
launchSuite("2026-10-31 23:30 EDT", Date.UTC(2026, 10, 1, 3, 30), Date.UTC(2026, 10, 1, 5, 30));

after(() => cleanUp());

/** Wait until `check` holds, polling on real timers; the timeout reads the monotonic clock, never the mocked Date. */
async function waitFor(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = performance.now();

    while (!(await check())) {
        if (performance.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** The status of a supervisor's sweeper task, or undefined when it has none that is live. */
async function sweeperOf(supervisor: number): Promise<string | undefined> {
    const live = await app.harness.inspect(context);
    const task = live.tasks.find(
        (each) =>
            each.record.kind === "x.desk.sweeper" &&
            Number(each.record.conversationId) === supervisor,
    );

    return (task?.record.state as { status?: string } | undefined)?.status;
}
