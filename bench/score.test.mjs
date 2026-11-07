// The scorer: S0 from the tries' events, S1 and S2 in copies of the submitted tree (which never changes), the
// judges through a fake `pi` behind the fake bwrap (a grade, an unparsable answer, a later judgment of a pending
// judge, a diff cut), and a budget refusal. No network, no model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { readSpend, setBudget } from "./lib/budget.mjs";
import { overlayFiles } from "./lib/gitfiles.mjs";
import { scratchClone } from "./lib/clone.mjs";
import { EventEmitter } from "node:events";
import {
    JUDGES,
    JUDGE_MESSAGE,
    PROMPT_FILE,
    cutDiff,
    judgeCommand,
    parseAnswer,
    renderPrompt,
    runJudge,
} from "./lib/judge.mjs";
import { authPreflight, authPreflightArgs } from "./lib/runner.mjs";
import { hostGit, s0Of, scoreMain, toolCalls } from "./lib/score.mjs";
import { FAKE_BWRAP, bwrapWorks, git, makeFixture } from "./fixtures/helpers.mjs";
import { makeExtraRepo, makeNodeRepo } from "./fixtures/harvest.mjs";

const REPO = "bketelsen/pi-pocket-team";
const NOW = Date.UTC(2026, 10, 7, 12, 0);
const GOOD = (grade) => JSON.stringify({ grade, reasons: "fine" });
let fixture;
let node;

before(() => {
    fixture = makeFixture();
    node = makeNodeRepo(join(fixture.root, "node-repo"));
});

after(() => rm(fixture.root, { recursive: true, force: true }));

/** The task of the fixture PR; the judges' answers go in the brief as a fake-pi scenario. */
const taskOf = (id, answers, extra = {}) => ({
    id,
    repo: REPO,
    thread: "T1",
    pr: `${REPO}#10`,
    parent: node.parent,
    merge: node.merge,
    brief: `Fix add in lib.mjs.\nSCENARIO ${JSON.stringify({ name: "judge", answers, log: join(fixture.root, `${id}.judges.log`) })}`,
    briefSource: "delegation",
    setup: "true",
    check: "PI_POCKET_CHECKOUT=/pocket make test",
    hiddenTests: [
        { file: "add.test.mjs", names: ["adds"] },
        { file: "fixtures/data.json", names: [] },
        { file: "mul.test.mjs", names: [] },
    ],
    hiddenCommand: "node --test --test-name-pattern='^(?:adds)$' 'add.test.mjs'",
    size: 31,
    features: null,
    owner: { keep: true, reason: "", scopeMatches: true, commandsConfirmed: true },
    ...extra,
});

/**
 * An attempt of `task` in its own data dir: a scratch clone at the parent with `change` applied (files), its events
 * (Pi JSON lines) in `try-1/events.jsonl`, a manifest and a result file. Returns the paths.
 */
