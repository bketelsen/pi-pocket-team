// The pool gate (docs/plans/router-bench.md, phase 1 "Pool v1"): the owners' kept tasks become 3 disjoint sets before
// any paid run: the judge calibration items, stage 1 (explore) and stage 2 (R, confirm). The file `bench/pool-v1.json`
// is frozen once written: a later run only checks it, or grows R with new kept tasks (`--grow`).
//
// The rules, in the bench's pre-registration words: seed 1064 over the kept tasks sorted by id; (a) calibration: 3
// kept tasks of each owner except Sheeana (her items come from the pilot tasks, which are not in the pool), 1 dev and
// 2 held-out, 1 per size stratum where the owner has one; (b) stage 1: 36 tasks, 12 per stratum, 6 to 8 per owner
// where possible; a stratum with fewer than 12 gives all and its neighbour fills it (small from medium, large from
// medium, medium from large); fewer than 30 in all: no stage 1, the bench waits for the pool; (c) stage 2: every
// other kept task, R. Where that text is open, the choices are written beside the code that makes them. The owner
// balance is a greedy pass, then a deterministic swap pass, so that the gate finds a set within 6 to 8 per owner
// where 1 exists by swaps inside a stratum.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { manifestTasks } from "../analyze.mjs";
import { stratumOf } from "./harvest.mjs";
import { BENCH_REPOS, OWNERS, SEED, benchRepo, expandHome, seededShuffle } from "./owners.mjs";

export const POOL_SCHEMA = 1;
export const POOL_VERSION = 1;
export const STRATA = ["small", "medium", "large"];
export const STRATA_LIMITS = { small: "<=50", medium: "51-300", large: ">300" };
/** Calibration items per owner: the first 2 by rank are held-out, the 3rd is dev. */
export const CALIBRATION_PER_OWNER = 3;
export const HELD_OUT_PER_OWNER = 2;
/** Sheeana's calibration items come from the pilot tasks, which never join the pool. */
export const CALIBRATION_SKIP = new Set(["sheeana"]);
export const STAGE1_PER_STRATUM = 12;
export const STAGE1_SIZE = 36;
/** Fewer tasks than this left after calibration: no stage 1, the bench waits for the pool. */
export const STAGE1_MIN = 30;
export const OWNER_RANGE = [6, 8];
/** The neighbour fills, in this order: [to, from] (small from medium, large from medium, medium from large). */
export const FILLS = [
    ["small", "medium"],
    ["large", "medium"],
    ["medium", "large"],
];

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

/** `~/` for a path under the home folder: the pool file holds no absolute home path. */
export const tildePath = (path, home = homedir()) =>
    path === home ? "~" : path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;

/** The default manifests: `<homes>/<owner>/bench/<repo name>.json` for each bench repository, in table order. */
export const defaultManifests = (homes = "~/agents") =>
    BENCH_REPOS.map((entry) => `${homes}/${entry.owner}/bench/${entry.repo.split("/")[1]}.json`);

