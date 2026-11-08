// The judge calibration's instrument (the T1064 plan, section Scoring, "Judge calibration"): real bench attempts,
// checked (S0 to S2, no judge), then blind label packs for the owners.
//
// - Plan: the calibration tasks of `bench/pool-v1.json` (3 per owner except Sheeana: 1 dev and 2 held-out) and the 3
//   pilot tasks for Sheeana (ranked as the pool ranks: the first 2 held-out, the 3rd dev). Each task gets 4 models: 2
//   cheap, 1 middle and 1 dear, each group in a seeded order (mulberry32, seed 1064) taken in turn over the tasks, so
//   the models of a group get the same count, give or take 1.
// - Attempts: the pool tasks run in the runner stage `calibration`; Sheeana's items are the finished pilot attempts.
//   An attempt with a `limit`, `provider`, `harness` or `protocol` failure stays in the record, with its cost, but
//   not in a pack: the next model of its group, in the group's order, that the task has not used replaces it, at most
//   `MAX_REPLACEMENTS` times per task; then the item is missing. Replacements wait until every slot of the task has
//   an outcome, so the choice depends only on the outcomes, never on which attempt ended first.
// - Packs: per owner, the items in a seeded order with exactly the judge's input (the brief, S1, S2, the submitted
//   diff and the merged diff, each cut as the judge sees it), and no model, cost, wall time or try count. The key
//   (item -> task, model, result file) is a separate file that no operator or owner opens.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
    REPO_ROOT,
    privateDir,
    readJson,
    resultPath,
    writeAtomic,
    writeJsonAtomic,
} from "./common.mjs";
import { checkWords, cutDiff, cutNote } from "./judge.mjs";
import { UsageError, inPeak, loadManifest } from "./manifest.mjs";
import { OWNERS, SEED, expandHome, seededShuffle } from "./owners.mjs";
import { checksDone } from "./score.mjs";

/** The price groups of plan section Scoring, by list price (unpriced models are cheap). */
export const PRICE_GROUPS = {
    cheap: [
        "github-copilot/gpt-6-luna",
        "github-copilot/claude-haiku-5.5",
        "deepseek/deepseek-flash",
        "halogen/halogen-qwen3.8-flash-next",
        "github-copilot/mai-code-2-flash",
    ],
    middle: ["github-copilot/gemini-3.8-flash", "github-copilot/grok-4.7"],
    dear: [
        "github-copilot/claude-sonnet-5.5",
        "github-copilot/gpt-6.1-sol",
        "github-copilot/claude-opus-5.5",
    ],
};

/** The 4 slots of a task, by price group. */
export const SLOTS = ["cheap", "cheap", "middle", "dear"];

/** Replacements per task, over all its slots. */
export const MAX_REPLACEMENTS = 2;

/** The failures that keep an attempt out of a pack. */
export const EXCLUDED_FAILURES = ["limit", "provider", "protocol"];

/** The most starts of 1 action (a run or a check of 1 model on 1 task) in 1 driver run. */
export const MAX_LAUNCHES = 3;

/** The runner stage of the calibration attempts. */
export const CALIBRATION_STAGE = "calibration";

/** Sheeana's tasks: the pilot tasks (they are not in the pool). */
export const PILOT_OWNER = "sheeana";

/** The pilot manifest, relative to the repository root. */
export const PILOT_MANIFEST = "bench/pilot.json";

/** The plan's schema. */
export const CALIBRATION_SCHEMA = 1;

/** The folder of this instrument in the data dir. */
export const calibrationDir = (data, option) =>
    option ? resolve(option) : join(data, "calibration-v2");

/** The rank order of the pilot tasks: the pool's rule (ids sorted, then 1 seeded shuffle). */
export const rankPilot = (ids) => seededShuffle([...ids].sort(), SEED);

/** The SHA-256 hex of a text. */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------

/**
 * The calibration plan, from the pool and the pilot manifest. `pool.calibration.owners` gives each owner's dev and
 * held-out tasks; `pool.inputs` the reviewed manifest files; `manifestOf(id)` the file of a pool task (the caller
 * reads the files). Returns `{ schema, seed, groups, maxReplacements, tasks }`; each task is `{ id, owner, set,
 * source, manifest, slots, models }`.
 */
