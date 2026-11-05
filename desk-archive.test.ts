// The archive of closed threads' sessions: the pure rules (the binding step B1 to B7 and the facts step F1 to F5), the
// pending and reopen work, and the event text. Plain data only: no app, no host, no git. The integration tests, with a
// stub host, are in desk.test.ts ("the archive of closed threads' sessions").
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    ARCHIVE_GRACE_MS,
    archiveBindings,
    archiveDecide,
    archiveEventText,
    archiveKey,
    archivePending,
    archiveRestores,
    archivesOf,
    SWEEP_MIN_AGE_MS,
    unarchiveKey,
    type ArchiveBinding,
    type ArchiveFacts,
    type ArchiveMode,
    type DeskState,
    type Plan,
    type Thread,
} from "./desk.ts";

const DAY = 24 * 3600_000;
const NOW = 100 * DAY;
/** The supervisor's conversation id. */
const SUP = 1;

let counter = 0;

/** A closed delegation thread of SUP, closed 3 days ago, with its own session: every rule passes. */
const thread = (overrides: Partial<Thread> = {}): Thread => {
    counter += 1;
    const id = overrides.id ?? `T${String(counter)}`;

    return {
        id,
        key: `x.test:${id}`,
        origin: "delegate",
        title: `work ${id}`,
        agents: ["duncan"],
        state: "closed",
        startedAt: 1,
        lastEventAt: 1,
        prs: {},
        branches: [],
        asks: [],
        run: {},
        events: [],
        supervisor: SUP,
        session: 1000 + counter,
        address: `session-${id}`,
        closed: { at: NOW - 3 * DAY, why: "done", by: "sweep" },
        ...overrides,
    };
};

const stateOf = (threads: Thread[], extra: Partial<DeskState> = {}): DeskState => ({
    next: { T: 1, F: 1 },
    threads: Object.fromEntries(threads.map((each) => [each.id, each])),
    grants: [],
    seen: {},
    archive: { since: 0 },
    ...extra,
});

/** A plan of a plan thread, in a state, with consults. */
const planOf = (planThread: string, state: Plan["state"], consults: Plan["consults"] = []): Plan =>
    ({
        thread: planThread,
        slug: "a-plan",
        file: "/plans/a.md",
        lead: "duncan",
        idea: "an idea",
        source: "chat",
        state,
        rev: "0".repeat(40),
        revs: [],
        sections: [],
        comments: [],
        graphs: [],
        approvals: [],
        consults,
        findings: [],
    }) as Plan;

const consult = (overrides: Partial<Plan["consults"][number]> = {}): Plan["consults"][number] => ({
    id: "k1",
    agent: "gurney",
    question: "is it safe?",
    key: "x.test:k1",
    nonce: "n",
    at: 1,
    state: "answered",
    session: 5001,
    address: "session-k1",
    ...overrides,
});

/** Facts in which every binding passes: in the list, idle, no shift, no schedule, every folder clean. */
const okFacts = (bindings: readonly ArchiveBinding[]): ArchiveFacts => ({
    sessions: bindings.map((each) => ({ address: each.address, busy: false, archived: false })),
    subagents: {},
    shifts: Object.fromEntries(bindings.map((each) => [String(each.session), null])),
    schedules: Object.fromEntries(bindings.map((each) => [String(each.session), 0])),
    folders: Object.fromEntries(
        bindings.flatMap((each) =>
            each.folder === undefined ? [] : [[each.folder, { dirty: 0, ahead: 0 }]],
        ),
    ),
});

const bind = (state: DeskState, mode: ArchiveMode = "sweep", now = NOW) =>
    archiveBindings(state, SUP, now, mode);

/** The skip reason of 1 session in the binding step, or "bound". */
const reasonOf = (state: DeskState, session: number, mode: ArchiveMode = "sweep", now = NOW) => {
    const { bindings, skips } = bind(state, mode, now);

    if (bindings.some((each) => each.session === session)) {
        return "bound";
    }

    return skips.find((each) => each.session === session)?.reason;
};

/** The decision for 1 binding with changed facts: "archive", or the skip reason. */
const decide = (binding: ArchiveBinding, change: (facts: ArchiveFacts) => void) => {
    const facts = okFacts([binding]);

    change(facts);

    const { archive, skips } = archiveDecide([binding], facts);

    return archive.length === 1 ? "archive" : skips[0]?.reason;
};

