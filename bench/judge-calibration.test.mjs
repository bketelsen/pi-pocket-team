// The judges' calibration run: both judges through a fake `pi` behind the fake bwrap, on a small development set and
// a complete labelled held-out set (40 items): the results and their thresholds, a resumed run that makes no call, a
// verdict of another input judged again, a pending verdict judged again, an incomplete set, an unlabelled item or a
// changed rubric that stops the run before any call, `--exclude`, and a budget refusal. The thresholds also as
// functions. No network, no model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setBudget } from "./lib/budget.mjs";
import { JUDGES, JUDGE_PROMPT, JUDGE_PROMPT_CHANGED, JUDGE_PROMPT_SHA256 } from "./lib/judge.mjs";
import {
    HELD_OUT_REQUIRED,
    RESULTS_FILE,
    devResult,
    heldOutResult,
    judgeCalibrationMain,
    verdictPath,
} from "./lib/judge-calibration.mjs";
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
 * A calibration folder: 2 development pairs and 40 labelled held-out items (`heldOutCount` changes the count). GPT:
 * pair 1 higher, pair 2 a tie; Opus: pair 1 higher, pair 2 lower. Held-out: items 1 to 4 (labels pass, fail, pass,
 * fail) get grades 4, 1, 2, 3 from both judges (they agree on the first 2 only); the 36 others alternate pass (grade
 * 4) and fail (grade 1), so the judges agree on 38 of 40. `overrides` changes items by id.
 */
function calibrationDir(name, overrides = {}, { heldOutCount = HELD_OUT_REQUIRED } = {}) {
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
    const first = [
        ["pass", 4],
        ["fail", 1],
        ["pass", 2],
        ["fail", 3],
    ];
    const heldOut = Array.from({ length: heldOutCount }, (_, i) =>
        i < first.length ? first[i] : i % 2 ? ["fail", 1] : ["pass", 4],
    )
        .map(([label, grade], i) => ({
            id: `sheeana-${String(i + 1).padStart(2, "0")}`,
            repo: "fixture/repo",
            pr: `fixture/repo#${100 + i}`,
            thread: `T${100 + i}`,
            brief: "Fix add in lib.mjs.",
            briefSource: "delegation",
            diff: diff([grade], [grade]),
            diffCut: false,
            label,
        }))
        .map((item) => ({ ...item, ...overrides[item.id] }));

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

/** Write the development set of `dir` with `change` applied to pairs by id. */
function rewriteDev(dir, change) {
    const file = join(dir, "dev.json");
    const set = JSON.parse(readFileSync(file, "utf8"));

    set.items = set.items.map((pair) => ({ ...pair, ...change[pair.id] }));
    writeFileSync(file, JSON.stringify(set));
}

test("dev and held-out: each judge's counts, thresholds and spend; a second run makes no call", async () => {
    const dir = calibrationDir("full");
    const start = callCount();
    const first = await calibrate(dir);

    assert.equal(first.code, 0, first.logs.join("\n"));
    assert.equal(callCount() - start, 2 * (2 * 2 + 40), "2 calls per pair, 1 per item, per judge");

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
            items: 40,
            required: 40,
            complete: true,
            counted: 40,
            excluded: 0,
            agree: 38,
            threshold: 32,
            pass: true,
            agreeAll: 38,
            confusion: {
                ownerPass: { judgePass: 19, judgeFail: 1 },
                ownerFail: { judgePass: 1, judgeFail: 19 },
            },
            pending: 0,
        });
        // 44 verdicts at $0.02 each.
        assert.equal(judges[model].spend, 0.88);
    }

    assert.equal(spend, 1.76);
    assert.match(first.printed, /## Development set/);
    assert.match(first.printed, /## Held-out set/);
    assert.match(first.printed, /Judge spend: \$1\.76/);

    // The verdicts: 1 file per judge and diff, private, with the frozen rubric's hash and the input's hash.
    const verdict = JSON.parse(readFileSync(verdictPath(dir, OPUS, "dev-01", "merged"), "utf8"));

    assert.equal(statSync(verdictPath(dir, OPUS, "dev-01", "merged")).mode & 0o777, 0o600);
    assert.equal(verdict.grade, 3);
    assert.equal(verdict.promptSha256, JUDGE_PROMPT_SHA256);
    assert.match(verdict.inputSha256, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(verdictPath(dir, GPT, "sheeana-40")));

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
    assert.equal(
        createHash("sha256").update(prompt).digest("hex"),
        JSON.parse(readFileSync(verdictPath(dir, GPT, "dev-01", "notReady"), "utf8")).inputSha256,
    );

    // Resumed: every verdict has a grade and the same input, so no call; the same results.
    const again = await calibrate(dir);

    assert.equal(again.code, 0);
    assert.equal(callCount() - start, 88, "a second run makes no call");
    assert.deepEqual(again.results, first.results);
});

test("--exclude changes the counted total and the threshold, not the all-items agreement", async () => {
    // The folder of the test above when it ran (its verdicts are used again), else judged here.
    const dir = existsSync(join(fixture.root, "full"))
        ? join(fixture.root, "full")
        : calibrationDir("full");
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
        [40, 39, 1, 38, 32, true, 38],
    );
    assert.deepEqual(h.confusion.ownerPass, { judgePass: 19, judgeFail: 0 });

    // An id that is not a held-out item is a usage error.
    assert.equal((await calibrate(dir, ["--set", "held-out", "--exclude", "dev-01"])).code, 1);
});