/** SHA-256 of the sorted ids joined by "\n". */
export const idsSha256 = (ids) =>
    createHash("sha256")
        .update([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"))
        .digest("hex");

/**
 * The kept tasks of the manifests, checked: each task's repository is a bench repository (its owner comes from
 * there), each id appears once, and no task is a pilot PR (pilot tasks never join the pool). `manifests`: `{ file,
 * json }` in input order; `pilotPrs`: the PR refs of `bench/pilot.json`. Gives `{ tasks, inputs }`.
 */
export function poolTasks(manifests, pilotPrs = []) {
    const pilot = new Set(pilotPrs.map((pr) => String(pr).toLowerCase()));
    const seen = new Map();
    const tasks = [];
    const inputs = [];

    for (const { file, json } of manifests) {
        const kept = manifestTasks(json, file);

        for (const t of kept) {
            const entry = benchRepo(t.repo);

            if (!entry) {
                throw new Error(
                    `${file}: task ${t.id} is in ${t.repo}, which is no bench repository`,
                );
            }

            if (seen.has(t.id)) {
                throw new Error(`task id ${t.id} repeats (${seen.get(t.id)} and ${file})`);
            }

            if (t.pr && pilot.has(String(t.pr).toLowerCase())) {
                throw new Error(
                    `${file}: task ${t.id} is the pilot PR ${t.pr}; pilot tasks never join the pool`,
                );
            }

            if (typeof t.size !== "number" || !Number.isFinite(t.size) || t.size < 0) {
                throw new Error(`${file}: task ${t.id} has no size (lines changed)`);
            }

            seen.set(t.id, file);
            tasks.push({
                id: t.id,
                repo: t.repo,
                size: t.size,
                owner: entry.owner,
                stratum: stratumOf(t.size),
            });
        }

        inputs.push({
            file,
            repo: json?.repo ?? null,
            kept: kept.length,
            keptSha256: idsSha256(kept.map((t) => t.id)),
        });
    }

    return { tasks, inputs };
}

/**
 * The rank: the kept tasks sorted by id (plain code-unit compare), then 1 Fisher-Yates shuffle driven by
 * mulberry32(1064). Every later choice takes the best rank (the lowest position) first, and no other random number is
 * drawn, so the pool depends only on the set of kept tasks.
 */
export const rankTasks = (tasks, seed = SEED) => seededShuffle([...tasks].sort(byId), seed);

/**
 * Calibration, per owner in `OWNERS` order except Sheeana: the owner's best-ranked task of each stratum (small, medium,
 * large); an owner with no task of a stratum fills up to 3 with its next best-ranked tasks not taken. The picks in rank
 * order: the first 2 are held-out, the 3rd is dev. An owner with fewer than 3 kept tasks gives all of them, held-out
 * first (2 tasks: 2 held-out and no dev; 1 task: 1 held-out), and `short` is the missing count.
 */
export function pickCalibration(ranked) {
    const owners = {};
    const taken = new Set();

    for (const owner of OWNERS) {
        if (CALIBRATION_SKIP.has(owner)) {
            continue;
        }

        const mine = ranked.filter((t) => t.owner === owner);
        const picked = [];

        for (const stratum of STRATA) {
            const best = mine.find((t) => t.stratum === stratum);

            if (best) {
                picked.push(best);
            }
        }

        for (const t of mine) {
            if (picked.length >= CALIBRATION_PER_OWNER) {
                break;
            }

            if (!picked.includes(t)) {
                picked.push(t);
            }
        }

        const ids = ranked.filter((t) => picked.includes(t)).map((t) => t.id);

        for (const id of ids) {
            taken.add(id);
        }

        owners[owner] = {
            heldOut: ids.slice(0, HELD_OUT_PER_OWNER),
            dev: ids.slice(HELD_OUT_PER_OWNER),
            short: CALIBRATION_PER_OWNER - ids.length,
        };
    }

    return { owners, ids: ranked.filter((t) => taken.has(t.id)).map((t) => t.id) };
}

/**
 * The stage 1 quotas from A (the tasks left per stratum after calibration): q = min(12, A) per stratum, then each
 * deficit (12 - min(12, A)) is filled from the neighbour's spare (A - q of the neighbour, updated as it is taken), in
 * the order of `FILLS`. A fill raises the neighbour's quota: stage 1 takes more of the neighbour's tasks.
 */
export function stage1Quotas(available) {
    const quota = {};
    const deficit = {};
    const fills = [];

    for (const s of STRATA) {
        quota[s] = Math.min(STAGE1_PER_STRATUM, available[s]);
        deficit[s] = STAGE1_PER_STRATUM - quota[s];
    }

    for (const [to, from] of FILLS) {
        const count = Math.min(deficit[to], available[from] - quota[from]);

        if (count > 0) {
            quota[from] += count;
            deficit[to] -= count;
            fills.push({ to, from, count });
        }
    }

    return { quota, fills };
}

const countBy = (tasks, key, keys) => {
    const out = zeros(keys);

    for (const t of tasks) {
        out[t[key]] += 1;
    }

    return out;
};

/**
 * The swap pass after the greedy: the greedy can leave an owner far above another when the strata's quotas ran out
 * in the wrong order. Repeat: for each owner `a` in descending stage 1 count (a tie in `OWNERS` order), find the owner
 * `b` with the fewest (a tie in `OWNERS` order) such that count[a] - count[b] >= 2 and a stratum (in the order small,
 * medium, large) exists where `a` has a selected task and `b` has an unselected task left after calibration; the
 * first such pair swaps: `a`'s worst-ranked selected task of that stratum goes out, `b`'s best-ranked unselected task
 * of it comes in. The stratum counts stay the same, and each swap lowers the sum of squares of the owner counts, so
 * the loop ends. Stops when no pair exists. Gives the swaps `{ out, in, stratum }` in order.
 */
export function balanceSwaps(left, taken, perOwner) {
    const swaps = [];
    const at = (o) => OWNERS.indexOf(o);

    const findSwap = () => {
        const desc = [...OWNERS].sort((x, y) => perOwner[y] - perOwner[x] || at(x) - at(y));
        const asc = [...OWNERS].sort((x, y) => perOwner[x] - perOwner[y] || at(x) - at(y));

        for (const a of desc) {
            for (const b of asc) {
                if (perOwner[a] - perOwner[b] < 2) {
                    break;
                }

                for (const stratum of STRATA) {
                    const out = left.findLast(
                        (t) => t.owner === a && t.stratum === stratum && taken.has(t.id),
                    );
                    const into = left.find(
                        (t) => t.owner === b && t.stratum === stratum && !taken.has(t.id),
                    );

                    if (out && into) {
                        return { out, into, stratum };
                    }
                }
            }
        }

        return null;
    };

    for (let swap = findSwap(); swap; swap = findSwap()) {
        taken.delete(swap.out.id);
        taken.add(swap.into.id);
        perOwner[swap.out.owner] -= 1;
        perOwner[swap.into.owner] += 1;
        swaps.push({ out: swap.out.id, in: swap.into.id, stratum: swap.stratum });
    }

    return swaps;
}

/**
 * Stage 1 from the tasks left after calibration (in rank order). Fewer than 30: status "wait", no task. 30 to 36:
 * every task left. Else the quotas, then the owner balance in 2 passes. The greedy: until every quota is 0, the
 * candidate (a left task whose stratum has quota left) of the owner with the fewest stage 1 tasks so far is taken, a
 * tie to the best rank. Then the swap pass (`balanceSwaps`). `outsideRange`: the owners outside 6 to 8 ("where
 * possible": a record, not an error). `options.swap: false` gives the greedy alone (for the tests).
 */
export function pickStage1(left, options = {}) {
    const available = countBy(left, "stratum", STRATA);
    const total = left.length;

    if (total < STAGE1_MIN) {
        return { status: "wait", ids: [], fills: [], swaps: [] };
    }

    if (total <= STAGE1_SIZE) {
        return { status: "ready", ids: left.map((t) => t.id), fills: [], swaps: [] };
    }

    const { quota, fills } = stage1Quotas(available);
    const perOwner = zeros(OWNERS);
    const taken = new Set();

    while (STRATA.some((s) => quota[s] > 0)) {
        let best = null;

        for (const t of left) {
            if (taken.has(t.id) || quota[t.stratum] === 0) {
                continue;
            }

            // `left` is in rank order: a later task wins only with a smaller owner count.
            if (best === null || perOwner[t.owner] < perOwner[best.owner]) {
                best = t;
            }
        }

        taken.add(best.id);
        quota[best.stratum] -= 1;
        perOwner[best.owner] += 1;
    }

    const swaps = options.swap === false ? [] : balanceSwaps(left, taken, perOwner);

    return {
        status: "ready",
        ids: left.filter((t) => taken.has(t.id)).map((t) => t.id),
        fills,
        swaps,
    };
}

/** The pool of the checked kept tasks (`poolTasks`): calibration, stage 1 and stage 2 (R), and the counts. */
export function buildPool(tasks, inputs = []) {
    const ranked = rankTasks(tasks);
    const calibration = pickCalibration(ranked);
    const inCalibration = new Set(calibration.ids);
    const left = ranked.filter((t) => !inCalibration.has(t.id));
    const stage1 = pickStage1(left);
    const inStage1 = new Set(stage1.ids);
    // R: every kept task in no other set, in rank order (stage 2 takes the first n of a group in this order).
    const stage2Ids = left.filter((t) => !inStage1.has(t.id)).map((t) => t.id);

    return assemble(ranked, inputs, calibration, { ...stage1 }, { ids: stage2Ids });
}

const outsideRange = (byOwner) =>
    OWNERS.filter((o) => byOwner[o] < OWNER_RANGE[0] || byOwner[o] > OWNER_RANGE[1]);

/** The whole pool file from its sets; checks that each kept task is in exactly 1 set. */
function assemble(ranked, inputs, calibration, stage1, stage2) {
    const byIdMap = new Map(ranked.map((t) => [t.id, t]));
    const tasksOf = (ids) => ids.map((id) => byIdMap.get(id));
    const sets = { calibration: calibration.ids, stage1: stage1.ids, stage2: stage2.ids };
    const seen = new Map();

    for (const [name, ids] of Object.entries(sets)) {
        for (const id of ids) {
            if (!byIdMap.has(id)) {
                throw new Error(`pool check: ${name} holds ${id}, which is not a kept task`);
            }

            if (seen.has(id)) {
                throw new Error(`pool check: ${id} is in ${seen.get(id)} and ${name}`);
            }

            seen.set(id, name);
        }
    }

    const missing = ranked.filter((t) => !seen.has(t.id)).map((t) => t.id);

    if (missing.length) {
        throw new Error(`pool check: kept tasks in no set: ${missing.join(", ")}`);
    }

    const stage1ByOwner = countBy(tasksOf(stage1.ids), "owner", OWNERS);
    const per = (key, keys) =>
        Object.fromEntries(
            keys.map((k) => [
                k,
                {
                    kept: ranked.filter((t) => t[key] === k).length,
                    ...Object.fromEntries(
                        Object.entries(sets).map(([name, ids]) => [
                            name,
                            tasksOf(ids).filter((t) => t[key] === k).length,
                        ]),
                    ),
                },
            ]),
        );

    return {
        schema: POOL_SCHEMA,
        version: POOL_VERSION,
        seed: SEED,
        strata: STRATA_LIMITS,
        inputs,
        counts: {
            kept: ranked.length,
            calibration: sets.calibration.length,
            stage1: sets.stage1.length,
            stage2: sets.stage2.length,
            byStratum: per("stratum", STRATA),
            byOwner: per("owner", OWNERS),
        },
        calibration: { owners: calibration.owners, ids: calibration.ids },
        stage1: {
            status: stage1.status,
            ids: stage1.ids,
            byStratum: countBy(tasksOf(stage1.ids), "stratum", STRATA),
            byOwner: stage1ByOwner,
            fills: stage1.fills,
            swaps: stage1.swaps ?? [],
            outsideRange: stage1.status === "wait" ? [] : outsideRange(stage1ByOwner),
        },
        stage2: {
            ids: stage2.ids,
            byStratum: countBy(tasksOf(stage2.ids), "stratum", STRATA),
            byOwner: countBy(tasksOf(stage2.ids), "owner", OWNERS),
            ...(stage2.rounds ? { rounds: stage2.rounds } : {}),
        },
    };
}

/**
 * A frozen pool grown with new kept tasks: calibration and stage 1 stay as they are; each kept task in no set goes to
 * the end of R, the new ones in rank order, as 1 more entry of `stage2.rounds` (none when nothing is new). A task of
 * the frozen file that is no longer kept is an error.
 */
export function growPool(frozen, tasks, inputs = []) {
    const ranked = rankTasks(tasks);
    const kept = new Set(ranked.map((t) => t.id));
    const old = [...frozen.calibration.ids, ...frozen.stage1.ids, ...frozen.stage2.ids];
    const gone = old.filter((id) => !kept.has(id));

    if (gone.length) {
        throw new Error(`the frozen pool holds tasks that are no longer kept: ${gone.join(", ")}`);
    }

    const inPool = new Set(old);
    const added = ranked.filter((t) => !inPool.has(t.id)).map((t) => t.id);
    const rounds = [...(frozen.stage2.rounds ?? [])];

    if (added.length) {
        rounds.push({ added });
    }

    return assemble(ranked, inputs, frozen.calibration, frozen.stage1, {
        ids: [...frozen.stage2.ids, ...added],
        ...(rounds.length ? { rounds } : {}),
    });
}

/** The file text: pretty JSON, 4-space indent, a final newline. */
export const poolText = (pool) => `${JSON.stringify(pool, null, 4)}\n`;

/** The short table of a pool: counts per set, by stratum and by owner. */
export function poolTable(pool) {
    const rows = [
        ["calibration", "calibration"],
        ["stage 1", "stage1"],
        ["stage 2 (R)", "stage2"],
        ["kept", "kept"],
    ];
    const head = ["Set", "Tasks", ...STRATA, ...OWNERS];
    const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];

    for (const [label, key] of rows) {
        lines.push(
            `| ${[
                label,
                pool.counts[key],
                ...STRATA.map((s) => pool.counts.byStratum[s][key]),
                ...OWNERS.map((o) => pool.counts.byOwner[o][key]),
            ].join(" | ")} |`,
        );
    }

    const fills = pool.stage1.fills.map((f) => `${f.to} from ${f.from} ${f.count}`).join(", ");

    lines.push(
        ``,
        `Stage 1: ${pool.stage1.status}; fills: ${fills || "none"}; swaps: ${
            (pool.stage1.swaps ?? []).map((w) => `${w.out} -> ${w.in} (${w.stratum})`).join(", ") ||
            "none"
        }; owners outside ${OWNER_RANGE[0]} to ${OWNER_RANGE[1]}: ${pool.stage1.outsideRange.join(", ") || "none"}.`,
        `Calibration short: ${
            Object.entries(pool.calibration.owners)
                .filter(([, o]) => o.short > 0)
                .map(([owner, o]) => `${owner} ${o.short}`)
                .join(", ") || "none"
        }. R: ${pool.counts.stage2} tasks${pool.stage2.rounds ? `, ${pool.stage2.rounds.length} grow rounds` : ""}.`,
    );

    return lines.join("\n");
}

export const POOL_USAGE = `Usage: node bench/pool.mjs [--homes <dir>] [--manifest <file>]... [--pilot <file>] [--out <file>] [--grow | --check]

  --homes     the agents' homes (default ~/agents): reads <homes>/<owner>/bench/<repo name>.json of each bench repository
  --manifest  a reviewed manifest, repeated, instead of the default list
  --pilot     the pilot manifest (default bench/pilot.json): its PRs never join the pool
  --out       the pool file (default bench/pool-v1.json); frozen once written
  --grow      keep calibration and stage 1, and append each new kept task to R
  --check     recompute and compare; write nothing (exit 0 the same, 1 not)`;

/**
 * The command line. Exit 0: written or unchanged; 1: an error, a frozen file that differs (without `--grow`), or a
 * `--check` that differs.
 */
export function poolMain(
    argv,
    { root = process.cwd(), home = homedir(), log = console.log, error = console.error } = {},
) {
    let values;

    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                homes: { type: "string" },
                manifest: { type: "string", multiple: true },
                pilot: { type: "string" },
                out: { type: "string" },
                grow: { type: "boolean" },
                check: { type: "boolean" },
            },
            allowPositionals: false,
        }));

        if (values.grow && values.check) {
            throw new Error("--grow and --check do not go together");
        }

        if (values.homes && values.manifest?.length) {
            throw new Error("--homes and --manifest do not go together");
        }
    } catch (e) {
        error(`pool: ${e.message}\n${POOL_USAGE}`);

        return 1;
    }

    try {
        const at = (path) => resolve(root, expandHome(path, home));
        const files = values.manifest?.length
            ? values.manifest
            : defaultManifests(values.homes ?? "~/agents");
        const manifests = files.map((file) => {
            const path = at(file);
            const shown = tildePath(path, home);

            if (!existsSync(path)) {
                throw new Error(`the manifest ${shown} does not exist`);
            }

            return { file: shown, json: JSON.parse(readFileSync(path, "utf8")) };
        });
        const pilotPath = at(values.pilot ?? "bench/pilot.json");

        if (!existsSync(pilotPath)) {
            throw new Error(`the pilot manifest ${tildePath(pilotPath, home)} does not exist`);
        }

        const pilot = JSON.parse(readFileSync(pilotPath, "utf8"));
        const { tasks, inputs } = poolTasks(
            manifests,
            (pilot.tasks ?? []).map((t) => t.pr).filter(Boolean),
        );
        const out = at(values.out ?? "bench/pool-v1.json");
        const shownOut = tildePath(out, home);
        const fresh = poolText(buildPool(tasks, inputs));
        const existing = existsSync(out) ? readFileSync(out, "utf8") : null;

        if (existing === null) {
            if (values.check) {
                error(`pool: ${shownOut} does not exist`);

                return 1;
            }

            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, fresh);
            log(`${poolTable(JSON.parse(fresh))}\n\nWritten: ${shownOut}.`);

            return 0;
        }

        const frozen = JSON.parse(existing);
        // A grown file is current when growing it again changes nothing.
        const grown =
            values.grow || frozen?.stage2?.rounds
                ? poolText(growPool(frozen, tasks, inputs))
                : null;

        if (existing === fresh || existing === grown) {
            log(`${poolTable(frozen)}\n\nUnchanged: ${shownOut}.`);

            return 0;
        }

        if (values.check) {
            error(`pool: ${shownOut} differs from the pool of the kept tasks now`);

            return 1;
        }

        if (!values.grow) {
            error(
                `pool: ${shownOut} exists and differs from the pool of the kept tasks now. The pool is frozen once written: run with --grow to append the new kept tasks to R, or remove the file only before any stage has run.`,
            );

            return 1;
        }

        writeFileSync(out, grown);
        log(`${poolTable(JSON.parse(grown))}\n\nGrown: ${shownOut}.`);

        return 0;
    } catch (e) {
        error(`pool: ${e.message}`);

        return 1;
    }
}
