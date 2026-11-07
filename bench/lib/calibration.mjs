// The judge calibration sets (plan section Scoring, "Judge calibration"), from the daily audit's blocking review
// points (`metrics.Q1.blockers.points`): a cross-review called a PR head Not ready, and the PR merged later at another
// head.
// - Held-out set: per owner, 8 diffs of the owner's bench repositories from 8 different PRs, 4 at a Not-ready head and
//   4 at the final merged head, blind (no field tells which); the key is a separate file.
// - Development set: 20 pairs (the Not-ready diff and the merged diff of 1 PR, from the same base) from PRs that the
//   held-out set does not use, in any repository.
// A PR is eligible only when its desk thread gives the brief (the harvester's rule: exactly 1 thread names the PR,
// that thread names no other PR, and it has a brief). The PR body is never used: it often records the cross-review
// history and the final head, which would show the label. Diffs come from GitHub's compare API (read only). Every
// choice is seeded (mulberry32, seed 1064).
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { dataDir, privateDir, writeJsonAtomic } from "./common.mjs";
import { cutDiff, diffStat, sectionPath } from "./judge.mjs";
import { UsageError } from "./manifest.mjs";
import { OWNERS, SEED, reposOf, seededShuffle } from "./owners.mjs";
import { pocketDb, readThreads } from "./pocket.mjs";

const execFileP = promisify(execFile);

/** Held-out diffs per owner, and development pairs. */
export const HELD_OUT_PER_OWNER = 8;
export const DEV_PAIRS = 20;

/** The `gh pr view` fields of a calibration PR (no title or body: the brief comes from the desk thread). */
export const CALIBRATION_FIELDS = "headRefOid,baseRefOid,mergeCommit,state";

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
 * A reader of PRs and diffs over `gh`, with memos: `pr(ref)` gives `{ state, head, base, merge }` (null when gh
 * fails); `diff(repo, base, head)` gives the compare diff text (null when gh fails).
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
 * The briefs of the desk: a map from a PR ref (lower case) to `{ thread, brief, briefSource }`, for each PR that
 * exactly 1 thread names, when that thread names exactly 1 PR and has a brief (the rule of a bench task in
 * `selectCandidates`, in any repository). `threads`: from `loadThreads`.
 */
export function threadBriefs(threads) {
    const claims = new Map();

    for (const thread of threads) {
        for (const ref of new Set(thread.prs.map((r) => r.toLowerCase()))) {
            claims.set(ref, (claims.get(ref) ?? 0) + 1);
        }
    }

    const briefs = new Map();

    for (const thread of threads) {
        if (thread.prs.length !== 1 || !thread.brief) {
            continue;
        }

        const ref = thread.prs[0].toLowerCase();

        if (claims.get(ref) === 1) {
            briefs.set(ref, {
                thread: thread.id,
                brief: thread.brief,
                briefSource: thread.briefSource,
            });
        }
    }

    return briefs;
}

/**
 * A PR that can give a pair: its desk thread gives its brief (`briefs`, from `threadBriefs`), merged on GitHub, with
 * a base, and a Not-ready head that is not its final head. Returns `{ ref, repo, number, info, notReadyHead, brief }`
 * or null. When several Not-ready heads qualify, a seeded pick.
 */
async function eligible(reader, briefs, ref, heads, seed) {
    const brief = briefs.get(ref.toLowerCase());

    if (!brief) {
        return null;
    }

    const info = await reader.pr(ref);

    if (!info || info.state !== "MERGED" || !info.head || !info.base) {
        return null;
    }

    const notReady = heads.filter((head) => head !== info.head);

    if (notReady.length === 0) {
        return null;
    }

    return { ref, ...parseRef(ref), info, notReadyHead: seededShuffle(notReady, seed)[0], brief };
}