export function buildPlan(pool, pilotIds, manifestOf) {
    if (!pool?.calibration?.owners || !Array.isArray(pool.calibration.ids)) {
        throw new UsageError("the pool has no calibration set");
    }

    const groups = Object.fromEntries(
        Object.entries(PRICE_GROUPS).map(([name, models]) => [name, seededShuffle(models, SEED)]),
    );
    const cursor = { cheap: 0, middle: 0, dear: 0 };
    const setOf = new Map();
    const ownerOf = new Map();

    for (const [owner, sets] of Object.entries(pool.calibration.owners)) {
        for (const id of sets.dev ?? []) {
            setOf.set(id, "dev");
            ownerOf.set(id, owner);
        }

        for (const id of sets.heldOut ?? []) {
            setOf.set(id, "heldOut");
            ownerOf.set(id, owner);
        }
    }

    const pilotRanked = rankPilot(pilotIds);
    const order = [
        ...pool.calibration.ids.map((id) => ({ id, source: "pool" })),
        ...pilotRanked.map((id, i) => ({ id, source: "pilot", set: i < 2 ? "heldOut" : "dev" })),
    ];
    const tasks = [];

    for (const entry of order) {
        const models = SLOTS.map((group) => {
            const list = groups[group];
            const model = list[cursor[group] % list.length];

            cursor[group] += 1;

            return model;
        });

        if (entry.source === "pool" && !setOf.has(entry.id)) {
            throw new UsageError(`calibration task ${entry.id} has no owner set in the pool`);
        }

        tasks.push({
            id: entry.id,
            owner: entry.source === "pool" ? ownerOf.get(entry.id) : PILOT_OWNER,
            set: entry.source === "pool" ? setOf.get(entry.id) : entry.set,
            source: entry.source,
            manifest: entry.source === "pool" ? manifestOf(entry.id) : PILOT_MANIFEST,
            slots: [...SLOTS],
            models,
        });
    }

    return {
        schema: CALIBRATION_SCHEMA,
        seed: SEED,
        groups,
        maxReplacements: MAX_REPLACEMENTS,
        tasks,
    };
}

/** A manifest path of the plan as an absolute path (`~/` and repository-relative paths resolved). */
export const manifestPath = (file, home) =>
    file.startsWith("~/") ? expandHome(file, home) : resolve(REPO_ROOT, file);

// ---------------------------------------------------------------------------------------------------------------
// Outcomes and replacements
// ---------------------------------------------------------------------------------------------------------------

/**
 * The outcome of 1 attempt from its result: `run` (no result yet), `excluded` (a harness failure, or a limit,
 * provider or protocol failure), `check` (S0 to S2 or the diff not done), or `ok`.
 */
export function outcomeOf(result, task) {
    if (!result) {
        return "run";
    }

    if (result.harness || EXCLUDED_FAILURES.includes(result.failure)) {
        return "excluded";
    }

    if (!checksDone(result, task)) {
        return "check";
    }

    return "ok";
}

/** The next model of a group after `after`, in the group's order (cyclic), that `used` does not hold; or null. */
export function nextModel(order, after, used) {
    const start = order.indexOf(after);

    for (let step = 1; step <= order.length; step += 1) {
        const model = order[(start + step) % order.length];

        if (!used.has(model)) {
            return model;
        }
    }

    return null;
}

/**
 * The state of 1 task from the outcomes of its models (`outcome(model)`). Each slot holds a chain: its first model,
 * then its replacements. A replacement is chosen only when no slot's last model waits (`run` or `check`), in slot
 * order, at most `max` per task. Returns `{ slots: [{ group, chain, state: "ok" | "missing" | "waiting", model }],
 * replacements, waiting: [{ model, need }] }`.
 */
