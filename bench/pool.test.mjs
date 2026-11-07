// The pool gate on fixture manifests in a temp folder (never the real ~/agents data): the rank, calibration, the
// stage 1 quotas, fills and owner balance, R, the frozen file (--grow, --check) and the input errors.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BENCH_REPOS, OWNERS } from "./lib/owners.mjs";
import {
    STRATA,
    buildPool,
    pickStage1,
    poolMain,
    poolTasks,
    rankTasks,
    stage1Quotas,
} from "./lib/pool.mjs";

const KEPT = { keep: true, reason: "fixture", scopeMatches: true, commandsConfirmed: true };
const DROPPED = { keep: false, reason: "fixture", scopeMatches: false, commandsConfirmed: false };
const SIZE = { small: 10, medium: 100, large: 500 };
const PILOT_PR = "bketelsen/pi-pocket-team#127";

const nameOf = (repo) => repo.split("/")[1];

/** Tasks of 1 repository: `n` of each stratum given, ids `<name>-<s|m|l><i>`. */
function repoTasks(repo, { small = 0, medium = 0, large = 0, dropped = 0 } = {}) {
    const tasks = [];

    for (const [stratum, count] of Object.entries({ small, medium, large })) {
        for (let i = 1; i <= count; i++) {
            const id = `${nameOf(repo)}-${stratum[0]}${i}`;

            tasks.push({
                id,
                repo,
                pr: `${repo}#${id}`,
                size: SIZE[stratum],
                features: {},
                owner: KEPT,
            });
        }
    }

    for (let i = 1; i <= dropped; i++) {
        const id = `${nameOf(repo)}-x${i}`;

        tasks.push({ id, repo, pr: `${repo}#${id}`, size: 20, features: {}, owner: DROPPED });
    }

    return tasks;
}

/** A temp root with `agents/<owner>/bench/<name>.json` for each bench repository, and `bench/pilot.json`. */
function makeRoot(spec) {
    const root = mkdtempSync(join(tmpdir(), "bench-pool-"));

    writeManifests(root, spec);
    mkdirSync(join(root, "bench"), { recursive: true });
    writeFileSync(
        join(root, "bench", "pilot.json"),
        JSON.stringify({ tasks: [{ id: "pilot-small", pr: PILOT_PR }] }),
    );

    return root;
}

function writeManifests(root, spec) {
    for (const entry of BENCH_REPOS) {
        const dir = join(root, "agents", entry.owner, "bench");
        const extra = spec[entry.repo] ?? {};
        const tasks = Array.isArray(extra) ? extra : repoTasks(entry.repo, extra);

        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, `${nameOf(entry.repo)}.json`),
            JSON.stringify({ repo: entry.repo, tasks }),
        );
    }
}

function run(root, argv = []) {
    const out = [];
    const err = [];
    const code = poolMain(argv, {
        root,
        home: root,
        log: (l) => out.push(l),
        error: (l) => err.push(l),
    });

    return { code, out: out.join("\n"), err: err.join("\n") };
}

const readPool = (root, file = "bench/pool-v1.json") =>
    JSON.parse(readFileSync(join(root, file), "utf8"));

/** Every bench repository with 2 tasks of each stratum, and 1 dropped task each: 54 kept. */
const FULL = Object.fromEntries(
    BENCH_REPOS.map((e) => [e.repo, { small: 2, medium: 2, large: 2, dropped: 1 }]),
);

/** The rank of every kept task of a spec, as the pool computes it. */
const specRank = (spec) =>
    rankTasks(
        poolTasks(
            BENCH_REPOS.map((e) => ({
                file: e.repo,
                json: {
                    tasks: Array.isArray(spec[e.repo])
                        ? spec[e.repo]
                        : repoTasks(e.repo, spec[e.repo]),
                },
            })),
        ).tasks,
    );

const allIds = (pool) => [...pool.calibration.ids, ...pool.stage1.ids, ...pool.stage2.ids];

