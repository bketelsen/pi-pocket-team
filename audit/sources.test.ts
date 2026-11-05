// The audit's reads: Pocket's database (read-only, folded as Pi Durable folds it), the `gh` and `git` wrappers, and
// Odrade's notes. Everything runs on invented data; the process runner is a fake, so no real `gh` or `git` runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkQ1, isCrossReviewSpawn } from "./checks.mjs";
import { DAY, HOUR } from "./common.mjs";
import { NOW } from "./fixtures/builders.mjs";
import { SESSION_T1, SESSION_T2, SUPERVISOR, createFixtureDb } from "./fixtures/pocket-db.mjs";
import {
    GH_CAP,
    checkGhArgs,
    checkGitArgs,
    foldDocument,
    loadData,
    loadDesk,
    loadDecided,
    BLOCKER_LOOKUPS,
    BLOCKER_MAX_PR_QUERIES,
    BLOCKER_MAX_QUERIES,
    guardOf,
    loadBlockerGuards,
    loadGithub,
    loadGoalStops,
    loadPlanSessions,
    loadReviewAnswers,
    loadReviewCalls,
    Q1_MAX_CALLS,
    makeGh,
    makeGit,
    openPocket,
    readFlakyScan,
    readHomes,
    readOdrade,
} from "./sources.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "audit-sources-"));

/**
 * A git environment that no setting of this machine reaches: no inherited `GIT_` variable at all, then only the
 * test's own (a temporary home, config file and XDG folder with a test identity, no system config, an empty template
 * folder and no system attributes).
 */
function gitEnvironment(extraConfig = "") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-git-"));
    const home = path.join(root, "home");
    const config = path.join(root, "gitconfig");
    const template = path.join(root, "template");
    const xdg = path.join(root, "xdg");

    for (const folder of [home, template, xdg]) {
        fs.mkdirSync(folder);
    }

    fs.writeFileSync(
        config,
        `[user]\n\tname = Audit test\n\temail = audit@example.invalid\n${extraConfig}`,
    );

    // Every inherited `GIT_` variable goes, and then the test's own come in: nothing of this machine's git is used.
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.startsWith("GIT_")) {
            env[name] = value;
        }
    }

    return {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: config,
        GIT_TEMPLATE_DIR: template,
        GIT_ATTR_NOSYSTEM: "1",
    };
}

/** Real git, as a process runner, in that environment. */
const realGit =
    (env = gitEnvironment()) =>
    (command: string, args: string[]) =>
        execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });

/** A Pocket folder with the fixture database, an Odrade folder, and a recording runner for `git`. */
function setup() {
    const root = tmp();
    const pocketDir = path.join(root, "pocket");
    const odradeDir = path.join(root, "odrade");
    // No homes folder in `setup`: the homes source is 1 test of its own, below.
    const homesDir = path.join(root, "homes");

    fs.mkdirSync(pocketDir);
    fs.mkdirSync(path.join(odradeDir, "reports", "2026-10-22-a"), { recursive: true });
    fs.mkdirSync(path.join(odradeDir, "reports", "2026-10-23-daily-audit"));
    fs.writeFileSync(path.join(odradeDir, "README.md"), "see reports/2026-10-22-a");

    const times = createFixtureDb(path.join(pocketDir, "pocket.sqlite"), NOW);
    const calls: { command: string; args: string[] }[] = [];

    const run = (command: string, args: string[]) => {
        calls.push({ command, args });

        if (command === "git" && args.includes("status")) {
            return " M plans/x.md\n?? reports/2026-10-23-daily-audit/\n";
        }

        if (command === "git" && args.includes("log")) {
            return new Date(NOW - 5 * HOUR).toISOString();
        }

        throw new Error(`unexpected ${command}`);
    };

    return { root, pocketDir, odradeDir, homesDir, times, calls, run };
}

test("a document is its last base plus each delta; the event history keeps what the document dropped", () => {
    const { pocketDir } = setup();
    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const desk = loadDesk(db);
    const folded = foldDocument(db, 1);

    // The document keeps 3 events of T1 (the last delta dropped the first 2).
    assert.equal(folded.threads.T1.events.length, 3);
    assert.ok(!folded.threads.T1.events.some((event: { key: string }) => event.key === "opened"));

    // The history has all 5 events of T1, the 1 of T2 and the 1 of T3 (a thread set whole by a delta).
    const byThread = (id: string) =>
        desk.events.filter((event: { thread: string }) => event.thread === id);

    assert.deepEqual(
        byThread("T1").map((event: { key: string }) => event.key),
        ["opened", "closed:1", "reopened:1", "closed:2", "reopened:2"],
    );
    assert.equal(byThread("T2").length, 1);
    assert.equal(byThread("T3").length, 1);
    assert.deepEqual(Object.keys(desk.threads).sort(), ["T1", "T2", "T3"]);

    const times = desk.events.map((event: { at: number }) => event.at);

    assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b),
    );
    db.close();
});

test("the database handle is read-only: a write throws", () => {
    const { pocketDir } = setup();
    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));

    assert.throws(() => db.exec("delete from entries"), /readonly/i);
    assert.throws(() => db.exec("insert into documents (id) values (99)"), /readonly|constraint/i);
    assert.equal(db.prepare("select count(*) c from documents").get().c, 5);
    db.close();
});

test("loadData reads every source into one plain object", () => {
    const { pocketDir, odradeDir, homesDir, times, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.deepEqual(data.sourceErrors, {
        github: "disabled by --no-github",
        decided: "disabled by --no-github",
        blockerGuards: "disabled by --no-github",
    });
    assert.deepEqual(Object.keys(data.threads).sort(), ["T1", "T2", "T3"]);
    assert.equal(data.events.length, 7);
    assert.deepEqual(data.agentOf, { 10: "odrade" });
    // No homes folder in this fixture: the homes source is 1 test of its own.
    assert.deepEqual(data.homes, []);

    // Reports: the base one and the one that a delta added.
    assert.deepEqual(data.reports[SESSION_T1].map((report: { key: string }) => report.key).sort(), [
        "r1",
        "r2",
    ]);

    // The night shift goal.
    assert.equal(data.goals.length, 1);
    assert.equal(data.goals[0].session, SESSION_T1);
    assert.equal(data.goals[0].goal.worker, "deepseek/deepseek-flash");

    // Schedules: the one-shot's first due time comes from its document's history, though the item was deleted.
    const byId = Object.fromEntries(
        data.schedules.map((task: { scheduleId: string }) => [task.scheduleId, task]),
    );

    assert.equal(byId.abc.status, "completed");
    assert.equal(byId.abc.firstNext, times.due);
    assert.equal(byId.abc.every, false);
    assert.equal(byId.abc.endedAt, times.ranAt);
    assert.equal(byId.rec.status, "running");
    assert.equal(byId.rec.every, true);
    assert.equal(byId.rec.next, NOW + HOUR);

    // User entries of the threads' sessions and supervisors, cut short.
    assert.equal(data.userEntries[SESSION_T1].length, 1);
    assert.match(data.userEntries[SESSION_T1][0].text, /^\[via linked session session-aaa\]/);

    // Tool errors: the team tools and the plan tool only, with the desk-full refusal; a bash error is left out.
    assert.deepEqual(data.toolErrors.map((error: { tool: string }) => error.tool).sort(), [
        "plan",
        "team_delegate",
        "team_message",
    ]);
    assert.match(
        data.toolErrors.find((error: { tool: string }) => error.tool === "plan").text,
        /tasks needs rev/,
    );
    // The fixture desk has no plan thread: no planning session, and no source error.
    assert.deepEqual(data.planSessions, []);
    assert.ok(data.toolErrors.every((error: { isError: boolean }) => error.isError));

    // Cost rows from 8 days back; the row from 40 days ago is left out.
    assert.deepEqual(
        data.costRows
            .map((row: { cost: number }) => row.cost)
            .sort((a: number, b: number) => a - b),
        [0.75, 1.25, 2],
    );

    // Spawn calls with the model each one named.
    assert.deepEqual(
        data.spawns.map((spawn: { c: number; model: string }) => [spawn.c, spawn.model]),
        [
            [SUPERVISOR, "other/model"],
            [SUPERVISOR, "other/model"],
        ],
    );
    // The name, tools and the start of the brief are read too.
    assert.equal(data.spawns[0].name, "w");
    assert.deepEqual(data.spawns[0].tools, ["read", "bash"]);
    assert.equal(data.spawns[0].brief, "do");
    assert.equal(data.spawns[0].review, false);
    // "review" after character 300 is not in the brief, but the flag has it.
    assert.equal(data.spawns[1].brief.length, 300);
    assert.equal(data.spawns[1].review, true);
    assert.equal(isCrossReviewSpawn(data.spawns[1]), true);

    // No extensions folder: no install times.
    assert.deepEqual(data.installed, { "desk.ts": null, "team.ts": null, "night-shift.ts": null });
    assert.deepEqual(data.githubCalls, { calls: 0, capReached: false });
});

test("the routes source reads a routed thread's session with no time limit", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    // T1 carries the router's record, and its session is 11.
    assert.equal(data.threads.T1.route.kind, "implement");

    // The 8-day window leaves the 20-day-old row out; R1's own read keeps it, and takes no other session.
    assert.deepEqual(
        data.costRows
            .map((row: { cost: number }) => row.cost)
            .sort((a: number, b: number) => a - b),
        [0.75, 1.25, 2],
    );
    assert.deepEqual(
        data.routeCosts
            .map((row: { c: number; cost: number }) => [row.c, row.cost])
            .sort((a: number[], b: number[]) => a[1]! - b[1]!),
        [
            [SESSION_T1, 0.5],
            [SESSION_T1, 0.75],
            [SESSION_T1, 1.25],
        ],
    );
    // The supervisor's spend is not a routed thread's: it is not here.
    assert.ok(data.routeCosts.every((row: { c: number }) => row.c === SESSION_T1));

    assert.deepEqual(
        data.spawns.map((spawn: { c: number; model: string }) => [spawn.c, spawn.model]),
        [
            [SUPERVISOR, "other/model"],
            [SUPERVISOR, "other/model"],
        ],
    );
    assert.deepEqual(
        data.routeSpawns.map((spawn: { c: number; model: string }) => [spawn.c, spawn.model]),
        [[SESSION_T1, "old/model"]],
        "the spawn from 20 days back is loaded",
    );
});

/**
 * The fixture database with a plan thread T4 (planning session 13) added by a desk delta, and entries of session 13:
 * 3 `plan` results (2 refused, 1 with a targeted text), 1 `plan` result before the window, 2 tool calls that read the
 * source, 1 `read` of another file, and a `plan`, a `desk` and a `team_message` call that name the source. Session
 * 12 (T2, no plan thread) gets a `plan` refusal and a source read too.
 */
