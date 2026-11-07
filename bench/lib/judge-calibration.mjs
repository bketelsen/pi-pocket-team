// The judges' calibration run: each judge of `JUDGES` grades the calibration sets of `bench/calibration.mjs` by the
// frozen rubric `bench/judge-v1.md`, with the brief and the diff only (no merged change, no S1 or S2: the owners who
// labelled the held-out set saw the same). A judge passes the development set when it grades the merged diff higher
// than the Not-ready diff in 15 or more of 20 pairs, and the held-out set when its pass (grade 3 or more) agrees with
// the owner's label on 80% or more of the counted items of the complete set (40 items). Each verdict is saved with the
// hashes of the rubric and of its input, so a run can resume, and a rebuilt set that gives an id a new diff or brief
// is judged again; the key of the held-out set (`held-out-key.json`) is never read.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, modelSlug, privateDir, readJson, writeJsonAtomic } from "./common.mjs";
import {
    JUDGES,
    JUDGE_PROMPT,
    JUDGE_PROMPT_SHA256,
    checkJudgePrompt,
    renderPrompt,
    runJudge,
} from "./judge.mjs";
import { HELD_OUT_PER_OWNER } from "./calibration.mjs";
import { UsageError } from "./manifest.mjs";
import { OWNERS } from "./owners.mjs";
import { DEFAULTS, findProgram } from "./sandbox.mjs";

/** The pairs the development set needs, and the pairs a judge must grade the merged diff higher in. */
export const DEV_REQUIRED = 20;
export const DEV_THRESHOLD = 15;

/** The items of a complete held-out set, before exclusions: 8 per owner. */
export const HELD_OUT_REQUIRED = HELD_OUT_PER_OWNER * OWNERS.length;

/** The share of counted held-out items a judge must agree on with the owners. */
export const AGREEMENT = 0.8;

/** The lowest grade that is a pass. */
export const PASS_GRADE = 3;

/** The budget stage of a calibration judge try. */
export const CALIBRATION_STAGE = "calibration";

/** The results file of the judge-v1 calibration in the calibration folder. */
export const RESULTS_FILE = "results-v1.json";

/** The sets of `--set`. */
const SETS = ["dev", "held-out", "all"];

/** The verdict file of 1 judge on 1 diff: `<dir>/judged/<judge slug>/<item id>[.<part>].json`. */
export const verdictPath = (dir, model, id, part) =>
    join(dir, "judged", modelSlug(model), `${id}${part ? `.${part}` : ""}.json`);

/** The calls of a run: 1 per (judge, diff). Each is `{ model, id, part, brief, diff, cut }`. */
function callsOf({ dev, heldOut }, judges) {
    const calls = [];

    for (const model of judges) {
        for (const pair of dev ?? []) {
            for (const part of ["notReady", "merged"]) {
                calls.push({
                    model,
                    id: pair.id,
                    part,
                    brief: pair.brief,
                    diff: pair[`${part}Diff`],
                    cut: Boolean(pair[`${part}Cut`]),
                });
            }
        }

        for (const item of heldOut ?? []) {
            calls.push({
                model,
                id: item.id,
                part: null,
                brief: item.brief,
                diff: item.diff,
                cut: Boolean(item.diffCut),
            });
        }
    }

    return calls;
}

/** The judge's input of 1 calibration diff: the frozen template, the brief and the diff, no reference, no S1 or S2. */
export const calibrationPrompt = (template, { brief, diff, cut }) =>
    renderPrompt(template, {
        brief,
        submitted: { text: String(diff ?? ""), cut },
        reference: null,
        calibration: true,
    });

/** The SHA-256 hex of a text. */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * A saved verdict that holds for this call: the same judge, item id, part, rubric hash and input hash (the SHA-256
 * of the rendered prompt), so a rebuilt set that reuses an id with another diff or brief is judged again.
 */
export const verdictMatches = (verdict, { model, id, part, inputSha256 }) =>
    Boolean(verdict) &&
    verdict.judge === model &&
    verdict.item === id &&
    (verdict.part ?? null) === (part ?? null) &&
    verdict.promptSha256 === JUDGE_PROMPT_SHA256 &&
    verdict.inputSha256 === inputSha256;

/** A grade that is a judge's pass. */
const passes = (grade) => grade >= PASS_GRADE;

