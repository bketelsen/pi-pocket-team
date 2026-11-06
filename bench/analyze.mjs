#!/usr/bin/env node
// The replay bench's analysis: the statistics that the bench pre-registered before any paid run.
//
// It holds 4 parts, each a pure function that the tests drive on synthetic data:
//
// 1. The paired model. Model M against reference model B on n tasks: the 4 cells n11 (both pass), n10 (B passes, M
//    fails), n01 (B fails, M passes) and n00 (both fail); the posterior Dirichlet(1+n11, 1+n10, 1+n01, 1+n00); the gap
//    p10 - p01; P(gap <= margin) from 100,000 draws of the PRNG mulberry32, seeded 1064 at the start of each
//    comparison, so a probability depends only on its 4 counts.
// 2. The ordinal rule. A cumulative-logit regression over 3 bands (easy, medium, hard), in plain JavaScript:
//    numeric features standardized on the training fold, `kind` and `language` one-hot with a level `unknown`, a
//    missing number set to the training fold's median, an L2 penalty of 1.0, 2,000 gradient steps of 0.05 from 0.
//    Forward selection of at most 6 features inside each outer fold of a nested leave-one-repository-out
//    validation. The final rule is refit on all stage 1 tasks and written as `bench/rule-v1.json`.
// 3. The stage rules. Stage 1 (explore): bands, B1, shortlists, C1, the rule, H2. Stage 2 (confirm, decides): B,
//    the 4 "close enough" guards, Pick, the constant policy, H1, H3 and the decision per tier.
// 4. The simulation: the whole stage 2 procedure's false-acceptance rate (a model accepted while its true gap is
//    margin + 5 points) at the real tier sizes, and the threshold rule that follows from it (0.8, or 0.9 when that
//    rate is above 20%).
//
// The command line reads the bench's result files and the reviewed manifests, read only, and writes
// `bench/results/<stage>/summary.json` and `summary.md`. It calls no model, no network and no GitHub, and it records
// nothing outside its output files. Usage:
//
//   node bench/analyze.mjs --stage 1 --manifest <file> [--manifest <file> ...] [--results bench/results]
//       [--models <a,b,...>]   (default: the 10 CANDIDATES; every task needs a result of each)
//   node bench/analyze.mjs --stage 2 --manifest <file> ... [--rule bench/rule-v1.json]
//       [--stage1 bench/results/stage1/summary.json] [--simulation bench/results/simulation.json]
//   node bench/analyze.mjs --simulate [--reps 2000] [--draws 100000] [--discordance 0.2] [--pb 0.7]
//       [--rescue 1] [--out <file>]
//
// Manifests are the owners' reviewed files: only kept tasks count. Stage 2 needs the frozen rule, the stage 1
// summary and the simulation report (its threshold); it refuses a task that stage 1 used.
//
// The simulation's defaults are the plan's assumptions (about 20% discordant pairs, B passes 70%); run it again
// with the discordance that stage 1 measures before stage 2 starts.
//
// Exit 0: written; 1: usage error, or results still missing or waiting for a judge (`--allow-incomplete` drops
// those tasks instead and lists them).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// Pre-registered constants. They do not change after the data comes in.
// ---------------------------------------------------------------------------------------------------------------

export const SEED = 1064;
export const DRAWS = 100_000;
/** The margin, in pass-rate points as a proportion: 10 points. */
export const MARGIN = 0.1;
export const SHORTLIST_THRESHOLD = 0.5;
export const CLOSE_THRESHOLD = 0.8;
/** The threshold that replaces CLOSE_THRESHOLD when the simulated false-acceptance rate is above FAR_LIMIT. */
export const CLOSE_THRESHOLD_STRICT = 0.9;
export const FAR_LIMIT = 0.2;
export const GRADE_SLACK = 0.5;
export const MIN_AVAILABILITY = 0.95;
export const WALL_FACTOR = 2;
export const MIN_PAIRED = 30;
export const TIER_N = 60;
export const SHORTLIST_SIZE = 2;
/** H1: the rule beats the stage 1 majority band by this much accuracy. */
export const H1_LIFT = 0.1;
/** H2: Jev's rule is no better than kind alone within this much accuracy. */
export const H2_TOLERANCE = 0.05;
/** H3: the tier policy's cost per pass is this much below the constant policy's, or more. */
export const H3_SAVING = 0.15;

export const BANDS = ["easy", "medium", "hard"];
export const EASY_SHARE = 0.7;
export const HARD_SHARE = 0.3;

/** A model with no list price takes DeepSeek V4.1 Flash's price: $0.3 in, $1.2 out per 1M tokens. */
export const STAND_IN_PRICE = { input: 0.3 / 1e6, output: 1.2 / 1e6 };
export const UNPRICED_MODELS = new Set([
    "halogen/halogen-qwen3.8-flash-next",
    "github-copilot/mai-code-2-flash",
]);

/** The 10 candidate models of stage 1, each on its 1 provider route (the plan's section Candidates). */
export const CANDIDATES = [
    "github-copilot/gpt-6-luna",
    "anthropic/claude-haiku-5-5",
    "deepseek/deepseek-flash",
    "halogen/halogen-qwen3.8-flash-next",
    "github-copilot/mai-code-2-flash",
    "github-copilot/gemini-3.8-flash",
    "github-copilot/grok-4.7",
    "github-copilot/claude-sonnet-5.5",
    "github-copilot/gpt-6.1-sol",
    "github-copilot/claude-opus-5.5",
];

export const RULE_VERSION = 1;
export const L2 = 1.0;
export const STEPS = 2000;
export const STEP_SIZE = 0.05;
export const MAX_FEATURES = 6;
/** The ex-ante features, version 1, in the order that breaks a tie in forward selection. */
export const FEATURES_V1 = [
    "kind",
    "complexity",
    "capability",
    "deepReasoning",
    "demand",
    "briefChars",
    "pathsNamed",
    "reposNamed",
    "language",
    "riskPathNamed",
    "testsBeside",
];
export const CATEGORICAL = new Set(["kind", "language"]);
export const JEV_FEATURES = ["kind", "complexity", "capability", "deepReasoning", "demand"];
const JEV_NUMBERS = ["complexity", "capability", "deepReasoning", "demand"];