async function attempt(
    task,
    {
        change = {},
        events = [],
        events2 = null,
        prepare = null,
        result = {},
        budget = 100,
        repo = node,
    } = {},
) {
    const root = join(fixture.root, task.id);
    const data = join(root, "data");
    const tryDir = join(data, "runs", "stage1", task.id, "github-copilot__gpt-6-luna", "try-1");
    const work = join(tryDir, "work");

    mkdirSync(join(tryDir, "cache"), { recursive: true });
    await scratchClone({ checkout: repo.repo, work, parent: repo.parent, merge: repo.merge });

    for (const [file, text] of Object.entries(change)) {
        writeFileSync(join(work, file), text);
    }

    writeFileSync(
        join(tryDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    // A second try: its own Pi run, with its own events.
    if (events2) {
        mkdirSync(join(tryDir, "..", "try-2"), { recursive: true });
        writeFileSync(
            join(tryDir, "..", "try-2", "events.jsonl"),
            events2.map((e) => JSON.stringify(e)).join("\n") + "\n",
        );
    }

    if (prepare) {
        await prepare(work);
    }

    const manifest = join(root, "manifest.json");

    writeFileSync(manifest, JSON.stringify({ schema: 1, checkout: repo.repo, tasks: [task] }));

    const file = join(root, "results", "github-copilot__gpt-6-luna.json");

    mkdirSync(join(root, "results"), { recursive: true });
    writeFileSync(
        file,
        JSON.stringify({
            task: task.id,
            model: "github-copilot/gpt-6-luna",
            stage: "stage1",
            thinking: "high",
            headerVersion: 1,
            startedAt: new Date(NOW).toISOString(),
            wallMs: 1000,
            tries: 1,
            harness: false,
            failure: null,
            usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                tokens: 15,
                cost: 0.5,
                partial: false,
            },
            workDir: work,
            s0: null,
            s1: null,
            s2: null,
            grades: null,
            diffCut: null,
            judgePending: null,
            tryLog: events2
                ? [
                      { try: 1, outcome: "provider" },
                      { try: 2, outcome: "ok" },
                  ]
                : [{ try: 1, outcome: "ok" }],
            ...result,
        }),
    );
    await setBudget(data, budget);

    return { root, data, work, manifest, file };
}

/** Run the scorer on an attempt. */
const score = (paths, extra = [], deps = {}) => {
    const lines = [];

    return scoreMain(
        [
            "--result",
            paths.file,
            "--manifest",
            paths.manifest,
            "--bwrap",
            FAKE_BWRAP,
            "--pocket",
            fixture.pocket,
            "--agent-src",
            fixture.agent,
            "--no-auth-preflight",
            ...extra,
        ],
        { ...process.env, BENCH_DATA: paths.data },
        { now: () => NOW, log: (line) => lines.push(line), killGraceMs: 2000, ...deps },
    ).then((code) => ({ code, lines, result: JSON.parse(readFileSync(paths.file, "utf8")) }));
};

/** A hash of every file of a tree (`.git` included): its paths, modes, contents and link targets. */
function treeHash(dir) {
    const hash = createHash("sha256");

    const walk = (folder) => {
        for (const name of readdirSync(folder).sort()) {
            const path = join(folder, name);
            const info = lstatSync(path);

            hash.update(`${relative(dir, path)}\0${info.mode}\0${info.mtimeMs}\0`);

            if (info.isSymbolicLink()) {
                hash.update(readlinkSync(path));
            } else if (info.isDirectory()) {
                walk(path);
            } else {
                hash.update(readFileSync(path));
            }
        }
    };

    walk(dir);

    return hash.digest("hex");
}

const FIX = { "lib.mjs": "export const add = (a, b) => a + b;\n", "notes.txt": "a new file\n" };

/** A tool call of Pi's JSON stream. */
const toolStart = (id, toolName, args) => ({
    type: "tool_execution_start",
    toolCallId: id,
    toolName,
    args,
});

test("S0: reading /agent/auth.json (read or bash) fails the attempt; GitHub tries are flagged", () => {
    const calls = (events) => toolCalls(events.map((e) => JSON.stringify(e)).join("\n"));
    const facts = { prNumber: 10, repo: REPO, module: "example.com/mod" };

    assert.deepEqual(s0Of(calls([toolStart("1", "read", { path: "/agent/auth.json" })]), facts), {
        protocol: true,
        leakTry: false,
    });
    assert.deepEqual(s0Of(calls([toolStart("1", "read", { path: "../agent/auth.json" })]), facts), {
        protocol: true,
        leakTry: false,
    });
    assert.deepEqual(
        s0Of(
            calls([toolStart("1", "bash", { command: "cat $PI_CODING_AGENT_DIR/auth.json" })]),
            facts,
        ),
        { protocol: true, leakTry: false },
    );
    assert.deepEqual(
        s0Of(
            calls([
                {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "2",
                                name: "bash",
                                arguments: { command: "head -c 99 /agent/auth.json" },
                            },
                        ],
                    },
                },
            ]),
            facts,
        ),
        { protocol: true, leakTry: false },
    );

    for (const command of [
        "git fetch origin pull/10/head",
        "curl https://github.com/bketelsen/pi-pocket-team/commits",
        "go get example.com/mod@latest",
    ]) {
        assert.deepEqual(
            s0Of(calls([toolStart("1", "bash", { command })]), facts),
            {
                protocol: false,
                leakTry: true,
            },
            command,
        );
    }

    for (const command of [
        "git pull --help 100",
        "ls /agent",
        "cat github.com/bketelsen/pi-pocket-team-x",
    ]) {
        assert.deepEqual(
            s0Of(calls([toolStart("1", "bash", { command })]), facts),
            {
                protocol: false,
                leakTry: false,
            },
            command,
        );
    }
});

