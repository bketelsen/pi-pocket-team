// The judges' calibration run (the T1064 plan, section Scoring): each judge of `JUDGES` grades the counted items of
// the owners' packs (`bench/calibration.mjs packs`) with the judge prompt, from the same fields the owners saw, and the
// run compares each judge's verdict (grade 3 or more is a pass), and the S3 rule (both judges 3 or more), with the
// owners' labels: agreement, Cohen's kappa, the false-pass and false-fail rates with 80% Wilson bounds, and the class
// counts.
//
// - `--set dev`: the development items, with any prompt (`--prompt`, default `bench/judge-v1.md`); the numbers guide
//   a prompt change and decide nothing.
// - `--set held-out`: only with the frozen prompt (its SHA-256 is `JUDGE_PROMPT_SHA256`), and only when the counted
//   items meet the class minimums (36 items, 10 owner fails, 10 owner passes); both are checked before any judge call.
//   A judge passes with agreement on ceil(0.8 x counted) or more and kappa 0.6 or more; the S3 rule passes with a
//   false-pass rate of 20% or less.
//
// An item an owner marked `blind: false` leaves every count and is not judged. Each verdict is saved with the hashes
// of the prompt and of the rendered input, so a run resumes, and a changed item is judged again. The run never reads a
// key file.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, modelSlug, readJson, writeJsonAtomic } from "./common.mjs";
import {
    FALSE_PASS_MAX,
    KAPPA_MIN,
    PASS_GRADE,
    classCounts,
    judgePasses,
    raterStats,
    s3Passes,
} from "./agreement.mjs";
import { CALIBRATION_STAGE, calibrationDir, sha256 } from "./calibration.mjs";
import { JUDGES, JUDGE_PROMPT, JUDGE_PROMPT_SHA256, renderPrompt, runJudge } from "./judge.mjs";
import { UsageError } from "./manifest.mjs";
import { DEFAULTS, findProgram } from "./sandbox.mjs";

/** The sets of `--set`, and their name in the packs. */
export const SETS = { dev: "dev", "held-out": "heldOut" };

/** The labels an owner can give. */
export const LABELS = ["pass", "fail"];

/** The verdict file of 1 judge on 1 item under 1 prompt. */
export const verdictPath = (dir, promptSha, model, id) =>
    join(dir, "judged", promptSha.slice(0, 12), modelSlug(model), `${id}.json`);

/** A saved verdict that holds for this call: the same judge, item, prompt and rendered input, with a grade. */
export const verdictHolds = (verdict, { model, id, promptSha256, inputSha256 }) =>
    Boolean(verdict) &&
    verdict.judge === model &&
    verdict.item === id &&
    verdict.promptSha256 === promptSha256 &&
    verdict.inputSha256 === inputSha256 &&
    Number.isInteger(verdict.grade);

/**
 * The packs of a calibration folder: `[{ owner, items, labels }]`, each label checked against its pack: the items'
 * hash, 1 entry per item, a label `pass`, `fail` or null, and a reason for `blind: false`.
 */
export function readPacks(dir) {
    const root = join(dir, "packs");

    if (!existsSync(root)) {
        throw new UsageError(`no packs: ${root} (run \`node bench/calibration.mjs packs\`)`);
    }

    const packs = [];

    for (const owner of readdirSync(root).sort()) {
        const itemsText = readFileSync(join(root, owner, "items.json"), "utf8");
        const { items } = JSON.parse(itemsText);
        const labels = JSON.parse(readFileSync(join(root, owner, "labels.json"), "utf8"));

        if (labels.itemsSha256 !== sha256(itemsText)) {
            throw new UsageError(`${owner}: items.json changed after the pack was written`);
        }

        const byId = new Map(labels.labels.map((entry) => [entry.id, entry]));

        if (byId.size !== items.length || items.some((item) => !byId.has(item.id))) {
            throw new UsageError(`${owner}: labels.json does not list each item once`);
        }

        for (const entry of labels.labels) {
            if (entry.label !== null && !LABELS.includes(entry.label)) {
                throw new UsageError(`${owner} ${entry.id}: label must be "pass" or "fail"`);
            }

            if (typeof entry.blind !== "boolean") {
                throw new UsageError(`${owner} ${entry.id}: blind must be true or false`);
            }

            if (entry.blind === false && String(entry.reason ?? "").trim() === "") {
                throw new UsageError(`${owner} ${entry.id}: blind false needs a reason`);
            }
        }

        packs.push({ owner, items, labels: byId });
    }

    return packs;
}