/**
 * True for a file that records the review of a change, not the change: `.memory/` holds the corrections log
 * (`.memory/corrections.jsonl`), whose lines name the review round and the finding that a fix answers. Shown in a
 * calibration diff, it tells that a later review happened, so it can show the label.
 */
export const isReviewRecord = (path) => /^\.memory\//.test(String(path ?? ""));

/**
 * A diff without the file sections of review records (`isReviewRecord`): the text before the first `diff --git `
 * line and every other section stay as they are.
 */
export function withoutReviewRecords(diff) {
    const text = String(diff ?? "");
    const starts = [...text.matchAll(/^diff --git /gm)].map((m) => m.index);

    if (starts.length === 0) {
        return text;
    }

    const sections = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));

    return (
        text.slice(0, starts[0]) +
        sections.filter((section) => !isReviewRecord(sectionPath(section))).join("")
    );
}

/** A diff for the judge and the owners, with no review record, cut: `{ text, cut }`. */
const cut = (diff) => {
    const shown = withoutReviewRecords(diff);

    return cutDiff(shown, diffStat(shown));
};

/**
 * Build both sets. `points`: from `loadPoints`; `threads`: from `loadThreads`. Returns `{ heldOut: { owner: items },
 * key, dev, warnings }` (nothing written).
 */
export async function buildCalibration({ points, threads, gh, log = () => {}, seed = SEED }) {
    const reader = githubReader(gh, log);
    const briefs = threadBriefs(threads);
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

            const pr = await eligible(reader, briefs, ref, points.get(ref), seed);

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
                    thread: pr.brief.thread,
                    brief: pr.brief.brief,
                    briefSource: pr.brief.briefSource,
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

        const pr = await eligible(reader, briefs, ref, points.get(ref), seed);

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
            thread: pr.brief.thread,
            brief: pr.brief.brief,
            briefSource: pr.brief.briefSource,
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

/**
 * The held-out items in `<out>/held-out/*.json` that hold an owner label (a label that is not null), as
 * `owner-file: id` lines. A file that does not parse counts too: its labels cannot be checked.
 */
export async function labelledItems(out) {
    const dir = join(out, "held-out");

    if (!existsSync(dir)) {
        return [];
    }

    const found = [];

    for (const name of readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        let items;

        try {
            items = JSON.parse(await readFile(join(dir, name), "utf8"))?.items ?? [];
        } catch {
            found.push(`${name}: does not parse`);
            continue;
        }

        for (const item of Array.isArray(items) ? items : []) {
            if (item?.label !== null && item?.label !== undefined) {
                found.push(`${name}: ${item.id}`);
            }
        }
    }

    return found;
}

export const CALIBRATION_USAGE =
    "usage: node bench/calibration.mjs [--findings <findings.json>]... [--out <dir>] [--db <pocket.sqlite>]";

/**
 * The builder's main: returns the exit code (0 written, 1 usage error or labelled sets in `--out`). `deps.gh`,
 * `deps.log`, `deps.print` and `deps.readThreads` replace the real ones in tests.
 */
export async function calibrationMain(argv, env = process.env, deps = {}) {
    const log = deps.log ?? ((line) => console.error(line));

    try {
        let values;

        try {
            ({ values } = parseArgs({
                args: argv,
                options: {
                    findings: { type: "string", multiple: true },
                    out: { type: "string" },
                    db: { type: "string" },
                },
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

        const out = resolve(values.out ?? join(dataDir(env), "calibration"));
        const labelled = await labelledItems(out);

        // The owners' labels are the only copy of their review: a new build never writes over them.
        if (labelled.length) {
            log(
                `refused: ${join(out, "held-out")} holds owner labels (${labelled.join(", ")}); move the folder away, or give another --out`,
            );

            return 1;
        }

        const points = await loadPoints(files);
        const threads = (deps.readThreads ?? readThreads)(values.db ?? pocketDb(env));
        const sets = await buildCalibration({ points, threads, gh: deps.gh ?? realGh, log });
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
