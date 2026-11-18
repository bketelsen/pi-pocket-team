// Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "./_pocket/src/server/http.ts";
import type { Host } from "./_pocket.d.ts";
import createTeam, * as teamModule from "./team.ts";
import {
    type CiCommandResult,
    type CiRunner,
    delegationWorktree,
    FRONT_DOOR_DESK_OFF,
    Identity,
    identityText,
    MESSAGE_LIMITS,
    pickSupervisor,
    PLANNING_ASK_EXCEPTION,
    roster,
    teamMessageProblems,
    linkedSend,
} from "./team.ts";

/** A reverted Team module must fail an assertion about the blocking CI wait, not fail module loading. */
async function waitForCi(...args: Parameters<typeof teamModule.waitForCi>): Promise<string> {
    assert.equal(
        typeof teamModule.waitForCi,
        "function",
        "Team must provide the blocking CI wait through waitForCi.",
    );

    return await teamModule.waitForCi(...args);
}

const ciUrl = "https://github.com/example/repo/pull/12";
const ciRepo = "github.com/example/repo";
const ciWhere = ["12", "--repo", ciRepo];
const ciView = ["pr", "view", "--json", "number,url,headRefOid,baseRefName"];
const ciConfirm = ["pr", "view", ...ciWhere, "--json", "headRefOid,baseRefName"];
const ciRules = ["api", "repos/example/repo/rules/branches/main"];
const ciRuns = (head = "head-a") => [
    "run",
    "list",
    "--repo",
    ciRepo,
    "--commit",
    head,
    "--limit",
    "1000",
    "--json",
    "status,conclusion",
];
const ciChecks = ["pr", "checks", ...ciWhere, "--required", "--json", "name,bucket,link"];
const ciAllChecks = ["pr", "checks", ...ciWhere, "--json", "name,bucket,link"];
const ciJson = (value: unknown, code = 0): CiCommandResult => ({
    code,
    stdout: JSON.stringify(value),
    stderr: "",
});
const ciPr = (head = "head-a", base = "main") =>
    ciJson({ number: 12, url: ciUrl, headRefOid: head, baseRefName: base });
const ciHead = (head = "head-a", base = "main") => ciJson({ headRefOid: head, baseRefName: base });
const ciCheck = (bucket: string, name = "Test", link = "") => ({ name, bucket, link });

const ciRuleNames = (...contexts: string[]) =>
    ciJson([
        {
            type: "required_status_checks",
            parameters: { required_status_checks: contexts.map((context) => ({ context })) },
        },
    ]);
const ciPassGates = (head = "head-a", readRules = true) => [
    ...(readRules ? [{ args: ciRules, result: ciRuleNames("Test") }] : []),
    { args: ciRuns(head), result: ciJson([{ status: "completed", conclusion: "success" }]) },
    { args: ciConfirm, result: ciHead(head) },
];

/** Exact command scripts and an injected monotonic clock: no GitHub calls and no timer sleeps. */
function ciFixture(
    steps: { args: string[]; result: CiCommandResult; elapsed?: number; tail?: boolean }[],
    signal?: AbortSignal,
) {
    let time = 0;
    let calls = 0;
    const waits: number[] = [];
    const observed: {
        args: string[];
        cwd: string;
        timeoutMs: number;
        tail?: boolean;
        signal?: AbortSignal;
    }[] = [];

    const run: CiRunner = async (args, options) => {
        const step = steps[calls++];

        observed.push({ args, ...options });
        assert(step, `Unexpected gh call: ${JSON.stringify(args)}`);
        time += step.elapsed ?? 0;

        return step.result;
    };

    return {
        deps: {
            run,
            signal,
            now: () => time,
            wait: async (ms: number) => {
                waits.push(ms);
                time += ms;
            },
        },
        waits,
        done: () => {
            // Check outside waitForCi: its ERROR result must not hide a failed fixture assertion.
            assert.equal(calls, steps.length, "Every scripted command ran exactly once");
            assert.deepEqual(
                observed.map((call) => call.args),
                steps.map((step) => step.args),
            );

            for (const [index, call] of observed.entries()) {
                assert.equal(call.cwd, "/session/current-folder");
                assert.equal(call.tail, steps[index]!.tail ?? false);
                assert.equal(call.signal, signal);
                assert(call.timeoutMs > 0 && call.timeoutMs <= 30_000);
            }
        },
    };
}

test("CI wait: no checks and pending checks wait; pass/skipping need same-head confirmation", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        { args: ciChecks, result: ciJson([]) },
        { args: ciConfirm, result: ciHead() },
        { args: ciChecks, result: ciJson([ciCheck("pending")], 8) },
        { args: ciConfirm, result: ciHead() },
        { args: ciChecks, result: ciJson([ciCheck("pass"), ciCheck("skipping", "Optional")]) },
        { args: ciConfirm, result: ciHead() },
        ...ciPassGates(),
    ]);
    const result = await waitForCi("/session/current-folder", {}, fixture.deps);

    assert.match(
        result,
        /^PASS: github.com\/example\/repo#12 \(head-a\); all required checks passed or skipped\.$/,
    );
    assert.deepEqual(fixture.waits, [30_000, 60_000]);
    fixture.done();
});

test("CI wait: no rows, no checks yet, and unknown buckets time out, never pass", async () => {
    for (const result of [
        ciJson([]),
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "no checks reported on the 'feature' branch\n" },
        ciJson([ciCheck("pending")], 8),
        ciJson([ciCheck("unknown")]),
    ]) {
        const observations = Array.from({ length: 2 }, () => [
            { args: ciChecks, result },
            { args: ciConfirm, result: ciHead() },
        ]).flat();
        const fixture = ciFixture([{ args: ciView, result: ciPr() }, ...observations]);
        const text = await waitForCi(
            "/session/current-folder",
            { timeout_minutes: 1 },
            fixture.deps,
        );

        assert.match(text, /^TIMEOUT:/);
        assert.doesNotMatch(text, /PASS/);
        assert.deepEqual(fixture.waits, [30_000, 30_000]);
        fixture.done();
    }
});

test("CI wait: polling backs off exactly 30s, 60s, then 90s and stays at 90s", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        ...Array.from({ length: 6 }, () => [
            { args: ciChecks, result: ciJson([ciCheck("pending")], 8) },
            { args: ciConfirm, result: ciHead() },
        ]).flat(),
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead() },
        ...ciPassGates(),
    ]);

    assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^PASS:/);
    assert.deepEqual(fixture.waits, [30_000, 60_000, 90_000, 90_000, 90_000, 90_000]);
    fixture.done();
});