/** A saved verdict's grade, or null when it is missing or pending. */
const gradeOf = (verdict) =>
    verdict && !verdict.pending && Number.isInteger(verdict.grade) ? verdict.grade : null;

/**
 * The development result of 1 judge: per pair, the merged diff higher (strictly), a tie, or lower; a pair with a
 * pending verdict is pending. It passes with `DEV_REQUIRED` pairs and `DEV_THRESHOLD` or more higher.
 */
export function devResult(pairs, verdictOf) {
    const out = { pairs: pairs.length, higher: 0, ties: 0, lower: 0, pending: 0 };

    for (const pair of pairs) {
        const notReady = gradeOf(verdictOf(pair.id, "notReady"));
        const merged = gradeOf(verdictOf(pair.id, "merged"));

        if (notReady === null || merged === null) {
            out.pending += 1;
        } else if (merged > notReady) {
            out.higher += 1;
        } else if (merged === notReady) {
            out.ties += 1;
        } else {
            out.lower += 1;
        }
    }

    return {
        ...out,
        required: DEV_REQUIRED,
        threshold: DEV_THRESHOLD,
        pass: out.pairs >= DEV_REQUIRED && out.higher >= DEV_THRESHOLD,
    };
}

/**
 * The held-out result of 1 judge: agreement of its pass (grade 3 or more) with the owner's label on the counted items
 * (all but `exclude`), against ceil(0.8 x counted); the agreement on all items too, for reference; the confusion
 * counts of the counted items (owner pass or fail x judge pass or fail); pending items agree with nothing. A set with
 * other than `HELD_OUT_REQUIRED` items (before exclusions) is incomplete and never passes.
 */
export function heldOutResult(items, verdictOf, exclude = new Set()) {
    const confusion = {
        ownerPass: { judgePass: 0, judgeFail: 0 },
        ownerFail: { judgePass: 0, judgeFail: 0 },
    };
    let agree = 0;
    let agreeAll = 0;
    let pending = 0;
    let counted = 0;

    for (const item of items) {
        const grade = gradeOf(verdictOf(item.id, null));
        const isCounted = !exclude.has(item.id);

        if (isCounted) {
            counted += 1;
        }

        if (grade === null) {
            pending += isCounted ? 1 : 0;
            continue;
        }

        const ownerPass = item.label === "pass";
        const same = passes(grade) === ownerPass;

        agreeAll += same ? 1 : 0;

        if (isCounted) {
            agree += same ? 1 : 0;
            confusion[ownerPass ? "ownerPass" : "ownerFail"][
                passes(grade) ? "judgePass" : "judgeFail"
            ] += 1;
        }
    }

    const threshold = Math.ceil(AGREEMENT * counted);

    const complete = items.length === HELD_OUT_REQUIRED;

    return {
        items: items.length,
        required: HELD_OUT_REQUIRED,
        complete,
        counted,
        excluded: items.length - counted,
        agree,
        threshold,
        pass: complete && counted > 0 && agree >= threshold,
        agreeAll,
        confusion,
        pending,
    };
}

/** The results' Markdown summary. */
export function summaryOf(results) {
    const lines = [
        `# Judge calibration (judge-v1.md, sha256 ${results.promptSha256.slice(0, 12)})`,
        "",
    ];
    const judges = Object.entries(results.judges);

    if (results.set !== "held-out") {
        lines.push(
            "## Development set",
            "",
            "| Judge | Pairs | Merged higher | Ties | Lower | Pending | Pass (15 of 20) |",
            "| ----- | ----- | ------------- | ---- | ----- | ------- | --------------- |",
            ...judges.map(
                ([model, { dev }]) =>
                    `| ${model} | ${dev.pairs} | ${dev.higher} | ${dev.ties} | ${dev.lower} | ${dev.pending} | ${dev.pass ? "yes" : "no"} |`,
            ),
            "",
        );
    }

    if (results.set !== "dev") {
        lines.push(
            "## Held-out set",
            "",
            "| Judge | Counted | Agree | Threshold | Pass | All items agree | Owner pass: judge pass / fail | Owner fail: judge pass / fail | Pending |",
            "| ----- | ------- | ----- | --------- | ---- | --------------- | ----------------------------- | ----------------------------- | ------- |",
            ...judges.map(
                ([model, { heldOut: h }]) =>
                    `| ${model} | ${h.counted} | ${h.agree} | ${h.threshold} | ${h.pass ? "yes" : "no"} | ${h.agreeAll} of ${h.items} | ${h.confusion.ownerPass.judgePass} / ${h.confusion.ownerPass.judgeFail} | ${h.confusion.ownerFail.judgePass} / ${h.confusion.ownerFail.judgeFail} | ${h.pending} |`,
            ),
            "",
        );

        if (results.exclude.length) {
            lines.push(`Excluded from the count: ${results.exclude.join(", ")}.`, "");
        }
    }

    lines.push(
        `Judge spend: $${results.spend} (${judges.map(([model, j]) => `${model} $${j.spend}`).join(", ")}).`,
    );

    return lines.join("\n");
}