function setupPlan() {
    const base = setup();
    const db = new DatabaseSync(path.join(base.pocketDir, "pocket.sqlite"));
    const seq = db.prepare("select max(seq) s from document_revisions").get().s + 1;

    db.prepare(
        "insert into document_revisions (document_id, seq, kind, version, content) values (1, ?, 'delta', 1, ?)",
    ).run(
        seq,
        JSON.stringify([
            [
                "s",
                ["threads", "T4"],
                {
                    id: "T4",
                    origin: "plan",
                    state: "open",
                    supervisor: SUPERVISOR,
                    session: 13,
                    startedAt: NOW - 5 * HOUR,
                    lastEventAt: NOW - HOUR,
                    prs: {},
                    asks: [],
                    run: {},
                    events: [],
                },
            ],
        ]),
    );

    let id = db.prepare("select max(id) i from entries").get().i;

    const entry = (conversation: number, record: object) => {
        id += 1;
        db.prepare(
            "insert into entries (id, conversation_id, head, commit_seq, record) values (?,?,?,?,?)",
        ).run(id, conversation, null, id, JSON.stringify(record));
    };

    const result = (conversation: number, at: number, text: string, isError: boolean) =>
        entry(conversation, {
            kind: "pi.tool-result",
            model: [
                {
                    role: "toolResult",
                    toolName: "plan",
                    isError,
                    content: [{ type: "text", text }],
                    timestamp: at,
                },
            ],
        });
    const calls = (conversation: number, at: number, parts: object[]) =>
        entry(conversation, {
            kind: "pi.assistant",
            model: [{ role: "assistant", content: parts, timestamp: at }],
        });

    result(13, NOW - 4 * HOUR, "Plan T4: rev abc", false);
    result(
        13,
        NOW - 3 * HOUR,
        "[error] Plan T4 has no draft graph for rev abc1234: call plan tasks first.",
        true,
    );
    result(13, NOW - 2 * HOUR, "[error] Each option is 1 to 40 characters, on one line.", true);
    result(13, NOW - 30 * HOUR, "[error] tasks needs rev: before the window.", true);
    calls(13, NOW - 2 * HOUR, [
        {
            type: "toolCall",
            id: "a",
            name: "bash",
            arguments: { command: "grep -n plan ~/pi-pocket-team/desk.ts" },
        },
        {
            type: "toolCall",
            id: "b",
            name: "read",
            arguments: { path: "/x/pi-pocket/src/server/memory.ts" },
        },
        { type: "toolCall", id: "c", name: "read", arguments: { path: "/x/README.md" } },
        { type: "text", text: "desk.ts in plain text is no tool call" },
        // A plan write, a desk call and a report that name the source write about it: no source read.
        {
            type: "toolCall",
            id: "e",
            name: "plan",
            arguments: { action: "write", text: "Change desk.ts and pi-pocket/src/server." },
        },
        { type: "toolCall", id: "f", name: "desk", arguments: { action: "ask", text: "desk.ts?" } },
        { type: "toolCall", id: "g", name: "team_message", arguments: { message: "read desk.ts" } },
    ]);
    result(12, NOW - 2 * HOUR, "[error] tasks needs rev: in a session that plans nothing.", true);
    calls(12, NOW - 2 * HOUR, [
        { type: "toolCall", id: "d", name: "bash", arguments: { command: "cat desk.ts" } },
    ]);
    db.close();

    return base;
}

test("planning sessions: the plan results and source reads of a plan thread's session, in the window", () => {
    const { pocketDir, odradeDir, homesDir, run } = setupPlan();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.equal(data.sourceErrors.planSessions, undefined);
    assert.equal(data.threads.T4.origin, "plan");
    // Only T4's session: T2's session 12 is no planning session, though it has a plan refusal and a source read.
    assert.deepEqual(
        data.planSessions.map((item: { thread: string; session: number }) => [
            item.thread,
            item.session,
        ]),
        [["T4", 13]],
    );

    const [t4] = data.planSessions;

    // The result from 30 h back is outside the window.
    assert.deepEqual(
        t4.results.map((item: { isError: boolean }) => item.isError),
        [false, true, true],
    );
    assert.equal(t4.results[0].text, "");
    assert.match(t4.results[1].text, /no draft graph for rev/);
    assert.deepEqual(
        t4.sourceReads.map((read: { tool: string }) => read.tool),
        ["bash", "read"],
    );
    // No argument text is kept.
    assert.deepEqual(Object.keys(t4.sourceReads[0]).sort(), ["at", "id", "tool"]);
    // Only the bash and read calls count: the plan write, the desk call and the report that name desk.ts do not.
    assert.ok(
        t4.sourceReads.every((read: { tool: string }) => ["bash", "read"].includes(read.tool)),
    );
});

test("planning sessions: loadPlanSessions skips a plan thread with no session, and a session with nothing in the window", () => {
    const { pocketDir } = setupPlan();
    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const threads = {
        T4: { id: "T4", origin: "plan", session: 13 },
        T5: { id: "T5", origin: "plan" },
        T6: { id: "T6", origin: "plan", session: SESSION_T1 },
        T7: { id: "T7", origin: "delegate", session: SESSION_T2 },
    };

    assert.deepEqual(
        loadPlanSessions(db, threads, NOW - 24 * HOUR).map(
            (item: { thread: string }) => item.thread,
        ),
        ["T4"],
    );
    // From 2 h back, only the second refusal and the source reads remain.
    const [late] = loadPlanSessions(db, threads, NOW - 2 * HOUR);

    assert.equal(late.results.length, 1);
    assert.equal(late.sourceReads.length, 2);
    db.close();
});

test("planning sessions: without the desk, the source is unknown, not empty", () => {
    const { pocketDir, odradeDir, homesDir, run } = setupPlan();
    const db = new DatabaseSync(path.join(pocketDir, "pocket.sqlite"));

    db.exec("delete from documents where kind='\"x.desk.threads\"'");
    db.close();

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.equal(data.sourceErrors.planSessions, "needs the desk threads");
});

test("loadData reads the install time of a live module", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();

    fs.mkdirSync(path.join(pocketDir, "extensions"));
    fs.writeFileSync(path.join(pocketDir, "extensions", "desk.ts"), "// x");

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.ok(data.installed["desk.ts"] > 0);
    assert.equal(data.installed["team.ts"], null);
});

test("loadData reads Odrade's notes through the read-only git wrapper", () => {
    const { pocketDir, odradeDir, homesDir, calls, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.deepEqual(data.odrade.reports.sort(), ["2026-10-22-a", "2026-10-23-daily-audit"]);
    assert.equal(data.odrade.readme, "see reports/2026-10-22-a");
    assert.deepEqual(data.odrade.dirty, [" M plans/x.md", "?? reports/2026-10-23-daily-audit/"]);
    assert.equal(data.odrade.lastCommitAt, NOW - 5 * HOUR);

    // Only git, only log and status, always with the locks off, no hook, no fsmonitor, and in Odrade's folder.
    const safe = [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
    ];

    assert.deepEqual(
        calls.map((call) => [call.command, ...call.args]),
        [
            ["git", ...safe, "-C", odradeDir, "status", "--porcelain"],
            ["git", ...safe, "-C", odradeDir, "log", "-1", "--format=%cI"],
        ],
    );
});

test("a missing source is reported by name and does not stop the load", () => {
    const root = tmp();
    const none = loadData({
        pocketDir: path.join(root, "nowhere"),
        odradeDir: path.join(root, "nowhere"),
        homesDir: path.join(root, "nowhere"),
        now: NOW,
        hours: 24,
        useGithub: false,
        run: () => "",
    });

    assert.ok(none.sourceErrors.desk);
    assert.ok(none.sourceErrors.entries);
    assert.ok(none.sourceErrors.costs);
    assert.ok(none.sourceErrors.odrade);
    assert.deepEqual(none.threads, {});
});

test("a database with no desk document skips the desk only", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();
    const db = new DatabaseSync(path.join(pocketDir, "pocket.sqlite"));

    db.exec("delete from documents where kind='\"x.desk.threads\"'");
    db.close();

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.equal(data.sourceErrors.desk, "no x.desk.threads document");
    assert.equal(data.sourceErrors.costs, undefined);
    assert.equal(data.costRows.length, 3);
});

// ---------- gh ----------

test("gh wrapper: it allows only GET api calls, graphql queries and `gh search prs`", () => {
    assert.doesNotThrow(() =>
        checkGhArgs(["api", "repos/acme/widgets/commits/abc/check-runs?per_page=100"]),
    );
    assert.doesNotThrow(() =>
        checkGhArgs(["api", "repos/acme/widgets", "--jq", ".delete_branch_on_merge"]),
    );
    assert.doesNotThrow(() => checkGhArgs(["api", "graphql", "-f", "query={ viewer { login } }"]));
    assert.doesNotThrow(() =>
        checkGhArgs([
            "search",
            "prs",
            "--author",
            "bot",
            "--created",
            ">=2026-10-23",
            "--limit",
            "300",
            "--json",
            "number",
        ]),
    );
});

test("gh wrapper: it refuses mutation, -X, --method, -f outside graphql and other subcommands", () => {
    const refused = [
        ["api", "graphql", "-f", "query=mutation { addStar(input: {}) { clientMutationId } }"],
        ["api", "graphql", "-f", "query=MUTATION { x }"],
        ["api", "repos/acme/widgets", "-X", "DELETE"],
        ["api", "repos/acme/widgets", "-XPATCH"],
        ["api", "repos/acme/widgets", "--method", "POST"],
        ["api", "repos/acme/widgets", "--method=POST"],
        ["api", "repos/acme/widgets/issues", "-f", "title=x"],
        ["api", "repos/acme/widgets/issues", "-F", "title=x"],
        ["api", "repos/acme/widgets/issues", "--field", "title=x"],
        ["api", "repos/acme/widgets", "--input", "-"],
        ["api"],
        ["pr", "merge", "1"],
        ["pr", "list"],
        ["issue", "create"],
        ["repo", "delete", "acme/widgets"],
        ["auth", "token"],
        ["search", "issues", "x"],
        ["search", "prs", "mutation"],
    ];

    for (const args of refused) {
        assert.throws(() => checkGhArgs(args), /gh:/, args.join(" "));
    }
});

test("gh wrapper: a refused call never reaches the runner", () => {
    const calls: string[][] = [];
    const gh = makeGh((_, args) => {
        calls.push(args);

        return "{}";
    });

    assert.throws(() => gh.call(["pr", "merge", "1"]));
    assert.throws(() => gh.api("repos/a/b", ["-X", "DELETE"]));
    assert.throws(() => gh.graphql("mutation { x }"));
    assert.equal(calls.length, 0);
    assert.equal(gh.state.calls, 0);
});

test("gh wrapper: it stops at 40 calls, returns nothing after that and says so", () => {
    const calls: string[][] = [];
    const gh = makeGh((_, args) => {
        calls.push(args);

        return "x";
    });

    assert.equal(GH_CAP, 40);

    for (let i = 0; i < 40; i += 1) {
        assert.equal(gh.api(`repos/a/b${i}`), "x");
    }

    assert.equal(gh.state.capReached, false);
    assert.equal(gh.api("repos/a/b41"), "");
    assert.equal(gh.searchPrs(["--author", "x"]), "");
    assert.equal(calls.length, 40);
    assert.equal(gh.state.calls, 40);
    assert.equal(gh.state.capReached, true);
});

test("gh wrapper: a failing call returns its stdout and counts the failure", () => {
    const gh = makeGh(() => {
        throw Object.assign(new Error("exit 1"), { stdout: '{"message":"Not Found"}' });
    });

    assert.equal(gh.api("repos/a/b"), '{"message":"Not Found"}');
    assert.equal(gh.state.failures, 1);
});

// ---------- git ----------

test("git wrapper: only log, status and show", () => {
    for (const args of [
        ["log", "-1"],
        ["status", "--porcelain"],
        ["show", "HEAD"],
    ]) {
        assert.doesNotThrow(() => checkGitArgs(args));
    }

    for (const args of [
        ["commit", "-m", "x"],
        ["push"],
        ["checkout", "main"],
        ["reset", "--hard"],
        ["add", "."],
        ["config", "user.name", "x"],
        ["log", "--output=/tmp/x"],
        ["log", "--ext-diff"],
        [],
    ]) {
        assert.throws(() => checkGitArgs(args), /git:/, args.join(" "));
    }
});