test("CI wait: same-head no checks return NO CHECKS after 5 minutes, including the all-checks fallback", async () => {
    const noRequired = {
        code: 1,
        stdout: "",
        stderr: "no required checks reported on the 'main' branch\n",
    };
    const fixture = ciFixture([
        // PR resolution time is not time spent observing an empty check set.
        { args: ciView, result: ciPr(), elapsed: 200_000 },
        ...Array.from({ length: 6 }, () => [
            { args: ciChecks, result: noRequired },
            { args: ciRules, result: ciJson([]) },
            { args: ciAllChecks, result: ciJson([]) },
            { args: ciConfirm, result: ciHead() },
        ]).flat(),
    ]);

    assert.match(
        await waitForCi("/session/current-folder", {}, fixture.deps),
        /^NO CHECKS:.*\(head-a\)/,
    );
    assert.deepEqual(fixture.waits, [30_000, 60_000, 90_000, 90_000, 90_000]);
    fixture.done();
});

test("CI wait: checks that pass before 5 minutes still pass after empty observations", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        ...Array.from({ length: 4 }, () => [
            { args: ciChecks, result: ciJson([]) },
            { args: ciConfirm, result: ciHead() },
        ]).flat(),
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead() },
        ...ciPassGates(),
    ]);

    assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^PASS:/);
    assert.deepEqual(fixture.waits, [30_000, 60_000, 90_000, 90_000]);
    fixture.done();
});

test("CI wait: a head change resets the first no-checks observation timestamp", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        ...Array.from({ length: 5 }, (_, index) => [
            { args: ciChecks, result: ciJson([]) },
            { args: ciConfirm, result: ciHead(index === 4 ? "head-b" : "head-a") },
        ]).flat(),
        ...Array.from({ length: 5 }, () => [
            { args: ciChecks, result: ciJson([]) },
            { args: ciConfirm, result: ciHead("head-b") },
        ]).flat(),
    ]);

    assert.match(
        await waitForCi("/session/current-folder", {}, fixture.deps),
        /^NO CHECKS:.*\(head-b\)/,
    );
    assert.deepEqual(
        fixture.waits,
        [30_000, 60_000, 90_000, 90_000, 90_000, 90_000, 90_000, 90_000],
    );
    fixture.done();
});

test("CI wait: abort ends an active polling wait without a real timer or a PASS result", async () => {
    assert.equal(typeof teamModule.waitForCiPoll, "function");
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    let cancellations = 0;
    const fixture = ciFixture(
        [
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pending")], 8) },
            { args: ciConfirm, result: ciHead() },
        ],
        controller.signal,
    );
    const result = waitForCi(
        "/session/current-folder",
        {},
        {
            ...fixture.deps,
            wait: (ms, signal) =>
                teamModule.waitForCiPoll(ms, signal, (_callback, interval) => {
                    assert.equal(signal, controller.signal);
                    assert.equal(interval, 30_000);
                    waiting.resolve();

                    return () => {
                        cancellations++;
                    };
                }),
        },
    );

    await waiting.promise;
    controller.abort();
    assert.match(await result, /^INTERRUPTED:/);
    assert.equal(cancellations, 1);
    fixture.done();
});

test("CI wait: abort kills and ends an active gh child without timers or network", async () => {
    assert.equal(typeof teamModule.runCiGh, "function");
    const controller = new AbortController();
    const kills: unknown[] = [];
    let cancellations = 0;
    let starts = 0;
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (signal: unknown) => {
            kills.push(signal);

            return true;
        },
    });
    const runtime = {
        spawn: ((command: string, args: string[], options: { shell: boolean; cwd: string }) => {
            starts++;
            assert.equal(command, "gh");
            assert.deepEqual(args, ciChecks);
            assert.equal(options.shell, false);
            assert.equal(options.cwd, "/session/current-folder");

            return child;
        }) as unknown as typeof import("node:child_process").spawn,
        timer: (_callback: () => void, ms: number) => {
            assert.equal(ms, 30_000);

            return () => {
                cancellations++;
            };
        },
    };
    const result = teamModule.runCiGh(
        ciChecks,
        {
            cwd: "/session/current-folder",
            timeoutMs: 30_000,
            signal: controller.signal,
        },
        runtime,
    );
    const ended = assert.rejects(result, { name: "AbortError" });

    controller.abort();
    await ended;
    assert.deepEqual(kills, ["SIGKILL"]);
    assert.equal(cancellations, 1);
    assert.equal(starts, 1);
    // A previously aborted call must not start a replacement child.
    await assert.rejects(
        teamModule.runCiGh(
            ciChecks,
            {
                cwd: "/session/current-folder",
                timeoutMs: 30_000,
                signal: controller.signal,
            },
            runtime,
        ),
        { name: "AbortError" },
    );
    assert.equal(starts, 1);
});

test("CI wait: a cancelled check fails at once, even when another check is pending", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        {
            args: ciChecks,
            result: ciJson([ciCheck("pending"), ciCheck("cancel", "Cancelled test")], 1),
        },
        { args: ciConfirm, result: ciHead() },
    ]);
    const result = await waitForCi("/session/current-folder", {}, fixture.deps);

    assert.match(result, /^FAIL:/);
    assert.match(result, /Cancelled test \(cancel\)/);
    assert.match(result, /Log unavailable: not an Actions run\/job link/);
    assert.deepEqual(fixture.waits, []);
    fixture.done();
});

test("CI wait: failing jobs include only 3 bounded log tails, with an 8000-character total", async () => {
    const failed = Array.from({ length: 4 }, (_, index) =>
        ciCheck(
            "fail",
            `job-${String(index + 1)}`,
            `https://github.com/example/repo/actions/runs/99/${index === 1 ? "job" : "jobs"}/${String(index + 1)}`,
        ),
    );
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        { args: ciChecks, result: ciJson(failed, 1) },
        { args: ciConfirm, result: ciHead() },
        ...failed.slice(0, 3).map((_check, index) => ({
            args: ["run", "view", "99", "--repo", ciRepo, "--job", String(index + 1), "--log"],
            result: {
                code: 0,
                stdout: `OMITTED-${String(index)}${"x".repeat(10_000)}TAIL-${String(index)}`,
                stderr: "",
            },
            tail: true,
        })),
    ]);
    const result = await waitForCi("/session/current-folder", {}, fixture.deps);

    assert.match(result, /^FAIL:/);
    assert(result.length <= 8000);

    for (let index = 0; index < 3; index++) {
        assert(result.includes(`TAIL-${String(index)}`));
        const section = result
            .split(`- job-${String(index + 1)} (fail)\n`)[1]!
            .split("\n- job-")[0]!;

        assert(section.length <= 3000);
    }

    assert.doesNotMatch(result, /OMITTED|job-4/);
    assert.deepEqual(fixture.waits, []);
    fixture.done();
});

test("CI wait: external, run-only and unrelated job links never become Actions job ids", async () => {
    for (const link of [
        "https://ci.example/jobs/1",
        "https://github.com/example/repo/actions/runs/99",
        "https://github.com/other/repo/actions/runs/99/jobs/1",
        "https://ci.example/example/repo/actions/runs/99/jobs/1",
        "not a URL",
    ]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("fail", "Test", link)], 1) },
            { args: ciConfirm, result: ciHead() },
        ]);

        assert.match(
            await waitForCi("/session/current-folder", {}, fixture.deps),
            /^FAIL:.*\n- Test \(fail\)\nLog unavailable:/,
        );
        fixture.done();
    }
});