/** 1 bound delegation, as the facts step gets it. */
const oneBinding = (overrides: Partial<Thread> = {}): ArchiveBinding => {
    const one = thread(overrides);
    const binding = bind(stateOf([one])).bindings[0];

    assert(binding, "the thread is bound");

    return binding;
};

describe("the archive's binding step", () => {
    test("B1: a delegate thread's session is bound, with its address, kind, key, folder and title", () => {
        const one = thread({ cwd: "/work/repo" });
        const { bindings, skips } = bind(stateOf([one]));

        assert.deepEqual(skips, []);
        assert.deepEqual(bindings, [
            {
                session: one.session,
                address: one.address,
                kind: "delegate",
                thread: one.id,
                threads: [one.id],
                closedAt: one.closed!.at,
                folder: "/work/repo",
                title: one.title,
                archivedBefore: false,
                key: `x.desk.archive:${one.id}:${String(one.session)}:${String(one.closed!.at)}`,
            },
        ]);
        assert.equal(archiveKey(one.id, one.session!, one.closed!.at), bindings[0]!.key);
    });

    for (const origin of ["found", "seed", "ask"] as const) {
        test(`B1: origin ${origin} is never archived (a person may have started the session)`, () => {
            const one = thread({ origin });

            assert.equal(reasonOf(stateOf([one]), one.session!), "origin");
        });
    }

    test("B1: another supervisor's thread is not bound", () => {
        const one = thread({ supervisor: 77 });
        const { bindings, skips } = bind(stateOf([one]));

        assert.deepEqual(bindings, []);
        assert.deepEqual(skips, []);
    });

    test("B1: a consult of a plan of this supervisor is bound on its plan thread, with no folder", () => {
        const planThread = thread({ origin: "plan", session: 4001, address: "session-plan" });
        const state = stateOf([planThread], {
            plans: { [planThread.id]: planOf(planThread.id, "done", [consult()]) },
        });
        const { bindings } = bind(state);
        const found = bindings.find((each) => each.session === 5001);

        assert.equal(found?.kind, "consult");
        assert.equal(found?.consult, "k1");
        assert.equal(found?.thread, planThread.id);
        assert.equal(found?.address, "session-k1");
        assert.equal(found?.folder, undefined);
        assert.equal(
            bindings.find((each) => each.session === 4001)?.kind,
            "plan",
            "the planning session of a done plan is bound too",
        );
    });

    test("B2: a session bound to an open thread is not archived", () => {
        const closed = thread();
        const open = thread({ session: closed.session, state: "open" });

        delete open.closed;
        assert.equal(reasonOf(stateOf([closed, open]), closed.session!), "open-thread");
    });

    test("B2: a parked thread counts as not closed", () => {
        const one = thread({ state: "parked" });

        assert.equal(reasonOf(stateOf([one]), one.session!), "open-thread");
    });

    test("B3: the supervisor session is never archived", () => {
        const one = thread();
        const other = thread({ supervisor: one.session });

        assert.equal(reasonOf(stateOf([one, other]), one.session!), "supervisor");
    });

    test("B3: the Clerk session is never archived", () => {
        const one = thread();
        const state = stateOf([one], {
            clerks: {
                [String(SUP)]: { session: one.session!, address: "a", agent: "clerk", at: 1 },
            },
        });

        assert.equal(reasonOf(state, one.session!), "clerk");
    });

    test("B3: the planning session of an open plan is never archived", () => {
        const planThread = thread({ origin: "plan" });

        for (const open of ["drafting", "review", "approved", "building", "verifying"] as const) {
            const state = stateOf([planThread], {
                plans: { [planThread.id]: planOf(planThread.id, open) },
            });

            assert.equal(reasonOf(state, planThread.session!), "plan-open", open);
        }

        // No plan record: fail closed.
        assert.equal(reasonOf(stateOf([planThread]), planThread.session!), "plan-open");

        for (const ended of ["done", "dropped"] as const) {
            const state = stateOf([planThread], {
                plans: { [planThread.id]: planOf(planThread.id, ended) },
            });

            assert.equal(reasonOf(state, planThread.session!), "bound", ended);
        }
    });

    test("B3: a consult of an open plan is never archived", () => {
        const planThread = thread({ origin: "plan" });
        const state = stateOf([planThread], {
            plans: { [planThread.id]: planOf(planThread.id, "building", [consult()]) },
        });

        assert.equal(reasonOf(state, 5001), "consult-open");
    });

    test("B3: a consult that starts, runs or waits in the queue is never archived", () => {
        const planThread = thread({ origin: "plan" });

        for (const running of ["starting", "running", "queued"] as const) {
            const state = stateOf([planThread], {
                plans: {
                    [planThread.id]: planOf(planThread.id, "done", [consult({ state: running })]),
                },
            });

            assert.equal(reasonOf(state, 5001), "consult-active", running);
        }
    });

    test("B4: a session with an open ask on its thread is not archived", () => {
        const one = thread({ asks: [{ id: "T1a", text: "which?", at: 1 }] });

        assert.equal(reasonOf(stateOf([one]), one.session!), "open-ask");

        const answered = thread({
            asks: [{ id: "T1a", text: "which?", at: 1, answer: { at: 2, by: "b", words: "a" } }],
        });

        assert.equal(reasonOf(stateOf([answered]), answered.session!), "bound");
    });

    test("B4: a consult whose plan thread has an open ask is not archived", () => {
        const planThread = thread({ origin: "plan", asks: [{ id: "T9a", text: "?", at: 1 }] });
        const state = stateOf([planThread], {
            plans: { [planThread.id]: planOf(planThread.id, "done", [consult()]) },
        });

        assert.equal(reasonOf(state, 5001), "open-ask");
    });

    test("B5 auto: a thread that closed before since is the sweep's, not the auto pass's", () => {
        const one = thread({ closed: { at: NOW - 3 * DAY, why: "done", by: "sweep" } });

        assert.equal(
            reasonOf(stateOf([one], { archive: { since: NOW - 2 * DAY } }), one.session!, "auto"),
            "before-since",
        );
        assert.equal(
            reasonOf(stateOf([one], { archive: {} }), one.session!, "auto"),
            "before-since",
            "no since yet: nothing",
        );
    });

    test("B5 auto: the grace is 24 hours after the close", () => {
        const closedAt = NOW - ARCHIVE_GRACE_MS + 1;
        const one = thread({ closed: { at: closedAt, why: "done", by: "sweep" } });
        const state = stateOf([one], { archive: { since: closedAt - 1 } });

        assert.equal(reasonOf(state, one.session!, "auto"), "grace");
        assert.equal(reasonOf(state, one.session!, "auto", NOW + 1), "bound");
    });

    test("B5 sweep: 2 days after the close, also before since", () => {
        const closedAt = NOW - SWEEP_MIN_AGE_MS + 1;
        const one = thread({ closed: { at: closedAt, why: "done", by: "sweep" } });
        const state = stateOf([one], { archive: { since: NOW } });

        assert.equal(reasonOf(state, one.session!, "sweep"), "too-new");
        assert.equal(reasonOf(state, one.session!, "sweep", NOW + 1), "bound");
    });

    test("B5: the newest close of the session's threads counts, and records the binding", () => {
        const older = thread({ closed: { at: NOW - 5 * DAY, why: "done", by: "sweep" } });
        const newer = thread({
            session: older.session,
            closed: { at: NOW - DAY, why: "done", by: "sweep" },
        });

        assert.equal(reasonOf(stateOf([older, newer]), older.session!), "too-new");

        const both = thread({
            session: older.session,
            closed: { at: NOW - 4 * DAY, why: "done", by: "sweep" },
        });
        const binding = bind(stateOf([older, both])).bindings[0];

        assert.equal(binding?.thread, both.id);
        assert.deepEqual(binding?.threads.sort(), [older.id, both.id].sort());
    });

    test("a pending entry is the pass's own work: the binding step skips it", () => {
        const one = thread();

        one.run.archives = {
            [String(one.session)]: { at: 1, by: "auto", key: "k", state: "pending" },
        };
        assert.equal(reasonOf(stateOf([one]), one.session!), "pending");
    });

    test("the folder is the worktree until the sweep removed it, then the thread's cwd", () => {
        const worktree = { path: "/wt/a", branch: "duncan/a", checkout: "/repo" };
        const kept = oneBinding({ worktree, cwd: "/repo" });

        assert.equal(kept.folder, "/wt/a");
        assert.equal(kept.branch, "duncan/a");
        assert.equal(
            oneBinding({ worktree, cwd: "/repo", run: { worktreeGone: 5 } }).folder,
            "/repo",
        );
        assert.equal(oneBinding({}).folder, undefined);
    });
});