export function resolveTask(task, groups, outcome, max = MAX_REPLACEMENTS) {
    const chains = task.models.map((model) => [model]);
    const missing = chains.map(() => false);
    const used = new Set(task.models);
    let replacements = 0;

    for (;;) {
        const outs = chains.map((chain) => outcome(chain.at(-1)));
        const waiting = chains
            .map((chain, i) => ({ model: chain.at(-1), need: outs[i] }))
            .filter(({ need }, i) => !missing[i] && (need === "run" || need === "check"));

        if (waiting.length) {
            return {
                slots: chains.map((chain, i) => ({
                    group: task.slots[i],
                    chain,
                    model: chain.at(-1),
                    state: missing[i]
                        ? "missing"
                        : outs[i] === "ok"
                          ? "ok"
                          : outs[i] === "excluded"
                            ? "excluded"
                            : "waiting",
                })),
                replacements,
                waiting,
            };
        }

        let changed = false;

        for (const [i, chain] of chains.entries()) {
            if (missing[i] || outs[i] !== "excluded") {
                continue;
            }

            const next =
                replacements < max ? nextModel(groups[task.slots[i]], chain.at(-1), used) : null;

            if (next) {
                chain.push(next);
                used.add(next);
                replacements += 1;
                changed = true;
            } else {
                missing[i] = true;
            }
        }

        if (!changed) {
            return {
                slots: chains.map((chain, i) => ({
                    group: task.slots[i],
                    chain,
                    model: chain.at(-1),
                    state: missing[i] ? "missing" : "ok",
                })),
                replacements,
                waiting: [],
            };
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run the plan until every task has an outcome, at most `parallel` actions at a time. `deps`:
 * - `outcome(task, model)`: as `outcomeOf`, read fresh each time;
 * - `run(task, model)`: 1 attempt (exit code of `run.mjs`: 0 recorded, 1 usage error, 2 budget refused or peak hours,
 *   3 harness failure, recorded);
 * - `check(task, model)`: S0 to S2 with no judge (exit code of `score.mjs --checks-only`);
 * - `model(id)`: the entry of `bench/models.json` (`priced`, `peakUtc`);
 * - `lease()`: resolves true when the halogen lease is held (called before the first halogen run);
 * - `refresh()` (optional): runs before each step, so a synchronous `outcome` can read a fresh cache;
 * - `peakEnds(model, date)`, `now()`, `wait(ms)`, `waitPeak`, `parallel`, `log`.
 * A pilot task never runs: a model with no finished pilot attempt is `excluded` by its `outcome`. Returns `{ tasks,
 * stuck, deferred, budgetRefused }`, the tasks as `resolveTask` gives them.
 */
export async function drive(plan, deps) {
    const live = new Map();
    const launches = new Map();
    const stuck = new Map();
    const failures = new Map();
    const deferred = new Set();
    let budgetRefused = false;
    let leaseTaken = null;

    const keyOf = (task, model) => `${task.id}\n${model}`;
    const states = () =>
        plan.tasks.map((task) => ({
            task,
            ...resolveTask(task, plan.groups, (model) => deps.outcome(task, model)),
        }));

    /** The next actions: 1 per waiting model that is not live, stuck or blocked. */
    const actions = () => {
        const out = [];

        deferred.clear();

        for (const { task, waiting } of states()) {
            for (const { model, need } of waiting) {
                const key = keyOf(task, model);

                if (live.has(key) || stuck.has(key)) {
                    continue;
                }

                // An action that ended and left its model waiting 3 times does not start again.
                if ((launches.get(key) ?? 0) >= MAX_LAUNCHES) {
                    stuck.set(key, `${need} started ${MAX_LAUNCHES} times and still waits`);
                    continue;
                }

                if (need === "run") {
                    const entry = deps.model(model);

                    if (task.source === "pilot") {
                        stuck.set(key, "a pilot task never runs");
                        continue;
                    }

                    if (budgetRefused && entry?.priced) {
                        continue;
                    }

                    if (entry && inPeak(entry, new Date(deps.now()))) {
                        deferred.add(key);
                        continue;
                    }
                }

                out.push({ task, model, need, key });
            }
        }

        return out;
    };

    const start = ({ task, model, need, key }) => {
        launches.set(key, (launches.get(key) ?? 0) + 1);

        const job = (async () => {
            if (need === "run" && model.startsWith("halogen/")) {
                // 1 take for the whole run, also when several halogen attempts start at once.
                leaseTaken ??= deps.lease();

                if (!(await leaseTaken)) {
                    stuck.set(key, "cannot take the halogen lease");

                    return;
                }
            }

            const code =
                need === "run" ? await deps.run(task, model) : await deps.check(task, model);

            if (need === "run" && code === 2) {
                if (inPeak(deps.model(model) ?? {}, new Date(deps.now()))) {
                    return;
                }

                budgetRefused = true;
                deps.log(`${task.id} ${model}: budget refused; no more priced attempts start`);

                return;
            }

            const ok = need === "run" ? code === 0 || code === 3 : code === 0;

            if (!ok) {
                const count = (failures.get(key) ?? 0) + 1;

                failures.set(key, count);

                // A usage error stops at once; a scoring error gets 1 more run.
                if (code === 1 || count >= 2) {
                    stuck.set(key, `${need} exited ${code}`);
                }
            }
        })().finally(() => live.delete(key));

        live.set(key, job);
    };

    for (;;) {
        await deps.refresh?.();

        for (const action of actions()) {
            if (live.size >= deps.parallel) {
                break;
            }

            start(action);
        }

        if (live.size) {
            await Promise.race(live.values());
            continue;
        }

        if (!deferred.size || !deps.waitPeak) {
            break;
        }

        const models = [...deferred].map((key) => deps.model(key.split("\n")[1]));
        const until = Math.max(...models.map((m) => deps.peakEnds(m, new Date(deps.now()))));

        deps.log(`waiting for the end of peak hours: ${new Date(until).toISOString()}`);
        await deps.wait(Math.max(1_000, until - deps.now() + 60_000));
    }

    await deps.refresh?.();

    return { tasks: states(), stuck, deferred: [...deferred], budgetRefused };
}

// ---------------------------------------------------------------------------------------------------------------
// Results on disk
// ---------------------------------------------------------------------------------------------------------------

/** The result file of a calibration attempt (pool task) or of a pilot copy (pilot task) in the instrument's folder. */
export const itemResultPath = (dir, task, model) =>
    resultPath(join(dir, "results"), {
        stage: task.source === "pilot" ? "pilot" : CALIBRATION_STAGE,
        task: task.id,
        model,
    });

/** The original pilot result of a model. */
export const pilotResultPath = (pilotResults, task, model) =>
    resultPath(pilotResults, { stage: "pilot", task: task.id, model });

/**
 * The outcome of a model on a task. A pilot task has no runs: a model with no pilot result is `excluded` (it did not
 * run in the pilot: the pilot ran Claude Haiku on the route `anthropic/claude-haiku-5-5`). A pilot result counts only
 * through its copy in the instrument's folder: an original with no failure waits for its check (the copy, then the
 * check), whatever scores the original holds, so an item's S1 and S2 are always those of the current manifest.
 */
export async function outcomeOnDisk(dir, pilotResults, task, manifestTask, model) {
    if (task.source !== "pilot") {
        return outcomeOf(await readJson(itemResultPath(dir, task, model), null), manifestTask);
    }

    const copy = await readJson(itemResultPath(dir, task, model), null);

    if (copy) {
        return outcomeOf(copy, manifestTask);
    }

    const original = await readJson(pilotResultPath(pilotResults, task, model), null);

    if (!original) {
        return "excluded";
    }

    const outcome = outcomeOf({ ...original, s0: null }, manifestTask);

    return outcome === "excluded" ? "excluded" : "check";
}

/** The fields that scoring adds to a result: a pilot copy starts without them. */
export const SCORE_FIELDS = [
    "s0",
    "s1",
    "s1Detail",
    "s2",
    "s2Detail",
    "grades",
    "judges",
    "diffCut",
    "referenceCut",
    "judgePending",
    "checksOnly",
    "diffFile",
    "scoredAt",
    "scoreError",
];

/**
 * Copy a pilot result into the instrument's folder once, without any score of the original (S0 to S3 are those of the
 * current manifest, from the copy's own check). The pilot's file never changes.
 */
export async function copyPilotResult(dir, pilotResults, task, model) {
    const to = itemResultPath(dir, task, model);

    if (!existsSync(to)) {
        const original = await readJson(pilotResultPath(pilotResults, task, model), null);

        for (const field of SCORE_FIELDS) {
            delete original[field];
        }

        await privateDir(dirname(to));
        await writeJsonAtomic(to, {
            ...original,
            s0: null,
            s1: null,
            s2: null,
            grades: null,
            judgePending: null,
        });
    }

    return to;
}

/** The counts of a driven plan: items per owner and set, per model, the missing items, and the attempts' spend. */
export function summarizeState(tasks, attempts) {
    const perModel = {};
    const perOwner = {};
    let items = 0;
    let missing = 0;
    let waiting = 0;
    let replacements = 0;

    for (const { task, slots, replacements: reps } of tasks) {
        replacements += reps;
        perOwner[task.owner] ??= { dev: 0, heldOut: 0, missing: 0 };

        for (const slot of slots) {
            if (slot.state === "ok") {
                items += 1;
                perModel[slot.model] = (perModel[slot.model] ?? 0) + 1;
                perOwner[task.owner][task.set] += 1;
            } else if (slot.state === "missing") {
                missing += 1;
                perOwner[task.owner].missing += 1;
            } else {
                waiting += 1;
            }
        }
    }

    const spend = attempts.reduce((sum, r) => sum + (r?.usage?.cost ?? 0), 0);

    return {
        items,
        missing,
        waiting,
        replacements,
        perModel,
        perOwner,
        attempts: attempts.length,
        spend: Math.round(spend * 1e6) / 1e6,
    };
}

/** The summary as Markdown: no item's diff, only counts, models and outcomes. */
export function summaryMarkdown(summary, tasks) {
    const lines = [
        `# Calibration attempts: ${summary.items} items, ${summary.missing} missing, ${summary.waiting} waiting`,
        "",
        `Attempts in stage ${CALIBRATION_STAGE}: ${summary.attempts}, list cost $${summary.spend.toFixed(4)}. Replacements: ${summary.replacements}.`,
        "",
        "| Task | Owner | Set | Slots (group: chain -> state) |",
        "| ---- | ----- | --- | ----------------------------- |",
        ...tasks.map(
            ({ task, slots }) =>
                `| ${task.id} | ${task.owner} | ${task.set} | ${slots.map((s) => `${s.group}: ${s.chain.join(" > ")} -> ${s.state}`).join("; ")} |`,
        ),
        "",
        "| Owner | Dev items | Held-out items | Missing |",
        "| ----- | --------- | -------------- | ------- |",
        ...Object.entries(summary.perOwner).map(
            ([owner, c]) => `| ${owner} | ${c.dev} | ${c.heldOut} | ${c.missing} |`,
        ),
        "",
        "| Model | Items |",
        "| ----- | ----- |",
        ...Object.entries(summary.perModel)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([model, n]) => `| ${model} | ${n} |`),
    ];

    return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Packs and keys
// ---------------------------------------------------------------------------------------------------------------

/** The label rules, relative to the repository root. */
export const LABEL_RULES = "bench/calibration-labels.md";

/** The pack folder of an owner, and the key file. */
export const packDir = (dir, owner) => join(dir, "packs", owner);
export const keyPath = (dir, owner) => join(dir, "keys", `${owner}.json`);

/** The fields an item carries: exactly the judge's input. */
export const ITEM_FIELDS = ["id", "set", "brief", "s1", "s2", "submitted", "reference"];

/**
 * 1 item of a pack from a checked result: the brief, S1, S2, and the submitted and merged diffs cut as the judge sees
 * them (`cutDiff`). `read(file)` reads a diff or stat file (null when missing).
 */
export async function itemOf(result, task, read) {
    const diffFile = result.diffFile;
    const stat = diffFile.replace(/\.diff$/, ".stat");
    const folder = dirname(diffFile);
    const submitted = await read(diffFile);
    const reference = await read(join(folder, "reference.diff"));

    if (submitted === null || reference === null) {
        throw new UsageError(`the diffs of ${result.task} ${result.model} are missing`);
    }

    return {
        brief: String(task.brief ?? "").trim(),
        s1: result.s1,
        s2: result.s2,
        submitted: cutDiff(submitted, await read(stat)),
        reference: cutDiff(reference, await read(join(folder, "reference.stat"))),
    };
}

/** An item as Markdown: the judge's input in its order, with no rubric and no answer format. */
export function itemMarkdown(item) {
    const fence = (text) => {
        const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
        const ticks = "`".repeat(longest + 1);

        return `${ticks}diff\n${text}${String(text).endsWith("\n") ? "" : "\n"}${ticks}`;
    };

    return [
        `# Item ${item.id} (${item.set === "dev" ? "development" : "held-out"})`,
        "",
        "## The task",
        "",
        item.brief,
        "",
        "## The automatic checks",
        "",
        `- S1, the repository's own check on the submitted tree: ${checkWords(item.s1, "not run")}`,
        `- S2, the merged change's own tests that failed before it: ${checkWords(item.s2, "none: this task has no hidden test")}`,
        "",
        "## The submitted change",
        "",
        cutNote(item.submitted.cut, "submitted"),
        "",
        item.submitted.text.trim() === "" ? "(no change)" : fence(item.submitted.text),
        "",
        "## The merged change (1 accepted solution, not the only one)",
        "",
        cutNote(item.reference.cut, "merged"),
        "",
        fence(item.reference.text),
        "",
    ].join("\n");
}

/** The README of an owner's pack. */
export function packReadme(owner, items) {
    return [
        `# Calibration labels: ${owner}`,
        "",
        `${items.length} items: ${items.filter((i) => i.set === "dev").length} development and ${items.filter((i) => i.set === "heldOut").length} held-out.`,
        "",
        `1. Read the label rules: \`${LABEL_RULES}\` in bketelsen/pi-pocket-team (main).`,
        "2. Read each item in `items/` (1 Markdown file per item). Each holds the task's brief, S1, S2, the submitted",
        "   change and the merged change: what the judges see, and nothing else.",
        "3. Put your label in `labels.json`: `label` (`pass` or `fail`) and `note` (1 to 3 sentences: why). When you saw",
        "   the item's change before (its diff, its run, or its review), set `blind` to `false` and give the reason in",
        "   `reason`. Change no other field and no other file.",
        "",
        "Open only this folder and the label rules. Do not open the key (`../../keys/`), the plan (`../../plan.json`),",
        "the results, runs, diffs or judges folders of the bench data dir, a GitHub PR or a desk thread of the task.",
        "",
    ].join("\n");
}

/**
 * The packs and keys of all owners from a resolved plan. `tasks`: `resolveTask` states, each `{ task, slots }`;
 * `load(task, model)` returns `{ result, manifestTask, file }`; `read(file)` reads a diff (null when missing). Returns
 * `{ packs: { owner: { items, labels } }, keys: { owner: key } }`. Items are in a seeded order (mulberry32, seed
 * 1064), with ids `<owner>-NN`.
 */
export async function buildPacks(tasks, load, read) {
    const byOwner = new Map();

    for (const { task, slots } of tasks) {
        if (slots.some((slot) => slot.state !== "ok" && slot.state !== "missing")) {
            throw new UsageError(`task ${task.id} still waits: run the attempts first`);
        }

        for (const [slotIndex, slot] of slots.entries()) {
            if (slot.state !== "ok") {
                continue;
            }

            const { result, manifestTask, file } = await load(task, slot.model);
            const item = await itemOf(result, manifestTask, read);

            if (!byOwner.has(task.owner)) {
                byOwner.set(task.owner, []);
            }

            byOwner.get(task.owner).push({
                item: { set: task.set, ...item },
                key: {
                    task: task.id,
                    set: task.set,
                    slot: slotIndex,
                    group: slot.group,
                    model: slot.model,
                    stage: result.stage,
                    result: file,
                },
            });
        }
    }

    const packs = {};
    const keys = {};

    for (const owner of OWNERS.filter((o) => byOwner.has(o))) {
        const ordered = seededShuffle(byOwner.get(owner), SEED);
        const items = ordered.map(({ item }, i) => ({
            id: `${owner}-${String(i + 1).padStart(2, "0")}`,
            ...item,
        }));
        const text = itemsText(owner, items);
        const itemsSha256 = sha256(text);

        packs[owner] = {
            text,
            items,
            labels: {
                schema: CALIBRATION_SCHEMA,
                owner,
                rules: LABEL_RULES,
                itemsSha256,
                labels: items.map((item) => ({
                    id: item.id,
                    set: item.set,
                    label: null,
                    note: "",
                    blind: true,
                    reason: "",
                })),
            },
        };
        keys[owner] = {
            schema: CALIBRATION_SCHEMA,
            owner,
            itemsSha256,
            items: Object.fromEntries(ordered.map(({ key }, i) => [items[i].id, key])),
        };
    }

    return { packs, keys };
}

/** The text of an owner's `items.json`. */
export const itemsText = (owner, items) =>
    `${JSON.stringify({ schema: CALIBRATION_SCHEMA, owner, rules: LABEL_RULES, items }, null, 4)}\n`;

/** True when a labels file holds a label, a note or a blind mark of an owner. */
export const labelled = (labels) =>
    (labels?.labels ?? []).some(
        (entry) =>
            entry.label !== null ||
            entry.blind !== true ||
            String(entry.note ?? "") !== "" ||
            String(entry.reason ?? "") !== "",
    );

/**
 * Write the packs and keys. A pack whose `labels.json` holds an owner's work is never written over: with the same
 * items it stays as it is; with other items the write stops (exit 1) before any file changes. Returns the owners
 * written and kept.
 */
export async function writePacks(dir, { packs, keys }) {
    const plan = [];

    for (const [owner, pack] of Object.entries(packs)) {
        const folder = packDir(dir, owner);
        const labels = await readJson(join(folder, "labels.json"), null);

        if (labelled(labels)) {
            if (labels.itemsSha256 === pack.labels.itemsSha256) {
                plan.push({ owner, keep: true });
                continue;
            }

            throw new UsageError(
                `the pack of ${owner} holds labels and its items would change: nothing is written`,
            );
        }

        plan.push({ owner, keep: false, folder, pack });
    }

    for (const { owner, keep, folder, pack } of plan) {
        if (keep) {
            continue;
        }

        await privateDir(join(folder, "items"));
        await writeAtomic(join(folder, "items.json"), pack.text);

        for (const item of pack.items) {
            await writeAtomic(join(folder, "items", `${item.id}.md`), itemMarkdown(item));
        }

        await writeAtomic(join(folder, "README.md"), packReadme(owner, pack.items));
        await writeJsonAtomic(join(folder, "labels.json"), pack.labels);
        await privateDir(join(dir, "keys"));
        await writeJsonAtomic(keyPath(dir, owner), keys[owner]);
    }

    return {
        written: plan.filter((p) => !p.keep).map((p) => p.owner),
        kept: plan.filter((p) => p.keep).map((p) => p.owner),
    };
}

/** Read a text file, or null when it does not exist. */
export const readText = (file) =>
    readFile(file, "utf8").catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
    );

/** Load the manifest tasks of a plan: a map task id -> the manifest task (and the manifest's checkout). */
export async function loadPlanTasks(plan, home) {
    const cache = new Map();
    const out = new Map();

    for (const task of plan.tasks) {
        const file = manifestPath(task.manifest, home);

        if (!cache.has(file)) {
            cache.set(file, await loadManifest(file));
        }

        const found = cache.get(file).tasks.find((t) => t.id === task.id);

        if (!found) {
            throw new UsageError(`task ${task.id} is not in ${file}`);
        }

        if (found.owner?.keep !== true) {
            throw new UsageError(`task ${task.id} is not kept in ${file}`);
        }

        out.set(task.id, { manifestTask: found, file });
    }

    return out;
}