test("CI wait: no PR is explicit and an auth error is not no PR", async () => {
    for (const [stderr, prefix] of [
        ["no pull requests found for branch feature", "NO PR:"],
        ["GraphQL: Could not resolve to a PullRequest", "NO PR:"],
        ["HTTP 401: Bad credentials", "ERROR:"],
    ]) {
        const fixture = ciFixture([
            { args: ciView, result: { code: 1, stdout: "", stderr: stderr! } },
        ]);
        const text = await waitForCi("/session/current-folder", {}, fixture.deps);

        assert(text.startsWith(prefix!));
        assert.doesNotMatch(text, /PASS/);
        fixture.done();
    }
});

test("CI wait: only stderr's no-required-checks message enables the all-checks fallback", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        {
            args: ciChecks,
            result: {
                code: 1,
                stdout: "",
                stderr: "no required checks reported on the 'main' branch\n",
            },
        },
        { args: ciRules, result: ciJson([]) },
        { args: ciAllChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead() },
        ...ciPassGates("head-a", false),
    ]);

    assert.match(
        await waitForCi("/session/current-folder", {}, fixture.deps),
        /^PASS:.*all checks \(none required\)/,
    );
    fixture.done();

    const failed = ciFixture([
        { args: ciView, result: ciPr() },
        {
            args: ciChecks,
            result: ciJson(
                [ciCheck("fail", "no required checks reported on the 'main' branch")],
                1,
            ),
        },
        { args: ciConfirm, result: ciHead() },
    ]);

    assert.match(await waitForCi("/session/current-folder", {}, failed.deps), /^FAIL:/);
    failed.done();
});

test("CI wait: aggregator gap requires every effective context and completed head workflows before PASS", async () => {
    const rules = ciJson([
        { type: "pull_request", parameters: {} },
        {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "Visible" }] },
        },
        {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "Test" }, { context: "Test" }] },
        },
    ]);

    for (const terminal of ["pass", "skipping"]) {
        const passed = ciJson([ciCheck("pass", "Visible"), ciCheck(terminal, "Test")]);
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pass", "Visible")]) },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: rules },
            { args: ciChecks, result: passed },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: rules },
            { args: ciRuns(), result: ciJson([{ status: "in_progress", conclusion: "" }]) },
            { args: ciChecks, result: passed },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: rules },
            { args: ciRuns(), result: ciJson([{ status: "completed", conclusion: "success" }]) },
            { args: ciConfirm, result: ciHead() },
        ]);

        assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^PASS:/);
        assert.deepEqual(fixture.waits, [30_000, 60_000]);
        fixture.done();
    }
});

test("CI wait: no-required output cannot enable all-checks fallback when rules require Test", async () => {
    for (const empty of [
        { code: 1, stdout: "", stderr: "no required checks reported on the 'main' branch\n" },
        ciJson([]),
    ]) {
        const reportsNoRequired = empty.code === 1;
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            ...Array.from({ length: 6 }, () => [
                { args: ciChecks, result: empty },
                ...(reportsNoRequired ? [{ args: ciRules, result: ciRuleNames("Test") }] : []),
                { args: ciConfirm, result: ciHead() },
            ]).flat(),
        ]);

        const text = await waitForCi("/session/current-folder", {}, fixture.deps);

        assert.match(text, /^NO CHECKS:/);
        assert.doesNotMatch(text, /PASS/);
        fixture.done();
    }
});

test("CI wait: unreadable or malformed effective rules are ERROR, never a safe fallback", async () => {
    for (const rules of [
        { code: 1, stdout: "", stderr: "HTTP 403: denied" },
        { ...ciJson([]), truncated: true },
        ciJson({}),
        ciJson([null]),
        ciJson([{ type: "required_status_checks" }]),
        ciJson([{ type: "required_status_checks", parameters: { required_status_checks: {} } }]),
        ciJson([
            {
                type: "required_status_checks",
                parameters: { required_status_checks: [{ context: "" }] },
            },
        ]),
        ciJson([{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }]),
        { code: 0, stdout: "{", stderr: "" },
    ]) {
        for (const noRequired of [false, true]) {
            const fixture = ciFixture([
                { args: ciView, result: ciPr() },
                {
                    args: ciChecks,
                    result: noRequired
                        ? {
                              code: 1,
                              stdout: "",
                              stderr: "no required checks reported on the 'main' branch\n",
                          }
                        : ciJson([ciCheck("pass")]),
                },
                ...(noRequired ? [] : [{ args: ciConfirm, result: ciHead() }]),
                { args: ciRules, result: rules },
            ]);

            assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^ERROR:/);
            fixture.done();
        }
    }
});

test("CI wait: head workflow active statuses are case-insensitive and completed conclusions belong to checks", async () => {
    for (const status of ["QUEUED", "Pending", "waiting", "Requested", "IN_PROGRESS"]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: ciRuleNames("Test") },
            {
                args: ciRuns(),
                result: ciJson([
                    { status: "completed", conclusion: "success" },
                    { status, conclusion: null },
                ]),
            },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: ciRuleNames("Test") },
            {
                args: ciRuns(),
                result: ciJson([
                    { status: "COMPLETED", conclusion: "failure" },
                    { status: "completed", conclusion: "cancelled" },
                ]),
            },
            { args: ciConfirm, result: ciHead() },
        ]);

        assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^PASS:/);
        assert.deepEqual(fixture.waits, [30_000]);
        fixture.done();
    }
});

test("CI wait: failed or malformed head workflow reads are ERROR, not PASS", async () => {
    for (const runs of [
        { code: 1, stdout: "", stderr: "HTTP 502" },
        { ...ciJson([]), truncated: true },
        ciJson({}),
        ciJson([null]),
        ciJson([{ conclusion: "success" }]),
        ciJson([{ status: "completed" }]),
        ciJson([{ status: "unknown", conclusion: "" }]),
        { code: 0, stdout: "{", stderr: "" },
    ]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: ciRuleNames("Test") },
            { args: ciRuns(), result: runs },
        ]);

        assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^ERROR:/);
        fixture.done();
    }
});

test("CI wait: 1000 completed workflow rows are ERROR because a full cap may hide active runs", async () => {
    for (const { count, status } of [
        { count: 999, status: "completed" },
        { count: 1000, status: "completed" },
        { count: 1000, status: "pending" },
    ]) {
        const full = count === 1000;
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            { args: ciRules, result: ciRuleNames("Test") },
            {
                args: ciRuns(),
                result: ciJson(
                    Array.from({ length: count }, () => ({
                        status,
                        conclusion: status === "completed" ? "success" : "",
                    })),
                ),
            },
            ...(full ? [] : [{ args: ciConfirm, result: ciHead() }]),
        ]);
        const text = await waitForCi("/session/current-folder", {}, fixture.deps);

        assert.match(text, full ? /^ERROR:.*1000-run cap.*truncated/ : /^PASS:/);
        assert.deepEqual(fixture.waits, []);
        fixture.done();
    }
});