test("a protocol breach: failure protocol, S1 to S3 skipped", async () => {
    const task = taskOf("protocol", { default: [GOOD(4)] });
    const paths = await attempt(task, {
        change: FIX,
        events: [
            toolStart("a", "bash", { command: "gh pr view 10 --json url; git pull" }),
            toolStart("b", "read", { path: "/agent/auth.json" }),
        ],
    });
    const { code, result } = await score(paths);

    assert.equal(code, 0);
    assert.deepEqual(result.s0, { protocol: true, leakTry: true });
    assert.equal(result.failure, "protocol");
    assert.equal(result.s1, null);
    assert.equal(result.s2, null);
    assert.equal(result.grades, null);
    assert.equal(result.judgePending, false);
    assert.equal(result.usage.cost, 0.5);
});

test("a full score: S1 and S2 in copies (the submitted tree never changes), both judges' grades", async () => {
    const answers = { [JUDGES[0]]: [GOOD(4)], [JUDGES[1]]: ["```json\n" + GOOD(3) + "\n```"] };
    const task = taskOf("full", answers);
    const paths = await attempt(task, { change: FIX });
    const before = treeHash(paths.work);
    const { code, result } = await score(paths);

    assert.equal(code, 0);
    assert.equal(treeHash(paths.work), before, "the submitted tree is unchanged, .git included");
    assert.deepEqual(result.s0, { protocol: false, leakTry: false });
    assert.equal(result.s1, true);
    assert.equal(result.s2, true);
    assert.deepEqual(result.grades, [4, 3]);
    assert.equal(result.judgePending, false);
    assert.equal(result.diffCut, false);
    assert.deepEqual(
        result.judges.map((j) => [j.model, j.grade, j.tries, j.pending]),
        [
            [JUDGES[0], 4, 1, false],
            [JUDGES[1], 3, 1, false],
        ],
    );
    assert.equal(result.usage.cost, 0.5, "the judge cost is not the attempt's");

    const diff = readFileSync(result.diffFile, "utf8");

    assert.match(diff, /\+export const add = \(a, b\) => a \+ b;/);
    assert.match(diff, /notes\.txt/, "an untracked file is part of the diff");

    const spend = await readSpend(paths.data);

    assert.deepEqual(
        spend.entries.map((e) => [e.model, e.cost]),
        [
            [JUDGES[0], 0.02],
            [JUDGES[1], 0.02],
        ],
    );
    assert.equal(spend.reservations.length, 0);

    // Scored already: a second run does nothing.
    const again = await score(paths);

    assert.equal(again.code, 0);
    assert.equal(
        readFileSync(join(fixture.root, "full.judges.log"), "utf8").split("\n").filter(Boolean)
            .length,
        2,
    );
});

test("a wrong change fails S1 or S2; the tree with no fix fails S2", async () => {
    const task = taskOf("nofix", { default: [GOOD(1)] });
    const paths = await attempt(task, { change: { "notes.txt": "only notes\n" } });
    const { result } = await score(paths);

    assert.equal(result.s1, true);
    assert.equal(result.s2, false);
    assert.match(
        readFileSync(
            join(paths.data, "score", "stage1", "nofix", "github-copilot__gpt-6-luna.score.log"),
            "utf8",
        ),
        /^--- S2, the hidden command failed \(exit 1\): the last \d+ lines of its stdout ---$/m,
    );
    assert.deepEqual(result.grades, [1, 1]);
});