test("git wrapper: a refused call never reaches the runner; an allowed one turns the locks off", () => {
    const calls: string[][] = [];
    const git = makeGit((_, args) => {
        calls.push(args);

        return "ok";
    });

    assert.throws(() => git.call("/x", ["push"]));
    assert.equal(calls.length, 0);
    assert.equal(git.call("/x", ["status", "--porcelain"]), "ok");
    assert.deepEqual(calls[0], [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        "/x",
        "status",
        "--porcelain",
    ]);
});

test("readOdrade reads the index, the reports, the dirty files and the last commit", () => {
    const { odradeDir, run } = setup();
    const notes = readOdrade(odradeDir, makeGit(run));

    assert.equal(notes.reports.length, 2);
    assert.equal(notes.dirty.length, 2);
    assert.equal(notes.lastCommitAt, NOW - 5 * HOUR);
});

// ---------- The agents' homes ----------

test("readHomes reads each git folder with its dirty lines and last commit, and leaves Odrade's out", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const odradeDir = path.join(homesDir, "odrade");
    const irulan = path.join(homesDir, "irulan");
    const moneo = path.join(homesDir, "moneo");

    // 3 git folders: Odrade's, Irulan's and Moneo's. 1 folder that is no home, and 1 hidden folder.
    for (const folder of [odradeDir, irulan, moneo, path.join(homesDir, "notes")]) {
        fs.mkdirSync(folder, { recursive: true });
    }

    for (const folder of [odradeDir, irulan, moneo, path.join(homesDir, ".cache")]) {
        fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    }

    // Odrade's folder, reached through a link, is still Odrade's folder: the real path decides.
    fs.symlinkSync(odradeDir, path.join(homesDir, "desk"));

    const calls: string[][] = [];

    const run = (_: string, args: string[]) => {
        calls.push(args);

        if (args.includes(irulan) && args.includes("status")) {
            return " M notes/x.md\n?? plans/y.md\n";
        }

        if (args.includes("status")) {
            return "";
        }

        if (args.includes("log")) {
            return new Date(args.includes(irulan) ? NOW - 30 * HOUR : NOW - HOUR).toISOString();
        }

        throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const homes = readHomes(homesDir, makeGit(run), { exclude: [odradeDir] });

    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["irulan", "moneo"],
    );
    assert.equal(homes[0].folder, irulan);
    assert.deepEqual(homes[0].dirty, [" M notes/x.md", "?? plans/y.md"]);
    assert.equal(homes[0].lastCommitAt, NOW - 30 * HOUR);
    assert.deepEqual(homes[1].dirty, []);
    assert.equal(homes[1].lastCommitAt, NOW - HOUR);

    // git ran in the 2 homes only: never in Odrade's folder, the link, the plain folder or the hidden one.
    assert.deepEqual(
        calls.map((args) => args[args.indexOf("-C") + 1]),
        [irulan, irulan, moneo, moneo],
    );
});

test("readHomes: an empty git init folder is 1 home with no last commit, and its status still counts", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const folder = path.join(homesDir, "irulan");

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "AGENTS.md"), "# Irulan's home\n");
    // A repository with no commit: `git log` fails there.
    const run = realGit();

    run("git", ["-C", folder, "init", "-b", "main"]);

    const homes = readHomes(homesDir, makeGit(run));

    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["irulan"],
    );
    assert.deepEqual(homes[0].dirty, ["?? AGENTS.md"]);
    assert.equal(homes[0].lastCommitAt, null);
});

test("readHomes: 1 home whose git fails does not fail the source; 1 whose status fails is left out", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const empty = path.join(homesDir, "irulan");
    const broken = path.join(homesDir, "moneo");

    for (const folder of [empty, broken]) {
        fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    }

    const run = (_: string, args: string[]) => {
        if (args.includes(broken)) {
            throw new Error("fatal: not a git repository");
        }

        if (args.includes("status")) {
            return " M notes/x.md\n";
        }

        throw new Error("fatal: your current branch 'main' does not have any commits yet");
    };

    const homes = readHomes(homesDir, makeGit(run));

    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["irulan"],
    );
    assert.deepEqual(homes[0].dirty, [" M notes/x.md"]);
    assert.equal(homes[0].lastCommitAt, null);
});

test("readHomes: a core.fsmonitor script is never run", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const folder = path.join(homesDir, "irulan");
    const marker = path.join(root, "fsmonitor-ran");
    const script = path.join(root, "fsmonitor.sh");
    const run = realGit();

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "AGENTS.md"), "# Irulan's home\n");
    run("git", ["-C", folder, "init", "-b", "main"]);
    run("git", ["-C", folder, "add", "-A"]);
    run("git", ["-C", folder, "commit", "-m", "home"]);

    // A filesystem monitor that writes a marker: `git status` runs it, if the audit lets it.
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    run("git", ["-C", folder, "config", "core.fsmonitor", script]);

    // It does run for a plain `git status`, so the test above means something.
    execFileSync("git", ["-C", folder, "status"], { encoding: "utf8", env: gitEnvironment() });
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker);

    const homes = readHomes(homesDir, makeGit(run));

    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["irulan"],
    );
});

test("readHomes: a GIT_CONFIG of the environment stays unchanged, and the repository's fsmonitor never runs", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const folder = path.join(homesDir, "irulan");
    const marker = path.join(root, "fsmonitor-ran");
    const script = path.join(root, "fsmonitor.sh");
    const file = path.join(root, "external-config");
    const content = "[core]\n\tquotePath = false\n";
    const run = realGit();

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "AGENTS.md"), "# Irulan's home\n");
    run("git", ["-C", folder, "init", "-b", "main"]);
    run("git", ["-C", folder, "add", "-A"]);
    run("git", ["-C", folder, "commit", "-m", "home"]);

    // The repository's own config names a filesystem monitor that writes a marker.
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    run("git", ["-C", folder, "config", "core.fsmonitor", script]);
    fs.writeFileSync(file, content);

    // The external config file, named by `GIT_CONFIG`: the audit reads, and must write nothing there.
    const env = { ...gitEnvironment(), GIT_CONFIG: file };
    const runWithConfig = realGit(env);

    // It runs for a plain `git status`, so the assertion below means something.
    runWithConfig("git", ["-C", folder, "status"]);
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker);

    const homes = readHomes(homesDir, makeGit(runWithConfig));

    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["irulan"],
    );
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
});

test("readHomes: a symlink loop beside a healthy home is skipped, and the healthy home is read", () => {
    const root = tmp();
    const homesDir = path.join(root, "agents");
    const healthy = path.join(homesDir, "moneo");

    fs.mkdirSync(path.join(healthy, ".git"), { recursive: true });
    // A link that points at itself: `stat` fails there, and 1 such entry must not stop the source.
    fs.symlinkSync("loop", path.join(homesDir, "loop"));

    const run = (_: string, args: string[]) => {
        if (args.includes("status")) {
            return "";
        }

        return new Date(NOW - HOUR).toISOString();
    };

    const homes = readHomes(homesDir, makeGit(run));

    assert.deepEqual(
        homes.map((home: { id: string }) => home.id),
        ["moneo"],
    );
    assert.equal(homes[0].lastCommitAt, NOW - HOUR);
});

test("a missing homes folder gives an empty list, not a source error", () => {
    const root = tmp();
    const homes = readHomes(
        path.join(root, "nowhere"),
        makeGit(() => ""),
    );

    assert.deepEqual(homes, []);

    const { pocketDir, odradeDir, homesDir, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.deepEqual(data.homes, []);
    assert.equal(data.sourceErrors.homes, undefined);
    // The checks that need the homes still run, on no homes.
    assert.deepEqual(data.sourceErrors, {
        github: "disabled by --no-github",
        decided: "disabled by --no-github",
        blockerGuards: "disabled by --no-github",
    });
});

// ---------- GitHub data ----------

/** A fake `gh`: a search, one GraphQL answer, check runs, and a repository setting. */
function fakeGh(refs: string[]) {
    const seen: string[][] = [];

    const run = (_: string, args: string[]) => {
        seen.push(args);

        if (args[0] === "search") {
            return JSON.stringify(
                refs.map((ref) => ({
                    repository: { nameWithOwner: ref.split("#")[0] },
                    number: Number(ref.split("#")[1]),
                })),
            );
        }

        if (args[1] === "graphql") {
            const query = args.find((arg) => arg.startsWith("query=")) ?? "";
            const count = (query.match(/\bp\d+: repository/g) ?? []).length;
            const data: Record<string, unknown> = {};

            for (let i = 0; i < count; i += 1) {
                data[`p${i}`] = {
                    pullRequest: {
                        state: "MERGED",
                        mergedAt: new Date(NOW - 3 * HOUR).toISOString(),
                        headRef: { name: "b" },
                        commits: { nodes: [] },
                    },
                };
            }

            return JSON.stringify({ data });
        }

        if (args[1].includes("check-runs")) {
            return JSON.stringify({ check_runs: [{ name: "Build", conclusion: "failure" }] });
        }

        return "false\n";
    };

    return { seen, run };
}

test("loadGithub: 1 search, 1 query per 40 PRs, check runs of each repair, 1 setting per repository", () => {
    const refs = Array.from({ length: 45 }, (_, i) => `acme/w${i % 3}#${i + 1}`);
    const fake = fakeGh(refs);
    const gh = makeGh(fake.run);
    const t1 = {
        id: "T1",
        state: "open",
        prs: { "acme/w0#900": { via: "seen" } },
        asks: [],
        run: {
            repairs: {
                "repair:acme/w0#900:abc123:FAILURE": { at: NOW - HOUR, to: "agent", sent: true },
            },
        },
    };
    const result = loadGithub({ threads: { T1: t1 } }, { gh, now: NOW, since: NOW - 24 * HOUR });

    assert.ok(
        fake.seen.some(
            (args) =>
                args[1] ===
                "repos/acme/w0/commits/abc123/check-runs?per_page=100&filter=all&page=1",
        ),
    );
    assert.equal(result.botPrs.length, 45);
    // 45 bot PRs + 1 attached PR = 46 refs: 2 GraphQL queries.
    assert.equal(Object.keys(result.prs).length, 46);
    assert.equal(fake.seen.filter((args) => args[1] === "graphql").length, 2);
    assert.ok(
        fake.seen.some(
            (args) =>
                args[1] === "graphql" &&
                (args.find((arg) => arg.startsWith("query=")) ?? "").includes("headRefOid"),
        ),
    );
    assert.deepEqual(result.checkRuns["acme/w0@abc123"], [
        { name: "Build", conclusion: "failure" },
    ]);
    assert.deepEqual(Object.keys(result.autoDelete).sort(), ["acme/w0", "acme/w1", "acme/w2"]);
    assert.equal(result.autoDelete["acme/w0"], false);
    // 1 search + 2 graphql + 1 check run + 3 settings.
    assert.equal(gh.state.calls, 7);
    assert.ok(fake.seen.every((args) => !args.includes("-X") && !args.includes("--method")));
});

/** A `gh` fake that serves the check runs of 1 commit in pages; `total` is what `total_count` says. */
function pagedRuns(count: number, total = count) {
    const pages: string[] = [];

    const run = (_: string, args: string[]) => {
        const url = args[1] ?? "";

        if (url.includes("check-runs")) {
            const page = Number(/[&?]page=(\d+)/.exec(url)?.[1]);

            pages.push(url);

            const from = (page - 1) * 100;
            const runs = Array.from(
                { length: Math.max(0, Math.min(100, count - from)) },
                (_, i) => ({
                    name: `n${from + i}`,
                    conclusion: from + i === 100 ? "failure" : "success",
                }),
            );

            return JSON.stringify({ total_count: total, check_runs: runs });
        }

        return args[0] === "search" ? "[]" : "{}";
    };

    return { pages, run };
}

const repairOf = {
    T1: {
        id: "T1",
        state: "open",
        prs: {},
        asks: [],
        run: {
            repairs: { "repair:acme/w0#900:abc123:FAILURE": { at: NOW - HOUR, to: "agent" } },
        },
    },
};

test("loadGithub: check runs are read page by page; the run on page 2 is kept", () => {
    const fake = pagedRuns(101);
    const result = loadGithub(
        { threads: repairOf },
        { gh: makeGh(fake.run), now: NOW, since: NOW - 24 * HOUR },
    );
    const runs = result.checkRuns["acme/w0@abc123"];

    assert.equal(fake.pages.length, 2);
    assert.match(fake.pages[1]!, /per_page=100&filter=all&page=2$/);
    assert.equal(runs.length, 101);
    assert.equal(runs[100].conclusion, "failure");
});

test("loadGithub: with more runs than 5 pages hold, the commit's check runs are null", () => {
    const fake = pagedRuns(600);
    const result = loadGithub(
        { threads: repairOf },
        { gh: makeGh(fake.run), now: NOW, since: NOW - 24 * HOUR },
    );

    assert.equal(fake.pages.length, 5);
    assert.equal(result.checkRuns["acme/w0@abc123"], null);
});

test("loadGithub: when gh gives nothing, the load fails and the source is reported", () => {
    const { pocketDir, odradeDir, homesDir } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: true,
        run: (command, args) => {
            if (command === "gh") {
                throw new Error("not signed in");
            }

            return args.includes("log") ? new Date(NOW).toISOString() : "";
        },
    });

    assert.match(data.sourceErrors.github, /gh failed or is not signed in/);
    assert.equal(data.github, undefined);
});