test("CI wait: effective rule paths exclude the host and encode the resolved base branch", async () => {
    const base = "release/1.0";
    const fixture = ciFixture([
        { args: ciView, result: ciPr("head-a", base) },
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead("head-a", base) },
        {
            args: ["api", "repos/example/repo/rules/branches/release%2F1.0"],
            result: ciRuleNames("Test"),
        },
        { args: ciRuns(), result: ciJson([]) },
        { args: ciConfirm, result: ciHead("head-a", base) },
    ]);

    assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^PASS:/);
    fixture.done();
});

test("CI wait: a head change after rule and workflow gates cannot return a stale PASS", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead() },
        { args: ciRules, result: ciRuleNames("Test") },
        { args: ciRuns(), result: ciJson([]) },
        { args: ciConfirm, result: ciHead("head-b") },
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead("head-b") },
        ...ciPassGates("head-b"),
    ]);

    assert.match(
        await waitForCi("/session/current-folder", {}, fixture.deps),
        /^PASS:.*\(head-b\)/,
    );
    fixture.done();
});

test("CI wait: a new head discards green and failed observations and starts checking again", async () => {
    for (const bucket of ["pass", "fail"]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck(bucket)], bucket === "fail" ? 1 : 0) },
            { args: ciConfirm, result: ciHead("head-b") },
            { args: ciChecks, result: ciJson([ciCheck("pending")], 8) },
            { args: ciConfirm, result: ciHead("head-b") },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead("head-b") },
            ...ciPassGates("head-b"),
        ]);

        assert.match(
            await waitForCi("/session/current-folder", {}, fixture.deps),
            /^PASS:.*\(head-b\)/,
        );
        assert.deepEqual(fixture.waits, [30_000]);
        fixture.done();
    }
});

test("CI wait: numeric, URL and repository selectors resolve first, then use the canonical base repository", async () => {
    for (const [pr, selector] of [
        [12, ["12"]],
        ["12", ["12"]],
        [ciUrl, ["12", "--repo", ciRepo]],
        ["example/repo#12", ["12", "--repo", "example/repo"]],
    ] as const) {
        const fixture = ciFixture([
            {
                args: ["pr", "view", ...selector, "--json", "number,url,headRefOid,baseRefName"],
                result: ciPr(),
            },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            ...ciPassGates(),
        ]);

        assert.match(await waitForCi("/session/current-folder", { pr }, fixture.deps), /^PASS:/);
        fixture.done();
    }
});

test("CI wait: timeout includes command time and never returns a late pass", async () => {
    const fixture = ciFixture([
        { args: ciView, result: ciPr() },
        { args: ciChecks, result: ciJson([ciCheck("pass")]) },
        { args: ciConfirm, result: ciHead(), elapsed: 60_000 },
    ]);

    assert.match(
        await waitForCi("/session/current-folder", { timeout_minutes: 1 }, fixture.deps),
        /^TIMEOUT:/,
    );
    fixture.done();
});

test("CI wait: bounded/malformed output and command errors cannot pass or fall back", async () => {
    for (const result of [
        { ...ciJson([ciCheck("pass")]), truncated: true },
        ciJson({ bucket: "pass" }),
        ciJson([{ bucket: "pass" }]),
        { code: 0, stdout: "{", stderr: "" },
        { code: 1, stdout: "", stderr: "HTTP 403: denied" },
        { code: null, stdout: "", stderr: "gh command timed out" },
    ]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result },
        ]);

        assert.match(await waitForCi("/session/current-folder", {}, fixture.deps), /^ERROR:/);
        fixture.done();
    }
});

test("CI wait: bad inputs do not start a child process, and timeout accepts 1 through 60 only", async () => {
    for (const pr of [
        0,
        -1,
        1.5,
        "--help",
        "12; echo bad",
        "",
        "https://github.com/example/repo/issues/12",
    ]) {
        const fixture = ciFixture([]);

        assert.match(await waitForCi("/session/current-folder", { pr }, fixture.deps), /^ERROR:/);
        fixture.done();
    }

    for (const timeout_minutes of [0, 61, 1.5, NaN]) {
        const fixture = ciFixture([]);

        assert.match(
            await waitForCi("/session/current-folder", { timeout_minutes }, fixture.deps),
            /^ERROR: timeout_minutes/,
        );
        fixture.done();
    }

    for (const timeout_minutes of [1, 60]) {
        const fixture = ciFixture([
            { args: ciView, result: ciPr() },
            { args: ciChecks, result: ciJson([ciCheck("pass")]) },
            { args: ciConfirm, result: ciHead() },
            ...ciPassGates(),
        ]);

        assert.match(
            await waitForCi("/session/current-folder", { timeout_minutes }, fixture.deps),
            /^PASS:/,
        );
        fixture.done();
    }
});

test("team_wait_for_ci is an ordinary, read-only, replay-safe tool and is always available to subagents", async () => {
    const symbol = Symbol.for("pi-pocket-team.team");
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const previous = holder[symbol];
    const disposers: (() => void)[] = [];

    try {
        const extension = createTeam(
            { text: { defang: (text: string) => text }, linkedSessions: {} } as never,
            {
                conversationRoute() {},
                route() {},
                client() {},
                command() {},
                send() {},
                onDispose(dispose: () => void) {
                    disposers.push(dispose);
                },
            } as never,
        ) as unknown as {
            tools: {
                name: string;
                subagents?: string;
                deferred?: boolean;
                replay?: string;
                annotations?: { readOnlyHint?: boolean };
                execute: (args: object, api: object, context: unknown) => Promise<unknown>;
            }[];
        };
        const tool = extension.tools.find((each) => each.name === "team_wait_for_ci");

        assert(tool);
        assert.equal(tool.subagents, "always");
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.replay, "safe");
        assert.notEqual(tool.deferred, true);
        // The tool reads the caller's folder through api.agent, without requiring a named identity.
        let reads = 0;
        const result = await tool.execute(
            {},
            {
                agent: async () => {
                    reads++;

                    return {};
                },
            },
            context,
        );

        assert.equal(reads, 1);
        assert.match(JSON.stringify(result), /This session has no current folder/);

        // Hold both calls before their first gh command, then dispose the module. Neither may reach the network.
        const folder = Promise.withResolvers<{ cwd: string }>();
        const active = [
            tool.execute({}, { agent: () => folder.promise }, context),
            tool.execute({}, { agent: () => folder.promise }, context),
        ];

        for (const dispose of disposers) {
            dispose();
        }

        folder.resolve({ cwd: "/session/current-folder" });

        for (const interrupted of await Promise.all(active)) {
            assert.match(JSON.stringify(interrupted), /INTERRUPTED:/);
            assert.doesNotMatch(JSON.stringify(interrupted), /PASS/);
        }
    } finally {
        if (previous === undefined) {
            delete holder[symbol];
        } else {
            holder[symbol] = previous;
        }
    }
});

