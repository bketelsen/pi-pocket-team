// The judge calibration's statistics and run: Wilson bounds, Cohen's kappa, the pass rules and the class minimums,
// then the run on fixture packs with the fake `pi` as judges: development verdicts, resume, a changed prompt, an item
// seen before, the held-out gates (the frozen prompt, the class minimums) before any judge call, and a budget refusal.
// No network, no model.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    Z80,
    classCounts,
    cohenKappa,
    judgePasses,
    raterStats,
    s3Passes,
    threshold,
    wilson,
} from "./lib/agreement.mjs";
import { sha256 } from "./lib/calibration.mjs";
import { JUDGES, JUDGE_PROMPT, cutDiff } from "./lib/judge.mjs";
import { judgeCalibrationMain, resultsOf } from "./lib/judge-calibration.mjs";
import { FAKE_BWRAP, makeFixture, setBudget, testEnv } from "./fixtures/helpers.mjs";

const close = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} != ${expected}`);

test("Wilson bounds (80%), kappa, the agreement threshold", () => {
    // 0 of 10: the upper bound is z^2 / (n + z^2).
    const zero = wilson(0, 10);

    close(zero.low, 0, "0 of 10 low");
    close(zero.high, (Z80 * Z80) / (10 + Z80 * Z80), "0 of 10 high");

    // 5 of 10: symmetric about 0.5.
    const half = wilson(5, 10);

    close(half.low + half.high, 1, "5 of 10 symmetric");
    assert.ok(Math.abs(half.high - 0.687795) < 1e-5, `5 of 10 high: ${half.high}`);
    assert.equal(wilson(0, 0), null);

    // tp 20, fn 5, fp 5, tn 10: observed 0.75, chance 0.53125, kappa 0.4667.
    close(cohenKappa({ tp: 20, fn: 5, fp: 5, tn: 10 }), 0.21875 / 0.46875, "kappa");
    close(cohenKappa({ tp: 10, fn: 0, fp: 0, tn: 10 }), 1, "perfect");
    assert.equal(cohenKappa({ tp: 40, fn: 0, fp: 0, tn: 0 }), null, "1 class: not defined");

    assert.equal(threshold(40), 32);
    assert.equal(threshold(36), 29);
    assert.equal(threshold(37), 30);
});

/** Pairs from confusion counts: owner pass/fail x judge pass/fail. */
const pairs = ({ tp = 0, fn = 0, fp = 0, tn = 0, pending = 0 }) => [
    ...Array(tp).fill({ owner: true, judge: true }),
    ...Array(fn).fill({ owner: true, judge: false }),
    ...Array(fp).fill({ owner: false, judge: true }),
    ...Array(tn).fill({ owner: false, judge: false }),
    ...Array(pending).fill({ owner: true, judge: null }),
];

test("pass rules: agreement and kappa per judge, false pass for S3; a judge that always says pass fails", () => {
    // 40 items, 32 agree, kappa 0.6 exactly: tp 16, tn 16, fp 4, fn 4 (chance 0.5, observed 0.8).
    const edge = raterStats(pairs({ tp: 16, tn: 16, fp: 4, fn: 4 }));

    assert.equal(edge.agree, 32);
    close(edge.kappa, 0.6, "kappa at the edge");
    assert.equal(judgePasses(edge), true);
    assert.deepEqual([edge.falsePass.k, edge.falsePass.n, edge.falsePass.rate], [4, 20, 0.2]);
    assert.deepEqual([edge.falseFail.k, edge.falseFail.n], [4, 20]);
    assert.equal(s3Passes(edge), true, "false pass 20% is allowed");

    // 31 of 40 agree: fails.
    assert.equal(judgePasses(raterStats(pairs({ tp: 16, tn: 15, fp: 5, fn: 4 }))), false);
    assert.equal(s3Passes(raterStats(pairs({ tp: 16, tn: 15, fp: 5, fn: 4 }))), false);

    // Always pass on 38 owner passes and 2 owner fails: 38 of 40 agree, kappa 0: fails.
    const always = raterStats(pairs({ tp: 38, fp: 2 }));

    assert.equal(always.agree, 38);
    close(always.kappa, 0, "always pass");
    assert.equal(judgePasses(always), false);

    // A pending verdict: no kappa, no pass.
    const pending = raterStats(pairs({ tp: 20, tn: 19, pending: 1 }));

    assert.equal(pending.pending, 1);
    assert.equal(pending.kappa, null);
    assert.equal(judgePasses(pending), false);
});

test("class minimums: 36 counted, 10 owner fails, 10 owner passes", () => {
    const labels = (passes, fails) => [...Array(passes).fill(true), ...Array(fails).fill(false)];

    assert.deepEqual(classCounts(labels(26, 10)), {
        counted: 36,
        passes: 26,
        fails: 10,
        valid: true,
        short: [],
    });
    assert.deepEqual(classCounts(labels(30, 9)).short, ["fails"]);
    assert.deepEqual(classCounts(labels(9, 30)).short, ["passes"]);
    assert.deepEqual(classCounts(labels(20, 15)).short, ["items"]);
    assert.deepEqual(classCounts(labels(38, 2)).short, ["fails"]);
});

test("results: each judge, the S3 rule (both 3 or more), validity and the held-out pass", () => {
    // 40 items: 20 owner passes, 20 owner fails. Judge A agrees on all; judge B passes everything.
    const counted = Array.from({ length: 40 }, (_, i) => ({
        item: { id: `i${i}` },
        label: i < 20 ? "pass" : "fail",
    }));

    const grade = (model, id) => {
        const i = Number(id.slice(1));

        return model === "A" ? (i < 20 ? 4 : 1) : 3;
    };

    const results = resultsOf("heldOut", counted, ["A", "B"], grade);

    assert.equal(results.judges.A.pass, true);
    assert.equal(results.judges.B.pass, false, "always pass: kappa 0");
    assert.equal(results.s3.agree, 40, "both 3 or more only where A passes");
    assert.equal(results.s3.pass, true);
    assert.equal(results.valid, true);
    assert.equal(results.pass, false, "every judge must pass");

    const dev = resultsOf("dev", counted.slice(0, 20), ["A", "B"], grade);

    assert.equal(dev.pass, undefined, "the development set decides nothing");
});

// ---------------------------------------------------------------------------------------------------------------
// The run, on fixture packs.
// ---------------------------------------------------------------------------------------------------------------

let fixture;
let dir;
const GOOD = (grade) => JSON.stringify({ grade, reasons: "fixture" });

/** An item whose judges answer `grades` (per judge, in `JUDGES` order). */
const item = (id, set, grades, log) => ({
    id,
    set,
    brief: `Task ${id}.\nSCENARIO ${JSON.stringify({ name: "judge", answers: { [JUDGES[0]]: [GOOD(grades[0])], [JUDGES[1]]: [GOOD(grades[1])] }, log })}`,
    s1: true,
    s2: null,
    submitted: cutDiff(`diff --git a/${id} b/${id}\n+x\n`, ""),
    reference: cutDiff("diff --git a/r b/r\n+y\n", ""),
});

/** Write 1 owner's pack: items and labels (`label`, and `blind: false` for the ids in `seen`). */
function writePack(owner, items, labelOf, seen = []) {
    const folder = join(dir, "packs", owner);
    const text = `${JSON.stringify({ schema: 1, owner, items }, null, 4)}\n`;

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "items.json"), text);
    writeFileSync(
        join(folder, "labels.json"),
        JSON.stringify({
            schema: 1,
            owner,
            itemsSha256: sha256(text),
            labels: items.map((i) => ({
                id: i.id,
                set: i.set,
                label: labelOf(i),
                note: "",
                blind: !seen.includes(i.id),
                reason: seen.includes(i.id) ? "I reviewed this change" : "",
            })),
        }),
    );
}

const judgeLog = () => join(fixture.root, "judges.log");

const calls = () => {
    try {
        return readFileSync(judgeLog(), "utf8").split("\n").filter(Boolean).length;
    } catch {
        return 0;
    }
};

const run = (args, deps = {}) => {
    const out = [];

    return judgeCalibrationMain(
        [
            ...args,
            "--dir",
            dir,
            "--bwrap",
            FAKE_BWRAP,
            "--pocket",
            fixture.pocket,
            "--agent-src",
            fixture.agent,
            "--no-auth-preflight",
        ],
        testEnv(fixture),
        {
            now: () => Date.UTC(2026, 10, 8),
            log: () => {},
            print: (t) => out.push(t),
            killGraceMs: 2000,
            ...deps,
        },
    ).then((code) => ({ code, out: out.join("\n") }));
};

before(async () => {
    fixture = makeFixture();
    dir = join(fixture.root, "calibration");
    await setBudget(fixture, 100);
});

after(() => rm(fixture.root, { recursive: true, force: true }));

test("the run: development verdicts, resume, a changed prompt, an item seen before", async () => {
    const log = judgeLog();
    // 4 dev items: owner labels pass, pass, fail, fail; judges agree except judge 2 on d3; d4 was seen before.
    const items = [
        item("d1", "dev", [4, 4], log),
        item("d2", "dev", [3, 3], log),
        item("d3", "dev", [1, 3], log),
        item("d4", "dev", [0, 0], log),
        item("h1", "heldOut", [4, 4], log),
    ];

    writePack("irulan", items, (i) => (["d1", "d2", "h1"].includes(i.id) ? "pass" : "fail"), [
        "d4",
    ]);

    const first = await run(["--set", "dev"]);

    assert.equal(first.code, 0, first.out);
    assert.equal(calls(), 6, "2 judges x 3 counted items; d4 and the held-out item are not judged");
    assert.match(
        first.out,
        /Counted items: 3 \(owner passes 2, owner fails 1\); left out \(blind: false\): 1/,
    );

    const results = JSON.parse(
        readFileSync(
            join(
                dir,
                "judge-results",
                `dev-${sha256(readFileSync(JUDGE_PROMPT, "utf8")).slice(0, 12)}.json`,
            ),
            "utf8",
        ),
    );

    assert.equal(results.judges[JUDGES[0]].agree, 3);
    assert.equal(results.judges[JUDGES[1]].agree, 2);
    assert.deepEqual(
        [results.judges[JUDGES[1]].falsePass.k, results.judges[JUDGES[1]].falsePass.n],
        [1, 1],
    );
    assert.equal(results.s3.agree, 3, "S3: d3 fails (judge 1 gave 1)");
    assert.equal(results.spend, 0.12);

    // Resume: every verdict holds, no call.
    const again = await run(["--set", "dev"]);

    assert.equal(again.code, 0);
    assert.equal(calls(), 6);

    // A changed prompt: a new hash, each item judged again.
    const v2 = join(fixture.root, "judge-v2.md");

    writeFileSync(v2, `${readFileSync(JUDGE_PROMPT, "utf8")}\nOne more rule.\n`);
    assert.equal((await run(["--set", "dev", "--prompt", v2])).code, 0);
    assert.equal(calls(), 12);
    assert.equal(readdirSync(join(dir, "judged")).length, 2, "1 verdict folder per prompt");

    // --stats-only: no call, the same numbers.
    const stats = await run(["--set", "dev", "--stats-only"]);

    assert.equal(stats.code, 0);
    assert.equal(calls(), 12);

    // A rebuilt pack gives the id d1 another diff: its saved verdicts are of another input, so d1 is judged again.
    const rebuilt = items.map((i) =>
        i.id === "d1" ? { ...i, submitted: cutDiff("diff --git a/z b/z\n+other\n", "") } : i,
    );

    writePack("irulan", rebuilt, (i) => (["d1", "d2", "h1"].includes(i.id) ? "pass" : "fail"), [
        "d4",
    ]);
    assert.equal((await run(["--set", "dev"])).code, 0);
    assert.equal(calls(), 14, "only d1, by both judges");
});

test("the held-out gates: an unlabelled item, a prompt not frozen, a short set: no judge call", async () => {
    const log = judgeLog();
    const before = calls();
    const heldOut = (n, fails) =>
        Array.from({ length: n }, (_, i) =>
            item(`h${i}`, "heldOut", [i < fails ? 1 : 4, i < fails ? 1 : 4], log),
        );

    // An unlabelled counted item.
    writePack("irulan", heldOut(4, 0), (i) => (i.id === "h2" ? null : "pass"));
    assert.equal((await run(["--set", "held-out"], { frozenSha256: "x" })).code, 1);

    // Not frozen.
    writePack("irulan", heldOut(40, 12), (i) => (Number(i.id.slice(1)) < 12 ? "fail" : "pass"));
    assert.equal((await run(["--set", "held-out"])).code, 1);

    // Another prompt than the frozen one.
    assert.equal((await run(["--set", "held-out"], { frozenSha256: "0".repeat(64) })).code, 1);

    // Short: 9 owner fails.
    const frozen = sha256(readFileSync(JUDGE_PROMPT, "utf8"));

    writePack("irulan", heldOut(40, 9), (i) => (Number(i.id.slice(1)) < 9 ? "fail" : "pass"));
    assert.equal((await run(["--set", "held-out"], { frozenSha256: frozen })).code, 1);

    // 4 of 40 seen before: 36 counted, still 10 fails.
    writePack("irulan", heldOut(40, 10), (i) => (Number(i.id.slice(1)) < 10 ? "fail" : "pass"), [
        "h36",
        "h37",
        "h38",
        "h39",
    ]);
    assert.equal(calls(), before, "no judge call before the gates pass");

    const valid = await run(["--set", "held-out"], { frozenSha256: frozen });

    assert.equal(valid.code, 0, valid.out);
    assert.equal(calls(), before + 72, "2 judges x 36 counted items");
    assert.match(valid.out, /Counted items: 36 \(owner passes 26, owner fails 10\)/);
    assert.match(valid.out, /Held-out result: PASS/);
});

test("a budget refusal stops the run with exit 2 and keeps the verdicts so far", async () => {
    const log = judgeLog();

    writePack(
        "teg",
        [item("b1", "dev", [4, 4], log), item("b2", "dev", [4, 4], log)],
        () => "pass",
    );
    await rm(join(dir, "packs", "irulan"), { recursive: true, force: true });
    await setBudget(fixture, 0);

    const refused = await run(["--set", "dev"]);

    assert.equal(refused.code, 2);

    await setBudget(fixture, 100);

    const done = await run(["--set", "dev"]);

    assert.equal(done.code, 0, done.out);
});