describe("the archive's facts step", () => {
    test("F1: a session not in the supervisor's list is not archived", () => {
        assert.equal(
            decide(oneBinding(), (facts) => {
                facts.sessions = [];
            }),
            "not-linked",
        );
    });

    test("F1: a list that is not readable decides nothing at all", () => {
        const binding = oneBinding();
        const facts = okFacts([binding]);

        delete facts.sessions;
        assert.deepEqual(archiveDecide([binding], facts), { archive: [], skips: [] });
    });

    test("F2: a busy session is not archived", () => {
        assert.equal(
            decide(oneBinding(), (facts) => {
                facts.sessions![0]!.busy = true;
            }),
            "busy",
        );
    });

    test("F2: a session with a working subagent is not archived", () => {
        const binding = oneBinding();

        assert.equal(
            decide(binding, (facts) => {
                facts.subagents = { [String(binding.session)]: true };
            }),
            "busy",
        );
    });

    test("F3: a running night shift keeps its session", () => {
        const binding = oneBinding();

        for (const status of ["running", "summary"]) {
            assert.equal(
                decide(binding, (facts) => {
                    facts.shifts[String(binding.session)] = status;
                }),
                "night-shift",
                status,
            );
        }

        for (const status of ["ended", "paused"]) {
            assert.equal(
                decide(binding, (facts) => {
                    facts.shifts[String(binding.session)] = status;
                }),
                "archive",
                status,
            );
        }
    });

    test("F3: an unknown night-shift read keeps the session (fail closed)", () => {
        assert.equal(
            decide(oneBinding(), (facts) => {
                facts.shifts = {};
            }),
            "night-shift-unknown",
        );
    });

    test("F4: a session with a schedule is not archived", () => {
        const binding = oneBinding();

        assert.equal(
            decide(binding, (facts) => {
                facts.schedules[String(binding.session)] = 1;
            }),
            "schedule",
        );
    });

    test("F4: an unknown schedule read keeps the session (fail closed)", () => {
        assert.equal(
            decide(oneBinding(), (facts) => {
                facts.schedules = {};
            }),
            "schedule-unknown",
        );
    });

    test("F5: a dirty folder keeps the session", () => {
        assert.equal(
            decide(oneBinding({ cwd: "/f" }), (facts) => {
                facts.folders["/f"] = { dirty: 2, ahead: 0 };
            }),
            "folder-dirty",
        );
    });

    test("F5: unpushed commits keep the session", () => {
        assert.equal(
            decide(oneBinding({ cwd: "/f" }), (facts) => {
                facts.folders["/f"] = { dirty: 0, ahead: 1 };
            }),
            "folder-unpushed",
        );
    });

    test("F5: an unknown folder read keeps the session (fail closed)", () => {
        const binding = oneBinding({ cwd: "/f" });

        for (const [name, change] of [
            [
                "no read",
                (facts: ArchiveFacts) => {
                    facts.folders = {};
                },
            ],
            [
                "status failed",
                (facts: ArchiveFacts) => {
                    facts.folders["/f"] = { dirty: 0, ahead: undefined, statusFailed: true };
                },
            ],
            [
                "unknown count",
                (facts: ArchiveFacts) => {
                    facts.folders["/f"] = { dirty: 0, ahead: undefined };
                },
            ],
        ] as const) {
            assert.equal(decide(binding, change), "folder-unknown", name);
        }
    });

    test("F5: a gone folder, a folder that is not git, a clean one, and no folder pass", () => {
        const binding = oneBinding({ cwd: "/f" });

        const word = (fact: ArchiveFacts["folders"][string]) => {
            const facts = okFacts([binding]);

            facts.folders["/f"] = fact;

            return archiveDecide([binding], facts).archive[0]?.folderWord;
        };

        assert.equal(word({ dirty: 3, ahead: undefined, gone: true }), "gone");
        assert.equal(word(null), "not git");
        assert.equal(word({ dirty: 0, ahead: 0 }), "clean");
        const bare = oneBinding();

        assert.equal(archiveDecide([bare], okFacts([bare])).archive[0]?.folderWord, "none");
    });

    test("B6: a session the desk archived and a person brought back is never archived again", () => {
        const one = thread();

        one.run.archives = {
            [String(one.session)]: { at: 1, by: "auto", key: "k", state: "done" },
        };

        const binding = bind(stateOf([one])).bindings[0]!;

        assert.equal(binding.archivedBefore, true);
        assert.equal(
            decide(binding, () => {}),
            "restored-by-person",
        );

        // The desk brought it back itself (a reopen), and the thread closed again: it may go again.
        one.run.archives = {
            [String(one.session)]: { at: 1, by: "auto", key: "k", state: "done", restored: 2 },
        };
        assert.equal(
            decide(bind(stateOf([one])).bindings[0]!, () => {}),
            "archive",
        );
    });

    test("B7: a session that is archived already gets no call and no record", () => {
        assert.equal(
            decide(oneBinding(), (facts) => {
                facts.sessions![0]!.archived = true;
            }),
            "archived",
        );
    });

    test("every rule passes: the session is archived", () => {
        const binding = oneBinding({ cwd: "/f" });

        assert.equal(
            decide(binding, () => {}),
            "archive",
        );
    });
});