test("linkedSend keeps follow-up delivery arguments", async () => {
    const source = 42 as import("@earendil-works/pi-durable").ConversationId;
    const key = "team-compatible";
    const request = { to: "session-worker", message: "continue" };
    let call:
        | {
              source: import("@earendil-works/pi-durable").ConversationId;
              request: { to: string; message: string; steer?: boolean };
              key: string;
          }
        | undefined;
    const host = {
        linkedSessions: {
            send: async (
                sentSource: import("@earendil-works/pi-durable").ConversationId,
                sentRequest: { to: string; message: string; steer?: boolean },
                sentKey: string,
            ) => {
                call = { source: sentSource, request: sentRequest, key: sentKey };

                return { answers: true };
            },
        },
    } as unknown as Host;

    const result = await linkedSend(host, source, request, key);

    assert.equal(result, undefined);
    assert.deepEqual(call, {
        source,
        request: { ...request, steer: false },
        key,
    });
});

after(cleanUp);
const definitions = join(root, "agents");
const repoA = join(root, "nsl");
const repoB = join(root, "igloo");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions);
mkdirSync(repoA);
mkdirSync(repoB);
writeFileSync(
    join(definitions, "odrade.md"),
    "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate Brian's team.",
);
writeFileSync(
    join(definitions, "duncan.md"),
    `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/nsl: ${repoA}\n  frostyard/igloo: ${repoB}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repositories.`,
);
writeFileSync(
    join(definitions, "teg.md"),
    `---\nrepositories:\n  bketelsen/fleet: ${repoA}\n---\n# Miles Teg\nOwn fleet.`,
);
writeFileSync(
    join(definitions, "moneo.md"),
    `---\nworkspace: ${repoB}\n---\n# Moneo\nOwn the NAS.`,
);