/** Read the sets of `set` from `dir`: `{ dev, heldOut }` (null for a set not asked for). */
async function readSets(dir, set) {
    const read = async (file) => {
        try {
            return JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            throw new UsageError(`cannot read ${file}: ${error.message}`);
        }
    };

    let dev = null;
    let heldOut = null;

    if (set !== "held-out") {
        dev = (await read(join(dir, "dev.json"))).items ?? [];
    }

    if (set !== "dev") {
        const folder = join(dir, "held-out");

        if (!existsSync(folder)) {
            throw new UsageError(`no held-out set: ${folder}`);
        }

        heldOut = [];

        for (const name of readdirSync(folder)
            .filter((n) => n.endsWith(".json"))
            .sort()) {
            heldOut.push(...((await read(join(folder, name))).items ?? []));
        }
    }

    return { dev, heldOut };
}

export const JUDGE_CALIBRATION_USAGE = `usage: node bench/judge-calibration.mjs [--dir <calibration dir>] [--set dev|held-out|all]
         [--exclude <item id>]... [--bwrap <path>] [--pocket <dir>] [--agent-src <dir>] [--mise-installs <dir>]
         [--no-auth-preflight]
exit codes: 0 the run completed (each judge passes or fails), 1 usage error (also an incomplete held-out set or
            an unlabelled held-out item), 2 budget refused (the verdicts so far are saved; run again)`;

const OPTIONS = {
    dir: { type: "string" },
    set: { type: "string" },
    exclude: { type: "string", multiple: true },
    bwrap: { type: "string" },
    pocket: { type: "string" },
    "agent-src": { type: "string" },
    "mise-installs": { type: "string" },
    "no-auth-preflight": { type: "boolean" },
};

/**
 * The calibration run's main: returns the exit code. `deps`: `now`, `log`, `print`, `judges`, `killGraceMs`,
 * `judgeWallMs` and `judgePromptFile` replace the defaults in tests.
 */