test("the pool is deterministic, its sets are disjoint and cover every kept task, and dropped tasks are in none", () => {
    const root = makeRoot(FULL);

    try {
        const a = run(root, ["--out", "a.json"]);
        const b = run(root, ["--out", "b.json"]);

        assert.equal(a.code, 0, a.err);
        assert.equal(b.code, 0, b.err);
        assert.equal(
            readFileSync(join(root, "a.json"), "utf8"),
            readFileSync(join(root, "b.json"), "utf8"),
        );

        const pool = readPool(root, "a.json");
        const ids = allIds(pool);

        assert.equal(new Set(ids).size, ids.length);
        assert.equal(ids.length, 54);
        assert.equal(pool.counts.kept, 54);
        assert.ok(!ids.some((id) => id.includes("-x")), "a dropped task is in a set");
        // Calibration: 3 per owner except Sheeana, 1 per stratum, 2 held-out then 1 dev.
        assert.equal(pool.calibration.ids.length, 12);
        assert.equal(pool.calibration.owners.sheeana, undefined);

        for (const owner of ["irulan", "lucilla", "duncan", "teg"]) {
            const o = pool.calibration.owners[owner];

            assert.equal(o.heldOut.length, 2);
            assert.equal(o.dev.length, 1);
            assert.equal(o.short, 0);
            const strata = [...o.heldOut, ...o.dev].map((id) => id.split("-").pop()[0]).sort();

            assert.deepEqual(strata, ["l", "m", "s"], owner);
        }

        // Stage 1: 42 left, so 12 per stratum and no fill; R the 6 others, in rank order.
        assert.equal(pool.stage1.status, "ready");
        assert.deepEqual(pool.stage1.byStratum, { small: 12, medium: 12, large: 12 });
        assert.deepEqual(pool.stage1.fills, []);
        assert.ok(Array.isArray(pool.stage1.swaps));
        assert.equal(pool.stage2.ids.length, 6);
        const rank = specRank(FULL).map((t) => t.id);

        assert.deepEqual(
            pool.stage2.ids,
            rank.filter((id) => pool.stage2.ids.includes(id)),
        );
        // No absolute home path in the file.
        assert.equal(pool.inputs[0].file, "~/agents/sheeana/bench/pi-pocket-team.json");
        assert.ok(!readFileSync(join(root, "a.json"), "utf8").includes(root));
        assert.match(a.out, /\| stage 2 \(R\) \| 6 \|/);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("a stratum with fewer than 12 after calibration gives all, and medium fills it", () => {
    const spec = Object.fromEntries(BENCH_REPOS.map((e) => [e.repo, {}]));

    spec["bketelsen/pi-pocket-team"] = { small: 2, medium: 10, large: 10 };

    for (const repo of [
        "frostyard/frostmail",
        "frostyard/updex",
        "frostyard/nsl",
        "bketelsen/fleet",
    ]) {
        spec[repo] = { small: 1, medium: 4, large: 4 };
    }

    const root = makeRoot(spec);

    try {
        assert.equal(run(root).code, 0);
        const pool = readPool(root);

        // 58 kept, 12 to calibration (4 per stratum): small 2, medium 22, large 22 left. Small's deficit of 10 comes
        // from medium's spare of 10.
        assert.deepEqual(pool.stage1.fills, [{ to: "small", from: "medium", count: 10 }]);
        assert.deepEqual(pool.stage1.byStratum, { small: 2, medium: 22, large: 12 });
        assert.equal(pool.counts.stage1, 36);
        assert.deepEqual(pool.stage2.byStratum, { small: 0, medium: 0, large: 10 });
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("the quotas: small then large fill from medium, then medium from large, each from the spare left", () => {
    assert.deepEqual(stage1Quotas({ small: 5, medium: 15, large: 30 }), {
        quota: { small: 5, medium: 15, large: 12 },
        fills: [{ to: "small", from: "medium", count: 3 }],
    });
    assert.deepEqual(stage1Quotas({ small: 20, medium: 4, large: 30 }), {
        quota: { small: 12, medium: 4, large: 20 },
        fills: [{ to: "medium", from: "large", count: 8 }],
    });
    // Small takes medium's spare first; large gets what is left.
    assert.deepEqual(stage1Quotas({ small: 8, medium: 18, large: 9 }), {
        quota: { small: 8, medium: 18, large: 9 },
        fills: [
            { to: "small", from: "medium", count: 4 },
            { to: "large", from: "medium", count: 2 },
        ],
    });
});

test("calibration: an owner with 2 tasks gives 2 held-out and no dev, an owner with none is short 3", () => {
    const spec = { ...FULL };

    spec["bketelsen/fleet"] = { small: 1, medium: 1 };
    spec["frostyard/frostmail"] = {};
    spec["frostyard/lodge"] = {};
    spec["frostyard/porter"] = {};
    const root = makeRoot(spec);

    try {
        assert.equal(run(root).code, 0);
        const pool = readPool(root);
        const teg = pool.calibration.owners.teg;
        const rank = specRank(spec)
            .filter((t) => t.owner === "teg")
            .map((t) => t.id);

        assert.deepEqual(teg, { heldOut: rank, dev: [], short: 1 });
        assert.deepEqual(pool.calibration.owners.irulan, { heldOut: [], dev: [], short: 3 });
        assert.match(run(root, ["--check"]).out, /Calibration short: irulan 3, teg 1/);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("calibration: an owner with no task in a stratum fills up to 3 from its next best-ranked tasks", () => {
    const spec = { ...FULL };

    // Lucilla: no large task at all.
    spec["frostyard/updex"] = { small: 2, medium: 2 };
    spec["frostyard/core"] = { small: 1, medium: 1 };
    const root = makeRoot(spec);

    try {
        assert.equal(run(root).code, 0);
        const pool = readPool(root);
        const lucilla = pool.calibration.owners.lucilla;
        const ranked = specRank(spec).filter((t) => t.owner === "lucilla");
        const bestSmall = ranked.find((t) => t.stratum === "small").id;
        const bestMedium = ranked.find((t) => t.stratum === "medium").id;
        const third = ranked.find((t) => t.id !== bestSmall && t.id !== bestMedium).id;
        const picked = ranked
            .map((t) => t.id)
            .filter((id) => [bestSmall, bestMedium, third].includes(id));

        assert.deepEqual(lucilla, { heldOut: picked.slice(0, 2), dev: [picked[2]], short: 0 });
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("stage 1 waits under 30 tasks left, and takes every task left from 30 to 36", () => {
    const repos = ["frostyard/frostmail", "frostyard/updex", "frostyard/nsl", "bketelsen/fleet"];

    const specWith = (sheeana) => {
        const spec = Object.fromEntries(BENCH_REPOS.map((e) => [e.repo, {}]));

        for (const repo of repos) {
            spec[repo] = { small: 1, medium: 1, large: 1 };
        }

        spec["bketelsen/pi-pocket-team"] = sheeana;

        return spec;
    };

    // 12 calibration tasks, then 29 left: wait.
    let root = makeRoot(specWith({ small: 10, medium: 10, large: 9 }));

    try {
        assert.equal(run(root).code, 0);
        const pool = readPool(root);

        assert.deepEqual(
            { status: pool.stage1.status, ids: pool.stage1.ids },
            { status: "wait", ids: [] },
        );
        assert.equal(pool.counts.stage2, 29);
    } finally {
        rmSync(root, { recursive: true });
    }

    // 33 left, unbalanced (small 20, medium 10, large 3; the quotas would take only 25): all to stage 1, R empty.
    root = makeRoot(specWith({ small: 20, medium: 10, large: 3 }));

    try {
        assert.equal(run(root).code, 0);
        const pool = readPool(root);

        assert.equal(pool.stage1.status, "ready");
        assert.equal(pool.counts.stage1, 33);
        assert.deepEqual(pool.stage2.ids, []);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("stage 1 owner balance: the owner with the fewest so far first; owners outside 6 to 8 are listed", () => {
    // In rank order: Sheeana's 25 tasks first, then Irulan 3, and Lucilla, Duncan and Teg 7 each; strata in turn.
    const owners = [
        ...Array(25).fill("sheeana"),
        ...Array(3).fill("irulan"),
        ...["lucilla", "duncan", "teg"].flatMap((o) => Array(7).fill(o)),
    ];
    const left = owners.map((owner, i) => ({
        id: `t${String(i).padStart(2, "0")}`,
        owner,
        stratum: STRATA[i % 3],
    }));
    const stage1 = pickStage1(left);
    const count = (o) =>
        stage1.ids.filter((id) => left.find((t) => t.id === id).owner === o).length;

    assert.equal(stage1.ids.length, 36);
    assert.deepEqual(Object.fromEntries(OWNERS.map((o) => [o, count(o)])), {
        sheeana: 12,
        irulan: 3,
        lucilla: 7,
        duncan: 7,
        teg: 7,
    });

    // Through the whole pool: byOwner and outsideRange.
    const tasks = left.map((t) => ({
        ...t,
        repo: BENCH_REPOS.find((e) => e.owner === t.owner).repo,
        size: SIZE[t.stratum],
    }));
    const pool = buildPool(tasks);
    const s1 = pool.stage1;

    assert.equal(s1.ids.length, 36);
    assert.deepEqual(
        s1.outsideRange,
        OWNERS.filter((o) => s1.byOwner[o] < 6 || s1.byOwner[o] > 8),
    );
    assert.ok(s1.outsideRange.length > 0);
});

test("stage 1 swap pass: the greedy leaves sheeana 11 and teg 4; swaps inside a stratum bring every owner to 6 to 8", () => {
    // In rank order: blocks of [owner, stratum, count], ids t00, t01, ...
    const blocks = [
        ["sheeana", "large", 10],
        ["duncan", "large", 6],
        ["sheeana", "small", 10],
        ["sheeana", "medium", 10],
        ["teg", "large", 8],
        ["duncan", "small", 2],
        ["irulan", "small", 4],
        ["irulan", "medium", 3],
        ["lucilla", "small", 4],
        ["lucilla", "medium", 4],
    ];
    const left = blocks
        .flatMap(([owner, stratum, n]) => Array.from({ length: n }, () => ({ owner, stratum })))
        .map((t, i) => ({ ...t, id: `t${String(i).padStart(2, "0")}` }));
    const counts = (ids) =>
        Object.fromEntries(
            OWNERS.map((o) => [
                o,
                ids.filter((id) => left.find((t) => t.id === id).owner === o).length,
            ]),
        );
    const strata = (ids) =>
        Object.fromEntries(
            STRATA.map((s) => [
                s,
                ids.filter((id) => left.find((t) => t.id === id).stratum === s).length,
            ]),
        );
    const greedy = pickStage1(left, { swap: false });

    assert.deepEqual(counts(greedy.ids), { sheeana: 11, irulan: 7, lucilla: 8, duncan: 6, teg: 4 });

    const stage1 = pickStage1(left);

    assert.deepEqual(counts(stage1.ids), { sheeana: 7, irulan: 7, lucilla: 8, duncan: 7, teg: 7 });
    // Sheeana's worst-ranked selected large task out, the low owner's best-ranked unselected large task in; a tie
    // between duncan and teg (6 each) goes to duncan, the earlier owner.
    assert.deepEqual(stage1.swaps, [
        { out: "t03", in: "t40", stratum: "large" },
        { out: "t02", in: "t41", stratum: "large" },
        { out: "t01", in: "t14", stratum: "large" },
        { out: "t00", in: "t42", stratum: "large" },
    ]);
    // The stratum counts stay the same.
    assert.deepEqual(strata(stage1.ids), strata(greedy.ids));
});

test("the frozen file: a changed pool exits 1 without --grow; --grow appends new tasks to R only; --check", () => {
    const root = makeRoot(FULL);

    try {
        assert.equal(run(root).code, 0);
        const before = readFileSync(join(root, "bench/pool-v1.json"), "utf8");
        const old = JSON.parse(before);

        assert.equal(run(root, ["--check"]).code, 0);
        assert.match(run(root).out, /Unchanged/);

        // 2 new kept tasks in fleet.
        const spec = { ...FULL, "bketelsen/fleet": { small: 3, medium: 3, large: 2, dropped: 1 } };

        writeManifests(root, spec);
        const refused = run(root);

        assert.equal(refused.code, 1);
        assert.match(refused.err, /frozen once written/);
        assert.equal(readFileSync(join(root, "bench/pool-v1.json"), "utf8"), before);
        assert.equal(run(root, ["--check"]).code, 1);
        assert.equal(readFileSync(join(root, "bench/pool-v1.json"), "utf8"), before);

        assert.equal(run(root, ["--grow"]).code, 0);
        const grown = readPool(root);

        assert.deepEqual(grown.calibration, old.calibration);
        assert.deepEqual(grown.stage1, old.stage1);
        assert.deepEqual(grown.stage2.ids.slice(0, old.stage2.ids.length), old.stage2.ids);
        assert.deepEqual(grown.stage2.ids.slice(old.stage2.ids.length).sort(), [
            "fleet-m3",
            "fleet-s3",
        ]);
        assert.deepEqual(grown.stage2.rounds, [
            { added: grown.stage2.ids.slice(old.stage2.ids.length) },
        ]);
        assert.equal(grown.counts.kept, 56);
        // A grown file is current: a plain run and --check leave it.
        assert.equal(run(root).code, 0);
        assert.equal(run(root, ["--check"]).code, 0);

        // A pool task that is no longer kept is an error.
        const gone = repoTasks("bketelsen/fleet", spec["bketelsen/fleet"]).map((t) =>
            t.id === "fleet-s1" ? { ...t, owner: DROPPED } : t,
        );

        writeManifests(root, { ...spec, "bketelsen/fleet": gone });
        const removed = run(root, ["--grow"]);

        assert.equal(removed.code, 1);
        assert.match(removed.err, /no longer kept/);

        rmSync(join(root, "bench/pool-v1.json"));
        assert.equal(run(root, ["--check"]).code, 1);
        assert.equal(existsSync(join(root, "bench/pool-v1.json")), false);
    } finally {
        rmSync(root, { recursive: true });
    }
});

test("input errors: a pilot PR, a repeated id, a task of no bench repository, a missing manifest", () => {
    const cases = [
        [
            "bketelsen/pi-pocket-team",
            [{ ...repoTasks("bketelsen/pi-pocket-team", { small: 1 })[0], pr: PILOT_PR }],
            /pilot PR bketelsen\/pi-pocket-team#127/,
        ],
        [
            "bketelsen/fleet",
            [
                ...repoTasks("bketelsen/fleet", { small: 1 }),
                { ...repoTasks("frostyard/nsl", { small: 1 })[0], id: "fleet-s1" },
            ],
            /task id fleet-s1 repeats/,
        ],
        [
            "bketelsen/fleet",
            [{ ...repoTasks("bketelsen/fleet", { small: 1 })[0], repo: "someone/else" }],
            /no bench repository/,
        ],
    ];

    for (const [repo, tasks, error] of cases) {
        const root = makeRoot({ ...FULL, [repo]: tasks });

        try {
            const r = run(root);

            assert.equal(r.code, 1);
            assert.match(r.err, error);
            assert.equal(existsSync(join(root, "bench/pool-v1.json")), false);
        } finally {
            rmSync(root, { recursive: true });
        }
    }

    // A repeated id across 2 files.
    const root = makeRoot(FULL);

    try {
        writeFileSync(
            join(root, "agents/teg/bench/fleet.json"),
            JSON.stringify({ tasks: repoTasks("frostyard/nsl", { small: 1 }) }),
        );
        assert.match(run(root).err, /task id nsl-s1 repeats/);
        rmSync(join(root, "agents/teg/bench/fleet.json"));
        assert.match(run(root).err, /~\/agents\/teg\/bench\/fleet.json does not exist/);
        // --manifest replaces the default list.
        const r = run(root, ["--manifest", "~/agents/duncan/bench/nsl.json"]);

        assert.equal(r.code, 0, r.err);
        assert.equal(readPool(root).counts.kept, 6);
    } finally {
        rmSync(root, { recursive: true });
    }
});