test("drop-in identities, named delegation, HTTP permissions, replay and restart", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    let requestContext = "";
    let rosterContext = "";
    const model = scriptedModel((ctx) => {
        requestContext = JSON.stringify(ctx);

        if (requestContext.includes("Named teammates:")) {
            rosterContext = requestContext;
        }

        const { text, role } = lastText(ctx as never);

        if (role === "user" && text.endsWith("delegate test")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "duncan",
                        repository: "frostyard/igloo",
                        task: "Say hello. No tools needed.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("report test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            assert(address, "The worker receives a return address in its initial context.");

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan finished the prototype task.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("null status test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan sent a null status.",
                        status: null,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("long ask test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan needs a decision.",
                        status: "blocked",
                        asks: [{ question: `Pick one. ${"x".repeat(530)}`, options: ["a", "b"] }],
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    let app = await openApp(model);
    let server: ReturnType<typeof createServer> | undefined;

    try {
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        const id = await newSession(app);
        const plain = await newSession(app);

        server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;

        async function call(path: string, body?: object, token = app.config.ownerToken) {
            const res = await fetch(base + path, {
                method: body ? "POST" : "GET",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });

            return { status: res.status, data: await res.json() };
        }

        assert.equal((await call("agents")).data.agents.length, 4);
        const guest = app.config.addUser("Guest", "guest");

        assert.equal((await call("agents", undefined, guest.token)).status, 404);
        // The supervisor button's route: owner-only; with the desk off it opens nothing and says why.
        assert.equal((await call("supervisor", undefined, guest.token)).status, 404);
        assert.deepEqual((await call("supervisor")).data, {
            found: false,
            reason: "desk-off",
            text: FRONT_DOOR_DESK_OFF,
        });
        assert.equal((await call(`session/${id}/identity`, { agent: "../missing" })).status, 400);
        assert.equal((await call(`session/${id}/identity`, { agent: "odrade" })).status, 200);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        assert.equal((await call(`session/${id}`)).data.identity.name, "Odrade");
        assert.equal((await call(`session/${id}/identity`, { agent: null })).status, 200);
        assert.equal((await call(`session/${id}`)).data.identity, null);
        assert.equal((await call(`session/${id}/identity`, { agent: "odrade" })).status, 200);
        await say(app, id, "Hello");
        const transcript = requestContext;

        assert.match(transcript, /You are Odrade/);
        assert.match(transcript, /frostyard\/nsl/);
        await say(app, plain, "Hello");
        assert.doesNotMatch(requestContext, /You are Odrade/);

        for (const [agent, cwd] of [
            ["teg", repoA],
            ["moneo", repoB],
        ]) {
            const response = await call(`session/${id}/start`, {
                agent,
                message: "Use your working folder",
                key: `default-folder-${agent}`,
            });

            assert.equal(response.status, 200);
            assert.equal(app.cwdOf(response.data.session), cwd);
            await until(() => !app.isBusy(response.data.session), "default-folder task settled");
        }

        // Default starts use the source model; opting into an unallowed model fails in core.
        const denied = await call(`session/${id}/start`, {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Hello",
            key: "denied-model-001",
            usePreferredModel: true,
        });

        assert.notEqual(denied.status, 200);
        const count = app.sessions().length;

        for (const repository of [undefined, "someone/else"]) {
            assert.equal(
                (
                    await call(`session/${id}/start`, {
                        agent: "duncan",
                        repository,
                        message: "Choose the right repository",
                        key: "bad-repository-001",
                    })
                ).status,
                400,
            );
            assert.equal(app.sessions().length, count);
        }

        const request = {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Say hello",
            key: "named-task-0001",
        };
        const started = await call(`session/${id}/start`, request);

        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(
            (await call(`session/${id}/start`, request)).data.session,
            started.data.session,
        );
        const child = started.data.session;

        await until(() => !app.isBusy(child), "linked task settled");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.match((await modelTexts(app, child)).join("\n"), /You are Duncan Idaho/);
        assert.equal(app.cwdOf(child), repoA);
        assert.equal(app.cwdOf(id), work);
        await say(app, child, "report test");
        await until(
            async () =>
                (await modelTexts(app, id))
                    .join("\n")
                    .includes("Duncan finished the prototype task."),
            "specialist report delivered to supervisor",
        );
        await until(() => !app.isBusy(id), "supervisor received the report");
        // A null optional status is dropped by the validator, as before: the message goes.
        await say(app, child, "null status test");
        await until(
            async () =>
                (await modelTexts(app, id)).join("\n").includes("Duncan sent a null status."),
            "a null status is no refusal",
        );
        await until(() => !app.isBusy(child) && !app.isBusy(id), "null status settled");
        // An ask over its limit: the error says which argument, the limit, by how much, and what to do; nothing is sent.
        await say(app, child, "long ask test");
        await until(() => !app.isBusy(child), "long ask settled");
        const longAsk = (await modelTexts(app, child)).join("\n");

        assert.match(
            longAsk,
            /team_message was not sent\. Fix the arguments below, and call it again:\\n- asks\[0\]\.question has 540 characters; the limit is 500\. Cut at least 40 characters: keep 1 decision on 1 line/,
        );
        assert.doesNotMatch((await modelTexts(app, id)).join("\n"), /Duncan needs a decision/);
        type Linked = { conversationId: string; title?: string; cwd?: string };

        // Delegate once, and return the new session with the model it runs on.
        async function delegateOnce() {
            const seen = new Set(
                (await call(`session/${id}`)).data.linked.map((s: Linked) => s.conversationId),
            );

            await say(app, id, "delegate test");
            await until(
                async () =>
                    (await call(`session/${id}`)).data.linked.some(
                        (s: Linked) => !seen.has(s.conversationId),
                    ),
                "named delegation",
            );
            const delegated = (await call(`session/${id}`)).data.linked.find(
                (s: Linked) => !seen.has(s.conversationId),
            ) as Linked;

            assert(delegated.title?.startsWith("Duncan Idaho:"));
            assert.equal(delegated.cwd, repoB, "Odrade's tool uses Duncan's selected repository.");
            await until(() => !app.isBusy(delegated.conversationId), "delegated task settled");
            await until(() => !app.isBusy(id), "supervisor settled");
            const runs = (await app.agentState(delegated.conversationId))?.model;

            return `${runs?.provider}/${runs?.modelId}`;
        }

        // Duncan's profile model is not in the owner's allowed list: he runs on Odrade's model, and the result says so.
        assert.match(
            rosterContext,
            /Model: your model \(faux\/faux-2 is not allowed for subagents\)/,
        );
        assert.equal(await delegateOnce(), "faux/faux-1");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /on your model \(faux\/faux-2 is not allowed for subagents\)/,
        );

        // The owner allows it: delegation runs Duncan on his profile model, and the roster says so.
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        assert.equal(await delegateOnce(), "faux/faux-2");
        assert.match((await modelTexts(app, id)).join("\n"), /, on faux\/faux-2\./);
        assert.match(rosterContext, /Model: faux\/faux-2\\n/);
        assert.equal(app.cwdOf(id), work);
        // A specialist can't create a second layer of agents.
        await say(app, child, "delegate test");
        // A specialist's linked task names the asks of team_message, not the built-in ask tool, for Brian's decisions.
        assert.match(
            requestContext,
            /In a linked task, never call the built-in `ask` tool: its card waits only in this session, and the desk does not see it\. Put the decision in the asks of team_message\./,
        );
        // A specialist's linked task is no planning session: it gets no exception to that rule.
        assert.equal(requestContext.includes(PLANNING_ASK_EXCEPTION.slice(0, 60)), false);
        assert.match(
            (await modelTexts(app, child)).join("\n"),
            /Only a session assigned a supervisor/,
        );

        // The third role: `role: clerk`. It sorts with the others by name, and the supervisor stays first.
        writeFileSync(
            join(definitions, "clerk.md"),
            `---\nrole: clerk\nmodel: faux/faux-2\nworkspace: ${repoA}\n---\n# Clerk\nYou are the desk clerk.`,
        );

        try {
            const listed = (await call("agents")).data.agents as { id: string; role: string }[];

            assert.equal(listed.find((each) => each.id === "clerk")?.role, "clerk");
            assert.equal(listed[0]?.role, "supervisor", "the supervisor goes first");

            const clerkSession = await newSession(app);

            assert.equal(
                (await call(`session/${clerkSession}/identity`, { agent: "clerk" })).status,
                200,
            );
            await say(app, clerkSession, "Hello");
            assert.match(
                requestContext,
                /You are the desk clerk of your supervisor\. Desk digests arrive as messages whose lines start with \[desk\]\. Escalate to your supervisor with desk escalate: thread \(the thread it is about\), text, and urgent: true only for what must go at once\. The desk drops an escalation when the supervisor acted on the thread, or got its news directly, after the news that caused it, and records the drop on the thread\. Use team_message to your supervisor only to answer a task that it sent you\. A thread that desk read shows as Handled needs no escalation for its reports, because the supervisor acted after them\./,
            );
            assert.doesNotMatch(requestContext, /Named teammates:/, "a Clerk gets no roster");
        } finally {
            rmSync(join(definitions, "clerk.md"), { force: true });
        }

        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await app.close();
        app = await openApp(model);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.equal(app.cwdOf(child), repoA);
        await say(app, id, "Still here?");
        assert.match(requestContext, /You are Odrade/);
    } finally {
        server?.closeAllConnections();
        server?.close();
        await app.close();
    }
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** One git command in a test folder. */
const git = (folder: string, ...args: string[]): string =>
    execFileSync("git", args, {
        cwd: folder,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

/** A folder with 1 commit: nothing when it is a repository with a commit already. */
function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");

    try {
        git(folder, "rev-parse", "--verify", "HEAD");
    } catch {
        writeFileSync(join(folder, "file.txt"), "one\n");
        git(folder, "add", ".");
        git(
            folder,
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-qm",
            "one",
        );
    }
}

test("identityText: only a planning session gets the exception to the rule on the built-in ask tool", () => {
    const persona = (role: "agent" | "supervisor" | "clerk") => ({
        id: "duncan",
        name: "Duncan Idaho",
        role,
        model: "",
        instructions: "# Duncan Idaho\nOwn the code.",
        repositories: {},
    });
    const rule =
        "In a linked task, never call the built-in `ask` tool: its card waits only in this session, and the desk does not see it. Put the decision in the asks of team_message.";
    const planning = identityText(persona("agent"), false, true);
    const linked = identityText(persona("agent"));

    // A planning session keeps the rule and gets the exception after it.
    assert(planning.includes(rule));
    assert(planning.includes(PLANNING_ASK_EXCEPTION));
    assert(planning.indexOf(rule) < planning.indexOf(PLANNING_ASK_EXCEPTION));
    assert.match(
        PLANNING_ASK_EXCEPTION,
        /planning session \(the session of a desk thread with origin plan\)\. In its chat, use the built-in `ask` tool for a pick-one question to Brian, with the recommended option first\./,
    );

    // Every other linked task keeps the rule, with no exception.
    assert(linked.includes(rule));
    assert.equal(linked.includes(PLANNING_ASK_EXCEPTION), false);
    assert.equal(identityText(persona("agent"), false, false), linked);

    // The flag adds nothing to a supervisor, a Clerk or a private agent: none of them has the rule.
    for (const [role, personal] of [
        ["supervisor", false],
        ["clerk", false],
        ["agent", true],
    ] as const) {
        assert.equal(
            identityText(persona(role), personal, true),
            identityText(persona(role), personal, false),
        );
    }
});

test("a delegation gets a sibling worktree on a new branch, and its key reuses it", async () => {
    const checkout = join(root, "worktree-checkout");

    repository(checkout);

    const key = "x.team.delegate:task-1:call-1";
    const slug = createHash("sha256").update(key).digest("hex").slice(0, 8);
    const first = await delegationWorktree(checkout, { agent: "duncan", key });

    assert(first, "a repository gets a worktree");
    assert.equal(first.checkout, checkout);
    assert.equal(first.path, join(root, `worktree-checkout--duncan-${slug}`));
    assert.equal(first.branch, `duncan/${slug}`);
    assert.equal(existsSync(first.path!), true);
    assert.equal(git(first.path!, "rev-parse", "--abbrev-ref", "HEAD").trim(), `duncan/${slug}`);

    // A replay of the same key finds the worktree it made, and makes no second one.
    const again = await delegationWorktree(checkout, { agent: "duncan", key });

    assert.equal(again?.path, first.path);

    // Another call is another worktree, so 2 jobs in 1 repository share no folder.
    const second = await delegationWorktree(checkout, {
        agent: "duncan",
        key: "x.team.delegate:task-1:call-2",
    });

    assert.notEqual(second?.path, first.path);
    assert.equal(existsSync(second!.path!), true);

    // A folder that is not a git repository, and a folder inside one, keep the folder itself.
    const plain = join(root, "worktree-plain");

    mkdirSync(plain, { recursive: true });
    assert.equal(await delegationWorktree(plain, { agent: "duncan", key }), undefined);

    const inside = join(checkout, "sub");

    mkdirSync(inside, { recursive: true });
    assert.equal(await delegationWorktree(inside, { agent: "duncan", key }), undefined);

    // A folder that is not this repository's worktree is no worktree: the delegation says why and uses the checkout.
    const occupiedKey = "x.team.delegate:task-1:call-3";
    const occupied = join(
        root,
        `worktree-checkout--duncan-${createHash("sha256").update(occupiedKey).digest("hex").slice(0, 8)}`,
    );

    mkdirSync(occupied);
    const blocked = await delegationWorktree(checkout, { agent: "duncan", key: occupiedKey });

    assert.equal(blocked?.path, undefined);
    assert.match(blocked?.error ?? "", /another folder/);
});

test("2 delegations to 1 repository work in 2 worktrees, and the task says where", async () => {
    // frostyard/nsl is Duncan's first repository: a real repository, so each delegation gets its own worktree.
    repository(repoA);

    const requests: string[] = [];
    const model = scriptedModel((ctx) => {
        const { text, role } = lastText(ctx as never);

        requests.push(JSON.stringify(ctx));

        if (role === "user" && text.endsWith("worktree test")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "duncan",
                        repository: "frostyard/nsl",
                        task: "Say hello. No tools needed.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    const app = await openApp(model);

    try {
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        const id = await newSession(app);
        const odrade = (await roster(definitions)).find((each) => each.id === "odrade");

        assert(odrade, "the roster has Odrade");
        await app.harness.commit(async (tx) => {
            (await tx.doc(Identity, id)).persona = odrade;
        }, context);

        // Delegate once, and give back the folder the new linked session starts in.
        async function delegateOnce(): Promise<string> {
            const before = new Set(
                app
                    .sessions()
                    .filter((session) => session.linkedFrom?.id === Number(id))
                    .map((session) => session.id),
            );

            await say(app, id, "worktree test");
            await until(
                () =>
                    app
                        .sessions()
                        .some(
                            (session) =>
                                session.linkedFrom?.id === Number(id) && !before.has(session.id),
                        ),
                "the delegation",
                20_000,
            );
            const linked = app
                .sessions()
                .find(
                    (session) => session.linkedFrom?.id === Number(id) && !before.has(session.id),
                );

            assert(linked);
            await until(() => !app.isBusy(linked.id), "the delegated task settled", 20_000);

            return app.cwdOf(linked.id) ?? "";
        }

        const first = await delegateOnce();
        const second = await delegateOnce();
        const prefix = `${repoA}--duncan-`;

        for (const cwd of [first, second]) {
            assert.equal(cwd.startsWith(prefix), true, `${cwd} is a sibling of the checkout`);
            assert.match(cwd.slice(prefix.length), /^[0-9a-f]{8}$/);
            assert.equal(existsSync(cwd), true);
            assert.match(
                git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim(),
                /^duncan\/[0-9a-f]{8}$/,
            );
        }

        assert.notEqual(first, second, "2 delegations to 1 repository get 2 folders");

        // The task tells the agent where it works, and where it must not work.
        const told = requests.join("\n");

        assert.match(told, /You work in your own git worktree at \S+ on branch duncan\//);
        assert.match(told, /you can rename the branch/);
        assert.match(told, /belongs to no task: do not work there/);
    } finally {
        await app.close();
    }
});

test("roster: mcp is a list of server names, [] when absent, and another type makes the profile invalid", async () => {
    const folder = join(root, "mcp-agents");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "moneo.md"), "---\nmcp: [truenas]\n---\n# Moneo\nOwn the NAS.");
    writeFileSync(
        join(folder, "chani.md"),
        "---\nmcp:\n  - frostnotes\n  - frostmail\n---\n# Chani\n",
    );
    writeFileSync(join(folder, "duncan.md"), "---\nmodel: faux/faux-2\n---\n# Duncan Idaho\n");
    const of = async (id: string) =>
        (await roster(folder)).find((each) => each.id === id) ?? assert.fail(id);

    // A list: the names, in order.
    assert.deepEqual((await of("moneo")).mcp, ["truenas"]);
    assert.deepEqual((await of("chani")).mcp, ["frostnotes", "frostmail"]);
    // Absent, or an empty list: no MCP server.
    assert.deepEqual((await of("duncan")).mcp, []);
    writeFileSync(join(folder, "none.md"), "---\nmcp: []\n---\n# None\n");
    assert.deepEqual((await of("none")).mcp, []);
    rmSync(join(folder, "none.md"));

    // Another type: the profile is invalid, so the roster read fails and names the file.
    for (const bad of [
        "mcp: truenas",
        "mcp: 5",
        "mcp: [truenas, 5]",
        'mcp: [""]',
        "mcp:\n  name: truenas",
        "mcp:",
        "mcp: null",
        "mcp: ~",
    ]) {
        writeFileSync(join(folder, "bad.md"), `---\n${bad}\n---\n# Bad\n`);
        await assert.rejects(
            roster(folder),
            /bad\.md: mcp must be a list of MCP server names/,
            bad,
        );
    }

    rmSync(join(folder, "bad.md"));
    assert.equal((await roster(folder)).length, 3);
});

test("pickSupervisor: the newest bound session that the person sees, not archived first", () => {
    const bound = [
        { supervisor: 9, lastEventAt: 300, asks: 1 },
        { supervisor: 7, lastEventAt: 200, asks: 2 },
        { supervisor: 5, lastEventAt: 100, asks: 0 },
    ];
    const session = (id: number, archived = false) => ({ id, title: `S${id}`, archived });

    // The newest one that the person sees.
    assert.deepEqual(pickSupervisor(bound, [session(5), session(7)]), {
        id: 7,
        title: "S7",
        asks: 2,
        archived: false,
    });
    // An archived one gives way to an older one that is not archived.
    assert.equal(pickSupervisor(bound, [session(9, true), session(5)])?.id, 5);
    // Only archived ones: the newest of them, marked.
    assert.deepEqual(pickSupervisor(bound, [session(7, true), session(9, true)]), {
        id: 9,
        title: "S9",
        asks: 1,
        archived: true,
    });
    // None seen, or none bound: no session.
    assert.equal(pickSupervisor(bound, [session(1)]), undefined);
    assert.equal(pickSupervisor([], [session(1)]), undefined);
    // An app with no session list: the newest bound one.
    assert.equal(pickSupervisor(bound, undefined)?.id, 9);
});

test("teamMessageProblems: each limit, with the count, the limit and the fix; the limits stay", () => {
    assert.deepEqual(MESSAGE_LIMITS, {
        message: 6000,
        asks: 4,
        question: 500,
        options: { min: 2, max: 6 },
        option: 40,
        prs: 100,
    });
    const ok = {
        to: "s",
        message: "Done.",
        status: "done",
        asks: [{ question: "Merge?", options: ["yes", "no"] }],
    };

    assert.deepEqual(teamMessageProblems(ok), []);
    // At the limits exactly: no problem. Characters are code points, as the schema counts them.
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "😀".repeat(6000),
            asks: Array.from({ length: 4 }, () => ({
                question: "q".repeat(500),
                options: Array.from({ length: 6 }, () => "o".repeat(40)),
            })),
        }),
        [],
    );
    // The 2 cases the audit found (2026-10-27): 1 question over 500 characters.
    assert.deepEqual(
        teamMessageProblems({ to: "s", message: "m", asks: [{ question: "q".repeat(538) }] }),
        [
            "asks[0].question has 538 characters; the limit is 500. Cut at least 38 characters: keep 1 decision on 1 line, with only the facts Brian needs to answer it; put the details in message.",
        ],
    );
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m".repeat(6523) }), [
        "message has 6523 characters; the limit is 6000. Cut at least 523 characters: keep the result and the facts the reader needs, and leave out logs and repeated details.",
    ]);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "" }), [
        "message is empty: it needs 1 to 6000 characters.",
    ]);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "finished" }), [
        'status is "finished": use done, working or blocked.',
    ]);
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "m",
            asks: Array.from({ length: 5 }, () => ({ question: "q" })),
        }),
        [
            "asks has 5 asks; the limit is 4. Merge related decisions, or send the others in a second team_message.",
        ],
    );
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "m",
            asks: [
                { question: "q", options: ["only"] },
                { question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] },
                { question: "q", options: ["yes", "o".repeat(41)] },
            ],
        }),
        [
            "asks[0].options has 1 choice; it needs 2 to 6. Leave options out when the ask is no pick-one.",
            "asks[1].options has 7 choices; it needs 2 to 6. Keep the main choices, or split the ask.",
            "asks[2].options[1] has 41 characters; the limit is 40. Cut at least 1 character: name the choice in a few words, and explain it in the question.",
        ],
    );
    // A done or blocked report says its asks, or asks: [] for none; a working one or a follow-up need not.
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "done" }), [
        "asks is missing: a done report lists each decision for Brian in asks, or sends asks: [] when there is none.",
    ]);
    assert.deepEqual(
        teamMessageProblems({ to: "s", message: "m", status: "blocked", asks: null }),
        [
            "asks is missing: a blocked report lists each decision for Brian in asks, or sends asks: [] when there is none.",
        ],
    );
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "done", asks: [] }), []);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "working" }), []);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m" }), []);
    // A null optional is the validator's to drop, as before: no refusal.
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: null }), []);
    // A wrong type is the schema's to report.
    assert.deepEqual(teamMessageProblems({ message: 5, asks: "x", status: undefined }), []);
    assert.deepEqual(teamMessageProblems(null), []);
});

