// The statistics of the judge calibration (the T1064 plan, section Scoring): agreement of a judge's verdict (grade 3
// or more is a pass) with the owners' labels, Cohen's kappa, the 2 error rates (false pass: a judge pass on an owner
// fail; false fail: a judge fail on an owner pass) with 80% Wilson bounds, and the class minimums of a valid
// held-out set.

/** The lowest grade that is a pass. */
export const PASS_GRADE = 3;

/** The share of counted items a judge must agree on: ceil(0.8 x counted). */
export const AGREEMENT = 0.8;

/** The lowest Cohen's kappa of a passing judge. */
export const KAPPA_MIN = 0.6;

/** The highest false-pass rate of the S3 rule (both judges 3 or more). */
export const FALSE_PASS_MAX = 0.2;

/** A valid held-out set: 36 or more counted items, with 10 or more owner fails and 10 or more owner passes. */
export const HELD_OUT_MIN = 36;
export const CLASS_MIN = 10;

/** The z of a two-sided 80% interval. */
export const Z80 = 1.2815515655446004;

/** The agreement threshold for `n` counted items. */
export const threshold = (n) => Math.ceil(AGREEMENT * n);

/** The Wilson score interval of `k` successes in `n` (two-sided, `z`), or null for n = 0. */
export function wilson(k, n, z = Z80) {
    if (!(n > 0)) {
        return null;
    }

    const p = k / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denominator;
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

    return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** A rate with its 80% Wilson bounds: `{ k, n, rate, low, high }` (rate and bounds null for n = 0). */
export function rateOf(k, n) {
    const bounds = wilson(k, n);

    return {
        k,
        n,
        rate: n > 0 ? k / n : null,
        low: bounds?.low ?? null,
        high: bounds?.high ?? null,
    };
}

/**
 * Cohen's kappa of 2 raters with 2 classes, from the confusion counts: `tp` (both pass), `fn` (owner pass, judge
 * fail), `fp` (owner fail, judge pass), `tn` (both fail). Null when the chance agreement is 1 (1 class only): then
 * kappa is not defined, and a judge cannot pass on it.
 */
export function cohenKappa({ tp, fn, fp, tn }) {
    const n = tp + fn + fp + tn;

    if (n === 0) {
        return null;
    }

    const observed = (tp + tn) / n;
    const ownerPass = (tp + fn) / n;
    const judgePass = (tp + fp) / n;
    const chance = ownerPass * judgePass + (1 - ownerPass) * (1 - judgePass);

    return chance === 1 ? null : (observed - chance) / (1 - chance);
}

/**
 * The statistics of 1 rater (a judge, or the S3 rule) on counted items: `pairs` is a list of `{ owner, judge }`
 * booleans (true = pass; `judge: null` for a pending verdict, which agrees with nothing and is counted as pending).
 */
export function raterStats(pairs) {
    const confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
    let pending = 0;

    for (const { owner, judge } of pairs) {
        if (judge === null || judge === undefined) {
            pending += 1;
            continue;
        }

        confusion[owner ? (judge ? "tp" : "fn") : judge ? "fp" : "tn"] += 1;
    }

    const n = pairs.length;
    const agree = confusion.tp + confusion.tn;
    const ownerFails = pairs.filter((p) => !p.owner).length;
    const ownerPasses = n - ownerFails;

    return {
        n,
        agree,
        threshold: threshold(n),
        kappa: pending ? null : cohenKappa(confusion),
        falsePass: rateOf(confusion.fp, ownerFails),
        falseFail: rateOf(confusion.fn, ownerPasses),
        confusion,
        pending,
    };
}

/** A judge passes: agreement on ceil(0.8 x n) or more, kappa 0.6 or more, and no pending verdict. */
export const judgePasses = (stats) =>
    stats.pending === 0 &&
    stats.n > 0 &&
    stats.agree >= stats.threshold &&
    stats.kappa !== null &&
    stats.kappa >= KAPPA_MIN;

/** The S3 rule passes: its false-pass rate is 20% or less, with no pending verdict. */
export const s3Passes = (stats) =>
    stats.pending === 0 && stats.falsePass.rate !== null && stats.falsePass.rate <= FALSE_PASS_MAX;

/**
 * The class counts of the counted labels (`true` = owner pass), and what a valid held-out set lacks: `short` lists
 * "items", "fails" and "passes" when below `HELD_OUT_MIN` or `CLASS_MIN`.
 */
export function classCounts(owners) {
    const passes = owners.filter(Boolean).length;
    const fails = owners.length - passes;
    const short = [];

    if (owners.length < HELD_OUT_MIN) {
        short.push("items");
    }

    if (fails < CLASS_MIN) {
        short.push("fails");
    }

    if (passes < CLASS_MIN) {
        short.push("passes");
    }

    return { counted: owners.length, passes, fails, valid: short.length === 0, short };
}