// ---------------------------------------------------------------------------------------------------------------
// Random numbers: mulberry32, a normal by Box-Muller, a gamma by Marsaglia and Tsang, a Dirichlet from gammas.
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: a 32-bit PRNG; each call gives a number in [0, 1). */
export function mulberry32(seed) {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A standard normal draw (Box-Muller, 1 value of each pair; 1 - u keeps the log finite). */
export function normal(rng) {
    const u1 = 1 - rng();
    const u2 = rng();

    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang; shape below 1 by the boost U^(1/shape)). */
export function gamma(shape, rng) {
    if (!(shape > 0)) {
        throw new Error(`gamma shape must be positive, got ${shape}`);
    }

    if (shape < 1) {
        return gamma(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    for (;;) {
        let x;
        let v;

        do {
            x = normal(rng);
            v = 1 + c * x;
        } while (v <= 0);

        v = v * v * v;
        const u = 1 - rng();

        if (u < 1 - 0.0331 * x * x * x * x) {
            return d * v;
        }

        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
            return d * v;
        }
    }
}

/** A Dirichlet(alphas) draw. */
export function dirichlet(alphas, rng) {
    const g = alphas.map((alpha) => gamma(alpha, rng));
    const sum = g.reduce((a, b) => a + b, 0);

    return g.map((x) => x / sum);
}

// ---------------------------------------------------------------------------------------------------------------
// The paired model.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The 4 cells of B against M over the tasks both attempted. `bPass` and `mPass` map a task id to a boolean; a task
 * missing from either map is left out of n.
 */
export function pairedCells(bPass, mPass, taskIds) {
    const cells = { n11: 0, n10: 0, n01: 0, n00: 0 };

    for (const id of taskIds) {
        if (!bPass.has(id) || !mPass.has(id)) {
            continue;
        }

        const b = bPass.get(id);
        const m = mPass.get(id);

        if (b && m) {
            cells.n11++;
        } else if (b) {
            cells.n10++;
        } else if (m) {
            cells.n01++;
        } else {
            cells.n00++;
        }
    }

    return cells;
}

/**
 * P(gap <= margin) under the posterior Dirichlet(1+n11, 1+n10, 1+n01, 1+n00), with gap = p10 - p01. Each call starts
 * mulberry32 at `seed`, and each draw takes its 4 gammas in the order n11, n10, n01, n00.
 */
export function probGapWithin(cells, { margin = MARGIN, draws = DRAWS, seed = SEED } = {}) {
    const rng = mulberry32(seed);
    const a11 = 1 + cells.n11;
    const a10 = 1 + cells.n10;
    const a01 = 1 + cells.n01;
    const a00 = 1 + cells.n00;
    let within = 0;

    for (let i = 0; i < draws; i++) {
        const g11 = gamma(a11, rng);
        const g10 = gamma(a10, rng);
        const g01 = gamma(a01, rng);
        const g00 = gamma(a00, rng);
        const gap = (g10 - g01) / (g11 + g10 + g01 + g00);

        if (gap <= margin) {
            within++;
        }
    }

    return within / draws;
}

/** probGapWithin with a cache by counts and settings: the simulation asks for the same cells many times. */
export function memoProb(cache = new Map()) {
    return (cells, options = {}) => {
        const key = [
            cells.n11,
            cells.n10,
            cells.n01,
            cells.n00,
            options.margin ?? MARGIN,
            options.draws ?? DRAWS,
            options.seed ?? SEED,
        ].join(",");
        let p = cache.get(key);

        if (p === undefined) {
            p = probGapWithin(cells, options);
            cache.set(key, p);
        }

        return p;
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Attempts: 1 result file (schema v1) of the runner and the scorer, reduced to what the rules use.
// ---------------------------------------------------------------------------------------------------------------

/** The cost of a result: its list cost, or the stand-in price of its tokens for a model with no list price. */
export function attemptCost(result, pricing = "standin") {
    const usage = result.usage ?? {};

    if (!UNPRICED_MODELS.has(result.model)) {
        return Number(usage.cost) || 0;
    }

    if (pricing === "zero") {
        return 0;
    }

    // Cache reads take the input price: a cautious stand-in.
    const input = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0);

    return input * STAND_IN_PRICE.input + (Number(usage.output) || 0) * STAND_IN_PRICE.output;
}

/**
 * Pass: the attempt finished (no `failure`), S0 found no protocol breach, S1 passed, every hidden test of S2 passed
 * (or the task has no S2: `s2` null), and both judges graded 3 or more.
 *
 * Status: `harness` (out of every comparison), `pending` (waits for a judge), `unscored` (it finished, but the
 * scorer has not written S1, S2 and both grades yet), or `valid`. An attempt with a `failure` is a fail and needs no
 * score; a missing grade there counts as 0 in the mean grade.
 */
export function toAttempt(result, pricing = "standin") {
    const grades = Array.isArray(result.grades) ? result.grades : [];
    const g = [0, 1].map((i) => (typeof grades[i] === "number" ? grades[i] : null));
    const scored =
        typeof result.s1 === "boolean" &&
        (result.s2 === null || typeof result.s2 === "boolean") &&
        g[0] !== null &&
        g[1] !== null;
    const status = result.harness
        ? "harness"
        : result.judgePending
          ? "pending"
          : !result.failure && !scored
            ? "unscored"
            : "valid";
    const pass =
        status === "valid" &&
        !result.failure &&
        !result.s0?.protocol &&
        result.s1 === true &&
        (result.s2 === null || result.s2 === true) &&
        g[0] !== null &&
        g[1] !== null &&
        g[0] >= 3 &&
        g[1] >= 3;

    return {
        task: result.task,
        model: result.model,
        status,
        pass,
        providerFail: result.failure === "provider",
        grade: ((g[0] ?? 0) + (g[1] ?? 0)) / 2,
        wallMs: Number(result.wallMs) || 0,
        cost: attemptCost(result, pricing),
    };
}

/** Index attempts as task id -> model -> attempt. A second result for the same pair is an error. */
export function indexAttempts(attempts) {
    const byTask = new Map();

    for (const a of attempts) {
        if (!byTask.has(a.task)) {
            byTask.set(a.task, new Map());
        }

        const row = byTask.get(a.task);

        if (row.has(a.model)) {
            throw new Error(`2 results for task ${a.task} and model ${a.model}`);
        }

        row.set(a.model, a);
    }

    return byTask;
}

/**
 * The tasks a set of models can be compared on. A task where any of the models has a harness failure is dropped
 * from every comparison; a task where one has no result yet, waits for a judge, or is not scored yet, is
 * `incomplete`.
 */
export function usableTasks(byTask, taskIds, models) {
    const usable = [];
    const dropped = [];
    const incomplete = [];

    for (const id of taskIds) {
        const row = byTask.get(id) ?? new Map();
        const list = models.map((m) => row.get(m));

        if (list.some((a) => a?.status === "harness")) {
            dropped.push(id);
        } else if (list.some((a) => !a || a.status === "pending" || a.status === "unscored")) {
            incomplete.push(id);
        } else {
            usable.push(id);
        }
    }

    return { usable, dropped, incomplete };
}

const median = (values) => {
    if (values.length === 0) {
        return null;
    }

    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);

    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** A model's figures on a set of tasks. */
export function modelStats(byTask, model, taskIds) {
    let passes = 0;
    let cost = 0;
    let gradeSum = 0;
    let available = 0;
    const walls = [];

    for (const id of taskIds) {
        const a = byTask.get(id).get(model);

        if (a.pass) {
            passes++;
        }

        cost += a.cost;
        gradeSum += a.grade;

        if (!a.providerFail) {
            available++;
        }

        walls.push(a.wallMs);
    }

    const n = taskIds.length;

    return {
        model,
        n,
        passes,
        passRate: n ? passes / n : null,
        meanGrade: n ? gradeSum / n : null,
        cost,
        costPerPass: passes ? cost / passes : Infinity,
        availability: n ? available / n : null,
        medianWallMs: median(walls),
    };
}

const passMap = (byTask, model, taskIds) =>
    new Map(taskIds.map((id) => [id, byTask.get(id).get(model).pass]));

/** Most passes; a tie goes to the higher mean grade, then the lower cost per pass, then the model id. */
export function bestModel(stats) {
    return [...stats].sort(
        (a, b) =>
            b.passes - a.passes ||
            b.meanGrade - a.meanGrade ||
            a.costPerPass - b.costPerPass ||
            (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    )[0];
}

/** Lowest cost per pass; a tie goes to the higher mean grade, then the model id. */
export function cheapestFirst(stats) {
    return [...stats].sort(
        (a, b) =>
            a.costPerPass - b.costPerPass ||
            b.meanGrade - a.meanGrade ||
            (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    );
}

/** Each model against reference B on the tasks: its cells and P(gap <= margin). */
export function compareAll(byTask, models, reference, taskIds, prob = probGapWithin, options = {}) {
    const bPass = passMap(byTask, reference, taskIds);

    return Object.fromEntries(
        models.map((m) => {
            const cells = pairedCells(bPass, passMap(byTask, m, taskIds), taskIds);

            return [m, { ...cells, p: prob(cells, options) }];
        }),
    );
}

/** The judges, in the order of `grades`: [0] openai/gpt-6.1-sol, [1] anthropic/claude-opus-5-5. */
export const JUDGE_FAMILIES = ["openai", "anthropic"];

/** A model's family for the self-preference report, from its id. */
export function familyOf(model) {
    const id = String(model).split("/").pop();

    if (id.startsWith("gpt-")) {
        return "openai";
    }

    if (id.startsWith("claude-")) {
        return "anthropic";
    }

    return "other";
}

/**
 * Self-preference: for each judge, its mean grade of its own family's attempts against the other judge's mean grade
 * of the same attempts. It changes no score: the "both judges" rule already needs the other family's agreement.
 */
export function selfPreference(results) {
    return Object.fromEntries(
        JUDGE_FAMILIES.map((family, j) => {
            const graded = results.filter(
                (r) =>
                    !r.harness &&
                    familyOf(r.model) === family &&
                    Array.isArray(r.grades) &&
                    typeof r.grades[0] === "number" &&
                    typeof r.grades[1] === "number",
            );
            const mean = (k) =>
                graded.length ? graded.reduce((a, r) => a + r.grades[k], 0) / graded.length : null;

            return [family, { n: graded.length, own: mean(j), other: mean(1 - j) }];
        }),
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Bands.
// ---------------------------------------------------------------------------------------------------------------

/** easy: 70% or more of the models pass; medium: 30% to under 70%; hard: under 30%; unsolved: none pass. */
export function bandOf(passes, models) {
    if (passes === 0) {
        return "unsolved";
    }

    const share = passes / models;

    if (share >= EASY_SHARE) {
        return "easy";
    }

    if (share >= HARD_SHARE) {
        return "medium";
    }

    return "hard";
}

/** The band index for the rule's fit: an unsolved task counts as hard. */
export const bandIndex = (band) => (band === "unsolved" ? 2 : BANDS.indexOf(band));

// ---------------------------------------------------------------------------------------------------------------
// The ordinal rule.
// ---------------------------------------------------------------------------------------------------------------

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

const featureValue = (features, name) => {
    const v = features?.[name];

    if (CATEGORICAL.has(name)) {
        return typeof v === "string" && v !== "" ? v : "unknown";
    }

    if (typeof v === "boolean") {
        return v ? 1 : 0;
    }

    return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/**
 * The transform of a feature set, learnt on the training tasks: for a number, its median (for a missing value), mean
 * and standard deviation after that fill (a deviation of 0 becomes 1); for `kind` and `language`, the sorted levels
 * seen plus `unknown`.
 */
export function fitTransform(rows, features) {
    const center = {};
    const scale = {};
    const medians = {};
    const levels = {};

    for (const name of features) {
        if (CATEGORICAL.has(name)) {
            const seen = new Set(rows.map((r) => featureValue(r.features, name)));

            seen.add("unknown");
            levels[name] = [...seen].sort();
            continue;
        }

        const present = rows.map((r) => featureValue(r.features, name)).filter((v) => v !== null);
        const med = median(present) ?? 0;
        const filled = rows.map((r) => featureValue(r.features, name) ?? med);
        const mean = filled.reduce((a, b) => a + b, 0) / (filled.length || 1);
        const variance =
            filled.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (filled.length || 1);

        medians[name] = med;
        center[name] = mean;
        scale[name] = variance > 0 ? Math.sqrt(variance) : 1;
    }

    return { features: [...features], center, scale, medians, levels };
}

/** The column names of a transform, in a fixed order. */
export function columnsOf(transform) {
    const cols = [];

    for (const name of transform.features) {
        if (CATEGORICAL.has(name)) {
            for (const level of transform.levels[name]) {
                cols.push(`${name}=${level}`);
            }
        } else {
            cols.push(name);
        }
    }

    return cols;
}

/** 1 task's design row under a transform. A level the training fold never saw becomes `unknown`. */
export function designRow(transform, features) {
    const row = [];

    for (const name of transform.features) {
        if (CATEGORICAL.has(name)) {
            const levels = transform.levels[name];
            const raw = featureValue(features, name);
            const v = levels.includes(raw) ? raw : "unknown";

            for (const level of levels) {
                row.push(level === v ? 1 : 0);
            }
        } else {
            const raw = featureValue(features, name) ?? transform.medians[name];

            row.push((raw - transform.center[name]) / transform.scale[name]);
        }
    }

    return row;
}

/** The thresholds from the free parameters: theta1 = a, theta2 = a + exp(b), so theta1 < theta2 always. */
const thresholdsOf = (a, b) => [a, a + Math.exp(b)];

/** The class probabilities of 1 linear score under the 2 thresholds. */
export function bandProbabilities(eta, thresholds) {
    const f1 = sigmoid(thresholds[0] - eta);
    const f2 = sigmoid(thresholds[1] - eta);

    return [f1, Math.max(f2 - f1, 0), 1 - f2];
}

/**
 * The objective: (sum of the negative log-likelihoods + L2/2 * |w|^2) / n, and its gradient in (w, a, b). The
 * thresholds carry no penalty.
 */
export function objective(X, y, w, a, b, l2 = L2) {
    const n = X.length;
    const [t1, t2] = thresholdsOf(a, b);
    const gw = new Array(w.length).fill(0);
    let ga = 0;
    let gb = 0;
    let loss = 0;
    const eps = 1e-12;

    for (let i = 0; i < n; i++) {
        const x = X[i];
        let eta = 0;

        for (let j = 0; j < w.length; j++) {
            eta += w[j] * x[j];
        }

        const F1 = sigmoid(t1 - eta);
        const F2 = sigmoid(t2 - eta);
        const d1 = F1 * (1 - F1);
        const d2 = F2 * (1 - F2);
        let dEta;
        let dT1 = 0;
        let dT2 = 0;

        if (y[i] === 0) {
            loss -= Math.log(Math.max(F1, eps));
            dT1 = -(1 - F1);
            dEta = 1 - F1;
        } else if (y[i] === 2) {
            loss -= Math.log(Math.max(1 - F2, eps));
            dT2 = F2;
            dEta = -F2;
        } else {
            const p = Math.max(F2 - F1, eps);

            loss -= Math.log(p);
            dT1 = d1 / p;
            dT2 = -d2 / p;
            dEta = (d2 - d1) / p;
        }

        for (let j = 0; j < w.length; j++) {
            gw[j] += dEta * x[j];
        }

        ga += dT1 + dT2;
        gb += dT2 * Math.exp(b);
    }

    let penalty = 0;

    for (let j = 0; j < w.length; j++) {
        penalty += w[j] * w[j];
        gw[j] = (gw[j] + l2 * w[j]) / n;
    }

    return { loss: (loss + (l2 / 2) * penalty) / n, gw, ga: ga / n, gb: gb / n };
}

/** Gradient descent from 0: `steps` steps of `stepSize` on the objective. */
export function fitOrdinal(X, y, { l2 = L2, steps = STEPS, stepSize = STEP_SIZE } = {}) {
    const k = X[0]?.length ?? 0;
    const w = new Array(k).fill(0);
    let a = 0;
    let b = 0;

    for (let s = 0; s < steps; s++) {
        const g = objective(X, y, w, a, b, l2);

        for (let j = 0; j < k; j++) {
            w[j] -= stepSize * g.gw[j];
        }

        a -= stepSize * g.ga;
        b -= stepSize * g.gb;
    }

    return { w, thresholds: thresholdsOf(a, b) };
}

/** The band with the highest probability; a tie goes to the easier band. */
export function predictIndex(w, thresholds, x) {
    let eta = 0;

    for (let j = 0; j < w.length; j++) {
        eta += w[j] * x[j];
    }

    const p = bandProbabilities(eta, thresholds);
    let best = 0;

    for (let k = 1; k < 3; k++) {
        if (p[k] > p[best]) {
            best = k;
        }
    }

    return best;
}

/** Fit a feature set on rows `{ features, band }` and give its transform, weights and thresholds. */
export function fitRule(rows, features, options = {}) {
    const transform = fitTransform(rows, features);
    const X = rows.map((r) => designRow(transform, r.features));
    const y = rows.map((r) => bandIndex(r.band));
    const { w, thresholds } = fitOrdinal(X, y, options);

    return { transform, w, thresholds };
}

const accuracyOf = (fitted, rows) => {
    let right = 0;

    for (const r of rows) {
        const x = designRow(fitted.transform, r.features);

        if (predictIndex(fitted.w, fitted.thresholds, x) === bandIndex(r.band)) {
            right++;
        }
    }

    return rows.length ? right / rows.length : 0;
};

/** Leave-one-repository-out accuracy of a fixed feature set: the mean of the per-fold accuracies. */
export function looAccuracy(rows, features, options = {}) {
    const repos = [...new Set(rows.map((r) => r.repo))].sort();

    if (repos.length < 2) {
        return null;
    }

    let sum = 0;

    for (const repo of repos) {
        const train = rows.filter((r) => r.repo !== repo);
        const test = rows.filter((r) => r.repo === repo);

        sum += accuracyOf(fitRule(train, features, options), test);
    }

    return sum / repos.length;
}

/**
 * Forward selection by leave-one-repository-out accuracy on `rows`: start from no feature, add the feature of `pool`
 * that raises the accuracy most (a tie goes to the earlier one in `pool`), stop when none raises it or at
 * `maxFeatures`. With fewer than 2 repositories nothing can be validated, and the set stays empty.
 */
export function forwardSelect(rows, pool = FEATURES_V1, options = {}) {
    const maxFeatures = options.maxFeatures ?? MAX_FEATURES;
    const chosen = [];
    let score = looAccuracy(rows, chosen, options);

    if (score === null) {
        return { features: [], accuracy: null };
    }

    while (chosen.length < maxFeatures) {
        let bestFeature = null;
        let bestScore = score;

        for (const f of pool) {
            if (chosen.includes(f)) {
                continue;
            }

            const s = looAccuracy(rows, [...chosen, f], options);

            if (s > bestScore) {
                bestScore = s;
                bestFeature = f;
            }
        }

        if (bestFeature === null) {
            break;
        }

        chosen.push(bestFeature);
        score = bestScore;
    }

    return { features: chosen, accuracy: score };
}

/**
 * Nested leave-one-repository-out validation: in each outer fold, forward selection runs on the other repositories
 * only (inner leave-one-repository-out), the selected set is fit on them, and the held-out repository is predicted.
 * The accuracy is the mean over the outer folds.
 */
export function nestedValidation(rows, pool = FEATURES_V1, options = {}) {
    const repos = [...new Set(rows.map((r) => r.repo))].sort();

    if (repos.length < 2) {
        return { accuracy: null, folds: [] };
    }

    const folds = [];

    for (const repo of repos) {
        const train = rows.filter((r) => r.repo !== repo);
        const test = rows.filter((r) => r.repo === repo);
        const { features } = forwardSelect(train, pool, options);
        const accuracy = accuracyOf(fitRule(train, features, options), test);

        folds.push({ repo, n: test.length, features, accuracy });
    }

    return { accuracy: folds.reduce((a, f) => a + f.accuracy, 0) / folds.length, folds };
}

/**
 * The frozen rule: forward selection on all rows, a refit on all rows with the selected set, and the
 * `bench/rule-v1.json` shape. `medians` is the fill for a missing number: prediction needs it.
 */
export function buildRule(rows, pool = FEATURES_V1, options = {}) {
    const { features } = forwardSelect(rows, pool, options);
    const fitted = fitRule(rows, features, options);
    const cols = columnsOf(fitted.transform);

    return {
        version: RULE_VERSION,
        features,
        center: fitted.transform.center,
        scale: fitted.transform.scale,
        levels: fitted.transform.levels,
        weights: Object.fromEntries(cols.map((c, j) => [c, fitted.w[j]])),
        thresholds: fitted.thresholds,
        medians: fitted.transform.medians,
    };
}

/** The predicted tier (easy, medium or hard) of a task's features under a frozen rule. */
export function predictTier(rule, features) {
    const transform = {
        features: rule.features,
        center: rule.center,
        scale: rule.scale,
        medians: rule.medians,
        levels: rule.levels,
    };
    const cols = columnsOf(transform);
    const w = cols.map((c) => {
        if (!(c in rule.weights)) {
            throw new Error(`rule has no weight for column ${c}`);
        }

        return rule.weights[c];
    });

    return BANDS[predictIndex(w, rule.thresholds, designRow(transform, features))];
}

export function writeRule(path, rule) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(rule, null, 4)}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// Stage 1: explore.
// ---------------------------------------------------------------------------------------------------------------

const modelsIn = (attempts) => [...new Set(attempts.map((a) => a.model))].sort();

/** A task id may appear once: a repeated task would count twice in every posterior. */
export function checkTasks(tasks) {
    const seen = new Set();
    const repeated = new Set();

    for (const t of tasks) {
        if (seen.has(t.id)) {
            repeated.add(t.id);
        }

        seen.add(t.id);
    }

    if (repeated.size) {
        throw new Error(`task ids repeat: ${[...repeated].join(", ")}`);
    }

    if (tasks.length === 0) {
        throw new Error("no tasks to analyze");
    }
}

/** Every result must be of an expected model: a result of another model is an error, not a silent extra. */
function checkModels(results, expected, where) {
    const allowed = new Set(expected);
    const stray = [...new Set(results.map((r) => r.model))].filter((m) => !allowed.has(m));

    if (stray.length) {
        throw new Error(`results of models not expected in ${where}: ${stray.join(", ")}`);
    }
}

const hasJev = (features) => JEV_NUMBERS.some((f) => typeof features?.[f] === "number");

/**
 * Stage 1. `tasks`: `{ id, repo, features }`; `results`: result files (schema v1). Gives the bands, the per-model
 * figures by band, B1, the shortlists, C1, H2 and, unless `fitRule` is false, the rule with its nested accuracy.
 * `options.models`: the models every task must have a result of (the command line gives CANDIDATES); a task that
 * lacks one is incomplete. Without it, the models of the results.
 */
export function analyzeStage1({ tasks, results, options = {} }) {
    checkTasks(tasks);
    // The cells do not depend on the pricing: 1 cache serves both pricings.
    const prob = options.prob ?? memoProb();
    const probOptions = { margin: options.margin ?? MARGIN, draws: options.draws ?? DRAWS };
    const attempts = results.map((r) => toAttempt(r, "standin"));
    const models = options.models ? [...options.models].sort() : modelsIn(attempts);

    checkModels(results, models, "stage 1");
    const byTask = indexAttempts(attempts);
    const taskIds = tasks.map((t) => t.id);
    const { usable, dropped, incomplete } = usableTasks(byTask, taskIds, models);

    const bandByTask = {};

    for (const id of usable) {
        const passes = models.filter((m) => byTask.get(id).get(m).pass).length;

        bandByTask[id] = bandOf(passes, models.length);
    }

    const tierTasks = Object.fromEntries(
        BANDS.map((band) => [band, usable.filter((id) => bandByTask[id] === band)]),
    );
    const solved = usable.filter((id) => bandByTask[id] !== "unsolved");

    const decide = (pricing) => {
        const priced = indexAttempts(results.map((r) => toAttempt(r, pricing)));
        const tiers = {};

        for (const band of BANDS) {
            const ids = tierTasks[band];

            if (ids.length === 0) {
                tiers[band] = { n: 0, b1: null, shortlist: [], stats: [], vsB1: {} };
                continue;
            }

            const stats = models.map((m) => modelStats(priced, m, ids));
            const b1 = bestModel(stats).model;
            const vsB1 = compareAll(priced, models, b1, ids, prob, probOptions);
            const shortlist = cheapestFirst(
                stats.filter((s) => s.model !== b1 && vsB1[s.model].p >= SHORTLIST_THRESHOLD),
            )
                .slice(0, SHORTLIST_SIZE)
                .map((s) => s.model);

            tiers[band] = { n: ids.length, b1, shortlist, stats, vsB1 };
        }

        let c1 = null;
        let best = null;
        let overall = [];
        let vsBest = {};

        if (solved.length) {
            overall = models.map((m) => modelStats(priced, m, solved));
            best = bestModel(overall).model;
            vsBest = compareAll(priced, models, best, solved, prob, probOptions);
            c1 =
                cheapestFirst(overall.filter((s) => vsBest[s.model].p >= SHORTLIST_THRESHOLD))[0]
                    ?.model ?? null;
        }

        return { tiers, overall: { n: solved.length, best, c1, stats: overall, vsBest } };
    };

    const standin = decide("standin");
    const zero = decide("zero");
    const pricingDiffers = BANDS.filter(
        (band) =>
            standin.tiers[band].b1 !== zero.tiers[band].b1 ||
            standin.tiers[band].shortlist.join() !== zero.tiers[band].shortlist.join(),
    );

    if (standin.overall.c1 !== zero.overall.c1) {
        pricingDiffers.push("constant");
    }

    const rows = tasks
        .filter((t) => usable.includes(t.id))
        .map((t) => ({
            id: t.id,
            repo: t.repo,
            features: t.features ?? {},
            band: bandByTask[t.id],
        }));
    const fitOptions = options.fit ?? {};

    let rule = null;
    let nested = null;
    let h2 = null;

    if (options.fitRule !== false) {
        nested = nestedValidation(rows, FEATURES_V1, fitOptions);
        rule = buildRule(rows, FEATURES_V1, fitOptions);
        const jevShare = rows.length
            ? rows.filter((r) => hasJev(r.features)).length / rows.length
            : 0;

        if (jevShare < 0.5) {
            h2 = {
                result: "inconclusive",
                jevShare,
                reason: "fewer than half the tasks have Jev numbers",
            };
        } else {
            const jev = nestedValidation(rows, JEV_FEATURES, fitOptions).accuracy;
            const kind = nestedValidation(rows, ["kind"], fitOptions).accuracy;

            h2 = {
                result:
                    jev === null || kind === null
                        ? "inconclusive"
                        : jev - kind <= H2_TOLERANCE
                          ? "holds"
                          : "fails",
                jevShare,
                jevAccuracy: jev,
                kindAccuracy: kind,
            };
        }
    }

    const counts = Object.fromEntries(
        [...BANDS, "unsolved"].map((b) => [b, usable.filter((id) => bandByTask[id] === b).length]),
    );
    const majorityBand = [...BANDS].sort(
        (x, y) =>
            counts[y] +
                (y === "hard" ? counts.unsolved : 0) -
                (counts[x] + (x === "hard" ? counts.unsolved : 0)) ||
            BANDS.indexOf(x) - BANDS.indexOf(y),
    )[0];

    return {
        stage: 1,
        settings: { margin: probOptions.margin, draws: probOptions.draws, seed: SEED },
        models,
        tasks: { total: taskIds.length, ids: taskIds, usable: usable.length, dropped, incomplete },
        bands: bandByTask,
        bandCounts: counts,
        majorityBand,
        tiers: standin.tiers,
        overall: standin.overall,
        zeroPricing: {
            tiers: Object.fromEntries(
                BANDS.map((b) => [b, { b1: zero.tiers[b].b1, shortlist: zero.tiers[b].shortlist }]),
            ),
            c1: zero.overall.c1,
        },
        pricingDiffers,
        rule,
        nested,
        h2,
        selfPreference: selfPreference(results),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Stage 2: confirm and decide.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Whether M is close enough to B: (1) P(gap <= margin) >= threshold; (2) M's mean grade >= B's - 0.5; (3) M's
 * availability >= 95%; (4) M's median wall time <= 2 x B's. Gives each guard and the whole answer.
 */
export function closeEnough(m, b, p, threshold = CLOSE_THRESHOLD) {
    const guards = {
        posterior: p >= threshold,
        grade: m.meanGrade >= b.meanGrade - GRADE_SLACK,
        availability: m.availability >= MIN_AVAILABILITY,
        wall: m.medianWallMs <= WALL_FACTOR * b.medianWallMs,
    };

    return { ...guards, ok: Object.values(guards).every(Boolean) };
}

/**
 * B, the close-enough models and the pick on 1 set of tasks. B fails guard (3) or (4): `today`, the set keeps
 * today's policy. Fewer than `minPaired` tasks: `inconclusive`.
 */
export function decideSet(byTask, models, ids, options = {}) {
    const minPaired = options.minPaired ?? MIN_PAIRED;
    const threshold = options.threshold ?? CLOSE_THRESHOLD;
    const prob = options.prob ?? probGapWithin;
    const probOptions = { margin: options.margin ?? MARGIN, draws: options.draws ?? DRAWS };

    if (ids.length < minPaired) {
        return { n: ids.length, ids, status: "inconclusive", models };
    }

    const stats = models.map((m) => modelStats(byTask, m, ids));
    const byModel = Object.fromEntries(stats.map((s) => [s.model, s]));
    const b = bestModel(stats);
    const vsB = compareAll(byTask, models, b.model, ids, prob, probOptions);
    const close = Object.fromEntries(
        models.map((m) => [m, closeEnough(byModel[m], b, vsB[m].p, threshold)]),
    );
    const base = { n: ids.length, ids, models, b: b.model, stats, vsB, close };

    if (!close[b.model].availability || !close[b.model].wall) {
        return { ...base, status: "today", pick: null };
    }

    const pick = cheapestFirst(stats.filter((s) => close[s.model].ok))[0]?.model ?? b.model;

    return { ...base, status: "decided", pick };
}

const costOn = (byTask, model, ids) => {
    let cost = 0;
    let passes = 0;

    for (const id of ids) {
        const a = byTask.get(id).get(model);

        cost += a.cost;

        if (a.pass) {
            passes++;
        }
    }

    return { cost, passes, costPerPass: passes ? cost / passes : Infinity };
};

/**
 * Stage 1's model set for a stage 2 tier: B1, its shortlist and C1 (at most 4). Null when the summary has no tiers.
 */
export function tierModelsFrom(stage1, band) {
    if (!stage1?.tiers) {
        return null;
    }

    const tier = stage1.tiers[band] ?? {};

    return [
        ...new Set([tier.b1, ...(tier.shortlist ?? []), stage1.overall?.c1].filter(Boolean)),
    ].sort();
}

/**
 * A tier's decision with the unsolved rule: a task that no model of the tier passes drops from every pick (it would
 * only add to n00), then decideSet. Stage 2 and the simulation both use it.
 */
export function decideTier(byTask, models, usable, options = {}) {
    const solved = usable.filter((id) => models.some((m) => byTask.get(id).get(m).pass));
    const unsolved = usable.filter((id) => !solved.includes(id));

    return { ...decideSet(byTask, models, solved, options), unsolved };
}

/**
 * Stage 2. `tasks`: `{ id, repo, features, predictedTier? }` (fresh tasks only); the tier comes from the frozen
 * `rule`, or from `predictedTier` without one; a stored tier that the rule contradicts is an error. `stage1`: the
 * stage 1 summary: its task ids (stage 2 refuses them), its majority band (H1) and, when it has tiers, each tier's
 * expected models (B1, the shortlist and C1). `options.threshold`: the simulation's threshold.
 */
export function analyzeStage2({ tasks, results, rule = null, stage1 = null, options: given = {} }) {
    checkTasks(tasks);
    // The cells do not depend on the pricing: 1 cache serves both pricings.
    const options = { ...given, prob: given.prob ?? memoProb() };

    const tierOf = (t) => {
        if (!rule) {
            return t.predictedTier ?? null;
        }

        const tier = predictTier(rule, t.features ?? {});

        if (t.predictedTier !== undefined && t.predictedTier !== tier) {
            throw new Error(
                `task ${t.id}: stored tier ${t.predictedTier}, but the frozen rule gives ${tier}`,
            );
        }

        return tier;
    };

    // Every stage 1 task, dropped and incomplete ones included.
    const stage1Ids = new Set(stage1?.tasks?.ids ?? Object.keys(stage1?.bands ?? {}));
    const reused = tasks.filter((t) => stage1Ids.has(t.id)).map((t) => t.id);

    if (reused.length) {
        throw new Error(`stage 2 must use fresh tasks; stage 1 used ${reused.join(", ")}`);
    }

    const tierById = new Map(tasks.map((t) => [t.id, tierOf(t)]));

    for (const t of tasks) {
        if (!BANDS.includes(tierById.get(t.id))) {
            throw new Error(`task ${t.id} has no predicted tier`);
        }
    }

    const run = (pricing) => {
        const attempts = results.map((r) => toAttempt(r, pricing));
        const byTask = indexAttempts(attempts);
        const tiers = {};
        const usableAll = [];
        const solvedAll = [];
        const droppedAll = [];
        const incompleteAll = [];

        for (const band of BANDS) {
            const ids = tasks.filter((t) => tierById.get(t.id) === band).map((t) => t.id);
            const tierResults = results.filter((r) => ids.includes(r.task));
            const expected = tierModelsFrom(stage1, band);
            const models = expected ?? modelsIn(attempts.filter((a) => ids.includes(a.task)));

            if (expected) {
                checkModels(tierResults, expected, `the ${band} tier`);
            }

            const { usable, dropped, incomplete } = usableTasks(byTask, ids, models);
            const tier = decideTier(byTask, models, usable, options);

            usableAll.push(...usable);
            solvedAll.push(...tier.ids);
            droppedAll.push(...dropped);
            incompleteAll.push(...incomplete);
            tiers[band] = { ...tier, dropped, incomplete };
        }

        // The constant policy: over all solved stage 2 tasks, among the models that ran on every one of them.
        const everywhere = modelsIn(attempts).filter((m) =>
            solvedAll.every((id) => byTask.get(id).get(m)?.status === "valid"),
        );
        const constant = decideSet(byTask, everywhere, solvedAll, { ...options, minPaired: 1 });
        const constantModel = constant.status === "decided" ? constant.pick : null;

        // H3: the tier policy against the constant policy, on the tasks of the decided tiers.
        const decided = BANDS.filter((b) => tiers[b].status === "decided");
        let h3 = { result: "inconclusive", reason: "no decided tier, or no constant policy" };

        if (decided.length && constantModel) {
            let cost = 0;
            let passes = 0;
            const ids = [];

            for (const band of decided) {
                const c = costOn(byTask, tiers[band].pick, tiers[band].ids);

                cost += c.cost;
                passes += c.passes;
                ids.push(...tiers[band].ids);
            }

            const tierCpp = passes ? cost / passes : Infinity;
            const constCpp = costOn(byTask, constantModel, ids).costPerPass;
            const saving =
                Number.isFinite(constCpp) && constCpp > 0 ? 1 - tierCpp / constCpp : null;

            h3 = {
                result: saving !== null && saving >= H3_SAVING ? "holds" : "fails",
                tiers: decided,
                tierCostPerPass: tierCpp,
                constantCostPerPass: constCpp,
                saving,
            };
        }

        const decisions = Object.fromEntries(
            BANDS.map((band) => {
                const t = tiers[band];

                if (t.status !== "decided") {
                    return [band, { action: t.status, model: null }];
                }

                if (h3.result === "holds") {
                    return [band, { action: "pick", model: t.pick }];
                }

                if (constantModel) {
                    return [band, { action: "constant", model: constantModel }];
                }

                return [band, { action: "today", model: null }];
            }),
        );

        return {
            byTask,
            tiers,
            constant: { ...constant, model: constantModel },
            h3,
            decisions,
            usable: usableAll,
            dropped: droppedAll,
            incomplete: incompleteAll,
        };
    };

    const standin = run("standin");
    const zero = run("zero");
    const pricingDiffers = BANDS.filter(
        (b) => standin.decisions[b].model !== zero.decisions[b].model,
    );

    if (standin.constant.model !== zero.constant.model) {
        pricingDiffers.push("constant");
    }

    // H1: the frozen rule's tier against the stage 2 band (from the models that ran on the task), and the stage 1
    // majority band against the same.
    let h1 = { result: "inconclusive", reason: "no stage 1 majority band" };
    const observed = {};

    for (const id of standin.usable) {
        const row = standin.byTask.get(id);
        const passes = [...row.values()].filter((a) => a.pass).length;

        observed[id] = bandOf(passes, row.size);
    }

    if (stage1?.majorityBand && standin.usable.length) {
        const ids = standin.usable;
        const hard = (b) => (b === "unsolved" ? "hard" : b);
        const ruleAcc =
            ids.filter((id) => tierById.get(id) === hard(observed[id])).length / ids.length;
        const baseAcc =
            ids.filter((id) => stage1.majorityBand === hard(observed[id])).length / ids.length;

        h1 = {
            result: ruleAcc - baseAcc >= H1_LIFT ? "holds" : "fails",
            ruleAccuracy: ruleAcc,
            majorityAccuracy: baseAcc,
            majorityBand: stage1.majorityBand,
            n: ids.length,
        };
    }

    const { byTask: _byTask, ...rest } = standin;

    return {
        stage: 2,
        settings: {
            margin: options.margin ?? MARGIN,
            draws: options.draws ?? DRAWS,
            seed: SEED,
            threshold: options.threshold ?? CLOSE_THRESHOLD,
            minPaired: options.minPaired ?? MIN_PAIRED,
        },
        ...rest,
        observedBands: observed,
        zeroPricing: { decisions: zero.decisions, constant: zero.constant.model },
        pricingDiffers,
        h1,
        selfPreference: selfPreference(results),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------------------------------------------

export const SIM_B = "sim/best";
export const SIM_M = "sim/cheaper";
export const SIM_OTHER = "sim/other";

/**
 * 1 simulated stage 2 tier through the real decision code (decideTier: the unsolved rule, the minimum of tasks,
 * B, the 4 guards and the pick). `outcomes`: 1 `{ b, m, other }` of booleans per task. All attempts get the same
 * grade, availability and wall time, so guards (2) to (4) hold: the worst case for false acceptance. M costs less
 * than B, so a tie in passes goes to M. A third model, dearest and passing only where it is told to, stands for the
 * tier's other models: it keeps a task that B and M both fail from being unsolved.
 */
export function simulatedTier(outcomes, options = {}) {
    const cost = { [SIM_B]: 1, [SIM_M]: 0.1, [SIM_OTHER]: 10 };
    const byTask = new Map();
    const ids = [];

    outcomes.forEach((o, i) => {
        const id = `sim-${i}`;
        const row = new Map();

        for (const [model, pass] of [
            [SIM_B, o.b],
            [SIM_M, o.m],
            [SIM_OTHER, o.other],
        ]) {
            row.set(model, {
                task: id,
                model,
                status: "valid",
                pass,
                providerFail: false,
                grade: 3.5,
                wallMs: 1000,
                cost: cost[model],
            });
        }

        byTask.set(id, row);
        ids.push(id);
    });

    return decideTier(byTask, [SIM_B, SIM_M, SIM_OTHER], ids, options);
}

/**
 * The false-acceptance rate of the stage 2 rule for 1 cheaper model M against the best model B, by Monte Carlo. Each
 * of the tier's n tasks draws its (B, M) outcome from the true cells: p10 - p01 = gap, p10 + p01 = discordance, B's
 * pass rate pB. A task that both fail is solved by another model of the tier with probability `rescue` (default 1,
 * the worst case: no task drops as unsolved, and every n00 stays in the posterior); else it drops, and a tier left
 * with fewer than `minPaired` tasks is inconclusive. M is accepted when the decision picks it (simulatedTier).
 */
export function simulateAcceptance({
    n,
    gap,
    discordance = 0.2,
    pB = 0.7,
    rescue = 1,
    threshold = CLOSE_THRESHOLD,
    margin = MARGIN,
    minPaired = MIN_PAIRED,
    reps = 2000,
    seed = SEED,
    draws = DRAWS,
    prob = memoProb(),
}) {
    const p10 = (discordance + gap) / 2;
    const p01 = (discordance - gap) / 2;
    const p11 = pB - p10;
    const p00 = 1 - p11 - p10 - p01;

    if ([p10, p01, p11, p00].some((p) => p < 0)) {
        throw new Error("impossible true cells");
    }

    const rng = mulberry32(seed);
    const options = { threshold, margin, minPaired, draws, prob };
    let accepted = 0;

    for (let r = 0; r < reps; r++) {
        const outcomes = [];

        for (let i = 0; i < n; i++) {
            const u = rng();

            if (u < p11) {
                outcomes.push({ b: true, m: true, other: false });
            } else if (u < p11 + p10) {
                outcomes.push({ b: true, m: false, other: false });
            } else if (u < p11 + p10 + p01) {
                outcomes.push({ b: false, m: true, other: false });
            } else {
                outcomes.push({ b: false, m: false, other: rng() < rescue });
            }
        }

        if (simulatedTier(outcomes, options).pick === SIM_M) {
            accepted++;
        }
    }

    return {
        n,
        gap,
        discordance,
        pB,
        rescue,
        threshold,
        reps,
        draws,
        accepted,
        rate: accepted / reps,
    };
}

/** The threshold rule: 0.9 when the false-acceptance rate at 0.8 is above 20% at any tier size, else 0.8. */
export function chooseThreshold(rows) {
    const atBase = rows.filter((r) => r.threshold === CLOSE_THRESHOLD);

    if (atBase.length === 0) {
        throw new Error(`the simulation has no row at threshold ${CLOSE_THRESHOLD}`);
    }

    return atBase.some((r) => r.falseAcceptance > FAR_LIMIT)
        ? CLOSE_THRESHOLD_STRICT
        : CLOSE_THRESHOLD;
}

/**
 * The simulation report: the false-acceptance rate at gap = margin + 5 points, and the acceptance rate at gap 0 (the
 * power), for each tier size and threshold; then the threshold rule: 0.9 when the rate at 0.8 is above 20% at any
 * size.
 */
export function simulationReport({
    sizes = [MIN_PAIRED, TIER_N],
    thresholds = [CLOSE_THRESHOLD, CLOSE_THRESHOLD_STRICT],
    reps = 2000,
    draws = DRAWS,
    seed = SEED,
    margin = MARGIN,
    discordance = 0.2,
    pB = 0.7,
    rescue = 1,
} = {}) {
    const prob = memoProb();
    const falseGap = Math.round((margin + 0.05) * 1000) / 1000;
    const rows = [];

    for (const n of sizes) {
        for (const threshold of thresholds) {
            const common = {
                n,
                threshold,
                margin,
                reps,
                draws,
                seed,
                prob,
                discordance,
                pB,
                rescue,
            };
            const far = simulateAcceptance({ ...common, gap: falseGap });
            const power = simulateAcceptance({ ...common, gap: 0 });

            rows.push({ n, threshold, falseAcceptance: far.rate, powerAtZeroGap: power.rate });
        }
    }

    return {
        gap: falseGap,
        margin,
        discordance,
        pB,
        rescue,
        reps,
        draws,
        seed,
        rows,
        threshold: chooseThreshold(rows),
        rule: `threshold ${CLOSE_THRESHOLD}, or ${CLOSE_THRESHOLD_STRICT} when the false-acceptance rate at ${CLOSE_THRESHOLD} is above ${FAR_LIMIT * 100}%`,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// The Markdown tables.
// ---------------------------------------------------------------------------------------------------------------

const fmt = (x, digits = 2) =>
    x === null || x === undefined ? "-" : Number.isFinite(x) ? x.toFixed(digits) : "inf";

export function stage1Markdown(s) {
    const lines = [
        `# Bench stage 1`,
        ``,
        `Models: ${s.models.length}. Tasks: ${s.tasks.usable} usable of ${s.tasks.total}.`,
        ``,
    ];

    lines.push(`| Band | Tasks |`, `| --- | --- |`);

    for (const [band, count] of Object.entries(s.bandCounts)) {
        lines.push(`| ${band} | ${count} |`);
    }

    for (const band of BANDS) {
        const t = s.tiers[band];

        lines.push(
            ``,
            `## ${band}: ${t.n} tasks, B1 ${t.b1 ?? "-"}, shortlist ${t.shortlist.join(", ") || "-"}`,
            ``,
        );
        lines.push(
            `| Model | Passes | Mean grade | Cost per pass | Availability | Median wall s | P(gap <= margin) vs B1 |`,
        );
        lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);

        for (const st of t.stats) {
            lines.push(
                `| ${st.model} | ${st.passes} | ${fmt(st.meanGrade)} | ${fmt(st.costPerPass)} | ${fmt(st.availability)} | ${fmt(st.medianWallMs / 1000, 0)} | ${fmt(t.vsB1[st.model]?.p, 3)} |`,
            );
        }
    }

    lines.push(
        ``,
        `C1 (constant candidate): ${s.overall.c1 ?? "-"}; best overall: ${s.overall.best ?? "-"}.`,
    );

    if (s.pricingDiffers.length) {
        lines.push(
            ``,
            `At $0 for unpriced models the result differs in: ${s.pricingDiffers.join(", ")}.`,
        );
    }

    if (s.rule) {
        lines.push(
            ``,
            `Rule features: ${s.rule.features.join(", ") || "none"}. Nested accuracy: ${fmt(s.nested?.accuracy, 3)}.`,
        );
    }

    if (s.h2) {
        lines.push(
            ``,
            `H2: ${s.h2.result} (Jev ${fmt(s.h2.jevAccuracy, 3)}, kind ${fmt(s.h2.kindAccuracy, 3)}).`,
        );
    }

    return `${lines.join("\n")}\n`;
}

export function stage2Markdown(s) {
    const lines = [
        `# Bench stage 2`,
        ``,
        `| Tier | Tasks | Status | B | Pick | Decision |`,
        `| --- | --- | --- | --- | --- | --- |`,
    ];

    for (const band of BANDS) {
        const t = s.tiers[band];
        const d = s.decisions[band];

        lines.push(
            `| ${band} | ${t.n} | ${t.status} | ${t.b ?? "-"} | ${t.pick ?? "-"} | ${d.action} ${d.model ?? ""} |`,
        );
    }

    lines.push(``, `Constant policy: ${s.constant.model ?? "-"}.`);
    lines.push(`H1: ${s.h1.result}. H3: ${s.h3.result}.`);

    if (s.pricingDiffers.length) {
        lines.push(
            ``,
            `At $0 for unpriced models the result differs in: ${s.pricingDiffers.join(", ")}.`,
        );
    }

    return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The tasks of a reviewed manifest file (an array of tasks, or an object with `tasks`). Only tasks the owner kept
 * count: `owner.keep` true, with `scopeMatches` and `commandsConfirmed` true. `keep` false drops a task. A task with
 * no owner review, or a kept task without both confirmations, is an error: the file is not a reviewed manifest.
 */
export function manifestTasks(json, file = "manifest") {
    const list = Array.isArray(json) ? json : json?.tasks;

    if (!Array.isArray(list)) {
        throw new Error(`${file}: no task list`);
    }

    return list.filter((t) => {
        const owner = t?.owner;

        if (!t?.id || typeof owner?.keep !== "boolean") {
            throw new Error(`${file}: task ${t?.id ?? "(no id)"} has no owner review`);
        }

        if (owner.keep && (owner.scopeMatches !== true || owner.commandsConfirmed !== true)) {
            throw new Error(
                `${file}: task ${t.id} is kept without scopeMatches and commandsConfirmed both true`,
            );
        }

        return owner.keep;
    });
}

/**
 * The threshold that stage 2 must use, from the simulation report run before it: the report must hold the
 * pre-registered settings (margin, gap = margin + 5 points, tier sizes 30 and 60 at 0.8), and the threshold is
 * computed again from its rows, not read from it.
 */
export function thresholdFromSimulation(report) {
    const gap = Math.round((MARGIN + 0.05) * 1000) / 1000;

    if (report?.margin !== MARGIN || report?.gap !== gap || !Array.isArray(report?.rows)) {
        throw new Error(`the simulation report must use margin ${MARGIN} and gap ${gap}`);
    }

    for (const n of [MIN_PAIRED, TIER_N]) {
        if (!report.rows.some((r) => r.n === n && r.threshold === CLOSE_THRESHOLD)) {
            throw new Error(
                `the simulation report has no row for tier size ${n} at ${CLOSE_THRESHOLD}`,
            );
        }
    }

    return chooseThreshold(report.rows);
}

/** Every result file under `dir` (`<task-id>/<model-slug>.json`). */
export function readResults(dir) {
    const out = [];

    if (!existsSync(dir)) {
        return out;
    }

    for (const task of readdirSync(dir, { withFileTypes: true })) {
        if (!task.isDirectory()) {
            continue;
        }

        for (const file of readdirSync(join(dir, task.name))) {
            if (file.endsWith(".json")) {
                out.push(JSON.parse(readFileSync(join(dir, task.name, file), "utf8")));
            }
        }
    }

    return out;
}

function parseArgs(argv) {
    const args = { manifest: [] };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        const value = () => {
            const v = argv[++i];

            if (v === undefined) {
                throw new Error(`${a} needs a value`);
            }

            return v;
        };

        if (a === "--stage") {
            args.stage = value();
        } else if (a === "--manifest") {
            args.manifest.push(value());
        } else if (a === "--results") {
            args.results = value();
        } else if (a === "--rule") {
            args.rule = value();
        } else if (a === "--stage1") {
            args.stage1 = value();
        } else if (a === "--simulation") {
            args.simulation = value();
        } else if (a === "--models") {
            args.models = value()
                .split(",")
                .map((m) => m.trim())
                .filter(Boolean);
        } else if (a === "--out") {
            args.out = value();
        } else if (a === "--reps") {
            args.reps = Number(value());
        } else if (a === "--draws") {
            args.draws = Number(value());
        } else if (a === "--allow-incomplete") {
            args.allowIncomplete = true;
        } else if (a === "--discordance") {
            args.discordance = Number(value());
        } else if (a === "--pb") {
            args.pB = Number(value());
        } else if (a === "--rescue") {
            args.rescue = Number(value());
        } else if (a === "--simulate") {
            args.simulate = true;
        } else {
            throw new Error(`unknown argument ${a}`);
        }
    }

    return args;
}

export function main(argv, { root = process.cwd(), log = console.log } = {}) {
    const args = parseArgs(argv);

    if (args.simulate) {
        const report = simulationReport({
            reps: args.reps ?? 2000,
            draws: args.draws ?? DRAWS,
            discordance: args.discordance ?? 0.2,
            pB: args.pB ?? 0.7,
            rescue: args.rescue ?? 1,
        });
        const text = `${JSON.stringify(report, null, 4)}\n`;

        if (args.out) {
            writeFileSync(resolve(root, args.out), text);
        } else {
            log(text);
        }

        return 0;
    }

    if (args.stage !== "1" && args.stage !== "2") {
        throw new Error("--stage must be 1 or 2");
    }

    if (args.manifest.length === 0) {
        throw new Error("at least 1 --manifest is needed");
    }

    const tasks = args.manifest.flatMap((f) =>
        manifestTasks(JSON.parse(readFileSync(resolve(root, f), "utf8")), f),
    );

    checkTasks(tasks);
    const resultsRoot = resolve(root, args.results ?? "bench/results");
    const stageDir = join(resultsRoot, `stage${args.stage}`);
    const results = readResults(stageDir);
    // The pool holds more tasks than a stage runs: the stage's tasks are those with a result in its folder.
    const known = new Set(tasks.map((t) => t.id));
    const unknown = [...new Set(results.map((r) => r.task))].filter((id) => !known.has(id));

    if (unknown.length) {
        throw new Error(`results for tasks in no kept manifest task: ${unknown.join(", ")}`);
    }

    const ran = new Set(results.map((r) => r.task));
    const stageTasks = tasks.filter((t) => ran.has(t.id));

    if (stageTasks.length === 0) {
        throw new Error(`no results in ${stageDir}`);
    }

    const readJson = (path, what) => {
        if (!existsSync(path)) {
            throw new Error(`stage 2 needs ${what}: ${path} does not exist`);
        }

        return JSON.parse(readFileSync(path, "utf8"));
    };

    let summary;
    let markdown;

    if (args.stage === "1") {
        summary = analyzeStage1({
            tasks: stageTasks,
            results,
            options: { models: args.models ?? CANDIDATES },
        });
        markdown = stage1Markdown(summary);
    } else {
        // Confirmation needs the frozen rule (the tiers), the stage 1 summary (fresh tasks, the model sets, H1) and
        // the simulation run before stage 2 (the threshold).
        const rule = readJson(resolve(root, args.rule ?? "bench/rule-v1.json"), "the frozen rule");
        const stage1 = readJson(
            resolve(root, args.stage1 ?? join(resultsRoot, "stage1", "summary.json")),
            "the stage 1 summary",
        );
        const simulation = readJson(
            resolve(root, args.simulation ?? join(resultsRoot, "simulation.json")),
            "the simulation report",
        );
        const threshold = thresholdFromSimulation(simulation);

        summary = analyzeStage2({
            tasks: stageTasks,
            results,
            rule,
            stage1,
            options: { threshold },
        });
        markdown = stage2Markdown(summary);
    }

    const incomplete = summary.incomplete ?? summary.tasks?.incomplete ?? [];

    if (incomplete.length && !args.allowIncomplete) {
        throw new Error(
            `${incomplete.length} tasks have a missing result or wait for a judge: ${incomplete.join(", ")} (--allow-incomplete drops them)`,
        );
    }

    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "summary.json"), `${JSON.stringify(summary, null, 4)}\n`);
    writeFileSync(join(stageDir, "summary.md"), markdown);

    if (args.stage === "1" && summary.rule) {
        // The fit of this run always goes beside the summary. bench/rule-v1.json is frozen once written: a later run
        // never replaces it.
        writeRule(join(stageDir, "rule.json"), summary.rule);
        const frozen = resolve(root, "bench/rule-v1.json");

        if (existsSync(frozen)) {
            log(
                `bench/rule-v1.json exists and stays frozen; this fit is in ${join(stageDir, "rule.json")}`,
            );
        } else {
            writeRule(frozen, summary.rule);
        }
    }

    log(markdown);

    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`analyze: ${error.message}`);
        process.exitCode = 1;
    }
}
