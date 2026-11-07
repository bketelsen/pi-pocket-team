// The judge calibration sets: from fixture findings files, a fixture Pocket database and a fake gh, 8 blind held-out
// diffs per owner (4 at a Not-ready head, 4 at the merged head), a separate key, 20 development pairs from other PRs,
// briefs from the desk thread (never the PR body), private files, the same output for the same seed, and no write
// over owner labels. No network.
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { calibrationMain, loadPoints, threadBriefs } from "./lib/calibration.mjs";
import { DIFF_LIMIT } from "./lib/judge.mjs";
import { BENCH_REPOS, OWNERS, reposOf } from "./lib/owners.mjs";
import { fakeGh, makePocketDb, wrapped } from "./fixtures/harvest.mjs";

let root;
const sha = (seed) => seed.repeat(40).slice(0, 40);
const prs = {};
const diffs = {};
const findings = [];
const threads = {};
const messages = {};
let db;
let contestedFindings;

/** The body of every fixture PR: a cross-review history that tells the label. */
const LEAK = "Initial review at abc1234: Not ready, 2 blocking points, fixed in def5678.";

/** A desk thread `T<n>` (session n) that names `refs`; its brief is the task of its first message, or none. */
function addThread(n, refs, brief = `Brief of ${refs[0]}.`) {
    threads[`T${n}`] = {
        id: `T${n}`,
        session: n,
        prs: Object.fromEntries(refs.map((ref) => [ref, {}])),
    };
    messages[n] = brief === null ? "A message with no wrapper marker." : wrapped(brief);
}

/** 1 PR with blocking points: `notReady` heads, a final head, a base; a diff for each head. */
function addPr(repo, number, { notReady = [`${number}a`], merged = true, big = false } = {}) {
    const ref = `${repo}#${number}`;
    const base = sha(`b${number}`);
    const head = sha(`f${number}`);

    prs[ref] = {
        state: merged ? "MERGED" : "OPEN",
        headRefOid: head,
        baseRefOid: base,
        mergeCommit: { oid: sha(`m${number}`) },
        title: `PR ${number}`,
        body: `${LEAK} Body of ${ref}.`,
    };

    for (const h of [...notReady.map(sha), head]) {
        diffs[`${repo}@${base}...${h}`] = big
            ? `diff --git a/x b/x\n${"+y\n".repeat(DIFF_LIMIT)}`
            : `diff --git a/f b/f\n+${ref} at ${h}\n`;
    }

    addThread(number, [ref]);

    return notReady.map((n) => ({ ref, head: sha(n), state: "merged", item: "1" }));
}

/** Write a findings file of `points`; returns its path. */
function writeFindings(name, points) {
    const dir = join(root, "reports", `${name}-daily-audit`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "findings.json"),
        JSON.stringify({ metrics: { Q1: { blockers: { points } } } }),
    );

    return join(dir, "findings.json");
}

before(() => {
    root = mkdtempSync(join(tmpdir(), "bench-calibration-"));

    const day1 = [];
    const day2 = [];
    let n = 100;

    // Each owner: 10 PRs in its bench repositories; the first has 2 Not-ready heads and a big diff.
    for (const owner of OWNERS) {
        const repos = reposOf(owner);

        for (let i = 0; i < 10; i += 1) {
            n += 1;

            const points = addPr(repos[i % repos.length], n, {
                notReady: i === 0 ? [`${n}a`, `${n}c`] : [`${n}a`],
                big: i === 0,
            });

            (i % 2 ? day1 : day2).push(...points);
        }
    }

    // Other repositories: 25 PRs for the development set, and PRs that give no pair.
    for (let i = 0; i < 25; i += 1) {
        n += 1;
        day1.push(...addPr("frostyard/snosi", n));
    }

    n += 1;
    addPr("frostyard/snosi", n);
    // A point at the final head gives no Not-ready head; a PR open on GitHub gives none; an open point is skipped.
    day2.push({ ref: `frostyard/snosi#${n}`, head: sha(`f${n}`), state: "merged" });
    n += 1;
    day2.push(...addPr("frostyard/snosi", n, { merged: false }));
    day2.push({ ref: "frostyard/snosi#999", head: sha("z"), state: "open" });
    // The same point in 2 files counts once.
    day2.push(day1[0]);

    findings.push(writeFindings("2026-11-01", day1), writeFindings("2026-11-02", day2));

    // PRs that the desk does not give a brief for: named by 2 threads, named by a thread with 2 PRs, or by a thread
    // with no brief. Their points are in a findings file of their own (the "only eligible" test).
    const contested = [];

    for (const number of [900, 901, 902, 903, 904]) {
        contested.push(...addPr("frostyard/snosi", number));
    }

    addThread(905, ["frostyard/snosi#900"], "A second thread on #900.");
    addThread(901, ["frostyard/snosi#901", "frostyard/snosi#999"]);
    addThread(903, ["frostyard/snosi#903"], null);
    contestedFindings = writeFindings("2026-11-03", contested);
    db = makePocketDb(join(root, "pocket.sqlite"), { threads, messages });
});