test("an unparsable answer: 3 tries, then the judge is pending with a null grade; a later run judges it", async () => {
    const answers = {
        [JUDGES[0]]: ["no json here", '{"grade": 7, "reasons": "x"}', '{"grade": 2}', GOOD(2)],
        [JUDGES[1]]: [GOOD(3)],
    };
    const task = taskOf("pending", answers);
    const paths = await attempt(task, { change: FIX });
    const first = await score(paths);

    assert.equal(first.code, 0);
    assert.deepEqual(first.result.grades, [null, 3]);
    assert.equal(first.result.judgePending, true);
    assert.equal(first.result.judges[0].tries, 3);
    assert.equal(first.result.judges[0].pending, true);

    // The pending judge runs again (its 4th try parses); the other judge does not.
    const second = await score(paths);

    assert.equal(second.code, 0);
    assert.deepEqual(second.result.grades, [2, 3]);
    assert.equal(second.result.judgePending, false);
    assert.equal(second.result.judges[0].tries, 4);

    const log = readFileSync(join(fixture.root, "pending.judges.log"), "utf8")
        .split("\n")
        .filter(Boolean);

    assert.deepEqual(log, [
        `${JUDGES[0]} 1`,
        `${JUDGES[0]} 2`,
        `${JUDGES[0]} 3`,
        `${JUDGES[1]} 1`,
        `${JUDGES[0]} 4`,
    ]);
});

test("a diff over 60,000 characters is cut, with its stat, and sets diffCut", async () => {
    const task = taskOf("cut", { default: [GOOD(3)] });
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const paths = await attempt(task, { change: { ...FIX, "big.txt": big } });
    const { result } = await score(paths);

    assert.equal(result.diffCut, true);
    assert.equal(result.referenceCut, false);

    const prompt = readFileSync(
        join(
            paths.data,
            "judges",
            "stage1",
            "cut",
            "github-copilot__gpt-6-luna",
            JUDGES[0].replaceAll("/", "__"),
            "try-1",
            "work",
            "judge-prompt.md",
        ),
        "utf8",
    );

    assert.match(prompt, /The submitted diff is longer than 60000 characters/);
    assert.match(prompt, /big\.txt +\| 3000 \+{10,}/);
    assert.doesNotMatch(prompt, /gpt-6-luna/, "no model name in the judge's input");
});

test("a budget refusal exits 2 and leaves the judges pending", async () => {
    const task = taskOf("budget", { default: [GOOD(4)] });
    const paths = await attempt(task, { change: FIX, budget: 0.5 });
    const { code, result } = await score(paths);

    assert.equal(code, 2);
    assert.deepEqual(result.grades, [null, null]);
    assert.equal(result.judgePending, true);
    assert.equal(result.s1, true, "S1 and S2 are kept");
    assert.deepEqual(
        result.judges.map((j) => j.pending),
        [true, true],
    );
});

