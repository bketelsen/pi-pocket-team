// The judge calibration sets: from fixture findings files and a fake gh, 8 blind held-out diffs per owner (4 at a
// Not-ready head, 4 at the merged head), a separate key, 20 development pairs from other PRs, private files, and
// the same output for the same seed. No network.
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
import { calibrationMain, loadPoints } from "./lib/calibration.mjs";
import { DIFF_LIMIT } from "./lib/judge.mjs";
import { BENCH_REPOS, OWNERS, reposOf } from "./lib/owners.mjs";
import { fakeGh } from "./fixtures/harvest.mjs";

let root;
const sha = (seed) => seed.repeat(40).slice(0, 40);
const prs = {};
const diffs = {};
const findings = [];

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
        body: `Body of ${ref}.`,
    };

    for (const h of [...notReady.map(sha), head]) {
        diffs[`${repo}@${base}...${h}`] = big
            ? `diff --git a/x b/x\n${"+y\n".repeat(DIFF_LIMIT)}`
            : `diff --git a/f b/f\n+${ref} at ${h}\n`;
    }

    return notReady.map((n) => ({ ref, head: sha(n), state: "merged", item: "1" }));
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

    const write = (name, points) => {
        const dir = join(root, "reports", `${name}-daily-audit`);

        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "findings.json"),
            JSON.stringify({ metrics: { Q1: { blockers: { points } } } }),
        );
        findings.push(join(dir, "findings.json"));
    };

    write("2026-11-01", day1);
    write("2026-11-02", day2);
});

after(() => rm(root, { recursive: true, force: true }));

/** Build into `out`; returns the exit code and the files as JSON. */
async function build(out, gh = fakeGh({ prs, diffs })) {
    const logs = [];
    const code = await calibrationMain(
        [...findings.flatMap((f) => ["--findings", f]), "--out", out],
        process.env,
        { gh, log: (line) => logs.push(line), print: () => {} },
    );
    const read = (path) => JSON.parse(readFileSync(join(out, path), "utf8"));

    return {
        code,
        logs,
        gh,
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
    const { code, heldOut, key, dev, gh, logs } = await build(out);

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
                "diff",
                "diffCut",
                "id",
                "label",
                "pr",
                "repo",
            ]);
            assert.equal(item.label, null);
            assert.ok(repos.has(item.repo), `${item.repo} is ${owner}'s`);
            assert.match(item.brief, /^PR \d+\n\nBody of /);
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
