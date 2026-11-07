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
// The fixture: 12 tasks x 3 models, with known counts.
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

const ids = Array.from({ length: 12 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);

const tierOfFixture = (id) => {
    const n = Number(id.slice(1));

    return n <= 6 ? "easy" : n <= 8 ? "medium" : "hard";
};

const FEATURES = {
    easy: { kind: "write", briefChars: 400, complexity: 1 },
    medium: { kind: "implement", briefChars: 1500, complexity: 2 },
    hard: { kind: "debug", briefChars: 4000, complexity: 3 },
};

const fixtureTasks = () =>
    ids.map((id, i) => ({
        id,
        repo: `owner/r${(i % 3) + 1}`,
        features: { ...FEATURES[tierOfFixture(id)], language: "go" },
        predictedTier: tierOfFixture(id),
    }));

const pass = (grades) => ({ s1: true, s2: true, grades });
const fail = (grades = [1, 1]) => ({ s1: false, s2: false, grades });

function outcome(id, model) {
    const tier = tierOfFixture(id);
    const n = Number(id.slice(1));

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

const fixtureResults = (stage) => ids.flatMap((id) => MODELS.map((m) => result(id, m, stage)));

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

    const s2 = analyzeStage2({
        tasks: fixtureTasks(),
        results: results("stage2"),
        options: { minPaired: 3 },
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

test("stage 2 on the fixture: B, picks, today, inconclusive, the constant policy, H1 and H3", () => {
    const stage1 = { bands: {}, majorityBand: "easy" };
    const s = analyzeStage2({
        tasks: fixtureTasks(),
        results: fixtureResults("stage2"),
        stage1,
        options: { minPaired: 4 },
    });

    const easy = s.tiers.easy;

    assert.equal(easy.status, "decided");
    assert.equal(easy.b, BIG);
    assert.equal(easy.vsB[MID].p, 0.80579);
    assert.equal(easy.vsB[HALOGEN].p, 0.80579);
    assert.equal(easy.close[MID].ok, true);
    assert.equal(easy.close[HALOGEN].ok, true);
    assert.equal(easy.pick, MID);

    assert.equal(s.tiers.medium.status, "inconclusive");
    assert.equal(s.tiers.medium.n, 2);

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

    // H3: mid on the easy tier ($0.04 a pass) against big ($2 a pass).
    assert.equal(s.h3.result, "holds");
    assert.deepEqual(s.h3.tiers, ["easy"]);
    assert.ok(Math.abs(s.h3.saving - 0.98) < 1e-9);

    assert.deepEqual(s.decisions, {
        easy: { action: "pick", model: MID },
        medium: { action: "inconclusive", model: null },
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
    const s = analyzeStage2({ tasks: fixtureTasks(), results, options: { minPaired: 4 } });

    assert.equal(s.tiers.easy.pick, HALOGEN);
    assert.ok(Math.abs(s.h3.saving - 0.1) < 1e-9);
    assert.equal(s.h3.result, "fails");
    assert.deepEqual(s.decisions.easy, { action: "constant", model: BIG });
    // At $0 for halogen the tier policy saves everything: the priced result is the one deployed, and both show.
    assert.deepEqual(s.zeroPricing.decisions.easy, { action: "pick", model: HALOGEN });
    assert.ok(s.pricingDiffers.includes("easy"));
    assert.equal(s.h1.result, "inconclusive");
});

test("stage 2 at the pre-registered minimum of 30 tasks: every fixture tier is inconclusive", () => {
    const s = analyzeStage2({ tasks: fixtureTasks(), results: fixtureResults("stage2") });

    for (const band of BANDS) {
        assert.equal(s.decisions[band].action, "inconclusive");
    }
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
    overall: { c1: HALOGEN },
};

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
    const manifest = join(root, "manifest.json");
    const tasks = fixtureTasks().map((t) => {
        const { predictedTier: _tier, ...rest } = t;

        return { ...rest, owner: KEPT };
    });

    writeFileSync(manifest, JSON.stringify({ tasks }));

    for (const r of fixtureResults(stage)) {
        const dir = join(root, "bench", "results", stage, r.task);

        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${r.model.replace("/", "--")}.json`), JSON.stringify(r));
    }

    if (stage === "stage2") {
        writeFileSync(join(root, "rule.json"), JSON.stringify(FIXTURE_RULE));
        writeFileSync(join(root, "stage1.json"), JSON.stringify(FIXTURE_STAGE1));
        writeFileSync(join(root, "simulation.json"), JSON.stringify(STRICT_SIMULATION));
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
        assert.equal(summary.tiers.easy.n, 6);
        assert.equal(summary.tiers.hard.n, 4);

        // Each input is required.
        for (const flag of ["--rule", "--stage1", "--simulation"]) {
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
        analyzeStage2({ tasks, results, rule: FIXTURE_RULE, options: { minPaired: 4 } }).tiers.easy
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
        options: { minPaired: 4 },
    });

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
        options: { minPaired: 4 },
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