test("judge input and answers: the rubric prompt, a fenced answer, a bad grade", () => {
    const template = readFileSync(join(import.meta.dirname, "judge-v1.md"), "utf8");

    for (const line of [
        "- 0: no change, or the build breaks.",
        "- 1: wrong approach.",
        "- 2: right approach, needs major fixes.",
        "- 3: acceptable with minor fixes.",
        "- 4: mergeable as it is.",
    ]) {
        assert.ok(template.includes(line), line);
    }

    assert.match(template, /1 accepted solution, not the only one/);

    const prompt = renderPrompt(template, {
        brief: "Do $& {{S1}}",
        s1: true,
        s2: null,
        submitted: cutDiff("diff a", ""),
        reference: cutDiff("diff b", ""),
    });

    assert.match(prompt, /Do \$& \{\{S1\}\}/, "a value is put in as it is");
    assert.match(prompt, /S1, the repository's own check on the submitted tree: passed/);
    assert.match(prompt, /none: this task has no hidden test/);
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
    assert.deepEqual(parseAnswer('```\n{"grade": 0, "reasons": ""}\n```'), {
        grade: 0,
        reasons: "",
    });
    assert.equal(parseAnswer('{"grade": 2.5, "reasons": "x"}'), null);
    assert.deepEqual(parseAnswer('Here: {"grade": 2, "reasons": "x"}'), { grade: 2, reasons: "x" });
    assert.equal(parseAnswer(""), null);
});

test("usage errors exit 1: no result, a task in no manifest", async () => {
    const quiet = { log: () => {} };

    assert.equal(await scoreMain([], process.env, quiet), 1);

    const file = join(fixture.root, "orphan.json");

    writeFileSync(file, JSON.stringify({ task: "nowhere", stage: "stage1", workDir: "/x" }));
    assert.equal(
        await scoreMain(
            ["--result", file, "--bwrap", FAKE_BWRAP],
            { ...process.env, BENCH_DATA: join(fixture.root, "empty") },
            quiet,
        ),
        1,
    );
});

test("a judge's answer: exactly 1 valid candidate (the whole text, else 1 fence, else 1 top-level object)", () => {
    const prose =
        'This file is a self-contained grading prompt. Here is the result of applying it:\n\n```json\n{ "grade": 3, "reasons": "Fixes the sum {and} keeps the API." }\n```\n\nIf you wanted something else, tell me.';

    assert.deepEqual(parseAnswer(prose), {
        grade: 3,
        reasons: "Fixes the sum {and} keeps the API.",
    });
    assert.equal(
        parseAnswer('First {"grade": 3, "reasons": "a"} then {"grade": 1, "reasons": "b"}.'),
        null,
        "2 different objects",
    );
    assert.equal(
        parseAnswer(
            '```json\n{"grade": 3, "reasons": "a"}\n```\nor\n```json\n{"grade": 4, "reasons": "b"}\n```',
        ),
        null,
        "2 valid fences",
    );
    assert.equal(
        parseAnswer('Result:\n```json\n{"grade": 5, "reasons": "too high"}\n```'),
        null,
        "a fence with a bad grade",
    );
    assert.equal(parseAnswer("No grade here."), null);
    assert.deepEqual(parseAnswer('{"grade": 4, "reasons": "a } in a string"}'), {
        grade: 4,
        reasons: "a } in a string",
    });
});

test("the judge command: the prompt file, then the message that asks for the answer", () => {
    const command = judgeCommand(JUDGES[1]);

    assert.deepEqual(command.slice(-2), [`@/work/${PROMPT_FILE}`, JUDGE_MESSAGE]);
    assert.ok(command.includes("--no-tools"));
    assert.ok(JUDGE_MESSAGE.length < 200);
});

/** A spawn that records its argv and exits with `code`. */
const fakeSpawn = (calls, code) => (bin, args) => {
    const child = new EventEmitter();

    calls.push(args);
    setImmediate(() => child.emit("close", code));

    return child;
};

test("the auth pre-flight: the runner asks for 60 minutes of token life, a judge for 30", async () => {
    const runnerCalls = [];

    assert.equal(
        await authPreflight(
            { pocket: "/p", provider: "openai", agentSrc: "/a" },
            { spawn: fakeSpawn(runnerCalls, 0) },
        ),
        true,
    );
    assert.deepEqual(runnerCalls[0].slice(-4), ["--provider", "openai", "--min-expiry", "60m"]);
    assert.deepEqual(authPreflightArgs({ pocket: "/p", provider: "x" }).slice(-2), [
        "--min-expiry",
        "60m",
    ]);

    const data = join(fixture.root, "preflight-data");
    const agent = join(fixture.root, "preflight-agent");
    const judgeCalls = [];
    const lines = [];

    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
    writeFileSync(join(agent, "models.json"), "{}\n");
    await setBudget(data, 10);

    const verdict = await runJudge(
        {
            data,
            bwrap: FAKE_BWRAP,
            pocket: fixture.pocket,
            agentSrc: agent,
            miseInstalls: join(fixture.root, "no-mise"),
            authPreflight: true,
            spawn: fakeSpawn(judgeCalls, 1),
            log: (line) => lines.push(line),
        },
        { model: JUDGES[0], prompt: "p", dir: join(data, "judge"), task: "t", stage: "stage1" },
    );

    assert.equal(judgeCalls.length, 3, "1 pre-flight per try");

    for (const args of judgeCalls) {
        assert.deepEqual(args.slice(-4), ["--provider", "openai", "--min-expiry", "30m"]);
    }

    assert.equal(verdict.pending, true);
    assert.ok(lines.every((line) => /auth pre-flight failed/.test(line)));
});

test("S0 reads each try on its own: an auth read in try 2 with the call id of an ordinary call in try 1 counts", async () => {
    const task = taskOf("two-tries", { default: [GOOD(4)] });
    const paths = await attempt(task, {
        change: FIX,
        events: [toolStart("call_1", "bash", { command: "ls" })],
        events2: [toolStart("call_1", "read", { path: "/agent/auth.json" })],
    });
    const { code, result } = await score(paths);

    assert.equal(code, 0);
    assert.deepEqual(result.s0, { protocol: true, leakTry: false });
    assert.equal(result.failure, "protocol");
});

/**
 * A submitted tree whose git config runs commands: a clean filter on every file and an fsmonitor hook. Each writes
 * `sentinel` when it runs. `markOnly`: write it only when the variable `BENCH_HOST_MARK` is set (the test sets it in
 * its own environment, which host git inherits and the sandbox's cleared environment does not).
 */
function hostileGit(work, sentinel, { markOnly }) {
    const guard = markOnly ? `[ -n "$BENCH_HOST_MARK" ] && ` : "";
    const hook = join(work, ".git", "fsmonitor-hook");

    writeFileSync(hook, `#!/bin/sh\n${guard}touch '${sentinel}.fsmonitor'\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(work, "config", "filter.x.clean", `sh -c '${guard}touch "${sentinel}.filter"; cat'`);
    git(work, "config", "core.fsmonitor", hook);
    writeFileSync(join(work, ".gitattributes"), "* filter=x\n");
}

test("the submitted diff runs git only in the sandbox: host git never runs in a worker's tree", async (t) => {
    const task = taskOf("hostile-git", { default: [GOOD(3)] });
    const sentinel = join(fixture.root, "hostile-git-ran");
    const paths = await attempt(task, {
        change: FIX,
        prepare: (work) => hostileGit(work, sentinel, { markOnly: true }),
    });
    const cwds = [];

    process.env.BENCH_HOST_MARK = "1";
    t.after(() => delete process.env.BENCH_HOST_MARK);

    const { code, result } = await score(paths, [], {
        git: (cwd, args) => {
            cwds.push(cwd);

            return hostGit(cwd, args);
        },
    });

    assert.equal(code, 0);
    assert.equal(existsSync(`${sentinel}.filter`), false, "no clean filter ran on the host");
    assert.equal(existsSync(`${sentinel}.fsmonitor`), false, "no fsmonitor ran on the host");
    assert.ok(cwds.length > 0);
    assert.deepEqual([...new Set(cwds)], [node.repo], "host git runs only in the local checkout");
    assert.match(readFileSync(result.diffFile, "utf8"), /\+export const add = \(a, b\) => a \+ b;/);
});

const skipBwrap = bwrapWorks() ? false : "bwrap cannot run here (missing, or no user namespaces)";

test(
    "real bwrap: a worker's clean filter and fsmonitor reach no host file",
    { skip: skipBwrap },
    async () => {
        const task = taskOf("hostile-git-bwrap", { default: [GOOD(3)] });
        const sentinel = join(fixture.root, "hostile-git-bwrap-ran");
        const paths = await attempt(task, {
            change: FIX,
            prepare: (work) => hostileGit(work, sentinel, { markOnly: false }),
        });
        const { code, result } = await score(paths, ["--bwrap", "bwrap"]);

        assert.equal(code, 0, JSON.stringify(result));
        assert.equal(existsSync(`${sentinel}.filter`), false);
        assert.equal(existsSync(`${sentinel}.fsmonitor`), false);
        assert.equal(result.s1, true);
        assert.equal(typeof result.diffFile, "string");
    },
);

test(
    "real bwrap: S2's copy of the hidden tests follows no symbolic link out of the copy",
    { skip: skipBwrap },
    async () => {
        const sentinel = join(fixture.root, "s2-sentinel.txt");

        writeFileSync(sentinel, "keep\n");

        // A hidden-test path that is a link to a host file.
        const fileLink = await attempt(taskOf("s2-file-link", { default: [GOOD(3)] }), {
            change: FIX,
            prepare: (work) => symlinkSync(sentinel, join(work, "add.test.mjs")),
        });
        // A folder of a hidden-test path that is a link to the original submitted tree.
        let original;
        const dirLink = await attempt(taskOf("s2-dir-link", { default: [GOOD(3)] }), {
            change: FIX,
            prepare: (work) => {
                original = work;
                symlinkSync(work, join(work, "fixtures"));
            },
        });
        const before = treeHash(original);

        for (const paths of [fileLink, dirLink]) {
            const { code } = await score(paths, ["--bwrap", "bwrap"]);

            assert.equal(code, 0);
        }

        assert.equal(readFileSync(sentinel, "utf8"), "keep\n", "the host file is unchanged");
        assert.equal(treeHash(original), before, "the submitted tree is unchanged");
        assert.equal(existsSync(join(original, "data.json")), false);
    },
);

test("the host overlay (the harvester's own trees) refuses a path through a symbolic link", async () => {
    const work = join(fixture.root, "overlay-link");
    const outside = join(fixture.root, "overlay-outside");

    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(work, "fixtures"));
    await assert.rejects(
        overlayFiles({ checkout: node.repo, rev: node.merge, files: ["fixtures/data.json"], work }),
        /symbolic link/,
    );
    assert.equal(existsSync(join(outside, "data.json")), false);
});

test("the submitted diff uses trusted git metadata: the worker's clean filter and `-diff` change nothing", async () => {
    const task = taskOf("trusted-diff", { default: [GOOD(3)] });
    const paths = await attempt(task, {
        change: FIX,
        prepare: (work) => {
            git(work, "config", "filter.x.clean", "sh -c 'echo REPLACED'");
            writeFileSync(join(work, ".gitattributes"), "* filter=x -diff\n");
        },
    });
    const { code, result } = await score(paths);
    const diff = readFileSync(result.diffFile, "utf8");

    assert.equal(code, 0);
    assert.match(diff, /^\+export const add = \(a, b\) => a \+ b;$/m, "the real content is judged");
    assert.match(diff, /^\+a new file$/m);
    assert.match(
        diff,
        /^\+\* filter=x -diff$/m,
        "the worker's .gitattributes is a plain file of the change",
    );
    assert.doesNotMatch(diff, /REPLACED/);
    assert.doesNotMatch(diff, /^Binary files/m);
});

test("a broken worker index (a lock and a corrupt index) does not stop the diff or the grades", async () => {
    const task = taskOf("broken-index", { default: [GOOD(3)] });
    const paths = await attempt(task, {
        change: FIX,
        prepare: (work) => {
            writeFileSync(join(work, ".git", "index.lock"), "");
            writeFileSync(join(work, ".git", "index"), "not an index");
        },
    });
    const { code, result } = await score(paths);

    assert.equal(code, 0);
    assert.deepEqual(result.grades, [3, 3]);
    assert.match(readFileSync(result.diffFile, "utf8"), /\+export const add/);
    assert.equal(result.scoreError, undefined);
});

test("a scoring error after S0 saves S0 to S2 with scoreError and exits 3; a later run finishes and clears it", async () => {
    const task = taskOf("score-error", { default: [GOOD(4)] });
    const paths = await attempt(task, { change: FIX });
    const failed = await score(paths, [], {
        submittedDiff: async () => {
            throw new Error("the submitted diff failed (timed out)\nmore");
        },
    });

    assert.equal(failed.code, 3);
    assert.deepEqual(failed.result.s0, { protocol: false, leakTry: false });
    assert.equal(failed.result.s1, true);
    assert.equal(failed.result.s2, true);
    assert.equal(failed.result.judgePending, true);
    assert.equal(failed.result.scoreError, "the submitted diff failed (timed out)");

    const again = await score(paths);

    assert.equal(again.code, 0);
    assert.deepEqual(again.result.grades, [4, 4]);
    assert.equal(again.result.judgePending, false);
    assert.equal("scoreError" in again.result, false);
    assert.match(readFileSync(again.result.diffFile, "utf8"), /\+export const add/);
});

test("S2 keeps the reference's file modes: an executable support script runs", async () => {
    const extra = makeExtraRepo(join(fixture.root, "extra-repo"));
    const task = taskOf(
        "exec-support",
        { default: [GOOD(3)] },
        {
            parent: extra.parent,
            merge: extra.merge,
            check: "true",
            hiddenTests: [
                { file: "fixtures/sum.sh", names: [] },
                { file: "tool.test.mjs", names: ["tool"] },
            ],
            hiddenCommand: "node --test --test-name-pattern='^(?:tool)$' 'tool.test.mjs'",
        },
    );
    let original;
    const paths = await attempt(task, {
        repo: extra,
        change: FIX,
        prepare: (work) => {
            original = work;
        },
    });
    const before = treeHash(original);
    const { code, result } = await score(paths);

    assert.equal(code, 0);
    assert.equal(result.s2, true, result.s2Detail);
    assert.equal(treeHash(original), before, "the submitted tree is unchanged");
});