test("loadData notes when the GitHub call cap was reached", () => {
    const { pocketDir, odradeDir, homesDir } = setup();
    const refs = Array.from({ length: 2000 }, (_, i) => `acme/w${i}#1`);
    const fake = fakeGh(refs);
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: true,
        run: (command, args) =>
            command === "gh"
                ? fake.run(command, args)
                : args.includes("log")
                  ? new Date(NOW).toISOString()
                  : "",
    });

    assert.equal(data.githubCalls.calls, 40);
    assert.equal(data.githubCalls.capReached, true);
    assert.equal(data.githubCalls.note, "GitHub call cap reached");
});

// ---------- Q1: decided PRs ----------

/** A decided PR as the search gives it. */
const searchNode = (repo: string, number: number, merged = true) => ({
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    body: "",
    mergedAt: merged ? new Date(NOW - HOUR).toISOString() : null,
    closedAt: new Date(NOW - HOUR).toISOString(),
    author: { login: "frostyard-machines" },
    repository: { nameWithOwner: repo },
});

/**
 * A fake `gh` that serves Q1's search in `pages` pages of 1 node each; page `n` answers `after: "c<n-1>"`. Every call
 * goes through `makeGh`, so its read-only check runs.
 */
function fakeSearch(pages: number, issueCount = pages) {
    const queries: string[] = [];

    const run = (_: string, args: string[]) => {
        const query = (args.find((arg) => arg.startsWith("query=")) ?? "").slice("query=".length);

        queries.push(query);

        const after = /after: "c(\d+)"/.exec(query);
        const page = after ? Number(after[1]) + 1 : 1;

        return JSON.stringify({
            data: {
                search: {
                    issueCount,
                    pageInfo: { hasNextPage: page < pages, endCursor: `c${page}` },
                    nodes: [searchNode("acme/w", page, page % 2 === 1)],
                },
            },
        });
    };

    return { queries, run };
}

/** A desk with 2 owners: `acme` (a thread's repository, in a closed thread) and `beta` (an attached PR). */
const decidedDesk = {
    threads: {
        T1: { id: "T1", state: "closed", repo: "acme/w", prs: {} },
        T2: { id: "T2", state: "open", prs: { "beta/x#4": {} } },
    },
    github: { botPrs: ["acme/z#1"] },
};

test("loadDecided: 1 search with the owners, is:closed and the window in +00:00; pages follow endCursor", () => {
    const fake = fakeSearch(2);
    const gh = makeGh(fake.run);
    const result = loadDecided(decidedDesk, { gh, now: NOW, since: NOW - 24 * HOUR });

    assert.equal(fake.queries.length, 2);
    assert.equal(result.calls, 2);
    assert.equal(result.complete, true);
    assert.equal(result.reason, undefined);
    assert.deepEqual(
        result.nodes.map((node: { number: number }) => node.number),
        [1, 2],
    );
    // The search text: 1 hour before `since` (the index lags) to now, with no milliseconds.
    const text =
        "is:pr is:closed closed:2026-10-22T13:00:00+00:00..2026-10-23T14:00:00+00:00 user:acme user:beta";

    assert.ok(
        fake.queries[0]!.includes(
            `search(query: ${JSON.stringify(text)}, type: ISSUE, first: 100)`,
        ),
    );
    assert.ok(fake.queries[1]!.includes(`first: 100, after: "c1")`));
    assert.match(fake.queries[0]!, /issueCount pageInfo \{ hasNextPage endCursor \}/);
    assert.match(
        fake.queries[0]!,
        /mergedAt closedAt author \{ login \} repository \{ nameWithOwner \}/,
    );
    assert.equal(result.from, new Date(NOW - 25 * HOUR).toISOString());
    assert.equal(result.until, new Date(NOW).toISOString());
});

test("loadDecided: 5 pages give exactly 4 calls and an incomplete result", () => {
    const fake = fakeSearch(5);
    const gh = makeGh(fake.run);
    const result = loadDecided(decidedDesk, { gh, now: NOW, since: NOW - 24 * HOUR });

    assert.equal(Q1_MAX_CALLS, 4);
    assert.equal(fake.queries.length, 4);
    assert.equal(gh.state.calls, 4);
    assert.equal(result.calls, 4);
    assert.equal(result.complete, false);
    assert.match(result.reason!, /more than 4 calls/);
});

test("loadDecided: more than 1000 results, no data, or no owners give an incomplete result", () => {
    const many = loadDecided(decidedDesk, {
        gh: makeGh(fakeSearch(1, 1001).run),
        now: NOW,
        since: NOW - 24 * HOUR,
    });

    assert.equal(many.complete, false);
    assert.match(many.reason!, /more than 1000 results/);

    const broken = loadDecided(decidedDesk, {
        gh: makeGh(() => "{}"),
        now: NOW,
        since: NOW - 24 * HOUR,
    });

    assert.equal(broken.complete, false);
    assert.equal(broken.reason, "a search returned no data");
    assert.equal(broken.calls, 1);

    const calls: string[][] = [];
    const none = loadDecided(
        { threads: {} },
        {
            gh: makeGh((_, args) => (calls.push(args), "")),
            now: NOW,
            since: NOW - 24 * HOUR,
        },
    );

    assert.equal(none.complete, false);
    assert.equal(none.calls, 0);
    assert.equal(calls.length, 0);
});

test("loadDecided: more than 4 owners make groups of 4 that share the 4 calls; the cap stops it", () => {
    const threads = Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((owner, i) => [
            `T${i}`,
            { id: `T${i}`, state: "open", repo: `${owner}/r`, prs: {} },
        ]),
    );
    const fake = fakeSearch(1);
    const result = loadDecided({ threads }, { gh: makeGh(fake.run), now: NOW, since: NOW - HOUR });

    assert.equal(fake.queries.length, 2);
    assert.ok(fake.queries[0]!.includes('user:a user:b user:c user:d", type'));
    assert.ok(fake.queries[1]!.includes('+00:00 user:e", type'));
    assert.equal(result.complete, true);

    // The run's 40 calls are spent: Q1 makes none, and says why.
    const gh = makeGh(fake.run, 0);
    const capped = loadDecided({ threads }, { gh, now: NOW, since: NOW - HOUR });

    assert.equal(capped.complete, false);
    assert.equal(capped.reason, "GitHub call cap reached");
    assert.equal(capped.calls, 0);
});

test("loadData: Q1's search comes after loadGithub with the same gh, and its calls count in the total", () => {
    const { pocketDir, odradeDir, homesDir } = setup();
    const order: string[] = [];
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: true,
        run: (command, args) => {
            if (command !== "gh") {
                return args.includes("log") ? new Date(NOW).toISOString() : "";
            }

            checkGhArgs(args);

            if (args[0] === "search") {
                order.push("search prs");

                return JSON.stringify([
                    { repository: { nameWithOwner: "acme/w" }, number: 1, url: "u" },
                ]);
            }

            const query = args.find((arg) => arg.startsWith("query=")) ?? "";

            if (query.includes("search(")) {
                order.push("q1");

                return JSON.stringify({
                    data: {
                        search: {
                            issueCount: 1,
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [searchNode("acme/w", 1)],
                        },
                    },
                });
            }

            order.push("graphql");

            return JSON.stringify({ data: { p0: { pullRequest: null } } });
        },
    });

    assert.deepEqual(order, ["search prs", "graphql", "q1"]);
    assert.equal(data.sourceErrors.decided, undefined);
    assert.equal(data.decided.complete, true);
    assert.equal(data.decided.calls, 1);
    assert.equal(data.githubCalls.calls, 3);
});

test("loadData: without the desk, Q1 has a source error and makes no call", () => {
    const { pocketDir, odradeDir, homesDir } = setup();
    const db = new DatabaseSync(path.join(pocketDir, "pocket.sqlite"));

    db.exec("delete from documents where kind='\"x.desk.threads\"'");
    db.close();

    const calls: string[][] = [];
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: true,
        run: (command, args) => {
            if (command === "gh") {
                calls.push(args);
            }

            return args.includes("log") ? new Date(NOW).toISOString() : "";
        },
    });

    assert.equal(data.sourceErrors.decided, "needs the desk threads");
    assert.equal(data.decided, undefined);
    assert.equal(calls.length, 0);
});

/** Q1 on 1 page that `answer` gives, through `makeGh`. */
const decidedFrom = (answer: (args: string[]) => string) =>
    loadDecided(decidedDesk, {
        gh: makeGh((_, args) => answer(args)),
        now: NOW,
        since: NOW - 24 * HOUR,
    });

/** 1 search page: `over` replaces parts of it. */
const searchPage = (over: Record<string, unknown> = {}) => ({
    data: {
        search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: "c1" },
            nodes: [searchNode("acme/w", 1)],
            ...over,
        },
    },
});

test("loadDecided: a good page is complete", () => {
    const result = decidedFrom(() => JSON.stringify(searchPage()));

    assert.equal(result.complete, true);
    assert.equal(result.reason, undefined);
    assert.equal(result.nodes.length, 1);
});