/** The counted items of a set: `[{ owner, item, label }]`, with the items marked `blind: false` left out. */
export function countedItems(packs, set) {
    return packs.flatMap(({ owner, items, labels }) =>
        items
            .filter((item) => item.set === set && labels.get(item.id).blind !== false)
            .map((item) => ({ owner, item, label: labels.get(item.id).label })),
    );
}

/** The judge's input of an item: the prompt template with exactly the pack's fields. */
export const itemPrompt = (template, item) =>
    renderPrompt(template, {
        brief: item.brief,
        s1: item.s1,
        s2: item.s2,
        submitted: item.submitted,
        reference: item.reference,
    });

/**
 * The results of a set from the counted items and the verdicts (`gradeOf(model, id)`: an integer, or null when
 * pending). Per judge and for the S3 rule: `raterStats` and `pass`; the class counts; for the held-out set, `valid`
 * and `pass` (valid, each judge passes, the S3 rule passes).
 */
export function resultsOf(set, counted, judges, gradeOf) {
    const owners = counted.map(({ label }) => label === "pass");
    const classes = classCounts(owners);
    const verdict = (grade) => (grade === null ? null : grade >= PASS_GRADE);
    const out = { set, classes, judges: {}, s3: null };

    for (const model of judges) {
        const stats = raterStats(
            counted.map(({ item, label }) => ({
                owner: label === "pass",
                judge: verdict(gradeOf(model, item.id)),
            })),
        );

        out.judges[model] = { ...stats, pass: judgePasses(stats) };
    }

    const s3 = raterStats(
        counted.map(({ item, label }) => {
            const grades = judges.map((model) => gradeOf(model, item.id));

            return {
                owner: label === "pass",
                judge: grades.some((g) => g === null) ? null : grades.every((g) => g >= PASS_GRADE),
            };
        }),
    );

    out.s3 = { ...s3, pass: s3Passes(s3) };

    if (set === "heldOut") {
        out.valid = classes.valid;
        out.pass = classes.valid && Object.values(out.judges).every((j) => j.pass) && out.s3.pass;
    }

    return out;
}

/** A rate and its bounds in words. */
const rateText = (r) =>
    r.rate === null
        ? `- (0 of 0)`
        : `${(r.rate * 100).toFixed(1)}% (${r.k} of ${r.n}; 80% ${(r.low * 100).toFixed(1)} to ${(r.high * 100).toFixed(1)})`;

/** The results as Markdown. */
export function resultsMarkdown(results) {
    const name = results.set === "dev" ? "Development" : "Held-out";
    const c = results.classes;
    const row = (who, s) =>
        `| ${who} | ${s.n} | ${s.agree} | ${s.threshold} | ${s.kappa === null ? "-" : s.kappa.toFixed(3)} | ${rateText(s.falsePass)} | ${rateText(s.falseFail)} | ${s.pending} | ${s.pass ? "yes" : "no"} |`;
    const lines = [
        `# Judge calibration, ${name.toLowerCase()} set (prompt ${results.prompt}, sha256 ${results.promptSha256.slice(0, 12)})`,
        "",
        `Counted items: ${c.counted} (owner passes ${c.passes}, owner fails ${c.fails}); left out (blind: false): ${results.excluded}.`,
        "",
        `| Rater | Counted | Agree | Needed | Kappa | False pass | False fail | Pending | Pass |`,
        `| ----- | ------- | ----- | ------ | ----- | ---------- | ---------- | ------- | ---- |`,
        ...Object.entries(results.judges).map(([model, s]) => row(model, s)),
        row("S3 (both 3 or more)", results.s3),
        "",
        `A judge passes with agreement on ceil(0.8 x counted) or more and kappa ${KAPPA_MIN} or more; the S3 rule passes with a false-pass rate of ${FALSE_PASS_MAX * 100}% or less.`,
    ];

    if (results.set === "heldOut") {
        lines.push(
            "",
            `Valid (36 or more counted, 10 or more owner fails and passes): ${results.valid ? "yes" : `no (short: ${c.short.join(", ")})`}. Held-out result: ${results.pass ? "PASS" : "FAIL"}.`,
        );
    } else {
        lines.push("", "The development numbers decide nothing: they guide a prompt change.");
    }

    lines.push("", `Judge spend of this set: $${results.spend.toFixed(4)}.`);

    return lines.join("\n");
}

