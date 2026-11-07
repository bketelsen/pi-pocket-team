// The judges' calibration run: both judges through a fake `pi` behind the fake bwrap, on a small development set and
// a labelled held-out set: the results and their thresholds, a resumed run that makes no call, a pending verdict
// judged again, an unlabelled item or a changed rubric that stops the run before any call, `--exclude`, and a budget
// refusal. No network, no model.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setBudget } from "./lib/budget.mjs";
import { JUDGES, JUDGE_PROMPT, JUDGE_PROMPT_CHANGED } from "./lib/judge.mjs";
import { RESULTS_FILE, judgeCalibrationMain, verdictPath } from "./lib/judge-calibration.mjs";
import { FAKE_BWRAP, makeFixture } from "./fixtures/helpers.mjs";

const NOW = Date.UTC(2026, 10, 7, 12, 0);
const [GPT, OPUS] = JUDGES;
let fixture;
let calls;

before(() => {
    fixture = makeFixture();
    calls = join(fixture.root, "judges.log");
});

after(() => rm(fixture.root, { recursive: true, force: true }));

/** A diff whose fake-pi scenario gives each judge its answers (1 per try; the last repeats). */
const diff = (gpt, opus) =>
    [
        "diff --git a/lib.mjs b/lib.mjs",
        `SCENARIO ${JSON.stringify({
            name: "judge",
            log: calls,
            answers: {
                [GPT]: gpt.map((g) =>
                    typeof g === "number" ? JSON.stringify({ grade: g, reasons: "r" }) : g,
                ),
                [OPUS]: opus.map((g) =>
                    typeof g === "number" ? JSON.stringify({ grade: g, reasons: "r" }) : g,
                ),
            },
        })}`,
        "+export const add = (a, b) => a + b;",
        "",
    ].join("\n");

/**
 * A calibration folder: 2 development pairs and 4 labelled held-out items. GPT: pair 1 higher, pair 2 a tie; Opus:
 * pair 1 higher, pair 2 lower. Held-out (labels pass, fail, pass, fail): both judges grade 4, 1, 2, 3: they agree on
 * the first 2 only. `overrides` changes items by id.
 */
function calibrationDir(name, overrides = {}) {
    const dir = join(fixture.root, name);
    const dev = [
        { id: "dev-01", notReady: diff([2], [1]), merged: diff([4], [3]) },
        { id: "dev-02", notReady: diff([3], [3]), merged: diff([3], [2]) },
    ].map((p) => ({
        id: p.id,
        repo: "fixture/repo",
        pr: `fixture/repo#${p.id.slice(-1)}`,
        thread: `T${p.id.slice(-1)}`,
        brief: "Fix add in lib.mjs.",
        briefSource: "delegation",
        base: "b".repeat(40),
        notReadyHead: "n".repeat(40),
        mergedHead: "m".repeat(40),
        notReadyDiff: p.notReady,
        mergedDiff: p.merged,
        notReadyCut: false,
        mergedCut: false,
        ...overrides[p.id],
    }));
    const heldOut = [
        ["sheeana-01", "pass", 4],
        ["sheeana-02", "fail", 1],
        ["sheeana-03", "pass", 2],
        ["sheeana-04", "fail", 3],
    ].map(([id, label, grade]) => ({
        id,
        repo: "fixture/repo",
        pr: `fixture/repo#1${id.slice(-1)}`,
        thread: `T1${id.slice(-1)}`,
        brief: "Fix add in lib.mjs.",
        briefSource: "delegation",
        diff: diff([grade], [grade]),
        diffCut: false,
        label,
        ...overrides[id],
    }));

    mkdirSync(join(dir, "held-out"), { recursive: true });
    writeFileSync(join(dir, "dev.json"), JSON.stringify({ schema: 1, seed: 1064, items: dev }));
    writeFileSync(
        join(dir, "held-out", "sheeana.json"),
        JSON.stringify({ schema: 1, owner: "sheeana", seed: 1064, items: heldOut }),
    );
    // The run never reads the key: a key that does not parse changes nothing.
    writeFileSync(join(dir, "held-out-key.json"), "not json");

    return dir;
}