test("a saved verdict of another input (a rebuilt set reuses an id) is judged again and overwritten", async () => {
    const dir = calibrationDir("rebuilt");
    const start = callCount();

    assert.equal((await calibrate(dir, ["--set", "dev"])).code, 0);
    assert.equal(callCount() - start, 8);

    const old = JSON.parse(readFileSync(verdictPath(dir, GPT, "dev-01", "merged"), "utf8"));

    // A rebuilt set: dev-01 has another merged diff, dev-02 another brief.
    rewriteDev(dir, {
        "dev-01": { mergedDiff: diff([1], [1]) },
        "dev-02": { brief: "Another task." },
    });

    const { code, results, logs } = await calibrate(dir, ["--set", "dev"]);

    assert.equal(code, 0);
    assert.equal(
        callCount() - start,
        8 + 2 + 4,
        "dev-01 merged and both parts of dev-02, per judge",
    );
    assert.match(
        logs.join("\n"),
        /dev-01 merged: the saved verdict is of another input: judged again/,
    );

    const now = JSON.parse(readFileSync(verdictPath(dir, GPT, "dev-01", "merged"), "utf8"));

    assert.deepEqual([old.grade, now.grade, now.tries], [4, 1, 1]);
    assert.notEqual(now.inputSha256, old.inputSha256);
    assert.deepEqual(
        [results.judges[GPT].dev.higher, results.judges[GPT].dev.lower],
        [0, 1],
        "the new grade counts, not the old one",
    );

    // The same input again: no call.
    await calibrate(dir, ["--set", "dev"]);
    assert.equal(callCount() - start, 14);
});

test("an incomplete held-out set stops the run before any call", async () => {
    const dir = calibrationDir("incomplete", {}, { heldOutCount: 4 });
    const start = callCount();
    const { code, results, logs } = await calibrate(dir);

    assert.equal(code, 1);
    assert.match(logs.join("\n"), /the held-out set is incomplete: 4 items, not 40/);
    assert.equal(callCount(), start, "no judge call");
    assert.equal(results, null);
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
    const dir = calibrationDir("pending");

    // GPT gives no parsable answer in its first 3 tries of dev-01's Not-ready diff, then grade 2 (BENCH_TRY counts
    // on across runs).
    rewriteDev(dir, { "dev-01": { notReadyDiff: diff(["no", "no", "no", 2], [1]) } });

    const start = callCount();
    const first = await calibrate(dir, ["--set", "dev"]);

    assert.equal(first.code, 0);
    assert.equal(callCount() - start, 3 + 3 + 4);
    assert.deepEqual(
        [first.results.judges[GPT].dev.pending, first.results.judges[GPT].dev.higher],
        [1, 0],
    );

    const second = await calibrate(dir, ["--set", "dev"]);

    assert.equal(callCount() - start, 11, "only the pending verdict runs again");
    assert.deepEqual(
        [second.results.judges[GPT].dev.pending, second.results.judges[GPT].dev.higher],
        [0, 1],
    );

    const saved = JSON.parse(readFileSync(verdictPath(dir, GPT, "dev-01", "notReady"), "utf8"));

    assert.deepEqual([saved.grade, saved.tries, saved.cost], [2, 4, 0.08]);
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

/** Held-out items with labels, and their verdicts: `agree` of the first `count` items agree with the owner. */
function heldOutCase(count, agree) {
    const items = Array.from({ length: count }, (_, i) => ({
        id: `x-${i}`,
        label: i % 2 ? "fail" : "pass",
    }));
    const grades = new Map(
        items.map((item, i) => {
            const ownerPass = item.label === "pass";
            const judgePass = i < agree ? ownerPass : !ownerPass;

            return [item.id, { grade: judgePass ? 4 : 1, pending: false }];
        }),
    );

    return { items, verdictOf: (id) => grades.get(id) ?? null };
}

test("held-out thresholds: only a complete set of 40 passes, at ceil(0.8 x counted) after --exclude", () => {
    const pass = (count, agree, exclude = []) => {
        const { items, verdictOf } = heldOutCase(count, agree);
        const result = heldOutResult(items, verdictOf, new Set(exclude));

        return [result.counted, result.agree, result.threshold, result.complete, result.pass];
    };

    // An incomplete set never passes, even when every item agrees.
    assert.deepEqual(pass(1, 1), [1, 1, 1, false, false]);
    assert.deepEqual(pass(39, 39), [39, 39, 32, false, false]);
    assert.deepEqual(pass(40, 31), [40, 31, 32, true, false]);
    assert.deepEqual(pass(40, 32), [40, 32, 32, true, true]);
    // 1 explicit exclusion of a disagreeing item: 39 counted, threshold ceil(31.2) = 32.
    assert.deepEqual(pass(40, 31, ["x-39"]), [39, 31, 32, true, false]);
    assert.deepEqual(pass(40, 32, ["x-39"]), [39, 32, 32, true, true]);
});

test("development thresholds: 15 of 20 merged higher passes, 14 of 20 fails, fewer than 20 pairs fails", () => {
    const run = (pairs, higher) => {
        const list = Array.from({ length: pairs }, (_, i) => ({ id: `d-${i}` }));

        const verdictOf = (id, part) => {
            const i = Number(id.slice(2));

            return { pending: false, grade: part === "merged" ? (i < higher ? 3 : 1) : 2 };
        };

        const result = devResult(list, verdictOf);

        return [result.pairs, result.higher, result.lower, result.pass];
    };

    assert.deepEqual(run(20, 15), [20, 15, 5, true]);
    assert.deepEqual(run(20, 14), [20, 14, 6, false]);
    assert.deepEqual(run(19, 15), [19, 15, 4, false]);
});