after(() => rm(root, { recursive: true, force: true }));

/** Build into `out`; returns the exit code, the logs and a reader of the files as JSON. */
async function run(out, { gh = fakeGh({ prs, diffs }), files = findings } = {}) {
    const logs = [];
    const code = await calibrationMain(
        [...files.flatMap((f) => ["--findings", f]), "--out", out, "--db", db],
        process.env,
        { gh, log: (line) => logs.push(line), print: () => {} },
    );

    return { code, logs, gh, read: (path) => JSON.parse(readFileSync(join(out, path), "utf8")) };
}

/** Build into `out`; returns the exit code and the files as JSON. */
async function build(out, gh) {
    const { code, logs, read } = await run(out, { gh });

    return {
        code,
        logs,
        gh: gh ?? null,
        heldOut: Object.fromEntries(OWNERS.map((o) => [o, read(join("held-out", `${o}.json`))])),
        key: read("held-out-key.json").key,
        dev: read("dev.json").items,
    };
}

test("points: the union of the files, 1 per ref@head, merged only", async () => {
    const points = await loadPoints(findings);

    assert.equal(points.get(`${reposOf("sheeana")[0]}#101`).length, 2);
    assert.equal(points.has("frostyard/snosi#999"), false);
});

test("8 blind held-out diffs per owner, 4 Not-ready and 4 merged; 20 development pairs from other PRs", async () => {
    const out = join(root, "out");
    const gh = fakeGh({ prs, diffs });
    const { code, heldOut, key, dev, logs } = await build(out, gh);

    assert.equal(code, 0, logs.join("\n"));

    const heldPrs = new Set();

    for (const owner of OWNERS) {
        const { items } = heldOut[owner];
        const repos = new Set(reposOf(owner));

        assert.equal(items.length, 8, owner);
        assert.equal(new Set(items.map((i) => i.pr)).size, 8, `${owner}: 8 different PRs`);

        for (const item of items) {
            assert.deepEqual(Object.keys(item).sort(), [
                "brief",
                "briefSource",
                "diff",
                "diffCut",
                "id",
                "label",
                "pr",
                "repo",
                "thread",
            ]);
            assert.equal(item.label, null);
            assert.ok(repos.has(item.repo), `${item.repo} is ${owner}'s`);
            assert.equal(item.brief, `Brief of ${item.pr}.`, "the thread's brief");
            assert.equal(item.thread, `T${item.pr.split("#")[1]}`);
            assert.equal(item.briefSource, "delegation");
            assert.doesNotMatch(JSON.stringify(item), /Initial review|Not ready|Body of/);
            heldPrs.add(item.pr);
        }

        const labels = items.map((i) => key[i.id].label);

        assert.equal(labels.filter((l) => l === "notReady").length, 4, owner);
        assert.equal(labels.filter((l) => l === "merged").length, 4, owner);

        for (const item of items) {
            const { label, head } = key[item.id];
            const pr = prs[item.pr];

            assert.equal(label === "merged", head === pr.headRefOid);
            assert.ok(item.diff.includes(`at ${head}`) || item.diffCut);
        }
    }

    assert.equal(Object.keys(key).length, 40);
    assert.equal(dev.length, 20);

    for (const pair of dev) {
        assert.equal(heldPrs.has(pair.pr), false, `${pair.pr} is also held out`);
        assert.equal(pair.base, prs[pair.pr].baseRefOid, "1 base for both diffs");
        assert.equal(pair.mergedHead, prs[pair.pr].headRefOid);
        assert.notEqual(pair.notReadyHead, pair.mergedHead);
        assert.equal(pair.brief, `Brief of ${pair.pr}.`, "the thread's brief");
        assert.equal(pair.thread, `T${pair.pr.split("#")[1]}`);
        assert.equal(pair.briefSource, "delegation");
        assert.doesNotMatch(JSON.stringify(pair), /Initial review|Body of/);
        assert.match(pair.notReadyDiff, new RegExp(`at ${pair.notReadyHead}`));
        assert.match(pair.mergedDiff, new RegExp(`at ${pair.mergedHead}`));
    }

    assert.ok(
        gh.calls.every(
            (args) =>
                (args[0] === "pr" && args[1] === "view") ||
                (args[0] === "api" && args[2] === "Accept: application/vnd.github.diff"),
        ),
        "gh only reads",
    );

    // Private files and folders.
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, "held-out")).mode & 0o777, 0o700);

    for (const file of [
        "dev.json",
        "held-out-key.json",
        ...readdirSync(join(out, "held-out")).map((f) => join("held-out", f)),
    ]) {
        assert.equal(statSync(join(out, file)).mode & 0o777, 0o600, file);
    }
});