test("loadDecided: a partial or doubtful answer is never complete", () => {
    const { closedAt: _closedAt, ...noClosedAt } = searchNode("acme/w", 2);
    const cases: [string, (args: string[]) => string, RegExp][] = [
        [
            "data with errors",
            () => JSON.stringify({ ...searchPage(), errors: [{ message: "timeout" }] }),
            /returned errors/,
        ],
        [
            "a null node",
            () => JSON.stringify(searchPage({ nodes: [searchNode("acme/w", 1), null] })),
            /not a whole PR/,
        ],
        [
            "a node without closedAt",
            () => JSON.stringify(searchPage({ nodes: [noClosedAt] })),
            /not a whole PR/,
        ],
        [
            "a node without its repository",
            () =>
                JSON.stringify(
                    searchPage({ nodes: [{ ...searchNode("acme/w", 3), repository: null }] }),
                ),
            /not a whole PR/,
        ],
        [
            "pageInfo missing",
            () => JSON.stringify(searchPage({ pageInfo: undefined })),
            /page info/,
        ],
        [
            "hasNextPage not a boolean",
            () => JSON.stringify(searchPage({ pageInfo: { hasNextPage: "no", endCursor: null } })),
            /page info/,
        ],
        [
            "a call that throws with valid JSON on stdout",
            () => {
                throw Object.assign(new Error("gh: exit 1"), {
                    stdout: JSON.stringify(searchPage()),
                });
            },
            /call failed/,
        ],
    ];

    for (const [name, answer, reason] of cases) {
        const result = decidedFrom(answer);

        assert.equal(result.complete, false, name);
        assert.match(result.reason!, reason, name);
        assert.equal(result.calls, 1, name);
    }
});

// ---------- Q1: review calls, goal stops and the flaky scan ----------

/** Add rows to the fixture database of `setup` (the test's own copy). */
function addRows(pocketDir: string, fill: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(path.join(pocketDir, "pocket.sqlite"));

    fill(db);
    db.close();
}

const insertEntry = (
    db: DatabaseSync,
    id: number,
    conversation: number,
    at: number,
    content: object[],
) =>
    db
        .prepare(
            "insert into entries (id, conversation_id, head, commit_seq, record) values (?,?,?,?,?)",
        )
        .run(
            id,
            conversation,
            null,
            id,
            JSON.stringify({
                kind: "pi.assistant",
                model: [{ role: "assistant", content, timestamp: at }],
            }),
        );

const STOP_WHY = "Pi is blocked: the same check failure came 3 times in a row: FAIL token=abc";

test("loadReviewCalls gives spawn and send rows, and skips other actions and rows older than since", () => {
    const { pocketDir } = setup();

    addRows(pocketDir, (db) => {
        insertEntry(db, 100, SUPERVISOR, NOW - 30 * 60_000, [
            {
                type: "toolCall",
                id: "c9",
                name: "subagent",
                arguments: { action: "send", name: "audit", message: "Look again" },
            },
            {
                type: "toolCall",
                id: "c10",
                name: "subagent",
                arguments: { action: "list" },
            },
        ]);
    });

    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const all = loadReviewCalls(db, NOW - 30 * DAY);
    const recent = loadReviewCalls(db, NOW - 10 * DAY);

    db.close();

    assert.deepEqual(
        all.map((call: { c: number; action: string; name: string }) => [
            call.c,
            call.action,
            call.name,
        ]),
        [
            [SUPERVISOR, "spawn", "w"],
            [SUPERVISOR, "spawn", "audit"],
            [SESSION_T1, "spawn", "old"],
            [SUPERVISOR, "send", "audit"],
        ],
    );
    // A spawn row is a spawn as `spawnRows` makes it: the reviewer is a cross-review.
    assert.equal(isCrossReviewSpawn(all[1]), true);
    assert.equal(all[1].brief.length, 300);
    assert.equal(all[1].model, "other/model");
    // A send row keeps no message text.
    assert.deepEqual(all[3], {
        id: 100,
        c: SUPERVISOR,
        at: NOW - 30 * 60_000,
        action: "send",
        name: "audit",
        refs: [],
        bare: [],
        head: null,
    });
    // The 20-day-old spawn is older than 10 days.
    assert.deepEqual(
        recent.map((call: { name: string }) => call.name),
        ["w", "audit", "audit"],
    );
});

test("loadGoalStops finds a 3-failure stop that a later goal wrote over, in a retired document too", () => {
    const { pocketDir } = setup();
    const endedAt = NOW - 2 * DAY;

    addRows(pocketDir, (db) => {
        db.prepare(
            "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) values (?,?,?,?,?,?,?,?,?)",
        ).run(
            6,
            JSON.stringify("x.night-shift.goal"),
            0,
            "",
            "conversation",
            SESSION_T2,
            1,
            NOW - DAY,
            "{}",
        );

        let seq = 100;
        const revision = (kind: string, value: unknown) =>
            db
                .prepare(
                    "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
                )
                .run(6, (seq += 1), kind, 1, JSON.stringify(value));

        revision("base", {
            goal: { id: "g2", status: "running", setAt: NOW - 3 * DAY, rounds: [] },
        });
        revision("delta", [
            ["s", ["goal", "rounds"], [{ n: 1, verdict: "continue", at: NOW - 3 * DAY + 60_000 }]],
        ]);
        revision("delta", [
            ["s", ["goal", "status"], "ended"],
            ["s", ["goal", "reason"], "blocked"],
            ["s", ["goal", "why"], STOP_WHY],
            ["s", ["goal", "failures"], { count: 3, fingerprint: "FAIL token=abc" }],
            ["s", ["goal", "endedAt"], endedAt],
        ]);
        // A new goal writes over g2.
        revision("delta", [
            ["s", ["goal"], { id: "g3", status: "running", setAt: NOW - DAY, rounds: [] }],
        ]);
        revision("delta", [["s", ["goal", "status"], "ended"]]);
        // An older ended stop with the same words but no endedAt: its last round's time; then a goal with no id.
        revision("delta", [
            [
                "s",
                ["goal"],
                {
                    id: "g4",
                    status: "ended",
                    reason: "blocked",
                    why: STOP_WHY,
                    setAt: NOW - 20 * 60_000,
                    rounds: [{ n: 1, at: NOW - 10 * 60_000 }],
                },
            ],
        ]);
        revision("delta", [["s", ["goal"], { status: "idle" }]]);
    });

    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const stops = loadGoalStops(db);

    db.close();

    // The fixture's own goal g1 is blocked with another detail: not a stop.
    assert.deepEqual(stops, [
        { session: SESSION_T2, id: "g2", at: endedAt },
        { session: SESSION_T2, id: "g4", at: NOW - 10 * 60_000 },
    ]);
    assert.ok(!JSON.stringify(stops).includes("token"));
});

test("loadGoalStops: a 3-failure goal in its summary round is not a stop; after the summary it ends, and is 1", () => {
    const { pocketDir } = setup();
    const endedAt = NOW - HOUR;
    const summary = {
        id: "g5",
        status: "summary",
        reason: "blocked",
        why: STOP_WHY,
        setAt: NOW - 3 * HOUR,
        rounds: [{ n: 3, at: NOW - 2 * HOUR }],
    };
    let seq = 200;

    const fill = (db: DatabaseSync, value: unknown, kind = "delta") =>
        db
            .prepare(
                "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
            )
            .run(7, (seq += 1), kind, 1, JSON.stringify(value));

    addRows(pocketDir, (db) => {
        db.prepare(
            "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) values (?,?,?,?,?,?,?,?)",
        ).run(7, JSON.stringify("x.night-shift.goal"), 0, "", "conversation", SESSION_T2, 1, "{}");
        fill(
            db,
            { goal: { id: "g5", status: "running", setAt: NOW - 3 * HOUR, rounds: [] } },
            "base",
        );
        fill(db, [["s", ["goal"], summary]]);
    });

    const read = () => {
        const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
        const stops = loadGoalStops(db);

        db.close();

        return stops;
    };

    // The last state is the summary round: reason and why are set, but the goal has not ended.
    assert.deepEqual(read(), []);

    addRows(pocketDir, (db) => {
        fill(db, [
            ["s", ["goal", "status"], "ended"],
            ["s", ["goal", "endedAt"], endedAt],
        ]);
    });

    assert.deepEqual(read(), [{ session: SESSION_T2, id: "g5", at: endedAt }]);
});

test("loadGoalStops: a second base resets the value; the stop before it and the goal after it are both found", () => {
    const { pocketDir } = setup();
    const firstEnd = NOW - 5 * DAY;
    const secondRound = NOW - 2 * DAY;
    let seq = 300;

    addRows(pocketDir, (db) => {
        const fill = (value: unknown, kind = "delta") =>
            db
                .prepare(
                    "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
                )
                .run(8, (seq += 1), kind, 1, JSON.stringify(value));

        db.prepare(
            "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) values (?,?,?,?,?,?,?,?)",
        ).run(8, JSON.stringify("x.night-shift.goal"), 0, "", "conversation", SESSION_T2, 1, "{}");
        // First base, then deltas: g6 ends as a 3-failure stop, with an endedAt.
        fill({ goal: { id: "g6", status: "running", setAt: NOW - 6 * DAY, rounds: [] } }, "base");
        fill([
            ["s", ["goal", "status"], "ended"],
            ["s", ["goal", "reason"], "blocked"],
            ["s", ["goal", "why"], STOP_WHY],
            ["s", ["goal", "endedAt"], firstEnd],
        ]);
        // Second base: g7 with no endedAt. If the value did not reset, g6's endedAt would be its time.
        fill(
            {
                goal: {
                    id: "g7",
                    status: "running",
                    setAt: NOW - 3 * DAY,
                    rounds: [{ n: 1, at: secondRound }],
                },
            },
            "base",
        );
        fill([
            ["s", ["goal", "status"], "ended"],
            ["s", ["goal", "reason"], "blocked"],
            ["s", ["goal", "why"], STOP_WHY],
        ]);
    });

    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const stops = loadGoalStops(db);

    db.close();

    assert.deepEqual(stops, [
        { session: SESSION_T2, id: "g6", at: firstEnd },
        { session: SESSION_T2, id: "g7", at: secondRound },
    ]);
});

test("loadData reads the review calls and the goal stops; no flaky scan is null, not an error", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.equal(data.sourceErrors.reviews, undefined);
    assert.equal(data.sourceErrors.goalHistory, undefined);
    assert.equal(data.sourceErrors.flakyScan, undefined);
    // 30 days: the 20-day-old spawn is in; the 8-day `spawns` leave it out.
    assert.deepEqual(
        data.reviewCalls.map((call: { name: string }) => call.name),
        ["w", "audit", "old"],
    );
    assert.equal(data.spawns.length, 2);
    // The fixture's goal is blocked with another detail.
    assert.deepEqual(data.goalStops, []);
    assert.equal(data.flakyScan, null);

    // With no database, the 2 database sources fail by name.
    const root = tmp();
    const none = loadData({
        pocketDir: path.join(root, "nowhere"),
        odradeDir: path.join(root, "nowhere"),
        homesDir: path.join(root, "nowhere"),
        now: NOW,
        hours: 24,
        useGithub: false,
        run: () => "",
    });

    assert.ok(none.sourceErrors.reviews);
    assert.ok(none.sourceErrors.goalHistory);
    assert.equal(none.sourceErrors.flakyScan, undefined);
    assert.deepEqual(none.reviewCalls, []);
    assert.deepEqual(none.goalStops, []);
    assert.equal(none.flakyScan, null);
});