export async function judgeCalibrationMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));
    const print = deps.print ?? ((text) => console.log(text));

    try {
        let values;

        try {
            ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
        } catch (error) {
            throw new UsageError(error.message);
        }

        const set = values.set ?? "all";

        if (!SETS.includes(set)) {
            throw new UsageError(`--set must be 1 of ${SETS.join(", ")}`);
        }

        const data = dataDir(env);
        const dir = resolve(values.dir ?? join(data, "calibration"));
        const sets = await readSets(dir, set);
        const exclude = new Set(values.exclude ?? []);
        const heldOutIds = new Set((sets.heldOut ?? []).map((item) => item.id));

        for (const id of exclude) {
            if (!heldOutIds.has(id)) {
                throw new UsageError(`--exclude ${id}: not a held-out item of this run`);
            }
        }

        // The thresholds hold for the complete set: an incomplete one stops the run before any judge call.
        if (sets.heldOut && sets.heldOut.length !== HELD_OUT_REQUIRED) {
            throw new UsageError(
                `the held-out set is incomplete: ${sets.heldOut.length} items, not ${HELD_OUT_REQUIRED} (${HELD_OUT_PER_OWNER} per owner); it cannot pass, so no judge runs`,
            );
        }

        // Agreement is with the owners' labels: an item with no label stops the run before any judge call.
        const unlabelled = (sets.heldOut ?? [])
            .filter((item) => item.label !== "pass" && item.label !== "fail")
            .map((item) => item.id);

        if (unlabelled.length) {
            throw new UsageError(
                `held-out items with no owner label ("pass" or "fail"): ${unlabelled.join(", ")}`,
            );
        }

        const promptFile = deps.judgePromptFile ?? JUDGE_PROMPT;

        try {
            await checkJudgePrompt(promptFile);
        } catch (error) {
            throw new UsageError(error.message);
        }

        const bwrap = findProgram(values.bwrap ?? "bwrap", env);

        if (!bwrap) {
            throw new UsageError(`bwrap not found: ${values.bwrap ?? "bwrap"}`);
        }

        const judges = deps.judges ?? JUDGES;
        const judgeCtx = {
            data,
            bwrap,
            pocket: resolve(values.pocket ?? DEFAULTS.pocket),
            miseInstalls: resolve(values["mise-installs"] ?? DEFAULTS.miseInstalls),
            agentSrc: resolve(values["agent-src"] ?? DEFAULTS.agentSrc),
            authPreflight: !values["no-auth-preflight"],
            killGraceMs: deps.killGraceMs,
            wallMs: deps.judgeWallMs,
            judgePromptFile: promptFile,
            log,
        };
        const template = await readFile(promptFile, "utf8");
        const verdicts = new Map();
        const keyOf = (model, id, part) => `${model}\n${id}\n${part ?? ""}`;
        let refused = false;

        for (const call of callsOf(sets, judges)) {
            const file = verdictPath(dir, call.model, call.id, call.part);
            const prompt = calibrationPrompt(template, call);
            const inputSha256 = sha256(prompt);
            const saved = await readJson(file, null);
            // A verdict of another input (a rebuilt set) is judged again and overwritten; its tries do not carry.
            const before = verdictMatches(saved, { ...call, inputSha256 }) ? saved : null;
            const name = `${call.model} ${call.id}${call.part ? ` ${call.part}` : ""}`;

            if (gradeOf(before) !== null) {
                verdicts.set(keyOf(call.model, call.id, call.part), before);
                continue;
            }

            if (refused) {
                if (before) {
                    verdicts.set(keyOf(call.model, call.id, call.part), before);
                }

                continue;
            }

            if (saved && !before) {
                log(`${name}: the saved verdict is of another input: judged again`);
            }

            const verdict = await runJudge(judgeCtx, {
                model: call.model,
                prompt,
                dir: join(
                    data,
                    "judges",
                    CALIBRATION_STAGE,
                    `${call.id}${call.part ? `.${call.part}` : ""}`,
                    modelSlug(call.model),
                ),
                task: call.id,
                stage: CALIBRATION_STAGE,
            });
            const next = {
                schema: 1,
                judge: call.model,
                item: call.id,
                part: call.part,
                promptSha256: JUDGE_PROMPT_SHA256,
                inputSha256,
                grade: verdict.grade,
                reasons: verdict.reasons,
                tries: (before?.tries ?? 0) + verdict.tries,
                cost: Math.round(((before?.cost ?? 0) + verdict.cost) * 1e6) / 1e6,
                pending: verdict.pending,
                judgedAt: new Date((deps.now ?? Date.now)()).toISOString(),
            };

            await privateDir(join(file, ".."));
            await writeJsonAtomic(file, next);
            verdicts.set(keyOf(call.model, call.id, call.part), next);
            refused = verdict.refused;
            log(
                `${name}: ${verdict.pending ? (refused ? "budget refused" : "pending") : `grade ${verdict.grade}`}`,
            );
        }

        if (refused) {
            log("budget refused: the run stops; the verdicts so far are saved (run again)");

            return 2;
        }

        const results = {
            schema: 1,
            prompt: "judge-v1.md",
            promptSha256: JUDGE_PROMPT_SHA256,
            generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
            set,
            exclude: [...exclude].sort(),
            judges: {},
            spend: 0,
        };

        for (const model of judges) {
            const verdictOf = (id, part) => verdicts.get(keyOf(model, id, part)) ?? null;
            const spend = [...verdicts]
                .filter(([key]) => key.startsWith(`${model}\n`))
                .reduce((sum, [, v]) => sum + (v.cost ?? 0), 0);

            results.judges[model] = {
                dev: sets.dev ? devResult(sets.dev, verdictOf) : null,
                heldOut: sets.heldOut ? heldOutResult(sets.heldOut, verdictOf, exclude) : null,
                spend: Math.round(spend * 1e6) / 1e6,
            };
            results.spend += spend;
        }

        results.spend = Math.round(results.spend * 1e6) / 1e6;
        await writeJsonAtomic(join(dir, RESULTS_FILE), results);
        print(summaryOf(results));

        return 0;
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${JUDGE_CALIBRATION_USAGE}`);

            return 1;
        }

        throw error;
    }
}