/** The judge calls so far (1 line per try). */
const callCount = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;

/**
 * Run the calibration on `dir` with its own data dir; returns the code, the logs (a usage error's message too) and
 * the summary.
 */
async function calibrate(dir, extra = [], { budget = 100, deps = {} } = {}) {
    const data = join(dir, "..", `${dir.split("/").pop()}-data`);
    const logs = [];
    const printed = [];

    if (!existsSync(join(data, "spend.json"))) {
        await setBudget(data, budget);
    }

    const original = console.error;

    console.error = (text) => logs.push(text);

    const code = await judgeCalibrationMain(
        [
            "--dir",
            dir,
            "--bwrap",
            FAKE_BWRAP,
            "--pocket",
            fixture.pocket,
            "--agent-src",
            fixture.agent,
            "--no-auth-preflight",
            ...extra,
        ],
        { ...process.env, BENCH_DATA: data },
        {
            now: () => NOW,
            log: (line) => logs.push(line),
            print: (text) => printed.push(text),
            killGraceMs: 2000,
            ...deps,
        },
    ).finally(() => {
        console.error = original;
    });
    const resultsFile = join(dir, RESULTS_FILE);

    return {
        code,
        logs,
        printed: printed.join("\n"),
        results: existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : null,
    };
}

test("dev and held-out: each judge's counts, thresholds and spend; a second run makes no call", async () => {
    const dir = calibrationDir("full");
    const start = callCount();
    const first = await calibrate(dir);

    assert.equal(first.code, 0, first.logs.join("\n"));
    assert.equal(callCount() - start, 2 * (2 * 2 + 4), "2 calls per pair, 1 per item, per judge");

    const { judges, spend } = first.results;

    assert.deepEqual(judges[GPT].dev, {
        pairs: 2,
        higher: 1,
        ties: 1,
        lower: 0,
        pending: 0,
        required: 20,
        threshold: 15,
        pass: false,
    });
    assert.deepEqual(
        [judges[OPUS].dev.higher, judges[OPUS].dev.ties, judges[OPUS].dev.lower],
        [1, 0, 1],
    );

    for (const model of JUDGES) {
        assert.deepEqual(judges[model].heldOut, {
            items: 4,
            counted: 4,
            excluded: 0,
            agree: 2,
            threshold: 4,
            pass: false,
            agreeAll: 2,
            confusion: {
                ownerPass: { judgePass: 1, judgeFail: 1 },
                ownerFail: { judgePass: 1, judgeFail: 1 },
            },
            pending: 0,
        });
        // 8 verdicts at $0.02 each.
        assert.equal(judges[model].spend, 0.16);
    }

    assert.equal(spend, 0.32);
    assert.match(first.printed, /## Development set/);
    assert.match(first.printed, /## Held-out set/);
    assert.match(first.printed, /Judge spend: \$0\.32/);

    // The verdicts: 1 file per judge and diff, private, with the frozen prompt's hash.
    const verdict = verdictPath(dir, OPUS, "dev-01", "merged");

    assert.equal(statSync(verdict).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(verdict, "utf8")).grade, 3);
    assert.ok(existsSync(verdictPath(dir, GPT, "sheeana-04")));

    // The judges got the brief and the diff only: no merged change, no S1 or S2.
    const prompt = readFileSync(
        join(
            dir,
            "..",
            "full-data",
            "judges",
            "calibration",
            "dev-01.notReady",
            GPT.replaceAll("/", "__"),
            "try-1",
            "work",
            "judge-prompt.md",
        ),
        "utf8",
    );

    assert.match(prompt, /No merged change is given for this item/);
    assert.match(prompt, /<reference-diff>\n\(none\)\n<\/reference-diff>/);
    assert.match(
        prompt,
        /S1, the repository's own check on the submitted tree: not run for this item/,
    );

    // Resumed: every verdict has a grade, so no call; the same results.
    const again = await calibrate(dir);

    assert.equal(again.code, 0);
    assert.equal(callCount() - start, 16, "a second run makes no call");
    assert.deepEqual(again.results, first.results);
});

test("--exclude changes the counted total and the threshold, not the all-items agreement", async () => {
    const dir = calibrationDir("exclude");
    const { code, results } = await calibrate(dir, [
        "--set",
        "held-out",
        "--exclude",
        "sheeana-03",
    ]);

    assert.equal(code, 0);
    assert.equal(results.judges[GPT].dev, null);
    assert.deepEqual(results.exclude, ["sheeana-03"]);

    const h = results.judges[GPT].heldOut;

    assert.deepEqual(
        [h.items, h.counted, h.excluded, h.agree, h.threshold, h.pass, h.agreeAll],
        [4, 3, 1, 2, 3, false, 2],
    );
    assert.deepEqual(h.confusion.ownerPass, { judgePass: 1, judgeFail: 0 });

    // An id that is not a held-out item is a usage error.
    assert.equal((await calibrate(dir, ["--set", "held-out", "--exclude", "dev-01"])).code, 1);
});

test("an unlabelled held-out item stops the run before any call, with its id", async () => {
    const dir = calibrationDir("unlabelled", {
        "sheeana-02": { label: null },
        "sheeana-04": { label: "maybe" },
    });
    const start = callCount();
    const { code, results, logs } = await calibrate(dir);

    assert.equal(code, 1);
    assert.match(logs.join("\n"), /no owner label \("pass" or "fail"\): sheeana-02, sheeana-04\n/);
    assert.equal(callCount(), start, "no judge call");
    assert.equal(results, null);
    assert.equal(existsSync(join(dir, "judged")), false);

    // The development set alone needs no label.
    assert.equal((await calibrate(dir, ["--set", "dev"])).code, 0);
    assert.equal(callCount() - start, 2 * 2 * 2);
});

test("a pending verdict is judged again on the next run; the others are not", async () => {
    const dir = calibrationDir("pending", {
        // GPT gives no parsable answer in its first 3 tries, then grade 4 (BENCH_TRY counts on across runs).
        "sheeana-01": { diff: diff(["no", "no", "no", 4], [4]) },
    });
    const start = callCount();
    const first = await calibrate(dir, ["--set", "held-out"]);

    assert.equal(first.code, 0);
    assert.equal(callCount() - start, 3 + 3 + 4);
    assert.equal(first.results.judges[GPT].heldOut.pending, 1);
    assert.equal(first.results.judges[GPT].heldOut.agree, 1);

    const second = await calibrate(dir, ["--set", "held-out"]);

    assert.equal(callCount() - start, 11, "only the pending verdict runs again");
    assert.equal(second.results.judges[GPT].heldOut.pending, 0);
    assert.equal(second.results.judges[GPT].heldOut.agree, 2);

    const saved = JSON.parse(readFileSync(verdictPath(dir, GPT, "sheeana-01"), "utf8"));

    assert.deepEqual([saved.grade, saved.tries, saved.cost], [4, 4, 0.08]);
});

test("a budget refusal stops the run with exit 2; nothing else runs and no results are written", async () => {
    const dir = calibrationDir("budget");
    const start = callCount();
    const { code, results, logs } = await calibrate(dir, [], { budget: 0.5 });

    assert.equal(code, 2);
    assert.equal(callCount(), start);
    assert.equal(results, null);
    assert.match(logs.join("\n"), /budget refused/);
    assert.equal(
        JSON.parse(readFileSync(verdictPath(dir, GPT, "dev-01", "notReady"), "utf8")).pending,
        true,
    );
});

test("a changed rubric stops the run before any call", async () => {
    const dir = calibrationDir("changed");
    const changed = join(fixture.root, "judge-v1-changed.md");

    writeFileSync(changed, `${readFileSync(JUDGE_PROMPT, "utf8")}\nOne more rule.\n`);

    const start = callCount();
    const { code, logs } = await calibrate(dir, [], { deps: { judgePromptFile: changed } });

    assert.equal(code, 1);
    assert.equal(callCount(), start);
    assert.ok(logs.join("\n").includes(JUDGE_PROMPT_CHANGED));
});