/** A flaky-scan file as the core spec writes it. */
const scanFile = (over: object = {}) => ({
    schema_version: 1,
    generated_at: "2026-10-20T10:00:00.000Z",
    window: { from: "2026-10-13", to: "2026-10-20T10:00:00.000Z" },
    apply: false,
    repos: [
        {
            repo: "acme/widgets",
            owner: "irulan",
            runs: 40,
            rerunAttempts: 3,
            error: null,
            flaky: [],
        },
        {
            repo: "acme/broken",
            owner: null,
            runs: null,
            rerunAttempts: null,
            error: "HTTP 404",
            flaky: [],
        },
        {
            repo: "acme/odd",
            owner: null,
            runs: 2,
            rerunAttempts: 5,
            error: "a write failed",
            flaky: [],
        },
        { repo: "acme/calm", owner: "teg", runs: 9, rerunAttempts: 0, error: null, flaky: [] },
        { repo: "acme/bad", owner: "teg", runs: 9, rerunAttempts: -1, error: null, flaky: [] },
    ],
    ...over,
});

const writeScan = (odradeDir: string, folder: string, content: unknown) => {
    fs.mkdirSync(path.join(odradeDir, "reports", folder), { recursive: true });
    fs.writeFileSync(
        path.join(odradeDir, "reports", folder, "scan.json"),
        typeof content === "string" ? content : JSON.stringify(content),
    );
};

test("readFlakyScan reads the newest scan; an error or a bad count is null, never 0", () => {
    const dir = tmp();

    assert.equal(readFlakyScan(dir), null, "no reports folder");
    fs.mkdirSync(path.join(dir, "reports", "2026-10-22-daily-audit"), { recursive: true });
    assert.equal(readFlakyScan(dir), null, "no scan folder");

    writeScan(dir, "2026-10-13-flaky-scan", scanFile({ generated_at: "old", repos: [] }));
    writeScan(dir, "2026-10-20-flaky-scan", scanFile());
    // A newer folder with no scan.json is skipped.
    fs.mkdirSync(path.join(dir, "reports", "2026-10-21-flaky-scan"));

    assert.deepEqual(readFlakyScan(dir), {
        file: "reports/2026-10-20-flaky-scan/scan.json",
        generatedAt: "2026-10-20T10:00:00.000Z",
        window: { from: "2026-10-13", to: "2026-10-20T10:00:00.000Z" },
        repos: {
            "acme/widgets": 3,
            "acme/broken": null,
            "acme/odd": null,
            "acme/calm": 0,
            "acme/bad": null,
        },
    });
});

test("readFlakyScan: invalid JSON, schema_version 2 or no repos list is a source error", () => {
    const bad = (content: unknown) => {
        const dir = tmp();

        writeScan(dir, "2026-10-20-flaky-scan", content);

        return dir;
    };

    assert.throws(() => readFlakyScan(bad("{ nope")), /not valid JSON/);
    assert.throws(() => readFlakyScan(bad(scanFile({ schema_version: 2 }))), /schema_version 2/);
    assert.throws(() => readFlakyScan(bad(scanFile({ repos: undefined }))), /no repos list/);

    // Through loadData, the reason goes to `sourceErrors.flakyScan`, and the scan stays null.
    const { pocketDir, odradeDir, homesDir, run } = setup();

    writeScan(odradeDir, "2026-10-20-flaky-scan", scanFile({ schema_version: 2 }));

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.match(data.sourceErrors.flakyScan, /schema_version 2, not 1/);
    assert.equal(data.flakyScan, null);
    assert.equal(data.sourceErrors.odrade, undefined);
});

// ---------- Q1: review calls with their PRs, reviewer answers and the guards of blocking points ----------

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const insertUser = (
    db: DatabaseSync,
    id: number,
    conversation: number,
    at: number,
    content: string | object[],
) =>
    db
        .prepare(
            "insert into entries (id, conversation_id, head, commit_seq, record) values (?,?,?,?,?)",
        )
        .run(
            id,
            conversation,
            null,
            id,
            JSON.stringify({ kind: "pi.user", model: [{ role: "user", content, timestamp: at }] }),
        );

test("loadReviewCalls: each spawn and send has the refs, bare numbers and head of its whole message", () => {
    const { pocketDir } = setup();

    addRows(pocketDir, (db) => {
        insertEntry(db, 200, SUPERVISOR, NOW - 10 * 60_000, [
            {
                type: "toolCall",
                id: "c20",
                name: "subagent",
                arguments: {
                    action: "spawn",
                    name: "rv",
                    tools: ["read", "bash"],
                    // The PR and the head sit after the 300 characters of the brief.
                    message: `${"y".repeat(320)}\nRepository: acme/widgets, PR #12\nHead: ${SHA_A}`,
                },
            },
            {
                type: "toolCall",
                id: "c21",
                name: "subagent",
                arguments: {
                    action: "send",
                    name: "rv",
                    message: `Re-review PR #12 and PR 13 at ${SHA_A}..${SHA_B}`,
                },
            },
        ]);
    });

    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const calls = loadReviewCalls(db, NOW - 30 * DAY).filter(
        (call: { id: number }) => call.id === 200,
    );

    db.close();

    assert.deepEqual(
        calls.map((call: { action: string; refs: string[]; bare: number[]; head: string }) => [
            call.action,
            call.refs,
            call.bare,
            call.head,
        ]),
        [
            ["spawn", ["acme/widgets#12"], [], SHA_A],
            ["send", [], [12, 13], SHA_B],
        ],
    );
    assert.equal(calls[0].brief.length, 300);
    assert.ok(!JSON.stringify(calls[1]).includes("Re-review"));
});

test("loadReviewAnswers: answers of subagents with their verdict and blocking items, and no text", () => {
    const { pocketDir } = setup();

    addRows(pocketDir, (db) => {
        insertUser(
            db,
            301,
            SUPERVISOR,
            NOW - 5 * 60_000,
            "[subagent rv answered, no reply needed] **Not ready.**\n1. **Medium · Blocking: yes** — `a.ts:3`",
        );
        insertUser(db, 300, SESSION_T1, NOW - 6 * 60_000, [
            { type: "text", text: "[from: Brian] [subagent rv2 answered]" },
            { type: "text", text: "**A1 — Low; blocking: yes**\nReady after A1." },
        ]);
        // Not an answer: the mark is not at the start.
        insertUser(db, 302, SUPERVISOR, NOW - 4 * 60_000, "Quote: [subagent rv answered] Ready");
        // Older than since.
        insertUser(db, 303, SUPERVISOR, NOW - 40 * DAY, "[subagent rv answered] Ready");
    });

    const db = openPocket(path.join(pocketDir, "pocket.sqlite"));
    const answers = loadReviewAnswers(db, NOW - 30 * DAY);

    db.close();

    assert.deepEqual(answers, [
        { id: 300, c: SESSION_T1, at: NOW - 6 * 60_000, name: "rv2", ready: true, items: ["A1"] },
        { id: 301, c: SUPERVISOR, at: NOW - 5 * 60_000, name: "rv", ready: false, items: ["1"] },
    ]);
});

test("loadData: the reviewer answers are a source; with no database it fails by name", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.equal(data.sourceErrors.reviewAnswers, undefined);
    assert.deepEqual(data.reviewAnswers, []);
    assert.equal(data.blockerGuards, undefined);
    assert.deepEqual(data.blockerCache, {});

    const root = tmp();
    const none = loadData({
        pocketDir: path.join(root, "nowhere"),
        odradeDir: path.join(root, "nowhere"),
        homesDir: path.join(root, "nowhere"),
        now: NOW,
        hours: 24,
        useGithub: false,
        run: () => "",
    });

    assert.ok(none.sourceErrors.reviewAnswers);
    assert.deepEqual(none.reviewAnswers, []);
});

/** 1 reviewer spawn naming `acme/w#N` at `head`, and its answer with 1 blocking point, `n` minutes before NOW. */
function blockerData(points: { n: number; head?: string | null; minutes?: number }[]) {
    const threads = {
        T1: { id: "T1", repo: "acme/w", session: 101, startedAt: NOW - 3 * DAY, prs: {} },
    };
    const reviewCalls = points.map((point, i) => ({
        id: i + 1,
        c: 101,
        at: NOW - (point.minutes ?? 100 - i) * 60_000 - 1000,
        action: "spawn",
        name: `rv${point.n}`,
        tools: ["read", "bash"],
        review: true,
        brief: "Review",
        refs: [`acme/w#${point.n}`],
        bare: [],
        head: point.head === undefined ? SHA_A : point.head,
    }));
    const reviewAnswers = points.map((point, i) => ({
        id: 1000 + i,
        c: 101,
        at: NOW - (point.minutes ?? 100 - i) * 60_000,
        name: `rv${point.n}`,
        ready: false,
        items: ["1"],
    }));

    return { threads, reviewCalls, reviewAnswers };
}

type PrNode = {
    state: string;
    headRefOid?: string;
    files?: { totalCount: number; nodes: { path: string; additions: number }[] };
};

type Blob = { oid: string; text?: string | null; isTruncated?: boolean };

/**
 * A fake GitHub for `loadBlockerGuards`: 1 PR node per PR number, the commits it has, and the blobs by `sha:path`.
 * It answers a PR query and a blob query by their aliases; `answer` can change a blob answer.
 */
function guardGh(
    nodes: (number: number) => PrNode,
    world: { commits?: string[]; blobs?: Record<string, Blob> } = {},
    answer: (data: Record<string, Record<string, unknown>>, query: string) => unknown = (data) => ({
        data,
    }),
    prAnswer: (data: Record<string, unknown>) => unknown = (data) => ({ data }),
) {
    const seen: string[][] = [];
    const commits = new Set(world.commits ?? [SHA_A, SHA_B]);
    const blobs = world.blobs ?? {};
    const queries: string[] = [];

    const run = (_: string, args: string[]) => {
        seen.push(args);

        const query = (args.find((arg) => arg.startsWith("query=")) ?? "").slice(6);

        if (args[1] !== "graphql") {
            throw new Error(`no such call: ${args.join(" ")}`);
        }

        if (query.includes("pullRequest(")) {
            const data: Record<string, unknown> = {};

            for (const match of query.matchAll(
                /(p\d+): repository\([^)]*\) \{ pullRequest\(number: (\d+)\)/g,
            )) {
                data[match[1]!] = {
                    pullRequest: {
                        mergedAt: null,
                        closedAt: null,
                        headRefOid: SHA_B,
                        files: { totalCount: 0, nodes: [] },
                        ...nodes(Number(match[2])),
                    },
                };
            }

            return JSON.stringify(prAnswer(data));
        }

        queries.push(query);

        const data: Record<string, Record<string, unknown>> = {};

        for (const line of query.replace(/^\{ /, "").replace(/ \}$/, "").split("\n")) {
            const repo = /^(r\d+): repository\(/.exec(line)![1]!;

            data[repo] = {};

            for (const match of line.matchAll(
                /(k\d+(?:[hf]\d+)?): object\((oid|expression): "([^"]*)"\)/g,
            )) {
                data[repo][match[1]!] =
                    match[2] === "oid"
                        ? commits.has(match[3]!)
                            ? { oid: match[3] }
                            : null
                        : (blobs[match[3]!] ?? null);
            }
        }

        return JSON.stringify(answer(data, query));
    };

    return { seen, queries, gh: makeGh(run) };
}

const prFiles = (...paths: string[]) => ({
    totalCount: paths.length,
    nodes: paths.map((file) => ({ path: file, additions: 1 })),
});

