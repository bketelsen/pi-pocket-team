// The bench analysis on synthetic data: the sampler, the paired posterior (seed 1064), the stage rules on a fixture
// of 12 tasks x 3 models with known counts, the ordinal rule with nested leave-one-repository-out selection, the
// simulation, and the command line. No model, no network and no wall clock.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    BANDS,
    CLOSE_THRESHOLD,
    CLOSE_THRESHOLD_STRICT,
    analyzeStage1,
    analyzeStage2,
    attemptCost,
    bandIndex,
    bandOf,
    buildRule,
    chooseThreshold,
    closeEnough,
    decideTier,
    designRow,
    fitTransform,
    manifestTasks,
    simulatedTier,
    SIM_B,
    SIM_M,
    SIM_OTHER,
    thresholdFromSimulation,
    familyOf,
    fitOrdinal,
    groupModelsFrom,
    stage2Branch,
    forwardSelect,
    gamma,
    main,
    mulberry32,
    nestedValidation,
    objective,
    pairedCells,
    predictTier,
    probGapWithin,
    selfPreference,
    simulateAcceptance,
    simulationReport,
    toAttempt,
    writeRule,
} from "./analyze.mjs";

// ---------------------------------------------------------------------------------------------------------------
// The fixture: 12 tasks x 3 models, with known counts. A larger fixture (the command line's stage 2) repeats the 12
// in order: t13 behaves as t01, t25 as t01, and so on.
//
// - easy t01-t06: all 3 pass. big grades 4, mid and halogen 3.5. B = big; mid and halogen are close enough
//   (n11 = 6: P = 0.80579 >= 0.8). The pick is mid ($0.04) at the stand-in price, halogen at $0.
// - medium t07-t08: only big passes. 2 tasks: inconclusive (the fixture's minPaired is 4).
// - hard t09-t12: big passes t09 and t12; mid passes t09-t11 and has a provider failure on t12; halogen fails all.
//   B = mid, whose availability is 0.75: the tier keeps today's policy.
// In stage 1 the same results give the true bands: t01-t06 easy (3 of 3 pass), t07-t12 medium (1 or 2 of 3).
// ---------------------------------------------------------------------------------------------------------------

const BIG = "test/big";
const MID = "test/mid";
const HALOGEN = "halogen/halogen-qwen3.8-flash-next";
const MODELS = [BIG, MID, HALOGEN];

const idsOf = (count) =>
    Array.from({ length: count }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
const baseOf = (id) => ((Number(id.slice(1)) - 1) % 12) + 1;

const tierOfFixture = (id) => {
    const n = baseOf(id);

    return n <= 6 ? "easy" : n <= 8 ? "medium" : "hard";
};

const FEATURES = {
    easy: { kind: "write", briefChars: 400, complexity: 1 },
    medium: { kind: "implement", briefChars: 1500, complexity: 2 },
    hard: { kind: "debug", briefChars: 4000, complexity: 3 },
};

const fixtureTasks = (count = 12) =>
    idsOf(count).map((id, i) => ({
        id,
        repo: `owner/r${(i % 3) + 1}`,
        features: { ...FEATURES[tierOfFixture(id)], language: "go" },
        predictedTier: tierOfFixture(id),
    }));

const pass = (grades) => ({ s1: true, s2: true, grades });
const fail = (grades = [1, 1]) => ({ s1: false, s2: false, grades });

function outcome(id, model) {
    const tier = tierOfFixture(id);
    const n = baseOf(id);

    if (tier === "easy") {
        return pass(model === BIG ? [4, 4] : [3, 4]);
    }

    if (tier === "medium") {
        return model === BIG ? pass([4, 4]) : fail(model === MID ? [1, 2] : [1, 1]);
    }

    if (model === BIG) {
        return n === 9 || n === 12 ? pass([4, 4]) : { s1: true, s2: false, grades: [2, 2] };
    }

    if (model === MID) {
        if (n === 12) {
            return { s1: false, s2: null, grades: null, failure: "provider" };
        }

        return pass([3, 4]);
    }

    return n === 12 ? { ...fail(), failure: "limit" } : fail();
}

function result(id, model, stage = "stage2") {
    const usage =
        model === BIG
            ? { input: 200000, output: 30000, cacheRead: 0, cost: 2, partial: false }
            : model === MID
              ? { input: 50000, output: 10000, cacheRead: 0, cost: 0.04, partial: false }
              : { input: 100000, output: 20000, cacheRead: 0, cost: 0, partial: false };
    const wallMs = model === BIG ? 600000 : model === MID ? 500000 : 400000;

    return {
        task: id,
        model,
        stage,
        thinking: "high",
        headerVersion: 1,
        startedAt: "2026-11-10T00:00:00Z",
        wallMs,
        tries: 1,
        usage,
        s0: { protocol: false, leakTry: false },
        diffCut: false,
        judgePending: false,
        ...outcome(id, model),
    };
}

const fixtureResults = (stage, count = 12) =>
    idsOf(count).flatMap((id) => MODELS.map((m) => result(id, m, stage)));

// ---------------------------------------------------------------------------------------------------------------
// The sampler and the posterior.
// ---------------------------------------------------------------------------------------------------------------

test("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(1064);
    const b = mulberry32(1064);
    const first = Array.from({ length: 5 }, () => a());

    assert.deepEqual(
        first,
        Array.from({ length: 5 }, () => b()),
    );

    for (const x of first) {
        assert.ok(x >= 0 && x < 1);
    }

    assert.notDeepEqual(first, Array.from({ length: 5 }, mulberry32(1065)));
});

test("gamma draws have the right mean and variance, also below shape 1", () => {
    for (const shape of [0.5, 1, 2.5, 30]) {
        const rng = mulberry32(7);
        const n = 100000;
        let sum = 0;
        let sq = 0;

        for (let i = 0; i < n; i++) {
            const x = gamma(shape, rng);

            sum += x;
            sq += x * x;
        }

        const mean = sum / n;
        const variance = sq / n - mean * mean;

        assert.ok(Math.abs(mean - shape) < 0.03 * shape + 0.01, `mean ${mean} for shape ${shape}`);
        assert.ok(
            Math.abs(variance - shape) < 0.06 * shape + 0.02,
            `variance ${variance} for shape ${shape}`,
        );
    }
});

/** P(p10 - p01 <= m) by midpoint integration over the simplex: Dirichlet aggregation gives (p10, p01, rest). */
function integrate(cells, margin, grid = 800) {
    const a = 1 + cells.n10;
    const b = 1 + cells.n01;
    const c = 2 + cells.n11 + cells.n00;
    let total = 0;
    let within = 0;
    const h = 1 / grid;

    for (let i = 0; i < grid; i++) {
        const x = (i + 0.5) * h;

        for (let j = 0; j < grid - i; j++) {
            const y = (j + 0.5) * h;
            const z = 1 - x - y;

            if (z <= 0) {
                continue;
            }

            const d = Math.exp(
                (a - 1) * Math.log(x) + (b - 1) * Math.log(y) + (c - 1) * Math.log(z),
            );

            total += d;

            if (x - y <= margin) {
                within += d;
            }
        }
    }

    return within / total;
}

test("the posterior P(gap <= margin) agrees with numerical integration", () => {
    for (const cells of [
        { n11: 6, n10: 0, n01: 0, n00: 0 },
        { n11: 40, n10: 6, n01: 6, n00: 8 },
        { n11: 20, n10: 9, n01: 1, n00: 5 },
    ]) {
        const p = probGapWithin(cells);
        const exact = integrate(cells, 0.1);

        assert.ok(Math.abs(p - exact) < 0.006, `${JSON.stringify(cells)}: ${p} against ${exact}`);
    }
});

test("the posterior is fixed by the seed 1064 and the counts", () => {
    assert.equal(probGapWithin({ n11: 6, n10: 0, n01: 0, n00: 0 }), 0.80579);
    assert.equal(probGapWithin({ n11: 1, n10: 2, n01: 2, n00: 0 }), 0.64829);
    assert.equal(probGapWithin({ n11: 7, n10: 2, n01: 2, n00: 0 }), 0.74222);
    assert.equal(probGapWithin({ n11: 6, n10: 3, n01: 0, n00: 2 }), 0.22211);
    assert.equal(probGapWithin({ n11: 4, n10: 0, n01: 0, n00: 0 }), 0.76178);
    // Another seed gives other draws.
    assert.notEqual(probGapWithin({ n11: 6, n10: 0, n01: 0, n00: 0 }, { seed: 1 }), 0.80579);
});

