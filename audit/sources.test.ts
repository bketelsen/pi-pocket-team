// The audit's reads: Pocket's database (read-only, folded as Pi Durable folds it), the `gh` and `git` wrappers, and
// Odrade's notes. Everything runs on invented data; the process runner is a fake, so no real `gh` or `git` runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isCrossReviewSpawn } from "./checks.mjs";
import { HOUR } from "./common.mjs";
import { NOW } from "./fixtures/builders.mjs";
import { SESSION_T1, SUPERVISOR, createFixtureDb } from "./fixtures/pocket-db.mjs";
import {
    GH_CAP,
    checkGhArgs,
    checkGitArgs,
    foldDocument,
    loadData,
    loadDesk,
    loadGithub,
    makeGh,
    makeGit,
    openPocket,
    readOdrade,
} from "./sources.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "audit-sources-"));

/** A Pocket folder with the fixture database, an Odrade folder, and a recording runner for `git`. */
function setup() {
    const root = tmp();
    const pocketDir = path.join(root, "pocket");
    const odradeDir = path.join(root, "odrade");

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

    return { root, pocketDir, odradeDir, times, calls, run };
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
    const { pocketDir, odradeDir, times, run } = setup();
    const data = loadData({ pocketDir, odradeDir, now: NOW, hours: 24, useGithub: false, run });

    assert.deepEqual(data.sourceErrors, { github: "disabled by --no-github" });
    assert.deepEqual(Object.keys(data.threads).sort(), ["T1", "T2", "T3"]);
    assert.equal(data.events.length, 7);
    assert.deepEqual(data.agentOf, { 10: "odrade" });

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

    // Tool errors: the team tools only, with the desk-full refusal; a bash error is left out.
    assert.deepEqual(data.toolErrors.map((error: { tool: string }) => error.tool).sort(), [
        "team_delegate",
        "team_message",
    ]);
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

test("loadData reads the install time of a live module", () => {
    const { pocketDir, odradeDir, run } = setup();

    fs.mkdirSync(path.join(pocketDir, "extensions"));
    fs.writeFileSync(path.join(pocketDir, "extensions", "desk.ts"), "// x");

    const data = loadData({ pocketDir, odradeDir, now: NOW, hours: 24, useGithub: false, run });

    assert.ok(data.installed["desk.ts"] > 0);
    assert.equal(data.installed["team.ts"], null);
});

test("loadData reads Odrade's notes through the read-only git wrapper", () => {
    const { pocketDir, odradeDir, calls, run } = setup();
    const data = loadData({ pocketDir, odradeDir, now: NOW, hours: 24, useGithub: false, run });

    assert.deepEqual(data.odrade.reports.sort(), ["2026-10-22-a", "2026-10-23-daily-audit"]);
    assert.equal(data.odrade.readme, "see reports/2026-10-22-a");
    assert.deepEqual(data.odrade.dirty, [" M plans/x.md", "?? reports/2026-10-23-daily-audit/"]);
    assert.equal(data.odrade.lastCommitAt, NOW - 5 * HOUR);

    // Only git, only log and status, always with the locks off and in Odrade's folder.
    assert.deepEqual(
        calls.map((call) => [call.command, call.args[0], call.args[1], call.args[2], call.args[3]]),
        [
            ["git", "--no-optional-locks", "-C", odradeDir, "status"],
            ["git", "--no-optional-locks", "-C", odradeDir, "log"],
        ],
    );
});

test("a missing source is reported by name and does not stop the load", () => {
    const root = tmp();
    const none = loadData({
        pocketDir: path.join(root, "nowhere"),
        odradeDir: path.join(root, "nowhere"),
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
    const { pocketDir, odradeDir, run } = setup();
    const db = new DatabaseSync(path.join(pocketDir, "pocket.sqlite"));

    db.exec("delete from documents where kind='\"x.desk.threads\"'");
    db.close();

    const data = loadData({ pocketDir, odradeDir, now: NOW, hours: 24, useGithub: false, run });

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
    assert.deepEqual(calls[0], ["--no-optional-locks", "-C", "/x", "status", "--porcelain"]);
});

test("readOdrade reads the index, the reports, the dirty files and the last commit", () => {
    const { odradeDir, run } = setup();
    const notes = readOdrade(odradeDir, makeGit(run));

    assert.equal(notes.reports.length, 2);
    assert.equal(notes.dirty.length, 2);
    assert.equal(notes.lastCommitAt, NOW - 5 * HOUR);
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
    const { pocketDir, odradeDir } = setup();
    const data = loadData({
        pocketDir,
        odradeDir,
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
    const { pocketDir, odradeDir } = setup();
    const refs = Array.from({ length: 2000 }, (_, i) => `acme/w${i}#1`);
    const fake = fakeGh(refs);
    const data = loadData({
        pocketDir,
        odradeDir,
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