const lookupsIn = (query: string) => (query.match(/: object\(/g) ?? []).length;

test("loadBlockerGuards: 1 PR query, then 1 blob query with the candidates at the reviewed and the final head", () => {
    const { seen, queries, gh } = guardGh(
        () => ({
            state: "MERGED",
            files: prFiles("src/a.ts", "src/a.test.ts", ".memory/corrections.jsonl"),
        }),
        {
            blobs: {
                [`${SHA_B}:src/a.test.ts`]: { oid: "t2" },
                [`${SHA_A}:.memory/corrections.jsonl`]: { oid: "c1", text: '{"old":1}\n' },
                [`${SHA_B}:.memory/corrections.jsonl`]: {
                    oid: "c2",
                    text: '{"old":1}\n{"pr":"w#4","rule":"x"}\n',
                },
            },
        },
    );
    const result = loadBlockerGuards(blockerData([{ n: 4 }]), { gh, now: NOW, cache: {} });

    assert.equal(seen.length, 2);
    assert.match(
        seen[0]!.find((arg) => arg.startsWith("query="))!,
        /p0: repository\(owner: "acme", name: "w"\) \{ pullRequest\(number: 4\) \{ state mergedAt closedAt headRefOid files\(first: 100\) \{ totalCount nodes \{ path additions \} \} \} \}/,
    );
    // No compare call: 1 alias for the repository, the head, and each candidate at H and at F.
    assert.ok(!seen.some((args) => args[1]!.includes("compare")));
    assert.equal(
        queries[0],
        `{ r0: repository(owner: "acme", name: "w") { k0: object(oid: "${SHA_A}") { oid } ` +
            `k0h0: object(expression: "${SHA_A}:src/a.test.ts") { oid } ` +
            `k0f0: object(expression: "${SHA_B}:src/a.test.ts") { oid } ` +
            `k0h1: object(expression: "${SHA_A}:.memory/corrections.jsonl") { oid ... on Blob { text isTruncated } } ` +
            `k0f1: object(expression: "${SHA_B}:.memory/corrections.jsonl") { oid ... on Blob { text isTruncated } } } }`,
    );
    assert.deepEqual(result, {
        prs: { "acme/w#4": { state: "merged", mergedAt: null, closedAt: null, head: SHA_B } },
        guards: {
            [`acme/w#4@${SHA_A}`]: {
                final: true,
                state: "merged",
                guarded: true,
                test: true,
                agentsRule: false,
                corrections: 1,
                namesPr: true,
            },
        },
        calls: 2,
        pending: 0,
        errors: [],
    });
});

test("loadBlockerGuards: an unchanged or deleted test file does not count; a changed AGENTS.md does", () => {
    const { gh } = guardGh(
        () => ({
            state: "MERGED",
            files: prFiles("tests/same.py", "tests/gone.py", "docs/AGENTS.md", "README.md"),
        }),
        {
            blobs: {
                [`${SHA_A}:tests/same.py`]: { oid: "s1" },
                [`${SHA_B}:tests/same.py`]: { oid: "s1" },
                [`${SHA_A}:tests/gone.py`]: { oid: "g1" },
                [`${SHA_A}:docs/AGENTS.md`]: { oid: "a1" },
                [`${SHA_B}:docs/AGENTS.md`]: { oid: "a2" },
            },
        },
    );
    const result = loadBlockerGuards(blockerData([{ n: 4 }]), { gh, now: NOW });

    // No corrections file in the PR: not guarded.
    assert.deepEqual(result.guards[`acme/w#4@${SHA_A}`], {
        final: true,
        state: "merged",
        guarded: false,
        test: false,
        agentsRule: true,
        corrections: 0,
        namesPr: false,
    });
});

test("guardOf: the added corrections lines are a multiset of non-empty lines; a missing text or head has no verdict", () => {
    const head = { oid: SHA_A };
    const log = (atHead: Blob | null, atFinal: Blob | null) => ({
        path: ".memory/corrections.jsonl",
        test: false,
        agents: false,
        corrections: true,
        atHead,
        atFinal,
    });
    const test1 = {
        path: "a_test.go",
        test: true,
        agents: false,
        corrections: false,
        atHead: null,
        atFinal: { oid: "n" },
    };

    assert.deepEqual(
        guardOf("acme/w#7", {
            head,
            files: [
                test1,
                log(
                    { oid: "1", text: "a\na\nb\n" },
                    { oid: "2", text: "a\na\na\nb\n\n  \nacme/w#7 c\n" },
                ),
            ],
        }),
        {
            final: true,
            state: "merged",
            guarded: true,
            test: true,
            agentsRule: false,
            corrections: 2,
            namesPr: true,
        },
    );
    // A new corrections file: every line is added; `other/w#7` names another PR.
    assert.deepEqual(
        guardOf("acme/w#7", { head, files: [log(null, { oid: "2", text: "other/w#7\n" })] }),
        {
            final: true,
            state: "merged",
            guarded: false,
            test: false,
            agentsRule: false,
            corrections: 1,
            namesPr: false,
        },
    );

    // A changed corrections file with no text, or a truncated one.
    for (const atFinal of [
        { oid: "2", text: null },
        { oid: "2", text: "x\n", isTruncated: true },
    ]) {
        assert.deepEqual(
            guardOf("acme/w#7", { head, files: [test1, log({ oid: "1", text: "" }, atFinal)] }),
            {
                final: true,
                state: "merged",
                guarded: null,
                test: true,
                agentsRule: false,
                corrections: null,
                namesPr: null,
                reason: "corrections text missing",
            },
        );
    }

    // An unchanged corrections file needs no text.
    assert.equal(
        guardOf("acme/w#7", { head, files: [log({ oid: "1" }, { oid: "1" })] }).corrections,
        0,
    );
    assert.deepEqual(guardOf("acme/w#7", { head: null, files: [test1] }), {
        final: true,
        state: "merged",
        guarded: null,
        reason: "head not found",
    });
});

test("loadBlockerGuards: a reviewed head that GitHub does not have is final with no verdict", () => {
    const { gh } = guardGh(() => ({ state: "MERGED", files: prFiles("x.test.ts") }), {
        commits: [SHA_B],
    });
    const result = loadBlockerGuards(blockerData([{ n: 4 }]), { gh, now: NOW });

    assert.deepEqual(result.guards[`acme/w#4@${SHA_A}`], {
        final: true,
        state: "merged",
        guarded: null,
        reason: "head not found",
    });
});

test("loadBlockerGuards: no candidate file, or no commit after the head, is final with no blob query", () => {
    const { queries, gh } = guardGh((n) =>
        n === 1
            ? { state: "MERGED", files: prFiles("src/a.ts", "README.md") }
            : { state: "MERGED", headRefOid: SHA_A, files: prFiles("src/a.test.ts") },
    );
    const result = loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 20 },
            { n: 2, minutes: 10 },
        ]),
        { gh, now: NOW },
    );
    const none = {
        final: true,
        state: "merged",
        guarded: false,
        test: false,
        agentsRule: false,
        corrections: 0,
        namesPr: false,
    };

    assert.deepEqual(queries, []);
    assert.deepEqual(result.guards, {
        [`acme/w#1@${SHA_A}`]: none,
        [`acme/w#2@${SHA_A}`]: none,
    });
    assert.equal(result.calls, 1);
});

test("loadBlockerGuards: at most 150 lookups a query and 4 queries a run, and 8 PR queries, newest first", () => {
    const { seen, queries, gh } = guardGh(() => ({
        state: "MERGED",
        files: prFiles("a.test.ts"),
    }));
    // 330 PRs; PR 330 is the newest point. Each key needs 3 lookups: 50 keys a query.
    const numbers = Array.from({ length: 330 }, (_, i) => i + 1);
    const result = loadBlockerGuards(blockerData(numbers.map((n) => ({ n, minutes: 1000 - n }))), {
        gh,
        now: NOW,
    });
    const prQueries = seen.filter((args) => args.some((arg) => arg.includes("pullRequest(")));

    assert.equal(BLOCKER_LOOKUPS, 150);
    assert.equal(BLOCKER_MAX_QUERIES, 4);
    assert.equal(BLOCKER_MAX_PR_QUERIES, 8);
    assert.equal(prQueries.length, 8);
    // The 10 oldest PRs are not read this run.
    assert.equal(Object.keys(result.prs).length, 320);
    assert.ok(!("acme/w#10" in result.prs));
    assert.deepEqual(queries.map(lookupsIn), [150, 150, 150, 150]);
    // 120 keys wait for a blob query, and the 10 oldest PRs were not read: 130 keys with no result.
    assert.equal(result.pending, 130);
    assert.equal(result.calls, 12);
    assert.deepEqual(
        Object.keys(result.guards)
            .map((key) => Number(key.split("#")[1]!.split("@")[0]))
            .sort((a, b) => a - b),
        numbers.slice(130),
    );
    // A key that does not fit in the rest of a query starts the next one.
    const big = guardGh(() => ({
        state: "MERGED",
        files: prFiles(...Array.from({ length: 40 }, (_, i) => `t/test_${i}.py`)),
    }));

    loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 30 },
            { n: 2, minutes: 20 },
            { n: 3, minutes: 10 },
        ]),
        { gh: big.gh, now: NOW },
    );
    assert.deepEqual(big.queries.map(lookupsIn), [81, 81, 81]);
});

test("loadBlockerGuards: a key that an error names, or a call with no data, stays pending", () => {
    const files = () => ({ state: "MERGED", files: prFiles("a.test.ts") });
    const partial = guardGh(files, {}, (data) => {
        delete data.r0!.k1f0;

        return { data, errors: [{ path: ["r0", "k0h0"], message: "boom" }] };
    });
    const points = blockerData([
        { n: 1, minutes: 30 },
        { n: 2, minutes: 20 },
        { n: 3, minutes: 10 },
    ]);
    const result = loadBlockerGuards(points, { gh: partial.gh, now: NOW });

    // Keys newest first: k0 is PR 3 (an error names it), k1 is PR 2 (an alias is missing), k2 is PR 1.
    assert.deepEqual(Object.keys(result.guards), [`acme/w#1@${SHA_A}`]);
    assert.equal(result.pending, 2);
    assert.deepEqual(result.errors.sort(), [
        "blob query missed a key",
        "blob query returned errors",
    ]);

    // A call that ends well with no object: no data. Every key stays pending.
    const failed = guardGh(files, {}, () => "");
    const none = loadBlockerGuards(points, { gh: failed.gh, now: NOW });

    assert.deepEqual(none.guards, {});
    assert.equal(none.pending, 3);
    assert.deepEqual(none.errors, ["blob query returned no data"]);

    // The same for the PR query: no `data`, or a PR that the answer leaves out with no error.
    const noData = guardGh(files, {}, undefined, () => ({ message: "ok" }));
    const unreadPrs = loadBlockerGuards(points, { gh: noData.gh, now: NOW });

    assert.deepEqual(unreadPrs.prs, {});
    assert.equal(unreadPrs.pending, 3);
    assert.deepEqual(unreadPrs.errors, ["PR query returned no data"]);

    const missed = guardGh(files, {}, undefined, (data) => {
        delete data.p1;

        return { data };
    });
    const some = loadBlockerGuards(points, { gh: missed.gh, now: NOW });

    // PR 2 (alias p1) is left out; PR 3 and PR 1 are read and judged.
    assert.deepEqual(Object.keys(some.prs).sort(), ["acme/w#1", "acme/w#3"]);
    assert.equal(Object.keys(some.guards).length, 2);
    assert.equal(some.pending, 1);
    assert.deepEqual(some.errors, ["PR query missed a PR"]);

    // Invalid JSON with exit status 0.
    const invalid = loadBlockerGuards(points, {
        gh: makeGh(() => "not json {"),
        now: NOW,
    });

    assert.equal(invalid.pending, 3);
    assert.deepEqual(invalid.errors, ["PR query returned no data"]);
});