test("a diff over 60,000 characters is cut with a stat", async () => {
    const { heldOut, dev } = await build(join(root, "cut"));
    const cut = [
        ...Object.values(heldOut).flatMap((h) => h.items.map((i) => [i.diffCut, i.diff])),
        ...dev.map((d) => [d.mergedCut, d.mergedDiff]),
    ].filter(([c]) => c);

    assert.ok(cut.length > 0, "a big diff is in the sets");

    for (const [, diff] of cut) {
        assert.match(diff, /^ x \| \+\d+ -0\n 1 files changed/);
        assert.ok(diff.length <= DIFF_LIMIT + 200);
    }
});

test("only a PR whose 1 thread names only it, with a brief, is chosen; the PR body is never the brief", async () => {
    const briefs = threadBriefs(
        Object.values(threads).map((t) => ({
            id: t.id,
            prs: Object.keys(t.prs),
            brief: messages[t.session].includes("Task from") ? "b" : null,
            briefSource: "delegation",
        })),
    );

    assert.equal(briefs.has("frostyard/snosi#900"), false, "named by 2 threads");
    assert.equal(briefs.has("frostyard/snosi#901"), false, "its thread names 2 PRs");
    assert.equal(briefs.has("frostyard/snosi#903"), false, "its thread has no brief");
    assert.equal(briefs.get("frostyard/snosi#902").thread, "T902");

    // Only #902 and #904 can give a pair, though GitHub has all 5 merged with a diff for each head.
    const { code, read, gh } = await run(join(root, "contested"), { files: [contestedFindings] });

    assert.equal(code, 0);
    assert.deepEqual(
        read("dev.json")
            .items.map((p) => [p.pr, p.thread, p.brief])
            .sort(),
        [
            ["frostyard/snosi#902", "T902", "Brief of frostyard/snosi#902."],
            ["frostyard/snosi#904", "T904", "Brief of frostyard/snosi#904."],
        ],
    );
    assert.ok(
        gh.calls.every((args) => !/^(900|901|903)$/.test(args[2])),
        "no gh call for a PR with no thread brief",
    );
});

test("a held-out set with owner labels in --out is never written over", async () => {
    const out = join(root, "labelled");

    assert.equal((await run(out)).code, 0);
    // A second build over unlabelled sets is fine.
    assert.equal((await run(out)).code, 0);

    const file = join(out, "held-out", `${OWNERS[0]}.json`);
    const labelled = JSON.parse(readFileSync(file, "utf8"));

    labelled.items[3].label = "fail";
    writeFileSync(file, JSON.stringify(labelled));

    const before = Object.fromEntries(
        ["dev.json", "held-out-key.json", join("held-out", `${OWNERS[0]}.json`)].map((f) => [
            f,
            readFileSync(join(out, f), "utf8"),
        ]),
    );
    const gh = fakeGh({ prs, diffs });
    const { code, logs } = await run(out, { gh });

    assert.equal(code, 1);
    assert.match(
        logs.join("\n"),
        new RegExp(
            `refused: .*holds owner labels \\(${OWNERS[0]}\\.json: ${labelled.items[3].id}\\)`,
        ),
    );
    assert.equal(gh.calls.length, 0, "refused before any gh call");

    for (const [f, text] of Object.entries(before)) {
        assert.equal(readFileSync(join(out, f), "utf8"), text, `${f} is unchanged`);
    }
});

test("the same seed gives the same files", async () => {
    await build(join(root, "a"));
    await build(join(root, "b"));

    for (const file of [
        "dev.json",
        "held-out-key.json",
        ...OWNERS.map((o) => join("held-out", `${o}.json`)),
    ]) {
        assert.equal(
            readFileSync(join(root, "a", file), "utf8"),
            readFileSync(join(root, "b", file), "utf8"),
            file,
        );
    }
});

test("an owner with fewer PRs gets fewer items and a warning", async () => {
    const teg = new Set(reposOf("teg").map((r) => `${r}#`));
    const few = Object.fromEntries(
        Object.entries(prs).map(([ref, pr]) =>
            // Only 3 of Teg's PRs stay merged.
            [...teg].some((p) => ref.startsWith(p)) && Number(ref.split("#")[1]) >= 144
                ? [ref, { ...pr, state: "CLOSED" }]
                : [ref, pr],
        ),
    );
    const { heldOut, key, logs } = await build(join(root, "few"), fakeGh({ prs: few, diffs }));
    const items = heldOut.teg.items;

    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => key[i.id].label).sort(), ["merged", "notReady", "notReady"]);
    assert.ok(logs.some((line) => /warning: teg: 3 held-out diffs, not 8/.test(line)));
    assert.ok(BENCH_REPOS.length > 0);
});