test("teamMessageProblems: prs takes a list of { repo, number }, and each bad item says the fix", () => {
    const done = { to: "s", message: "m", status: "done", asks: [] as unknown[] };

    // A list of PRs, an empty list, and no list at all: no problem.
    assert.deepEqual(
        teamMessageProblems({
            ...done,
            prs: [
                { repo: "frostyard/test", number: 7 },
                { repo: "bketelsen/pi-pocket-team", number: 1 },
            ],
        }),
        [],
    );
    assert.deepEqual(teamMessageProblems({ ...done, prs: [] }), []);
    assert.deepEqual(teamMessageProblems(done), []);
    // A null optional is the validator's to drop, as for status.
    assert.deepEqual(teamMessageProblems({ ...done, prs: null }), []);
    // The limit exactly: no problem.
    assert.deepEqual(
        teamMessageProblems({
            ...done,
            prs: Array.from({ length: 100 }, (_one, index) => ({
                repo: "frostyard/test",
                number: index + 1,
            })),
        }),
        [],
    );

    // A string in the list: the whole list is refused with the shape, as the likely mistake.
    assert.deepEqual(teamMessageProblems({ ...done, prs: ["frostyard/test#7"] }), [
        'prs[0] is "frostyard/test#7": use { repo: "owner/name", number: 12 }.',
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: "frostyard", number: 7 }] }), [
        'prs[0].repo is "frostyard": use owner/name, such as bketelsen/pi-pocket.',
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: 5, number: 7 }] }), [
        "prs[0].repo is 5: use owner/name, such as bketelsen/pi-pocket.",
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: "a/b", number: 0 }] }), [
        "prs[0].number is 0: use the PR number as a whole number, such as 12.",
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: "a/b", number: "12" }] }), [
        'prs[0].number is "12": use the PR number as a whole number, such as 12.',
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: "a/b", number: 1.5 }] }), [
        "prs[0].number is 1.5: use the PR number as a whole number, such as 12.",
    ]);
    // Both fields wrong: 1 line each.
    assert.deepEqual(teamMessageProblems({ ...done, prs: [{ repo: "", number: -1 }] }), [
        'prs[0].repo is "": use owner/name, such as bketelsen/pi-pocket.',
        "prs[0].number is -1: use the PR number as a whole number, such as 12.",
    ]);
    assert.deepEqual(
        teamMessageProblems({
            ...done,
            prs: Array.from({ length: 101 }, (_one, index) => ({
                repo: "frostyard/test",
                number: index + 1,
            })),
        }),
        ["prs has 101 PRs; the limit is 100. Send the others in a second team_message."],
    );
    // Not a list at all: the fix is the shape.
    assert.deepEqual(teamMessageProblems({ ...done, prs: "frostyard/test#7" }), [
        'prs is "frostyard/test#7": use a list of { repo: "owner/name", number: 12 }, or [].',
    ]);
    assert.deepEqual(teamMessageProblems({ ...done, prs: { repo: "a/b", number: 1 } }), [
        'prs is {"repo":"a/b","number":1}: use a list of { repo: "owner/name", number: 12 }, or [].',
    ]);
});