test("paired cells leave out a task that either model lacks", () => {
    const b = new Map([
        ["a", true],
        ["b", true],
        ["c", false],
        ["d", false],
        ["e", true],
    ]);
    const m = new Map([
        ["a", true],
        ["b", false],
        ["c", true],
        ["d", false],
    ]);

    assert.deepEqual(pairedCells(b, m, ["a", "b", "c", "d", "e"]), {
        n11: 1,
        n10: 1,
        n01: 1,
        n00: 1,
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Attempts.
// ---------------------------------------------------------------------------------------------------------------

test("a pass needs a finished attempt, S1, S2 or no S2, no protocol breach, and both grades of 3 or more", () => {
    const base = result("t01", BIG);

    assert.equal(toAttempt(base).pass, true);
    assert.equal(toAttempt({ ...base, s2: null }).pass, true);
    assert.equal(toAttempt({ ...base, s2: false }).pass, false);
    assert.equal(toAttempt({ ...base, s1: false }).pass, false);
    assert.equal(toAttempt({ ...base, grades: [4, 2] }).pass, false);
    assert.equal(toAttempt({ ...base, grades: [4] }).pass, false);
    assert.equal(toAttempt({ ...base, grades: [4] }).status, "unscored");
    assert.equal(toAttempt({ ...base, s1: undefined }).status, "unscored");
    assert.equal(toAttempt({ ...base, s2: undefined }).status, "unscored");
    // A failed attempt needs no score: it is a fail.
    assert.equal(
        toAttempt({ ...base, failure: "provider", s1: undefined, grades: null }).status,
        "valid",
    );
    assert.equal(toAttempt({ ...base, failure: "limit" }).pass, false);
    assert.equal(toAttempt({ ...base, s0: { protocol: true, leakTry: false } }).pass, false);
    assert.equal(toAttempt({ ...base, harness: "setup failed" }).status, "harness");
    assert.equal(toAttempt({ ...base, judgePending: true }).status, "pending");
    assert.equal(toAttempt({ ...base, failure: "limit", grades: null }).grade, 0);
});

test("a model with no list price takes the stand-in price, or $0 when asked", () => {
    const r = result("t01", HALOGEN);

    assert.ok(Math.abs(attemptCost(r) - (100000 * 0.3 + 20000 * 1.2) / 1e6) < 1e-12);
    assert.equal(attemptCost(r, "zero"), 0);
    assert.equal(attemptCost(result("t01", BIG)), 2);
    assert.equal(attemptCost(result("t01", BIG), "zero"), 2);
});

test("bands: easy at 70% or more, medium from 30%, hard below, unsolved at 0", () => {
    assert.equal(bandOf(7, 10), "easy");
    assert.equal(bandOf(6, 10), "medium");
    assert.equal(bandOf(3, 10), "medium");
    assert.equal(bandOf(2, 10), "hard");
    assert.equal(bandOf(0, 10), "unsolved");
});

test("close enough needs all 4 guards", () => {
    const b = { meanGrade: 3.6, availability: 1, medianWallMs: 1000 };
    const m = { meanGrade: 3.1, availability: 0.95, medianWallMs: 2000 };

    assert.equal(closeEnough(m, b, 0.8).ok, true);
    assert.equal(closeEnough(m, b, 0.79).posterior, false);
    assert.equal(closeEnough({ ...m, meanGrade: 3.09 }, b, 0.9).grade, false);
    assert.equal(closeEnough({ ...m, availability: 0.94 }, b, 0.9).availability, false);
    assert.equal(closeEnough({ ...m, medianWallMs: 2001 }, b, 0.9).wall, false);
    assert.equal(closeEnough(m, b, 0.85, CLOSE_THRESHOLD_STRICT).ok, false);
});

test("self-preference: each judge's grade of its own family against the other judge's", () => {
    const r = (model, grades) => ({ task: "x", model, grades });
    const report = selfPreference([
        r("github-copilot/gpt-6-luna", [4, 3]),
        r("github-copilot/gpt-6.1-sol", [4, 2]),
        r("github-copilot/claude-sonnet-5.5", [2, 4]),
        r("github-copilot/claude-haiku-5.5", [3, null]),
        r("deepseek/deepseek-flash", [1, 1]),
    ]);

    assert.deepEqual(report, {
        openai: { n: 2, own: 4, other: 2.5 },
        anthropic: { n: 1, own: 4, other: 2 },
    });
    assert.equal(familyOf("halogen/halogen-qwen3.8-flash-next"), "other");
});

// ---------------------------------------------------------------------------------------------------------------
// Stage 1 and stage 2 on the fixture.
// ---------------------------------------------------------------------------------------------------------------

test("stage 1 on the fixture: bands, B1, shortlists, C1 and the $0 pricing", () => {
    const s = analyzeStage1({
        tasks: fixtureTasks(),
        results: fixtureResults("stage1"),
        options: { fitRule: false },
    });

    assert.deepEqual(s.models, [HALOGEN, BIG, MID].sort());
    assert.deepEqual(s.bandCounts, { easy: 6, medium: 6, hard: 0, unsolved: 0 });
    assert.equal(s.bands.t09, "medium");
    assert.equal(s.majorityBand, "easy");

    assert.equal(s.tiers.easy.b1, BIG);
    assert.equal(s.tiers.easy.vsB1[MID].p, 0.80579);
    assert.deepEqual(s.tiers.easy.shortlist, [MID, HALOGEN]);

    // medium (t07-t12): big passes 4, mid 3. Mid falls just short of 0.5, so the shortlist is empty.
    assert.equal(s.tiers.medium.b1, BIG);
    assert.deepEqual(
        { ...s.tiers.medium.vsB1[MID], p: undefined },
        { n11: 1, n10: 3, n01: 2, n00: 0, p: undefined },
    );
    assert.equal(s.tiers.medium.vsB1[MID].p, 0.49312);
    assert.equal(s.tiers.medium.vsB1[HALOGEN].p, 0.0722);
    assert.deepEqual(s.tiers.medium.shortlist, []);
    assert.equal(s.tiers.hard.b1, null);

    // C1, over all 12 tasks: best is big (10 passes); mid (9 passes) qualifies at 0.59517, halogen does not.
    assert.equal(s.overall.n, 12);
    assert.equal(s.overall.best, BIG);
    assert.deepEqual(
        { ...s.overall.vsBest[MID], p: undefined },
        { n11: 7, n10: 3, n01: 2, n00: 0, p: undefined },
    );
    assert.equal(s.overall.vsBest[MID].p, 0.59517);
    assert.equal(s.overall.vsBest[HALOGEN].p, 0.12623);
    assert.equal(s.overall.c1, MID);

    assert.deepEqual(s.zeroPricing.tiers.easy.shortlist, [HALOGEN, MID]);
    assert.deepEqual(s.pricingDiffers, ["easy"]);
});

test("an unsolved task counts as hard for the rule and drops from every pick", () => {
    const results = (stage) =>
        fixtureResults(stage).map((r) =>
            r.task === "t12" && r.model === BIG ? { ...r, s2: false, grades: [2, 2] } : r,
        );
    const s1 = analyzeStage1({
        tasks: fixtureTasks(),
        results: results("stage1"),
        options: { fitRule: false },
    });

    assert.equal(s1.bands.t12, "unsolved");
    assert.deepEqual(s1.bandCounts, { easy: 6, medium: 5, hard: 0, unsolved: 1 });
    assert.equal(s1.tiers.medium.n, 5);
    assert.equal(s1.overall.n, 11);
    assert.equal(bandIndex(s1.bands.t12), 2);

    // minPaired 2: each fixture band (6, 2 and 4 tasks) is a confirmed group alone, as each tier was before the
    // branch rule; with 3, medium (2) would be unconfirmed and get no stage 2 run.
    const s2 = analyzeStage2({
        tasks: fixtureTasks(),
        results: results("stage2"),
        options: { minPaired: 2 },
    });

    assert.deepEqual(s2.tiers.hard.unsolved, ["t12"]);
    assert.equal(s2.tiers.hard.n, 3);
    assert.equal(s2.constant.n, 11);
});

test("stage 1 drops a task with a harness failure from every comparison", () => {
    const results = fixtureResults("stage1").map((r) =>
        r.task === "t01" && r.model === HALOGEN ? { ...r, harness: "sandbox died" } : r,
    );
    const s = analyzeStage1({ tasks: fixtureTasks(), results, options: { fitRule: false } });

    assert.deepEqual(s.tasks.dropped, ["t01"]);
    assert.equal(s.bandCounts.easy, 5);
    assert.equal(s.tiers.easy.vsB1[MID].n11, 5);
});

test("stage 2 on the fixture: B, picks, today, the constant policy, H1 and H3", () => {
    const stage1 = { bands: {}, majorityBand: "easy" };
    // minPaired 2, so the branch confirms each fixture band alone (6, 2 and 4 tasks). Before the branch rule this test
    // used 4, and medium (2 tasks) was "inconclusive"; under the branch rule a band under the minimum gets no stage 2
    // run at all ("unconfirmed", tested below), so medium is now decided on its 2 tasks.
    const s = analyzeStage2({
        tasks: fixtureTasks(),
        results: fixtureResults("stage2"),
        stage1,
        options: { minPaired: 2 },
    });

    assert.equal(s.branch.branch, "confirm");

    const easy = s.tiers.easy;

    assert.equal(easy.status, "decided");
    assert.equal(easy.b, BIG);
    assert.equal(easy.vsB[MID].p, 0.80579);
    assert.equal(easy.vsB[HALOGEN].p, 0.80579);
    assert.equal(easy.close[MID].ok, true);
    assert.equal(easy.close[HALOGEN].ok, true);
    assert.equal(easy.pick, MID);

    // medium: only big passes; mid and halogen are far from it.
    assert.equal(s.tiers.medium.status, "decided");
    assert.equal(s.tiers.medium.n, 2);
    assert.equal(s.tiers.medium.pick, BIG);

    const hard = s.tiers.hard;

    assert.equal(hard.b, MID);
    assert.equal(hard.stats.find((x) => x.model === MID).availability, 0.75);
    assert.equal(hard.status, "today");

    // The constant policy, over all 12 tasks: big passes 10, mid 9. Mid's P is 0.59517 (below 0.8), and its grade
    // 2.875 is below big's 3.667 - 0.5.
    assert.equal(s.constant.b, BIG);
    assert.equal(s.constant.vsB[MID].p, 0.59517);
    assert.equal(s.constant.close[MID].posterior, false);
    assert.equal(s.constant.close[MID].grade, false);
    assert.equal(s.constant.close[MID].ok, false);
    assert.equal(s.constant.model, BIG);

    // H3: mid on the easy tier ($0.24 for 6 passes) and big on medium ($4 for 2) against big on both ($16 for 8):
    // 1 - 0.53 / 2.
    assert.equal(s.h3.result, "holds");
    assert.deepEqual(s.h3.tiers, ["easy", "medium"]);
    assert.ok(Math.abs(s.h3.saving - 0.735) < 1e-9);

    assert.deepEqual(s.decisions, {
        easy: { action: "pick", model: MID },
        medium: { action: "pick", model: BIG },
        hard: { action: "today", model: null },
    });
    assert.deepEqual(s.zeroPricing.decisions.easy, { action: "pick", model: HALOGEN });
    assert.deepEqual(s.pricingDiffers, ["easy"]);

    // H1: the rule's tier is right on 8 of 12 (t09-t12 come out medium), the majority band (easy) on 6.
    assert.equal(s.h1.ruleAccuracy, 8 / 12);
    assert.equal(s.h1.majorityAccuracy, 0.5);
    assert.equal(s.h1.result, "holds");
});

test("stage 2: when H3 fails, every decided tier gets the constant policy", () => {
    // Mid as dear as big, and halogen at $1.80 an attempt at the stand-in price: the pick (halogen) saves 10%.
    const results = fixtureResults("stage2").map((r) => {
        if (r.model === MID) {
            return { ...r, usage: { ...r.usage, cost: 2 } };
        }

        if (r.model === HALOGEN) {
            return { ...r, usage: { ...r.usage, input: 2e6, output: 1e6 } };
        }

        return r;
    });
    // minPaired 2: medium (2 tasks) is decided too (big), so H3 counts it: halogen $10.80 for 6 passes and big $4
    // for 2, against big $16 for 8: 1 - 1.85 / 2 = 7.5% (10% on easy alone, before the branch rule).
    const s = analyzeStage2({ tasks: fixtureTasks(), results, options: { minPaired: 2 } });

    assert.equal(s.tiers.easy.pick, HALOGEN);
    assert.ok(Math.abs(s.h3.saving - 0.075) < 1e-9);
    assert.equal(s.h3.result, "fails");
    assert.deepEqual(s.decisions.easy, { action: "constant", model: BIG });
    // At $0 for halogen the tier policy saves everything: the priced result is the one deployed, and both show.
    assert.deepEqual(s.zeroPricing.decisions.easy, { action: "pick", model: HALOGEN });
    assert.ok(s.pricingDiffers.includes("easy"));
    assert.equal(s.h1.result, "inconclusive");
});

test("stage 2 at the pre-registered minimum of 30 tasks: the 12-task fixture waits, and refuses its results", () => {
    // Before the branch rule every tier was "inconclusive" here; now R = 12 is under 30, so stage 2 waits and runs
    // nothing: a result is an error, and no result is needed.
    assert.throws(
        () => analyzeStage2({ tasks: fixtureTasks(), results: fixtureResults("stage2") }),
        /stage 2 waits for the pool \(R = 12, under 30\)/,
    );
    const s = analyzeStage2({ tasks: fixtureTasks(), results: [] });

    assert.equal(s.branch.branch, "wait");
    assert.equal(s.R, 12);
    assert.deepEqual(s.counts, { easy: 6, medium: 2, hard: 4 });
    assert.equal(s.decisions, undefined);
});

test("stage 2 refuses a stage 1 task and a task with no tier", () => {
    const stage1 = { bands: { t01: "easy" }, majorityBand: "easy" };

    assert.throws(
        () => analyzeStage2({ tasks: fixtureTasks(), results: fixtureResults("stage2"), stage1 }),
        /fresh tasks/,
    );
    // A stage 1 task with no band (dropped by a harness failure) is still not fresh.
    const dropped = { bands: {}, tasks: { ids: ["t02"] }, majorityBand: "easy" };

    assert.throws(
        () =>
            analyzeStage2({
                tasks: fixtureTasks(),
                results: fixtureResults("stage2"),
                stage1: dropped,
            }),
        /t02/,
    );

    const tasks = fixtureTasks().map((t) => ({ ...t, predictedTier: undefined }));

    assert.throws(
        () => analyzeStage2({ tasks, results: fixtureResults("stage2") }),
        /no predicted tier/,
    );
});

// ---------------------------------------------------------------------------------------------------------------
// The ordinal rule.
// ---------------------------------------------------------------------------------------------------------------

test("the objective's gradient matches finite differences", () => {
    const rng = mulberry32(3);
    const X = Array.from({ length: 12 }, () => [rng() - 0.5, rng() * 2, rng() < 0.5 ? 1 : 0]);
    const y = X.map((_, i) => i % 3);
    const w = [0.3, -0.2, 0.5];
    const a = -0.4;
    const b = 0.2;
    const g = objective(X, y, w, a, b);
    const h = 1e-6;

    for (let j = 0; j < w.length; j++) {
        const wp = [...w];

        wp[j] += h;
        const wm = [...w];

        wm[j] -= h;
        const num = (objective(X, y, wp, a, b).loss - objective(X, y, wm, a, b).loss) / (2 * h);

        assert.ok(Math.abs(num - g.gw[j]) < 1e-6, `w${j}: ${num} against ${g.gw[j]}`);
    }

    const na = (objective(X, y, w, a + h, b).loss - objective(X, y, w, a - h, b).loss) / (2 * h);
    const nb = (objective(X, y, w, a, b + h).loss - objective(X, y, w, a, b - h).loss) / (2 * h);

    assert.ok(Math.abs(na - g.ga) < 1e-6);
    assert.ok(Math.abs(nb - g.gb) < 1e-6);
});

test("the fit starts at 0 and orders a 1-feature signal", () => {
    const X = [[-1], [-1], [0], [0], [1], [1]];
    const y = [0, 0, 1, 1, 2, 2];
    const { w, thresholds } = fitOrdinal(X, y);

    assert.ok(w[0] > 0);
    assert.ok(thresholds[0] < thresholds[1]);
    const { w: none } = fitOrdinal(X, y, { steps: 0 });

    assert.deepEqual(none, [0]);
});

/**
 * Synthetic stage 1 rows: 4 repositories x 9 tasks. A latent difficulty d sets the band (easy below 0.4, hard from
 * 0.7) and the brief length; every other feature is noise, and some values are missing.
 */
function syntheticRows() {
    const rng = mulberry32(1064);
    const kinds = ["implement", "debug", "write"];
    const languages = ["go", "ts", "python", "go"];
    const rows = [];

    for (let r = 0; r < 4; r++) {
        for (let i = 0; i < 9; i++) {
            const d = (i + rng()) / 9;
            const band = d < 0.4 ? "easy" : d < 0.7 ? "medium" : "hard";

            rows.push({
                id: `s${r}-${i}`,
                repo: `owner/repo${r}`,
                band,
                features: {
                    kind: rng() < 0.1 ? undefined : kinds[Math.floor(rng() * 3)],
                    complexity: rng() < 0.2 ? undefined : rng() * 3,
                    capability: rng() * 3,
                    deepReasoning: rng(),
                    demand: rng() * 3,
                    briefChars: Math.round(500 + 4000 * d + 300 * (rng() - 0.5)),
                    pathsNamed: Math.floor(rng() * 5),
                    reposNamed: 1,
                    language: languages[r],
                    riskPathNamed: rng() < 0.2,
                    testsBeside: i % 2 === 0 ? null : rng() < 0.5,
                },
            });
        }
    }

    return rows;
}

test("the ordinal rule: nested leave-one-repository-out selection, then the frozen rule-v1.json shape", () => {
    const rows = syntheticRows();
    const nested = nestedValidation(rows);

    assert.equal(nested.folds.length, 4);

    for (const fold of nested.folds) {
        assert.ok(fold.features.length <= 6);
        assert.ok(fold.features.includes("briefChars"), `fold ${fold.repo}: ${fold.features}`);
    }

    assert.ok(nested.accuracy >= 0.75, `nested accuracy ${nested.accuracy}`);

    const rule = buildRule(rows);

    assert.deepEqual(Object.keys(rule).sort(), [
        "center",
        "features",
        "levels",
        "medians",
        "scale",
        "thresholds",
        "version",
        "weights",
    ]);
    assert.equal(rule.version, 1);
    assert.ok(rule.features.includes("briefChars"));
    assert.ok(rule.features.length <= 6);
    assert.ok(rule.weights.briefChars > 0);
    assert.equal(rule.thresholds.length, 2);
    assert.ok(rule.thresholds[0] < rule.thresholds[1]);

    for (const f of rule.features) {
        if (f === "kind" || f === "language") {
            assert.ok(rule.levels[f].includes("unknown"));
        } else {
            assert.ok(rule.scale[f] > 0 && f in rule.center && f in rule.medians);
        }
    }

    assert.equal(predictTier(rule, { briefChars: 600 }), "easy");
    assert.equal(predictTier(rule, { briefChars: 4400 }), "hard");
    // A missing feature takes the training median, and an unseen level becomes `unknown`.
    assert.ok(BANDS.includes(predictTier(rule, { kind: "never-seen" })));

    const dir = mkdtempSync(join(tmpdir(), "bench-rule-"));

    try {
        const path = join(dir, "bench", "rule-v1.json");

        writeRule(path, rule);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), rule);
    } finally {
        rmSync(dir, { recursive: true });
    }
});

test("forward selection stops when no feature helps, and needs 2 repositories", () => {
    const rows = syntheticRows();
    const constant = rows.map((r) => ({ ...r, band: "easy" }));

    assert.deepEqual(forwardSelect(constant).features, []);
    const one = rows.filter((r) => r.repo === "owner/repo0");

    assert.deepEqual(forwardSelect(one), { features: [], accuracy: null });
});

test("stage 1 fits the rule and tests H2 only when half the tasks have Jev numbers", () => {
    const tasks = fixtureTasks().map((t) => ({
        ...t,
        features: { ...t.features, complexity: undefined },
    }));
    const s = analyzeStage1({ tasks, results: fixtureResults("stage1"), options: { draws: 1000 } });

    assert.equal(s.h2.result, "inconclusive");
    assert.ok(s.rule && s.nested.folds.length === 3);
    const withJev = analyzeStage1({
        tasks: fixtureTasks(),
        results: fixtureResults("stage1"),
        options: { draws: 1000 },
    });

    assert.ok(["holds", "fails"].includes(withJev.h2.result));
    assert.equal(typeof withJev.h2.jevAccuracy, "number");
    assert.equal(typeof withJev.h2.kindAccuracy, "number");
});

// ---------------------------------------------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------------------------------------------

test("the simulation reports the false-acceptance rate at gap 15 points for tier sizes 30 and 60", () => {
    const report = simulationReport({ reps: 200, draws: 10000 });

    assert.equal(report.gap, 0.15);
    assert.equal(report.seed, 1064);
    assert.deepEqual(
        report.rows.map((r) => [r.n, r.threshold]),
        [
            [30, 0.8],
            [30, 0.9],
            [60, 0.8],
            [60, 0.9],
        ],
    );

    for (const r of report.rows) {
        assert.ok(r.falseAcceptance >= 0 && r.falseAcceptance <= 1);
        // The rule accepts a model with no true gap far more often than one with a 15-point gap.
        assert.ok(r.powerAtZeroGap > r.falseAcceptance + 0.3, JSON.stringify(r));
    }

    const at = (n, t) => report.rows.find((r) => r.n === n && r.threshold === t).falseAcceptance;

    // More tasks and a stricter threshold each lower the false-acceptance rate.
    assert.ok(at(60, 0.8) < at(30, 0.8));
    assert.ok(at(30, 0.9) < at(30, 0.8));
    assert.deepEqual(report, simulationReport({ reps: 200, draws: 10000 }));
    assert.equal(report.threshold, chooseThreshold(report.rows));
});

test("the threshold rule moves to 0.9 when the false-acceptance rate at 0.8 is above 20%", () => {
    const rows = (far) => [
        { n: 30, threshold: 0.8, falseAcceptance: far },
        { n: 60, threshold: 0.8, falseAcceptance: 0.05 },
        { n: 30, threshold: 0.9, falseAcceptance: 0.5 },
    ];

    assert.equal(chooseThreshold(rows(0.2)), CLOSE_THRESHOLD);
    assert.equal(chooseThreshold(rows(0.21)), CLOSE_THRESHOLD_STRICT);
});

test("the simulated procedure: an equal or better M is always accepted, and the rate follows the true gap", () => {
    // A true gap of -0.2 (M better): M has more passes in nearly every rep.
    const better = simulateAcceptance({ n: 60, gap: -0.2, reps: 200, draws: 2000 });

    assert.ok(better.rate > 0.95);
    const far = simulateAcceptance({ n: 60, gap: 0.2, reps: 200, draws: 2000 });

    assert.ok(far.rate < 0.1);
    assert.throws(() => simulateAcceptance({ n: 30, gap: 0.5, discordance: 0.2 }), /impossible/);
});

// ---------------------------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------------------------

const KEPT = { keep: true, reason: "fixture", scopeMatches: true, commandsConfirmed: true };
const MODELS_FLAG = ["--models", MODELS.join(",")];

/** A rule on briefChars alone that gives the fixture's tiers: 400 easy, 1500 medium, 4000 hard. */
const FIXTURE_RULE = {
    version: 1,
    features: ["briefChars"],
    center: { briefChars: 1500 },
    scale: { briefChars: 1000 },
    levels: {},
    weights: { briefChars: 5 },
    thresholds: [-2, 2],
    medians: { briefChars: 1500 },
};

/** A stage 1 summary whose tiers expect all 3 fixture models, and whose only task is not in the fixture. */
const FIXTURE_STAGE1 = {
    tasks: { ids: ["old-1"] },
    bands: { "old-1": "easy" },
    majorityBand: "easy",
    tiers: {
        easy: { b1: BIG, shortlist: [MID, HALOGEN] },
        medium: { b1: BIG, shortlist: [MID] },
        hard: { b1: BIG, shortlist: [MID] },
    },
    groups: {
        "easy+medium": { b1: BIG, shortlist: [MID] },
        "medium+hard": { b1: BIG, shortlist: [MID] },
    },
    overall: { best: BIG, c1: HALOGEN },
};

/** The command line's stage 2 fixture: 60 tasks (the 12 repeated 5 times): easy 30, medium 10, hard 20. */
const STAGE2_COUNT = 60;

/** A simulation report whose rate at 0.8 is above 20% at tier size 30: stage 2 must use 0.9. */
const STRICT_SIMULATION = {
    margin: 0.1,
    gap: 0.15,
    seed: 1064,
    reps: 2000,
    draws: 100000,
    rows: [
        { n: 30, threshold: 0.8, falseAcceptance: 0.25 },
        { n: 60, threshold: 0.8, falseAcceptance: 0.05 },
    ],
};

function writeBench(root, stage) {
    const count = stage === "stage2" ? STAGE2_COUNT : 12;
    const manifest = join(root, "manifest.json");
    const tasks = fixtureTasks(count).map((t) => {
        const { predictedTier: _tier, ...rest } = t;

        return { ...rest, owner: KEPT };
    });

    writeFileSync(manifest, JSON.stringify({ tasks }));

    for (const r of fixtureResults(stage, count)) {
        const dir = join(root, "bench", "results", stage, r.task);

        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${r.model.replace("/", "--")}.json`), JSON.stringify(r));
    }

    if (stage === "stage2") {
        writeFileSync(join(root, "rule.json"), JSON.stringify(FIXTURE_RULE));
        writeFileSync(join(root, "stage1.json"), JSON.stringify(FIXTURE_STAGE1));
        writeFileSync(join(root, "simulation.json"), JSON.stringify(STRICT_SIMULATION));
        writeFileSync(
            join(root, "pool.json"),
            JSON.stringify({ stage1: { status: "ready", ids: [] }, stage2: { ids: idsOf(count) } }),
        );
    }

    return manifest;
}

const STAGE2_FLAGS = [
    "--stage",
    "2",
    "--manifest",
    "manifest.json",
    "--rule",
    "rule.json",
    "--stage1",
    "stage1.json",
    "--simulation",
    "simulation.json",
    "--pool",
    "pool.json",
];

test("the command line writes the stage 1 summary and freezes rule-v1.json once", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    try {
        const manifest = writeBench(root, "stage1");
        // A kept pool task that stage 1 did not run is not part of the stage.
        const json = JSON.parse(readFileSync(manifest, "utf8"));

        json.tasks.push({ id: "pool-1", repo: "owner/r9", features: {}, owner: KEPT });
        writeFileSync(manifest, JSON.stringify(json));
        const logs = [];
        const log = (line) => logs.push(line);

        assert.equal(
            main(["--stage", "1", "--manifest", "manifest.json", ...MODELS_FLAG], { root, log }),
            0,
        );
        const summary = JSON.parse(
            readFileSync(join(root, "bench/results/stage1/summary.json"), "utf8"),
        );

        assert.equal(summary.overall.c1, MID);
        assert.equal(summary.tasks.total, 12);
        assert.ok(
            readFileSync(join(root, "bench/results/stage1/summary.md"), "utf8").includes(
                "# Bench stage 1",
            ),
        );
        const rulePath = join(root, "bench/rule-v1.json");

        assert.ok(existsSync(rulePath));

        // A second run never replaces the frozen rule.
        writeFileSync(rulePath, '{"version":1,"frozen":true}\n');
        main(["--stage", "1", "--manifest", "manifest.json", ...MODELS_FLAG], { root, log });
        assert.equal(readFileSync(rulePath, "utf8"), '{"version":1,"frozen":true}\n');
        assert.ok(existsSync(join(root, "bench/results/stage1/rule.json")));
        assert.ok(logs.some((l) => l.includes("stays frozen")));
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the command line: stage 1 expects the 10 candidates, refuses an empty stage and repeated tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage1");
        // Without --models, every task needs a result of each of the 10 candidates: the 3 fixture models are not
        // candidates, so they are unexpected.
        assert.throws(
            () => main(["--stage", "1", "--manifest", "manifest.json"], { root, log }),
            /not expected/,
        );
        // A candidate with no result anywhere leaves every task incomplete.
        assert.throws(
            () =>
                main(
                    [
                        "--stage",
                        "1",
                        "--manifest",
                        "manifest.json",
                        "--models",
                        [...MODELS, "x/missing"].join(","),
                    ],
                    {
                        root,
                        log,
                    },
                ),
            /no usable task \(0 dropped by a harness failure, 12 incomplete\)/,
        );
        // The same manifest twice would count each task twice.
        assert.throws(
            () =>
                main(
                    [
                        "--stage",
                        "1",
                        "--manifest",
                        "manifest.json",
                        "--manifest",
                        "manifest.json",
                        ...MODELS_FLAG,
                    ],
                    {
                        root,
                        log,
                    },
                ),
            /task ids repeat/,
        );
        assert.equal(existsSync(join(root, "bench/results/stage1/summary.json")), false);
        assert.equal(existsSync(join(root, "bench/rule-v1.json")), false);

        rmSync(join(root, "bench/results"), { recursive: true });
        assert.throws(
            () =>
                main(["--stage", "1", "--manifest", "manifest.json", ...MODELS_FLAG], {
                    root,
                    log,
                }),
            /no results/,
        );
        assert.equal(existsSync(join(root, "bench/rule-v1.json")), false);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the command line: stage 2 uses the frozen rule, the stage 1 model sets and the simulation's threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage2");
        assert.equal(main(STAGE2_FLAGS, { root, log }), 0);
        const summary = JSON.parse(
            readFileSync(join(root, "bench/results/stage2/summary.json"), "utf8"),
        );

        assert.equal(summary.settings.threshold, CLOSE_THRESHOLD_STRICT);
        // 60 tasks: easy 30 is confirmed alone; medium 10 and hard 20 merge into 1 group of 30 (the merge branch).
        assert.equal(summary.branch.branch, "merge");
        assert.equal(summary.tiers.easy.n, 30);
        assert.equal(summary.tiers.hard.group, "medium+hard");
        assert.equal(summary.tiers.hard.n, 30);
        assert.deepEqual(summary.decisions.medium, summary.decisions.hard);

        // Each input is required.
        for (const flag of ["--rule", "--stage1", "--simulation", "--pool"]) {
            const flags = [...STAGE2_FLAGS];

            flags[flags.indexOf(flag) + 1] = "missing.json";
            assert.throws(() => main(flags, { root, log }), /stage 2 needs/);
        }

        // A stage 1 summary that names a fixture task: stage 2 refuses it.
        writeFileSync(
            join(root, "stage1.json"),
            JSON.stringify({ ...FIXTURE_STAGE1, tasks: { ids: ["t05"] } }),
        );
        assert.throws(() => main(STAGE2_FLAGS, { root, log }), /fresh tasks/);

        // A tier whose stage 1 model set lacks a model that has results: an error, not a silent extra.
        const narrow = structuredClone(FIXTURE_STAGE1);

        narrow.tiers.easy.shortlist = [MID];
        narrow.overall.c1 = MID;
        writeFileSync(join(root, "stage1.json"), JSON.stringify(narrow));
        assert.throws(() => main(STAGE2_FLAGS, { root, log }), /not expected in the easy tier/);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the command line refuses incomplete results unless asked to drop them", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage2");
        rmSync(join(root, "bench/results/stage2/t03/test--mid.json"));
        // A result the scorer has not finished: no S1 and no grades yet.
        const t04 = join(root, "bench/results/stage2/t04/test--big.json");
        const unscored = { ...JSON.parse(readFileSync(t04, "utf8")) };

        delete unscored.s1;
        delete unscored.grades;
        writeFileSync(t04, JSON.stringify(unscored));

        assert.throws(() => main(STAGE2_FLAGS, { root, log }), /t03, t04/);
        assert.equal(main([...STAGE2_FLAGS, "--allow-incomplete"], { root, log }), 0);
        const summary = JSON.parse(
            readFileSync(join(root, "bench/results/stage2/summary.json"), "utf8"),
        );

        assert.deepEqual(summary.incomplete, ["t03", "t04"]);
        assert.throws(() => main(["--stage", "3"], { root, log }), /--stage/);

        // A result for a task that no kept manifest task names is an error.
        const stray = join(root, "bench/results/stage2/ghost");

        mkdirSync(stray, { recursive: true });
        writeFileSync(
            join(stray, "test--big.json"),
            JSON.stringify({ ...result("t01", BIG), task: "ghost" }),
        );
        assert.throws(() => main([...STAGE2_FLAGS, "--allow-incomplete"], { root, log }), /ghost/);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("manifests: only tasks the owner kept, with both confirmations; an unreviewed task is an error", () => {
    const task = (id, owner) => ({ id, repo: "owner/r", features: {}, owner });

    assert.deepEqual(
        manifestTasks({ tasks: [task("a", KEPT), task("b", { ...KEPT, keep: false })] }).map(
            (t) => t.id,
        ),
        ["a"],
    );
    assert.deepEqual(manifestTasks([task("a", KEPT)]).length, 1);
    assert.throws(() => manifestTasks({ tasks: [task("a", undefined)] }), /no owner review/);
    assert.throws(() => manifestTasks({ tasks: [task("a", { reason: "x" })] }), /no owner review/);
    assert.throws(
        () => manifestTasks({ tasks: [task("a", { ...KEPT, scopeMatches: false })] }),
        /scopeMatches/,
    );
    assert.throws(
        () => manifestTasks({ tasks: [task("a", { keep: true, scopeMatches: true })] }),
        /commandsConfirmed/,
    );
    assert.throws(() => manifestTasks({}), /no task list/);
});

test("the simulation's threshold: settings checked, threshold computed again from the rows", () => {
    assert.equal(thresholdFromSimulation(STRICT_SIMULATION), CLOSE_THRESHOLD_STRICT);
    // The report's own `threshold` field is not trusted.
    assert.equal(
        thresholdFromSimulation({ ...STRICT_SIMULATION, threshold: 0.8 }),
        CLOSE_THRESHOLD_STRICT,
    );
    const fine = structuredClone(STRICT_SIMULATION);

    fine.rows[0].falseAcceptance = 0.088;
    assert.equal(thresholdFromSimulation(fine), CLOSE_THRESHOLD);
    assert.throws(() => thresholdFromSimulation({ ...STRICT_SIMULATION, margin: 0.05 }), /margin/);
    assert.throws(() => thresholdFromSimulation({ ...STRICT_SIMULATION, gap: 0.1 }), /gap/);

    // Incomplete calibration evidence: a missing or impossible rate, no reps, another seed.
    for (const falseAcceptance of [undefined, null, "0.1", NaN, -0.1, 1.5]) {
        const broken = structuredClone(STRICT_SIMULATION);

        broken.rows[0].falseAcceptance = falseAcceptance;
        assert.throws(() => thresholdFromSimulation(broken), /false-acceptance rate/);
    }

    for (const change of [{ reps: 0 }, { reps: null }, { draws: 1.5 }, { seed: 1 }]) {
        assert.throws(
            () => thresholdFromSimulation({ ...STRICT_SIMULATION, ...change }),
            /seed 1064 and positive whole numbers/,
        );
    }

    assert.throws(
        () =>
            thresholdFromSimulation({
                ...STRICT_SIMULATION,
                rows: STRICT_SIMULATION.rows.slice(1),
            }),
        /tier size 30/,
    );
});

// ---------------------------------------------------------------------------------------------------------------
// Guards from the cross-review of the first version.
// ---------------------------------------------------------------------------------------------------------------

test("the simulation decides each tier with the stage 2 code: the same outcomes give the same decision", () => {
    // 30 tasks: 18 both pass, 4 only B, 2 only M, 6 both fail (all 6 solved by the third model).
    const outcomes = [
        ...Array.from({ length: 18 }, () => ({ b: true, m: true, other: false })),
        ...Array.from({ length: 4 }, () => ({ b: true, m: false, other: false })),
        ...Array.from({ length: 2 }, () => ({ b: false, m: true, other: false })),
        ...Array.from({ length: 6 }, () => ({ b: false, m: false, other: true })),
    ];
    const sim = simulatedTier(outcomes);

    // The same outcomes as result files, through analyzeStage2.
    const cost = { [SIM_B]: 1, [SIM_M]: 0.1, [SIM_OTHER]: 10 };
    const tasks = outcomes.map((_, i) => ({
        id: `sim-${i}`,
        repo: "owner/r",
        predictedTier: "easy",
    }));
    const results = outcomes.flatMap((o, i) =>
        [
            [SIM_B, o.b],
            [SIM_M, o.m],
            [SIM_OTHER, o.other],
        ].map(([model, ok]) => ({
            task: `sim-${i}`,
            model,
            wallMs: 1000,
            usage: { input: 0, output: 0, cacheRead: 0, cost: cost[model] },
            s0: { protocol: false },
            s1: ok,
            s2: null,
            grades: [3, 4],
        })),
    );
    const real = analyzeStage2({ tasks, results }).tiers.easy;

    assert.equal(sim.status, "decided");
    assert.equal(real.status, sim.status);
    assert.equal(real.b, sim.b);
    assert.equal(real.pick, sim.pick);
    assert.deepEqual(real.vsB[SIM_M], sim.vsB[SIM_M]);
    assert.equal(sim.vsB[SIM_M].n00, 6);

    // Without the third model, the 6 both-fail tasks are unsolved and drop: 24 tasks are under the minimum of 30.
    const dropped = simulatedTier(outcomes.map((o) => ({ ...o, other: false })));

    assert.equal(dropped.unsolved.length, 6);
    assert.equal(dropped.status, "inconclusive");
    assert.equal(dropped.pick, undefined);
});

test("the simulation: with no rescue, unsolved drops make small tiers inconclusive", () => {
    const worst = simulateAcceptance({ n: 30, gap: 0, reps: 100, draws: 2000 });
    const none = simulateAcceptance({ n: 30, gap: 0, reps: 100, draws: 2000, rescue: 0 });

    assert.ok(worst.rate > 0.4, JSON.stringify(worst));
    // At 30 tasks, a tier with even 1 unsolved task has fewer than 30 and accepts nobody.
    assert.ok(none.rate < 0.05, JSON.stringify(none));
});

test("stage 2: a stored tier that the frozen rule contradicts is an error; the rule decides without one", () => {
    const tasks = fixtureTasks();
    const results = fixtureResults("stage2");

    assert.equal(
        analyzeStage2({ tasks, results, rule: FIXTURE_RULE, options: { minPaired: 2 } }).tiers.easy
            .n,
        6,
    );
    const wrong = tasks.map((t) => (t.id === "t01" ? { ...t, predictedTier: "hard" } : t));

    assert.throws(
        () => analyzeStage2({ tasks: wrong, results, rule: FIXTURE_RULE }),
        /t01: stored tier hard/,
    );
    const bare = tasks.map((t) => ({ ...t, predictedTier: undefined }));

    const byRule = analyzeStage2({
        tasks: bare,
        results,
        rule: FIXTURE_RULE,
        options: { minPaired: 2 },
    });

    assert.deepEqual(byRule.branch.counts, { easy: 6, medium: 2, hard: 4 });

    assert.deepEqual(
        BANDS.map((b) => byRule.tiers[b].ids.length + byRule.tiers[b].unsolved.length),
        [6, 2, 4],
    );
});

test("stage 2: a model of the stage 1 set with no result leaves the tier's tasks incomplete", () => {
    const stage1 = structuredClone(FIXTURE_STAGE1);

    stage1.tiers.hard.shortlist = [MID, "x/never-ran"];
    const s = analyzeStage2({
        tasks: fixtureTasks(),
        results: fixtureResults("stage2"),
        stage1,
        options: { minPaired: 2 },
    });

    assert.deepEqual(s.tiers.hard.incomplete, ["t09", "t10", "t11", "t12"]);
    assert.equal(s.tiers.hard.status, "inconclusive");
    assert.deepEqual(s.incomplete, ["t09", "t10", "t11", "t12"]);
});

test("stage 1 and stage 2 refuse a repeated task id and an empty task list", () => {
    const tasks = fixtureTasks();
    const results = fixtureResults("stage1");

    assert.throws(
        () => analyzeStage1({ tasks: [...tasks, tasks[0]], results, options: { fitRule: false } }),
        /task ids repeat: t01/,
    );
    assert.throws(() => analyzeStage1({ tasks: [], results: [] }), /no tasks/);
    assert.throws(
        () => analyzeStage2({ tasks: [...tasks, tasks[3]], results }),
        /task ids repeat: t04/,
    );
});

test("the transform: exact medians, means, scales, missing fill and unknown levels", () => {
    const rows = [
        { features: { briefChars: 100, kind: "write", riskPathNamed: true } },
        { features: { briefChars: 300, kind: "debug", riskPathNamed: false } },
        { features: { kind: "", riskPathNamed: null } },
        { features: { briefChars: 500 } },
    ];
    const t = fitTransform(rows, ["briefChars", "kind", "riskPathNamed"]);

    // briefChars: median of 100, 300, 500 is 300; the filled column 100, 300, 300, 500 has mean 300 and standard
    // deviation sqrt(20000).
    assert.equal(t.medians.briefChars, 300);
    assert.equal(t.center.briefChars, 300);
    assert.equal(t.scale.briefChars, Math.sqrt(20000));
    // riskPathNamed: 1, 0 present; median 0.5; filled 1, 0, 0.5, 0.5; mean 0.5; deviation sqrt(0.125).
    assert.equal(t.medians.riskPathNamed, 0.5);
    assert.equal(t.center.riskPathNamed, 0.5);
    assert.equal(t.scale.riskPathNamed, Math.sqrt(0.125));
    // kind: an empty or missing value is `unknown`; levels sorted.
    assert.deepEqual(t.levels.kind, ["debug", "unknown", "write"]);

    const s = Math.sqrt(20000);

    assert.deepEqual(designRow(t, { briefChars: 100, kind: "write", riskPathNamed: true }), [
        -200 / s,
        0,
        0,
        1,
        0.5 / Math.sqrt(0.125),
    ]);
    // Missing numbers take the median: (300 - 300) / s = 0 and (0.5 - 0.5) = 0. An unseen kind is `unknown`.
    assert.deepEqual(designRow(t, { kind: "never-seen" }), [0, 0, 1, 0, 0]);
    // A constant column gets scale 1.
    assert.equal(
        fitTransform(
            [{ features: { pathsNamed: 2 } }, { features: { pathsNamed: 2 } }],
            ["pathsNamed"],
        ).scale.pathsNamed,
        1,
    );
});

test("predictTier uses the weights of the one-hot columns and the median fill", () => {
    const rule = {
        version: 1,
        features: ["kind", "complexity"],
        center: { complexity: 1 },
        scale: { complexity: 1 },
        levels: { kind: ["debug", "unknown", "write"] },
        weights: { "kind=debug": 6, "kind=unknown": 0, "kind=write": -6, complexity: 0 },
        thresholds: [-2, 2],
        medians: { complexity: 1 },
    };

    assert.equal(predictTier(rule, { kind: "debug" }), "hard");
    assert.equal(predictTier(rule, { kind: "write" }), "easy");
    // An unseen kind, and a missing kind, take the `unknown` weight 0: medium.
    assert.equal(predictTier(rule, { kind: "never-seen" }), "medium");
    assert.equal(predictTier(rule, {}), "medium");
    // A missing number takes the median 1: (1 - 1) / 1 = 0. With weight 3 on complexity, 4 gives 9: hard.
    const steep = { ...rule, weights: { ...rule.weights, complexity: 3 } };

    assert.equal(predictTier(steep, { kind: "never-seen" }), "medium");
    assert.equal(predictTier(steep, { kind: "never-seen", complexity: 4 }), "hard");
    assert.throws(
        () => predictTier({ ...rule, weights: { complexity: 0 } }, {}),
        /no weight for column kind=debug/,
    );
});

test("re-review 1: stage 1 with no usable task freezes no rule", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage1");
        const dir = join(root, "bench/results/stage1");
        const all = fixtureResults("stage1");

        // Every task has a harness failure.
        for (const r of all) {
            writeFileSync(
                join(dir, r.task, `${r.model.replace("/", "--")}.json`),
                JSON.stringify(r.model === BIG ? { ...r, harness: "sandbox died" } : r),
            );
        }

        const flags = ["--stage", "1", "--manifest", "manifest.json", ...MODELS_FLAG];

        assert.throws(
            () => main(flags, { root, log }),
            /no usable task \(12 dropped by a harness failure/,
        );

        // Every task incomplete, and --allow-incomplete drops them all.
        for (const r of all) {
            writeFileSync(
                join(dir, r.task, `${r.model.replace("/", "--")}.json`),
                JSON.stringify(r.model === BIG ? { ...r, judgePending: true } : r),
            );
        }

        assert.throws(
            () => main([...flags, "--allow-incomplete"], { root, log }),
            /no usable task \(0 dropped by a harness failure, 12 incomplete\)/,
        );
        assert.equal(existsSync(join(root, "bench/rule-v1.json")), false);
        assert.equal(existsSync(join(dir, "summary.json")), false);
        assert.equal(existsSync(join(dir, "rule.json")), false);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("re-review 1: stage 2 refuses a rule or a stage 1 summary that is not whole", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage2");

        const brokenRules = [
            null,
            {},
            { ...FIXTURE_RULE, version: 2 },
            { ...FIXTURE_RULE, features: ["notAFeature"] },
            { ...FIXTURE_RULE, scale: { briefChars: 0 } },
            { ...FIXTURE_RULE, medians: {} },
            { ...FIXTURE_RULE, weights: {} },
            { ...FIXTURE_RULE, thresholds: [null, null] },
            { ...FIXTURE_RULE, thresholds: [2, -2] },
            { ...FIXTURE_RULE, features: ["kind"], levels: { kind: ["debug"] } },
        ];

        for (const rule of brokenRules) {
            writeFileSync(join(root, "rule.json"), JSON.stringify(rule));
            assert.throws(
                () => main(STAGE2_FLAGS, { root, log }),
                /the frozen rule is not valid/,
                JSON.stringify(rule),
            );
        }

        writeFileSync(join(root, "rule.json"), JSON.stringify(FIXTURE_RULE));

        const brokenSummaries = [
            null,
            {},
            { ...FIXTURE_STAGE1, tasks: { ids: [] } },
            { ...FIXTURE_STAGE1, majorityBand: "unsolved" },
            { ...FIXTURE_STAGE1, overall: {} },
            { ...FIXTURE_STAGE1, tiers: { easy: FIXTURE_STAGE1.tiers.easy } },
            { ...FIXTURE_STAGE1, tiers: { ...FIXTURE_STAGE1.tiers, hard: { b1: BIG } } },
        ];

        for (const stage1 of brokenSummaries) {
            writeFileSync(join(root, "stage1.json"), JSON.stringify(stage1));
            assert.throws(
                () => main(STAGE2_FLAGS, { root, log }),
                /the stage 1 summary is not valid/,
                JSON.stringify(stage1),
            );
        }

        assert.equal(existsSync(join(root, "bench/results/stage2/summary.json")), false);
        // The library refuses a broken rule too.
        assert.throws(
            () =>
                analyzeStage2({
                    tasks: fixtureTasks(),
                    results: fixtureResults("stage2"),
                    rule: {},
                }),
            /the frozen rule is not valid/,
        );
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("re-review 1: --simulate refuses counts and shares out of range", () => {
    const log = () => {};

    for (const flags of [
        ["--reps", "0"],
        ["--reps", "1.5"],
        ["--draws", "-1"],
        ["--discordance", "2"],
        ["--pb", "x"],
        ["--rescue", "-0.5"],
    ]) {
        assert.throws(() => main(["--simulate", ...flags], { log }), /must be/, flags.join(" "));
    }
});

// ---------------------------------------------------------------------------------------------------------------
// The stage 2 branch (confirm, merge, constant only, wait) and the pool.
// ---------------------------------------------------------------------------------------------------------------

test("the branch: each reading of the pre-registered steps", () => {
    const branch = (easy, medium, hard) => stage2Branch({ easy, medium, hard });
    const groups = (b) => b.groups.map((g) => [g.bands.join("+"), g.count, g.n, g.confirmed]);

    // R under 30: wait.
    assert.deepEqual(branch(10, 10, 9), {
        branch: "wait",
        counts: { easy: 10, medium: 10, hard: 9 },
        R: 29,
        groups: [],
    });
    // Each band of 30 or more alone, n capped at 60.
    assert.equal(branch(70, 30, 45).branch, "confirm");
    assert.deepEqual(groups(branch(70, 30, 45)), [
        ["easy", 70, 60, true],
        ["medium", 30, 30, true],
        ["hard", 45, 45, true],
    ]);
    // Medium merges with the larger left neighbour; a tie goes to easy.
    assert.deepEqual(groups(branch(12, 20, 15)), [
        ["easy", 12, 12, false],
        ["medium+hard", 35, 35, true],
    ]);
    assert.deepEqual(groups(branch(15, 20, 15)), [
        ["easy+medium", 35, 35, true],
        ["hard", 15, 15, false],
    ]);
    assert.equal(branch(15, 20, 15).branch, "merge");
    // Only bands that step 1 left merge: medium alone at 30 leaves easy and hard unmerged (never with each other).
    assert.deepEqual(groups(branch(20, 30, 20)), [
        ["easy", 20, 20, false],
        ["medium", 30, 30, true],
        ["hard", 20, 20, false],
    ]);
    assert.equal(branch(20, 30, 20).branch, "confirm");
    // An end band left with medium in step 1 merges with medium; the other end stays.
    assert.deepEqual(groups(branch(40, 10, 5)), [
        ["easy", 40, 40, true],
        ["medium+hard", 15, 15, false],
    ]);
    // No group reaches 30 and R is 30 or more: the constant policy only.
    assert.equal(branch(10, 10, 10).branch, "constant");
    assert.deepEqual(groups(branch(10, 10, 10)), [
        ["easy+medium", 20, 20, false],
        ["hard", 10, 10, false],
    ]);
    // The options.
    assert.equal(stage2Branch({ easy: 6, medium: 2, hard: 4 }, { minPaired: 4 }).branch, "confirm");
    assert.equal(stage2Branch({ easy: 40, medium: 0, hard: 0 }, { tierN: 25 }).groups[0].n, 25);
    assert.throws(() => stage2Branch({ easy: 1.5 }), /whole number/);
});

const SB = "x/best";
const SC = "x/cheap";
const SO = "x/other";

/** Tasks of the given tiers, ids `<prefix><i>`. */
const tierTasks = (prefix, tier, count) =>
    Array.from({ length: count }, (_, i) => ({
        id: `${prefix}${String(i).padStart(3, "0")}`,
        repo: "owner/r",
        predictedTier: tier,
    }));

/** A synthetic result: every model passes; the cheap model costs a tenth. */
const synth = (task, model) => ({
    task,
    model,
    wallMs: 1000,
    usage: { input: 0, output: 0, cacheRead: 0, cost: model === SC ? 0.1 : 1 },
    s0: { protocol: false },
    s1: true,
    s2: null,
    grades: [4, 4],
});

const STAGE1_SYNTH = {
    tasks: { ids: ["old-1"] },
    majorityBand: "easy",
    tiers: Object.fromEntries(BANDS.map((b) => [b, { b1: SB, shortlist: [] }])),
    groups: {
        "easy+medium": { b1: SB, shortlist: [] },
        "medium+hard": { b1: SB, shortlist: [] },
    },
    overall: { best: SB, c1: SC },
};

test("the confirm branch: a tier of 30 or more alone, its first 60 tasks in the pool's order decide", () => {
    const tasks = tierTasks("e", "easy", 70);
    // The pool's order: reversed, so the deciding tasks are e069 down to e010.
    const pool = tasks.map((t) => t.id).reverse();
    const deciding = pool.slice(0, 60);
    const results = deciding.flatMap((id) => [synth(id, SB), synth(id, SC)]);
    const s = analyzeStage2({
        tasks,
        results,
        stage1: STAGE1_SYNTH,
        options: { pool, draws: 2000 },
    });

    assert.equal(s.branch.branch, "confirm");
    assert.deepEqual(s.branch.groups[0].ids, deciding);
    assert.deepEqual(s.branch.groups[0].models, [SB, SC]);
    assert.equal(s.tiers.easy.n, 60);
    assert.equal(s.tiers.easy.pick, SC);
    assert.deepEqual(s.decisions.medium, { action: "unconfirmed", model: null });
    assert.equal(s.tiers.medium.status, "unconfirmed");

    // A result of a task past the cap, or of a model outside the tier's set: an error.
    assert.throws(
        () =>
            analyzeStage2({
                tasks,
                results: [...results, synth("e000", SB)],
                stage1: STAGE1_SYNTH,
                options: { pool, draws: 2000 },
            }),
        /outside the stage 2 branch \(confirm\): e000/,
    );
    assert.throws(
        () =>
            analyzeStage2({
                tasks,
                results: [...results, synth("e069", SO)],
                stage1: STAGE1_SYNTH,
                options: { pool, draws: 2000 },
            }),
        /not expected in the easy tier: x\/other/,
    );
    // The pool and the tasks must be the same set.
    assert.throws(
        () => analyzeStage2({ tasks, results, options: { pool: pool.slice(1) } }),
        /not in the pool's R: e069/,
    );
    assert.throws(
        () => analyzeStage2({ tasks, results, options: { pool: [...pool, "ghost"] } }),
        /no kept manifest task: ghost/,
    );
});

test("the merge branch: 2 small bands become 1 group of 30 or more, and both get the same pick", () => {
    const tasks = [
        ...tierTasks("e", "easy", 20),
        ...tierTasks("m", "medium", 15),
        ...tierTasks("h", "hard", 40),
    ];
    const results = tasks.flatMap((t) => [synth(t.id, SB), synth(t.id, SC)]);
    const s = analyzeStage2({ tasks, results, stage1: STAGE1_SYNTH, options: { draws: 2000 } });

    assert.equal(s.branch.branch, "merge");
    assert.deepEqual(
        s.branch.groups.map((g) => [g.bands.join("+"), g.n, g.confirmed]),
        [
            ["easy+medium", 35, true],
            ["hard", 40, true],
        ],
    );
    assert.equal(s.groups["easy+medium"].n, 35);
    assert.equal(s.groups["easy+medium"].pick, SC);
    assert.deepEqual(s.tiers.easy, s.tiers.medium);
    assert.equal(s.tiers.medium.group, "easy+medium");
    assert.deepEqual(s.decisions.easy, s.decisions.medium);
    assert.equal(s.decisions.easy.model, SC);
    assert.deepEqual(s.h3.tiers, ["easy+medium", "hard"]);

    // The group's models come from the stage 1 group: an older summary with no groups is refused.
    const { groups: _g, ...old } = STAGE1_SYNTH;

    assert.throws(
        () => analyzeStage2({ tasks, results, stage1: old, options: { draws: 2000 } }),
        /groups\.easy\+medium/,
    );
    assert.deepEqual(groupModelsFrom(STAGE1_SYNTH, ["easy", "medium"]), [SB, SC]);
    assert.deepEqual(groupModelsFrom(STAGE1_SYNTH, "constant"), [SB, SC]);
    assert.equal(groupModelsFrom(null, ["easy", "medium"]), null);
});

test("the constant branch: R of 30 or more and no group of 30; B1 against C1 over all R, H1 and H3 not tested", () => {
    const tasks = [
        ...tierTasks("e", "easy", 10),
        ...tierTasks("m", "medium", 10),
        ...tierTasks("h", "hard", 10),
    ];
    const results = tasks.flatMap((t) => [synth(t.id, SB), synth(t.id, SC)]);
    const s = analyzeStage2({ tasks, results, stage1: STAGE1_SYNTH, options: { draws: 2000 } });

    assert.equal(s.branch.branch, "constant");
    assert.equal(s.branch.constant.n, 30);
    assert.deepEqual(s.branch.constant.models, [SB, SC]);
    assert.equal(s.constant.n, 30);
    assert.equal(s.constant.model, SC);

    for (const band of BANDS) {
        assert.deepEqual(s.decisions[band], { action: "constant", model: SC });
    }

    assert.deepEqual(s.h1, { result: "not tested (pool)" });
    assert.deepEqual(s.h3, { result: "not tested (pool)" });
    assert.throws(
        () =>
            analyzeStage2({
                tasks,
                results: [...results, synth("e000", SO)],
                stage1: STAGE1_SYNTH,
                options: { draws: 2000 },
            }),
        /not expected in the constant policy: x\/other/,
    );
});

test("the wait branch: R under 30 needs no result, and gives no decision", () => {
    const tasks = [...tierTasks("e", "easy", 20), ...tierTasks("h", "hard", 9)];
    const s = analyzeStage2({ tasks, results: [], stage1: STAGE1_SYNTH });

    assert.deepEqual(s.branch, {
        branch: "wait",
        counts: { easy: 20, medium: 0, hard: 9 },
        R: 29,
        groups: [],
    });
    assert.equal(s.decisions, undefined);
    assert.equal(s.tiers, undefined);
});

test("stage 1 gives the 2 merge groups, on the union of their true bands", () => {
    const s = analyzeStage1({
        tasks: fixtureTasks(),
        results: fixtureResults("stage1"),
        options: { fitRule: false },
    });

    // easy+medium: all 12 fixture tasks (easy 6, medium 6): as the overall figures, mid at 0.59517 is shortlisted.
    assert.equal(s.groups["easy+medium"].n, 12);
    assert.equal(s.groups["easy+medium"].b1, BIG);
    assert.deepEqual(s.groups["easy+medium"].shortlist, [MID]);
    // medium+hard: no hard task, so the same as medium alone.
    assert.equal(s.groups["medium+hard"].n, 6);
    assert.deepEqual(s.groups["medium+hard"].shortlist, s.tiers.medium.shortlist);
    assert.deepEqual(s.zeroPricing.groups["medium+hard"], { b1: BIG, shortlist: [] });
});

test("the command line: --branch writes branch.json and branch.md from the pool, and runs no model", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage2");
        const flags = [
            "--branch",
            "--manifest",
            "manifest.json",
            "--rule",
            "rule.json",
            "--stage1",
            "stage1.json",
            "--pool",
            "pool.json",
        ];

        assert.equal(main(flags, { root, log }), 0);
        const branch = JSON.parse(
            readFileSync(join(root, "bench/results/stage2/branch.json"), "utf8"),
        );

        assert.equal(branch.branch, "merge");
        assert.deepEqual(branch.counts, { easy: 30, medium: 10, hard: 20 });
        assert.deepEqual(
            branch.groups.map((g) => [g.bands.join("+"), g.n, g.models]),
            [
                ["easy", 30, [HALOGEN, BIG, MID].sort()],
                ["medium+hard", 30, [HALOGEN, BIG, MID].sort()],
            ],
        );
        assert.deepEqual(
            branch.groups[0].ids,
            idsOf(STAGE2_COUNT).filter((id) => tierOfFixture(id) === "easy"),
        );
        assert.equal(branch.predictedTiers.t07, "medium");
        assert.ok(
            readFileSync(join(root, "bench/results/stage2/branch.md"), "utf8").includes(
                "Branch: merge",
            ),
        );
        assert.equal(existsSync(join(root, "bench/results/stage2/summary.json")), false);

        // A task of R that no kept manifest task names is an error.
        writeFileSync(
            join(root, "pool.json"),
            JSON.stringify({
                stage1: { ids: [] },
                stage2: { ids: [...idsOf(STAGE2_COUNT), "ghost"] },
            }),
        );
        assert.throws(() => main(flags, { root, log }), /no kept manifest task: ghost/);
        // Stage 2 refuses a result for a task outside R.
        writeFileSync(
            join(root, "pool.json"),
            JSON.stringify({ stage1: { ids: [] }, stage2: { ids: idsOf(STAGE2_COUNT - 1) } }),
        );
        assert.throws(() => main(STAGE2_FLAGS, { root, log }), /outside the pool's R: t60/);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the command line: stage 1 with a pool refuses a result outside the pool's stage 1 set", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage1");
        mkdirSync(join(root, "bench"), { recursive: true });
        // The default pool file is read when it exists.
        writeFileSync(
            join(root, "bench/pool-v1.json"),
            JSON.stringify({ stage1: { ids: idsOf(11) }, stage2: { ids: [] } }),
        );
        const flags = ["--stage", "1", "--manifest", "manifest.json", ...MODELS_FLAG];

        assert.throws(() => main(flags, { root, log }), /outside the pool's stage 1 set: t12/);
        writeFileSync(
            join(root, "bench/pool-v1.json"),
            JSON.stringify({ stage1: { ids: idsOf(12) }, stage2: { ids: [] } }),
        );
        assert.equal(main([...flags], { root, log }), 0);
        assert.throws(
            () => main([...flags, "--pool", "missing.json"], { root, log }),
            /stage 1 needs the pool/,
        );
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("stage 2 with an empty R (every task left went to stage 1) is the wait branch, not an error", () => {
    let s;

    assert.doesNotThrow(() => {
        s = analyzeStage2({ tasks: [], results: [], stage1: STAGE1_SYNTH, options: { pool: [] } });
    });

    assert.deepEqual(s.branch, {
        branch: "wait",
        counts: { easy: 0, medium: 0, hard: 0 },
        R: 0,
        groups: [],
    });
    assert.equal(s.R, 0);
    assert.equal(s.decisions, undefined);
    // A result is an error, as for any wait; a repeated id stays an error.
    assert.throws(
        () => analyzeStage2({ tasks: [], results: [synth("e000", SB)], options: { pool: [] } }),
        /stage 2 waits for the pool \(R = 0, under 30\)/,
    );
    assert.throws(
        () =>
            analyzeStage2({
                tasks: [...tierTasks("e", "easy", 1), ...tierTasks("e", "easy", 1)],
                results: [],
            }),
        /task ids repeat: e000/,
    );
});

test("the command line: --branch with an empty R writes the wait branch", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

    const log = () => {};

    try {
        writeBench(root, "stage2");
        writeFileSync(
            join(root, "pool.json"),
            JSON.stringify({ stage1: { ids: idsOf(STAGE2_COUNT) }, stage2: { ids: [] } }),
        );
        const flags = [
            "--branch",
            "--manifest",
            "manifest.json",
            "--rule",
            "rule.json",
            "--stage1",
            "stage1.json",
            "--pool",
            "pool.json",
        ];

        let code;

        assert.doesNotThrow(() => {
            code = main(flags, { root, log });
        });
        assert.equal(code, 0);
        const branch = JSON.parse(
            readFileSync(join(root, "bench/results/stage2/branch.json"), "utf8"),
        );

        assert.equal(branch.branch, "wait");
        assert.equal(branch.R, 0);
        assert.deepEqual(branch.groups, []);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the command line: --stage 2 with no results writes the wait summary, for an empty R and for R under 30", () => {
    for (const [r, label] of [
        [0, "an empty R"],
        [12, "R under 30"],
    ]) {
        const root = mkdtempSync(join(tmpdir(), "bench-analyze-"));

        const log = () => {};

        try {
            writeBench(root, "stage2");
            rmSync(join(root, "bench/results/stage2"), { recursive: true });
            writeFileSync(
                join(root, "pool.json"),
                JSON.stringify({ stage1: { ids: [] }, stage2: { ids: idsOf(r) } }),
            );
            let code;

            assert.doesNotThrow(() => {
                code = main(STAGE2_FLAGS, { root, log });
            }, label);
            assert.equal(code, 0, label);
            const summary = JSON.parse(
                readFileSync(join(root, "bench/results/stage2/summary.json"), "utf8"),
            );

            assert.equal(summary.branch.branch, "wait", label);
            assert.equal(summary.R, r, label);
            assert.equal(summary.decisions, undefined, label);
            assert.ok(
                readFileSync(join(root, "bench/results/stage2/summary.md"), "utf8").includes(
                    "Branch: wait",
                ),
                label,
            );
        } finally {
            rmSync(root, { recursive: true });
        }
    }
});