export const JUDGE_CALIBRATION_USAGE = `usage: node bench/judge-calibration.mjs --set dev|held-out [--dir <dir>] [--prompt <file>] [--stats-only]
         [--bwrap <path>] [--pocket <dir>] [--agent-src <dir>] [--mise-installs <dir>] [--no-auth-preflight]
--set held-out needs the frozen prompt (JUDGE_PROMPT_SHA256) and 36 or more counted items with 10 or more owner fails
and passes; both are checked before any judge call. --stats-only calls no judge (a missing verdict is pending).
exit codes: 0 complete (the result says pass or fail), 1 usage error, 2 budget refused (the verdicts so far are saved),
            3 verdicts pending (run again)`;

const OPTIONS = {
    set: { type: "string" },
    dir: { type: "string" },
    prompt: { type: "string" },
    "stats-only": { type: "boolean" },
    bwrap: { type: "string" },
    pocket: { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    "no-auth-preflight": { type: "boolean" },
};

/**
 * The calibration run's main: returns the exit code. `deps`: `now`, `log`, `print`, `judges`, `frozenSha256` (in
 * place of `JUDGE_PROMPT_SHA256`), `killGraceMs`, `judgeWallMs` replace the defaults in tests.
 */
export async function judgeCalibrationMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));
    const print = deps.print ?? ((text) => console.log(text));
    const now = deps.now ?? Date.now;

    try {
        let values;

        try {
            ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
        } catch (error) {
            throw new UsageError(error.message);
        }

        const set = SETS[values.set];

        if (!set) {
            throw new UsageError("--set must be dev or held-out");
        }

        const data = dataDir(env);
        const dir = calibrationDir(data, values.dir);
        const promptFile = resolve(values.prompt ?? JUDGE_PROMPT);
        const template = await readFile(promptFile, "utf8").catch(() => {
            throw new UsageError(`cannot read the prompt ${promptFile}`);
        });
        const promptSha256 = sha256(template);
        const packs = readPacks(dir);
        const all = packs.flatMap(({ items }) => items.filter((item) => item.set === set));
        const counted = countedItems(packs, set);
        const unlabelled = counted.filter(({ label }) => label === null).map(({ item }) => item.id);

        if (unlabelled.length) {
            throw new UsageError(`items with no owner label: ${unlabelled.join(", ")}`);
        }

        if (set === "heldOut") {
            const frozen = "frozenSha256" in deps ? deps.frozenSha256 : JUDGE_PROMPT_SHA256;

            if (!frozen) {
                throw new UsageError(
                    "the judge prompt is not frozen (JUDGE_PROMPT_SHA256 is not set): the held-out set runs only with the frozen prompt",
                );
            }

            if (promptSha256 !== frozen) {
                throw new UsageError(
                    `${promptFile} is not the frozen prompt (sha256 ${promptSha256}, frozen ${frozen})`,
                );
            }

            const classes = classCounts(counted.map(({ label }) => label === "pass"));

            if (!classes.valid) {
                throw new UsageError(
                    `the held-out set is short (${classes.counted} counted, ${classes.fails} owner fails, ${classes.passes} owner passes; short: ${classes.short.join(", ")}): top it up before any held-out call`,
                );
            }
        }

        const judges = deps.judges ?? JUDGES;
        let judgeCtx = null;

        if (!values["stats-only"]) {
            const bwrap = findProgram(values.bwrap ?? "bwrap", env);

            if (!bwrap) {
                throw new UsageError(`bwrap not found: ${values.bwrap ?? "bwrap"}`);
            }

            judgeCtx = {
                data,
                bwrap,
                pocket: resolve(values.pocket ?? DEFAULTS.pocket),
                miseInstalls: resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls),
                agentSrc: resolve(values["agent-src"] ?? DEFAULTS.agentSrc),
                authPreflight: !values["no-auth-preflight"],
                killGraceMs: deps.killGraceMs,
                wallMs: deps.judgeWallMs,
                log,
            };
        }

        const grades = new Map();
        let spend = 0;
        let refused = false;

        for (const model of judges) {
            for (const { item } of counted) {
                const file = verdictPath(dir, promptSha256, model, item.id);
                const prompt = itemPrompt(template, item);
                const inputSha256 = sha256(prompt);
                const saved = await readJson(file, null);
                const call = { model, id: item.id, promptSha256, inputSha256 };

                if (verdictHolds(saved, call)) {
                    grades.set(`${model}\n${item.id}`, saved.grade);
                    spend += saved.cost ?? 0;
                    continue;
                }

                if (!judgeCtx || refused) {
                    continue;
                }

                // A saved verdict of the same input that is pending keeps its tries and cost; another input starts
                // again.
                const before =
                    saved &&
                    saved.judge === model &&
                    saved.item === item.id &&
                    saved.promptSha256 === promptSha256 &&
                    saved.inputSha256 === inputSha256
                        ? saved
                        : null;
                const verdict = await runJudge(judgeCtx, {
                    model,
                    prompt,
                    dir: join(
                        data,
                        "judges",
                        CALIBRATION_STAGE,
                        item.id,
                        promptSha256.slice(0, 12),
                        modelSlug(model),
                    ),
                    task: item.id,
                    stage: CALIBRATION_STAGE,
                });
                const next = {
                    schema: 1,
                    judge: model,
                    item: item.id,
                    prompt: basename(promptFile),
                    promptSha256,
                    inputSha256,
                    grade: verdict.grade,
                    reasons: verdict.reasons,
                    tries: (before?.tries ?? 0) + verdict.tries,
                    cost: Math.round(((before?.cost ?? 0) + verdict.cost) * 1e6) / 1e6,
                    pending: verdict.pending,
                    judgedAt: new Date(now()).toISOString(),
                };

                await writeJsonAtomic(file, next);
                spend += verdict.cost;
                refused = verdict.refused;

                if (Number.isInteger(next.grade)) {
                    grades.set(`${model}\n${item.id}`, next.grade);
                }

                log(
                    `${model} ${item.id}: ${verdict.pending ? (refused ? "budget refused" : "pending") : `grade ${verdict.grade}`}`,
                );
            }
        }

        const results = {
            schema: 1,
            prompt: basename(promptFile),
            promptSha256,
            generatedAt: new Date(now()).toISOString(),
            excluded: all.length - counted.length,
            ...resultsOf(
                set,
                counted,
                judges,
                (model, id) => grades.get(`${model}\n${id}`) ?? null,
            ),
            spend: Math.round(spend * 1e6) / 1e6,
        };

        await writeJsonAtomic(
            join(dir, "judge-results", `${values.set}-${promptSha256.slice(0, 12)}.json`),
            results,
        );
        print(resultsMarkdown(results));

        if (refused) {
            log("budget refused: the run stops; the verdicts so far are saved (run again)");

            return 2;
        }

        const pending = [...Object.values(results.judges), results.s3].some((s) => s.pending > 0);

        return pending ? 3 : 0;
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${JUDGE_CALIBRATION_USAGE}`);

            return 1;
        }

        throw error;
    }
}