test("loadBlockerGuards: a cached final result needs no call; a closed PR is final with no lookup", () => {
    const cached = guardGh(() => ({ state: "MERGED", files: prFiles("a.test.ts") }));
    const cache = { [`acme/w#4@${SHA_A}`]: { final: true, guarded: true } };
    const none = loadBlockerGuards(blockerData([{ n: 4 }]), { gh: cached.gh, now: NOW, cache });

    assert.equal(cached.seen.length, 0);
    assert.deepEqual(none, { prs: {}, guards: {}, calls: 0, pending: 0, errors: [] });

    const closed = guardGh(() => ({ state: "CLOSED", files: prFiles("a.test.ts") }));
    const result = loadBlockerGuards(blockerData([{ n: 5 }]), { gh: closed.gh, now: NOW });

    assert.equal(closed.seen.length, 1);
    assert.deepEqual(result.guards, {
        [`acme/w#5@${SHA_A}`]: { final: true, state: "closed", guarded: null },
    });
    assert.equal(result.prs["acme/w#5"]!.state, "closed");
});

test("loadBlockerGuards: more than 100 PR files is final with no verdict; an open PR or no head gives no result", () => {
    const { queries, gh } = guardGh((n) =>
        n === 1
            ? { state: "MERGED", files: { totalCount: 101, nodes: [] } }
            : n === 2
              ? { state: "OPEN" }
              : { state: "MERGED", files: prFiles("a.test.ts") },
    );
    const result = loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 30 },
            { n: 2, minutes: 20 },
            { n: 3, head: null, minutes: 10 },
        ]),
        { gh, now: NOW },
    );

    assert.deepEqual(result.guards, {
        [`acme/w#1@${SHA_A}`]: {
            final: true,
            state: "merged",
            guarded: null,
            reason: "too many files",
        },
    });
    assert.deepEqual(queries, []);
    assert.equal(result.prs["acme/w#2"]!.state, "open");
    assert.equal(result.prs["acme/w#3"]!.state, "merged");
    // The open PR's key has no result yet: it is pending. PR 3 has no head: no key.
    assert.equal(result.pending, 1);
});

test("loadBlockerGuards: a PR that GitHub cannot find fails the call; the other PRs of the query still count", () => {
    const run = (_: string, args: string[]) => {
        if (args.some((arg) => arg.includes("pullRequest("))) {
            const error = new Error("gh: Could not resolve to a PullRequest") as Error & {
                stdout: string;
            };

            error.stdout = JSON.stringify({
                data: {
                    p0: {
                        pullRequest: {
                            state: "OPEN",
                            headRefOid: SHA_B,
                            files: { totalCount: 0, nodes: [] },
                        },
                    },
                    p1: { pullRequest: null },
                },
                errors: [{ type: "NOT_FOUND", path: ["p1", "pullRequest"] }],
            });

            throw error;
        }

        return "";
    };

    const gh = makeGh(run);
    // PR 9 is the newer point: it comes first in the query.
    const result = loadBlockerGuards(
        blockerData([
            { n: 8, minutes: 20 },
            { n: 9, minutes: 10 },
        ]),
        { gh, now: NOW },
    );

    assert.equal(gh.state.failures, 1);
    assert.deepEqual(Object.keys(result.prs), ["acme/w#9"]);
    assert.equal(result.prs["acme/w#9"]!.state, "open");
    // PR 8's key (not found) and PR 9's key (still open) have no result yet; the failure is named with no GitHub text.
    assert.equal(result.pending, 2);
    assert.deepEqual(result.errors, ["PR query failed", "PR query returned errors"]);
});

test("loadBlockerGuards: a key over 150 lookups, or a path the read-only gh refuses, is final with no query", () => {
    const { queries, gh } = guardGh((n) =>
        n === 1
            ? {
                  state: "MERGED",
                  files: prFiles(...Array.from({ length: 75 }, (_, i) => `t/${i}.test.ts`)),
              }
            : { state: "MERGED", files: prFiles("tests/mutation.test.ts") },
    );
    const result = loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 20 },
            { n: 2, minutes: 10 },
        ]),
        { gh, now: NOW },
    );

    assert.deepEqual(queries, []);
    assert.equal(result.guards[`acme/w#1@${SHA_A}`]!.reason, "too many files");
    assert.equal(result.guards[`acme/w#2@${SHA_A}`]!.reason, "path refused by the read-only gh");
    assert.equal(result.guards[`acme/w#2@${SHA_A}`]!.guarded, null);
});

test("loadBlockerGuards: a PR node with no whole file list, or with an error on its alias, leaves its key pending", () => {
    const { queries, gh } = guardGh(
        (n) =>
            n === 1
                ? ({ state: "MERGED", files: null } as unknown as PrNode)
                : n === 2
                  ? ({ state: "MERGED", files: { totalCount: 1 } } as unknown as PrNode)
                  : n === 3
                    ? {
                          state: "MERGED",
                          files: { totalCount: 2, nodes: [{ path: "a.test.ts", additions: 1 }] },
                      }
                    : { state: "MERGED", files: prFiles("a.test.ts") },
        { blobs: { [`${SHA_B}:a.test.ts`]: { oid: "t1" } } },
        undefined,
        // PR 5 is the newest point: alias p0. An error names it; its node is whole and still not used.
        (data) => ({ data, errors: [{ path: ["p0", "pullRequest", "files"], message: "x" }] }),
    );
    const result = loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 50 },
            { n: 2, minutes: 40 },
            { n: 3, minutes: 30 },
            { n: 4, minutes: 20 },
            { n: 5, minutes: 10 },
        ]),
        { gh, now: NOW },
    );

    // Only PR 4 is read and judged; the 4 other keys are pending, not final.
    assert.deepEqual(Object.keys(result.prs), ["acme/w#4"]);
    assert.deepEqual(Object.keys(result.guards), [`acme/w#4@${SHA_A}`]);
    assert.equal(result.guards[`acme/w#4@${SHA_A}`]!.test, true);
    assert.equal(queries.length, 1);
    assert.equal(result.pending, 4);
    assert.deepEqual(result.errors.sort(), [
        "PR query returned an incomplete PR",
        "PR query returned errors",
    ]);
});

test("loadBlockerGuards: a failed blob query and the call cap are named in errors", () => {
    const failed = guardGh(
        () => ({ state: "MERGED", files: prFiles("a.test.ts") }),
        {},
        () => ({ errors: [{ message: "Something went wrong" }] }),
    );
    const one = loadBlockerGuards(blockerData([{ n: 4 }]), { gh: failed.gh, now: NOW });

    assert.equal(one.pending, 1);
    assert.deepEqual(one.errors, ["blob query returned errors"]);
    assert.ok(!JSON.stringify(one).includes("Something"));

    const capped = guardGh(() => ({ state: "MERGED", files: prFiles("a.test.ts") }));

    // 39 calls are used before: the PR query is the 40th, and the blob query meets the cap.
    for (let i = 0; i < 39; i += 1) {
        capped.gh.api("repos/acme/w");
    }

    const two = loadBlockerGuards(blockerData([{ n: 4 }]), { gh: capped.gh, now: NOW });

    assert.equal(two.pending, 1);
    assert.deepEqual(two.errors, ["GitHub call cap reached"]);
});

test("loadData: all earlier review calls are loaded, with no lower time limit", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();

    addRows(pocketDir, (db) => {
        for (const [id, days] of [
            [400, 36],
            [401, 60],
            [402, 400],
        ]) {
            insertEntry(db, id, SUPERVISOR, NOW - days * DAY, [
                {
                    type: "toolCall",
                    id: `c${id}`,
                    name: "subagent",
                    arguments: {
                        action: "spawn",
                        name: `s${days}`,
                        tools: ["read", "bash"],
                        message: "Review",
                    },
                },
            ]);
        }
    });

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });

    assert.deepEqual(
        data.reviewCalls.map((call: { name: string }) => call.name),
        ["w", "audit", "old", "s36", "s60", "s400"],
    );
});

test("loadBlockerGuards: when the shared cap is reached before it starts, every uncached key is pending and the cap is named", () => {
    const { seen, gh } = guardGh(() => ({ state: "MERGED", files: prFiles("a.test.ts") }));

    // 41 calls: the 41st meets the cap of 40.
    for (let i = 0; i < 41; i += 1) {
        gh.api("repos/acme/w");
    }

    const before = seen.length;
    const cache = { [`acme/w#1@${SHA_A}`]: { final: true, guarded: true } };
    const result = loadBlockerGuards(
        blockerData([
            { n: 1, minutes: 30 },
            { n: 2, minutes: 20 },
            { n: 3, minutes: 10 },
        ]),
        { gh, now: NOW, cache },
    );

    assert.equal(gh.state.capReached, true);
    assert.equal(seen.length, before);
    assert.deepEqual(result.guards, {});
    // PR 1's key is cached final: only PR 2 and PR 3 are pending.
    assert.equal(result.pending, 2);
    assert.deepEqual(result.errors, ["GitHub call cap reached"]);
});

test("loadData and Q1: a spawn 60 days ago with a send and a blocking answer 29 days ago gives 1 round and the points", () => {
    const { pocketDir, odradeDir, homesDir, run } = setup();
    const tool = (args: object) => [
        { type: "toolCall", id: "x", name: "subagent", arguments: args },
    ];

    addRows(pocketDir, (db) => {
        db.prepare(
            "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
        ).run(1, 10_000, "delta", 1, JSON.stringify([["s", ["threads", "T1", "repo"], "acme/w"]]));
        insertEntry(
            db,
            500,
            SESSION_T1,
            NOW - 60 * DAY,
            tool({
                action: "spawn",
                name: "rv",
                tools: ["read", "bash"],
                message: `Cross-review acme/w#5 at head ${SHA_A}.`,
            }),
        );
        insertEntry(
            db,
            501,
            SESSION_T1,
            NOW - 29 * DAY,
            tool({ action: "send", name: "rv", message: `Re-review at head ${SHA_B}.` }),
        );
        insertUser(
            db,
            502,
            SESSION_T1,
            NOW - 29 * DAY + 60_000,
            "[subagent rv answered] **Not ready.**\n1. **Medium · Blocking: yes**",
        );
    });

    const data = loadData({
        pocketDir,
        odradeDir,
        homesDir,
        now: NOW,
        hours: 24,
        useGithub: false,
        run,
    });
    const q1 = checkQ1(data, { now: NOW, since: NOW - DAY, hours: 24, earlier: [] }).metrics;

    assert.deepEqual(q1.prRounds.prs, [
        {
            ref: "acme/w#5",
            rounds: 1,
            heads: 1,
            first: new Date(NOW - 29 * DAY).toISOString().slice(0, 16) + "Z",
            last: new Date(NOW - 29 * DAY).toISOString().slice(0, 16) + "Z",
        },
    ]);
    assert.deepEqual(
        q1.blockers.points.map((point: { ref: string; head: string; item: string }) => [
            point.ref,
            point.head,
            point.item,
        ]),
        [["acme/w#5", SHA_B, "1"]],
    );
});
