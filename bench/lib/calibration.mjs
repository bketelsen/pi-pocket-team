// The judge calibration sets (plan section Scoring, "Judge calibration"), from the daily audit's blocking review
// points (`metrics.Q1.blockers.points`): a cross-review called a PR head Not ready, and the PR merged later at another
// head.
// - Held-out set: per owner, 8 diffs of the owner's bench repositories from 8 different PRs, 4 at a Not-ready head and
//   4 at the final merged head, blind (no field tells which); the key is a separate file.
// - Development set: 20 pairs (the Not-ready diff and the merged diff of 1 PR, from the same base) from PRs that the
//   held-out set does not use, in any repository.
// Diffs come from GitHub's compare API (read only). Every choice is seeded (mulberry32, seed 1064).
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { dataDir, privateDir, writeJsonAtomic } from "./common.mjs";
import { cutDiff, diffStat } from "./judge.mjs";
import { UsageError } from "./manifest.mjs";
import { OWNERS, SEED, reposOf, seededShuffle } from "./owners.mjs";

const execFileP = promisify(execFile);

/** Held-out diffs per owner, and development pairs. */
export const HELD_OUT_PER_OWNER = 8;
export const DEV_PAIRS = 20;

/** The `gh pr view` fields of a calibration PR. */
export const CALIBRATION_FIELDS = "headRefOid,baseRefOid,mergeCommit,title,body,state";

/** The default findings files: every `~/agents/odrade/reports/*-daily-audit/findings.json`. */
export function defaultFindings(reports = join(homedir(), "agents", "odrade", "reports")) {
    if (!existsSync(reports)) {
        return [];
    }

    return readdirSync(reports)
        .filter((name) => name.endsWith("-daily-audit"))
        .sort()
        .map((name) => join(reports, name, "findings.json"))
        .filter((file) => existsSync(file));
}

/** `owner/name#n` as `{ repo, number }`, or null. */
const parseRef = (ref) => {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(String(ref));

    return match ? { repo: match[1], number: Number(match[2]) } : null;
};

/**
 * The blocking points of the findings files: their union, 1 per `ref@head`, only merged PRs with a head. Returns a
 * map PR ref -> the sorted Not-ready heads.
 */
export async function loadPoints(files) {
    const heads = new Map();

    for (const file of files) {
        const findings = JSON.parse(await readFile(file, "utf8"));
        const points = findings?.metrics?.Q1?.blockers?.points ?? [];

        for (const point of points) {
            if (
                point?.state !== "merged" ||
                typeof point.head !== "string" ||
                !parseRef(point.ref)
            ) {
                continue;
            }

            heads.set(point.ref, new Set([...(heads.get(point.ref) ?? []), point.head]));
        }
    }

    return new Map(
        [...heads]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ref, set]) => [ref, [...set].sort()]),
    );
}

/** The default `gh` (read only: `gh pr view` and GET `gh api`). */
export async function realGh(args) {
    const { stdout } = await execFileP("gh", args, { maxBuffer: 256 * 1024 * 1024 });

    return stdout;
}

/**
 * A reader of PRs and diffs over `gh`, with memos: `pr(ref)` gives `{ state, head, base, title, body }` (null when
 * gh fails); `diff(repo, base, head)` gives the compare diff text (null when gh fails).
 */
export function githubReader(gh, log) {
    const prs = new Map();
    const diffs = new Map();

    return {
        async pr(ref) {
            if (!prs.has(ref)) {
                const { repo, number } = parseRef(ref);

                try {
                    const raw = JSON.parse(
                        await gh([
                            "pr",
                            "view",
                            String(number),
                            "--repo",
                            repo,
                            "--json",
                            CALIBRATION_FIELDS,
                        ]),
                    );

                    prs.set(ref, {
                        state: raw.state ?? null,
                        head: raw.headRefOid ?? null,
                        base: raw.baseRefOid ?? null,
                        merge: raw.mergeCommit?.oid ?? null,
                        title: raw.title ?? "",
                        body: raw.body ?? "",
                    });
                } catch (error) {
                    log(`${ref}: gh pr view failed: ${error.message.split("\n")[0]}`);
                    prs.set(ref, null);
                }
            }

            return prs.get(ref);
        },
        async diff(repo, base, head) {
            const key = `${repo}@${base}...${head}`;

            if (!diffs.has(key)) {
                try {
                    diffs.set(
                        key,
                        await gh([
                            "api",
                            "-H",
                            "Accept: application/vnd.github.diff",
                            `repos/${repo}/compare/${base}...${head}`,
                        ]),
                    );
                } catch (error) {
                    log(
                        `${repo}: compare ${base.slice(0, 7)}...${head.slice(0, 7)} failed: ${error.message.split("\n")[0]}`,
                    );
                    diffs.set(key, null);
                }
            }

            return diffs.get(key);
        },
    };
}

/**
 * A PR that can give a pair: merged on GitHub, with a base, and a Not-ready head that is not its final head. Returns
 * `{ ref, repo, number, info, notReadyHead }` or null. When several Not-ready heads qualify, a seeded pick.
 */
async function eligible(reader, ref, heads, seed) {
    const info = await reader.pr(ref);

    if (!info || info.state !== "MERGED" || !info.head || !info.base) {
        return null;
    }

    const notReady = heads.filter((head) => head !== info.head);

    if (notReady.length === 0) {
        return null;
    }

    return { ref, ...parseRef(ref), info, notReadyHead: seededShuffle(notReady, seed)[0] };
}

/** A PR's brief: its title and body. */
const briefOf = (info) => `${info.title}\n\n${info.body}`.trim();

/** A diff cut for the judge: `{ text, cut }`. */
const cut = (diff) => cutDiff(diff, diffStat(diff));