describe("the archive's pending and reopen work", () => {
    test("archivesOf keeps only well-formed entries", () => {
        const one = thread({
            run: {
                archives: {
                    "1": { at: 1, by: "auto", key: "k", state: "done" },
                    "2": { at: 1, by: "someone", key: "k", state: "done" },
                    "3": "bad",
                },
            },
        });

        assert.deepEqual(Object.keys(archivesOf(one)), ["1"]);
    });

    test("a pending entry is found with its key and its address", () => {
        const one = thread();

        one.run.archives = {
            [String(one.session)]: { at: 1, by: "auto", key: "k1", state: "pending" },
        };

        const work = archivePending(stateOf([one]), SUP);

        assert.equal(work.length, 1);
        assert.equal(work[0]?.key, "k1");
        assert.equal(work[0]?.address, one.address);
    });

    test("a reopened thread's archived session comes back once, with its own key", () => {
        const one = thread({ state: "open" });
        const key = archiveKey(one.id, one.session!, 5);

        delete one.closed;
        one.run.archives = { [String(one.session)]: { at: 1, by: "auto", key, state: "done" } };

        const listed = [{ address: one.address!, archived: true }];
        const work = archiveRestores(stateOf([one]), SUP, listed);

        assert.equal(work.length, 1);
        assert.equal(work[0]?.key, unarchiveKey(key));
        assert.equal(work[0]?.key, `x.desk.unarchive:${one.id}:${String(one.session)}:5`);
        assert.deepEqual(
            archiveRestores(stateOf([one]), SUP, [{ address: one.address!, archived: false }]),
            [],
            "not archived now: nothing to bring back",
        );

        one.run.archives = {
            [String(one.session)]: { at: 1, by: "auto", key, state: "done", restored: 3 },
        };
        assert.deepEqual(archiveRestores(stateOf([one]), SUP, listed), [], "restored once");

        const closed = thread({ address: one.address });

        closed.run.archives = {
            [String(closed.session)]: { at: 1, by: "auto", key, state: "done" },
        };
        assert.deepEqual(
            archiveRestores(stateOf([closed]), SUP, [{ address: closed.address!, archived: true }]),
            [],
            "a closed thread stays archived",
        );
    });

    test("the event says what was checked", () => {
        assert.equal(
            archiveEventText(
                { kind: "delegate", closedAt: NOW - 3 * DAY, folderWord: "clean" },
                "auto",
                NOW,
            ),
            "session archived (auto): closed 3d ago; idle, no open ask, no night shift, no schedule, folder clean",
        );
        assert.equal(
            archiveEventText(
                { kind: "consult", consult: "k2", closedAt: NOW - 2 * DAY, folderWord: "none" },
                "sweep",
                NOW,
            ),
            "consult k2 session archived (sweep): closed 2d ago; idle, no open ask, no night shift, no schedule, no folder",
        );
    });
});