/**
 * Build both sets. `points`: from `loadPoints`. Returns `{ heldOut: { owner: items }, key, dev, warnings }` (nothing
 * written).
 */
export async function buildCalibration({ points, gh, log = () => {}, seed = SEED }) {
    const reader = githubReader(gh, log);
    const warnings = [];
    const heldOut = {};
    const key = {};
    const used = new Set();

    const warn = (text) => {
        warnings.push(text);
        log(`warning: ${text}`);
    };

    for (const owner of OWNERS) {
        const repos = new Set(reposOf(owner).map((r) => r.toLowerCase()));
        const refs = [...points.keys()].filter((ref) =>
            repos.has(parseRef(ref).repo.toLowerCase()),
        );
        const chosen = [];

        for (const ref of seededShuffle(refs, seed)) {
            if (chosen.length === HELD_OUT_PER_OWNER) {
                break;
            }

            const pr = await eligible(reader, ref, points.get(ref), seed);

            if (pr) {
                chosen.push(pr);
                used.add(ref);
            }
        }

        // The first half (rounded up) of the seeded order gives its Not-ready head, the rest its merged head.
        const notReadyCount = Math.ceil(chosen.length / 2);
        const items = [];

        for (const [i, pr] of chosen.entries()) {
            const label = i < notReadyCount ? "notReady" : "merged";
            const head = label === "notReady" ? pr.notReadyHead : pr.info.head;
            const diff = await reader.diff(pr.repo, pr.info.base, head);

            if (diff === null) {
                warn(`${owner}: ${pr.ref} has no diff: left out`);
                continue;
            }

            const { text, cut: diffCut } = cut(diff);

            items.push({
                item: {
                    repo: pr.repo,
                    pr: pr.ref,
                    brief: briefOf(pr.info),
                    diff: text,
                    diffCut,
                    label: null,
                },
                key: { label, head, repo: pr.repo, pr: pr.ref },
            });
        }

        if (items.length < HELD_OUT_PER_OWNER) {
            warn(`${owner}: ${items.length} held-out diffs, not ${HELD_OUT_PER_OWNER}`);
        }

        // A blind order: the position tells nothing of the label.
        heldOut[owner] = seededShuffle(items, seed).map((entry, i) => {
            const id = `${owner}-${String(i + 1).padStart(2, "0")}`;

            key[id] = entry.key;

            return { id, ...entry.item };
        });
    }

    const dev = [];
    const rest = [...points.keys()].filter((ref) => !used.has(ref));

    for (const ref of seededShuffle(rest, seed)) {
        if (dev.length === DEV_PAIRS) {
            break;
        }

        const pr = await eligible(reader, ref, points.get(ref), seed);

        if (!pr) {
            continue;
        }

        const notReadyDiff = await reader.diff(pr.repo, pr.info.base, pr.notReadyHead);
        const mergedDiff = await reader.diff(pr.repo, pr.info.base, pr.info.head);

        if (notReadyDiff === null || mergedDiff === null) {
            continue;
        }

        const notReady = cut(notReadyDiff);
        const merged = cut(mergedDiff);

        dev.push({
            id: `dev-${String(dev.length + 1).padStart(2, "0")}`,
            repo: pr.repo,
            pr: pr.ref,
            brief: briefOf(pr.info),
            base: pr.info.base,
            notReadyHead: pr.notReadyHead,
            mergedHead: pr.info.head,
            notReadyDiff: notReady.text,
            mergedDiff: merged.text,
            notReadyCut: notReady.cut,
            mergedCut: merged.cut,
        });
    }

    if (dev.length < DEV_PAIRS) {
        warn(`${dev.length} development pairs, not ${DEV_PAIRS}`);
    }

    return { heldOut, key, dev, warnings };
}

/** Write the sets: `held-out/<owner>.json`, `held-out-key.json` and `dev.json` (folders 0700, files 0600). */
export async function writeCalibration(out, { heldOut, key, dev }, seed = SEED) {
    await privateDir(out);
    await privateDir(join(out, "held-out"));

    const files = [];

    for (const [owner, items] of Object.entries(heldOut)) {
        const file = join(out, "held-out", `${owner}.json`);

        await writeJsonAtomic(file, { schema: 1, owner, seed, items });
        files.push(file);
    }

    await writeJsonAtomic(join(out, "held-out-key.json"), { schema: 1, seed, key });
    await writeJsonAtomic(join(out, "dev.json"), { schema: 1, seed, items: dev });

    return [...files, join(out, "held-out-key.json"), join(out, "dev.json")];
}

export const CALIBRATION_USAGE =
    "usage: node bench/calibration.mjs [--findings <findings.json>]... [--out <dir>]";

/** The builder's main: returns the exit code. `deps.gh`, `deps.log` and `deps.print` replace the real ones in tests. */
export async function calibrationMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));

    try {
        let values;

        try {
            ({ values } = parseArgs({
                args: argv,
                options: { findings: { type: "string", multiple: true }, out: { type: "string" } },
                allowPositionals: false,
            }));
        } catch (error) {
            throw new UsageError(error.message);
        }

        const files = values.findings?.length
            ? values.findings.map((f) => resolve(f))
            : defaultFindings(deps.reports);

        if (files.length === 0) {
            throw new UsageError("no findings file found");
        }

        const points = await loadPoints(files);
        const sets = await buildCalibration({ points, gh: deps.gh ?? realGh, log });
        const out = resolve(values.out ?? join(dataDir(env), "calibration"));
        const written = await writeCalibration(out, sets);

        for (const file of written) {
            (deps.print ?? console.log)(file);
        }

        return 0;
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`${error.message}\n${CALIBRATION_USAGE}`);

            return 1;
        }

        throw error;
    }
}
