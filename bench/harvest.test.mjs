// The harvester: candidates from a fixture Pocket database, the briefs, the size strata and the cap, the order of
// night shifts and other delegations, a validation of a fixture PR behind the fake bwrap (hidden tests kept and
// dropped), the written manifest, the validation cache, and `--revalidate`. No network and no real gh.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    PER_STRATUM,
    PR_FIELDS,
    TOO_MANY_COMMITS,
    VALIDATION_VERSION,
    commandsAt,
    goModulesAt,
    parentOf,
    revalidateTask,
    validateCandidate,
    validationKey,
    harvest,
    harvestRepo,
    selectCandidates,
    stratumOf,
    stratumOrder,
} from "./lib/harvest.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { commandMsOf, readRoster, repositoriesOf, seededShuffle } from "./lib/owners.mjs";
import { COMMAND_MS } from "./lib/exec.mjs";
import { delegationTask, goalBrief, readThreads } from "./lib/pocket.mjs";
import { FAKE_BWRAP, git, makeFixture, runScript, testEnv } from "./fixtures/helpers.mjs";
import {
    fakeGh,
    makeExtraRepo,
    makeMergeShapes,
    makeNestedGoRepo,
    makeNodeRepo,
    makePocketDb,
    makeTrackedRepo,
    wrapped,
} from "./fixtures/harvest.mjs";
import { cleanupTree, removeTree } from "./lib/common.mjs";

const REPO = "bketelsen/pi-pocket-team";
const NOW = Date.UTC(2026, 10, 7, 12, 0);
let fixture;
let node;
let threads;

const route = {
    kind: "implement",
    complexity: 1.5,
    capability: 2,
    deepReasoning: 0.4,
    demand: 1.6,
};

before(() => {
    fixture = makeFixture();
    node = makeNodeRepo(join(fixture.root, "node-repo"));

    const db = makePocketDb(join(fixture.root, "pocket.sqlite"), {
        threads: {
            T1: { id: "T1", session: 101, prs: { [`${REPO}#10`]: { state: "MERGED" } }, route },
            T2: { id: "T2", session: 102, prs: { [`${REPO}#11`]: { state: "MERGED" } } },
            T3: {
                id: "T3",
                session: 103,
                prs: { [`${REPO}#20`]: {}, [`${REPO}#21`]: {} },
            },
            T4: { id: "T4", session: 104, prs: { [`${REPO}#12`]: { state: "OPEN" } } },
            T5: { id: "T5", session: 105, prs: { [`${REPO}#13`]: {} } },
            T6: { id: "T6", session: 106, prs: { [`${REPO}#13`]: {} } },
            T7: { id: "T7", session: 107, prs: { "frostyard/snosi#5": {} } },
            T8: { id: "T8", session: 108, prs: { [`${REPO}#14`]: {} } },
        },
        goals: {
            101: { objective: "Fix the sum in lib.mjs.", stop: "The PR is open." },
        },
        messages: {
            101: wrapped("The delegation of the night shift.", { nightShift: true }),
            102: wrapped("Fix `add` in lib.mjs and add tests.", { nightShift: true }),
            103: wrapped("Two PRs."),
            104: wrapped("Not merged yet."),
            105: wrapped("Shared PR, first."),
            106: wrapped("Shared PR, second."),
            107: wrapped("Not a bench repository."),
            108: "A message with no wrapper marker.",
        },
    });

    threads = readThreads(db);
});

after(() => rm(fixture.root, { recursive: true, force: true }));

test("briefs: a night shift's goal; a delegation's task only, without the wrapper or the night-shift paragraph", () => {
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));

    assert.equal(byId.T1.brief, "Fix the sum in lib.mjs.\n\nStop when: The PR is open.");
    assert.equal(byId.T1.briefSource, "night-shift");
    assert.equal(byId.T1.nightShift, true);
    assert.equal(byId.T2.brief, "Fix `add` in lib.mjs and add tests.");
    assert.equal(byId.T2.briefSource, "delegation");
    assert.equal(byId.T2.nightShift, false);
    assert.equal(byId.T8.brief, null, "no marker line: no brief");
    assert.equal(delegationTask("no marker"), null);
    assert.equal(goalBrief({ objective: "Do it.", stop: "" }), "Do it.");
});

test("candidates: exactly 1 PR in a bench repository, named by no other thread, with a brief", () => {
    const { byRepo, dropped } = selectCandidates(threads);

    assert.deepEqual(
        byRepo.get(REPO).map((c) => [c.thread.id, c.pr]),
        [
            ["T1", `${REPO}#10`],
            ["T2", `${REPO}#11`],
            ["T4", `${REPO}#12`],
        ],
    );
    assert.deepEqual(dropped.get(REPO), [
        { thread: "T3", pr: `${REPO}#20`, reason: "the thread has 2 PRs" },
        { thread: "T3", pr: `${REPO}#21`, reason: "the thread has 2 PRs" },
        { thread: "T5", pr: `${REPO}#13`, reason: "the PR is named by 2 threads" },
        { thread: "T6", pr: `${REPO}#13`, reason: "the PR is named by 2 threads" },
        { thread: "T8", pr: `${REPO}#14`, reason: "the thread has no brief" },
    ]);
    assert.equal(byRepo.has("frostyard/snosi"), false);
});

test("strata: up to 50, 51 to 300, over 300 lines", () => {
    assert.deepEqual([0, 50, 51, 300, 301].map(stratumOf), [
        "small",
        "small",
        "medium",
        "medium",
        "large",
    ]);
});

/** A context for `harvestRepo` with a stubbed validation. */
const stubContext = (gh, validate, extra = {}) => ({
    data: join(fixture.root, `data-${Math.random().toString(36).slice(2)}`),
    now: () => NOW,
    log: () => {},
    gh,
    parallel: 3,
    sinceMs: Date.UTC(2026, 8, 1),
    untilMs: null,
    since: "2026-09-01",
    checkouts: { [REPO]: node.repo },
    validate,
    ...extra,
});

test("night shifts come first in a stratum; delegations fill it only after them; 20 per stratum, no space moved", async () => {
    const list = [];
    const prs = {};

    const add = (n, nightShift, lines) => {
        list.push({
            thread: {
                id: `T${n}`,
                nightShift,
                brief: `task ${n}`,
                briefSource: nightShift ? "night-shift" : "delegation",
                route: null,
            },
            pr: `${REPO}#${n}`,
            number: n,
            repo: REPO,
        });
        prs[`${REPO}#${n}`] = {
            state: "MERGED",
            mergedAt: "2026-10-01T00:00:00Z",
            mergeCommit: { oid: node.merge },
            additions: lines,
            deletions: 0,
        };
    };

    // small: 15 night shifts and 10 delegations; medium: 25 night shifts; large: 3 delegations.
    for (let n = 1; n <= 15; n += 1) {
        add(n, true, 10);
    }

    for (let n = 16; n <= 25; n += 1) {
        add(n, false, 20);
    }

    for (let n = 26; n <= 50; n += 1) {
        add(n, true, 100);
    }

    for (let n = 51; n <= 53; n += 1) {
        add(n, false, 1000);
    }

    // Night shift 3 fails its validation: the next candidate takes its place.
    const validated = [];

    const validate = async (_ctx, c) => {
        validated.push(c.number);

        return c.number === 3
            ? { ok: false, reason: "check failed at the merge (exit 1)", validation: {} }
            : {
                  ok: true,
                  validation: {},
                  fields: {
                      parent: node.parent,
                      setup: "true",
                      check: "true",
                      hiddenTests: [],
                      hiddenCommand: null,
                      features: null,
                  },
              };
    };

    const manifest = await harvestRepo(stubContext(fakeGh({ prs }), validate), REPO, list, []);
    const sizes = (stratum) => manifest.tasks.filter((t) => stratumOf(t.size) === stratum);
    const numbers = (stratum) => sizes(stratum).map((t) => Number(t.pr.split("#")[1]));

    assert.equal(sizes("small").length, PER_STRATUM);
    assert.equal(sizes("medium").length, PER_STRATUM);
    assert.equal(sizes("large").length, 3, "no space moves from another stratum");

    const small = numbers("small");

    assert.deepEqual(
        small.slice(0, 14).sort((a, b) => a - b),
        [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        "every valid night shift first",
    );
    assert.ok(
        small.slice(14).every((n) => n >= 16),
        "then 6 delegations",
    );
    assert.ok(numbers("medium").every((n) => n >= 26 && n <= 50));
    assert.deepEqual(manifest.dropped, [
        { thread: "T3", pr: `${REPO}#3`, reason: "check failed at the merge (exit 1)" },
    ]);
    assert.equal(
        manifest.notValidated.filter((c) => c.stratum === "small").length,
        4,
        "the delegations left over are not validated",
    );
    assert.ok(!validated.some((n) => manifest.notValidated.some((c) => c.pr === `${REPO}#${n}`)));
    assert.equal(manifest.tasks[0].owner.keep, null);

    // The same seed gives the same order.
    const again = await harvestRepo(stubContext(fakeGh({ prs }), validate), REPO, list, []);

    assert.deepEqual(
        again.tasks.map((t) => t.id),
        manifest.tasks.map((t) => t.id),
    );
    assert.deepEqual(
        stratumOrder(list.slice(0, 25))
            .slice(0, 15)
            .every((c) => c.thread.nightShift),
        true,
    );
    assert.deepEqual(seededShuffle([1, 2, 3, 4, 5]), seededShuffle([1, 2, 3, 4, 5]));
});

test("a harvest validates a fixture PR: hidden tests kept and dropped, a manifest that loadManifest reads, a cache", async () => {
    const out = join(fixture.root, "manifests");
    const data = join(fixture.root, "harvest-data");
    const gh = fakeGh({
        prs: {
            [`${REPO}#10`]: {
                state: "MERGED",
                mergedAt: "2026-10-01T10:00:00Z",
                mergeCommit: { oid: node.merge },
                additions: 30,
                deletions: 1,
                files: [],
                headRefOid: "f".repeat(40),
            },
            [`${REPO}#11`]: {
                state: "MERGED",
                mergedAt: "2026-08-01T10:00:00Z",
                mergeCommit: { oid: node.merge },
                additions: 30,
                deletions: 1,
            },
            [`${REPO}#12`]: { state: "OPEN", mergedAt: null, mergeCommit: null },
        },
    });
    const lines = [];
    const ctx = {
        data,
        now: () => NOW,
        log: (line) => lines.push(line),
        gh,
        parallel: 1,
        fetch: false,
        since: "2026-09-01",
        until: null,
        sinceMs: Date.UTC(2026, 8, 1),
        untilMs: null,
        repos: new Set([REPO]),
        out,
        checkouts: { [REPO]: node.repo },
        rosterNames: [REPO],
        hostNames: [],
        sandbox: {
            bwrap: FAKE_BWRAP,
            data,
            pocket: fixture.pocket,
            miseInstalls: join(fixture.root, "no-mise"),
        },
        timeouts: { setup: 60_000, check: 60_000, hidden: 60_000 },
    };
    const [file] = await harvest(ctx, threads);

    assert.equal(file, join(out, "bketelsen", "pi-pocket-team.json"));
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const manifest = await loadManifest(file);
    const [task] = manifest.tasks;

    assert.equal(manifest.tasks.length, 1);
    assert.equal(manifest.checkout, node.repo);
    assert.equal(manifest.generatedAt, new Date(NOW).toISOString());
    assert.equal(task.id, "pi-pocket-team-10");
    assert.equal(task.parent, node.parent);
    assert.equal(task.merge, node.merge);
    assert.equal(task.briefSource, "night-shift");
    assert.equal(task.size, 31);
    assert.equal(task.setup, "PI_POCKET_CHECKOUT=/pocket node link.mjs");
    assert.equal(task.check, "PI_POCKET_CHECKOUT=/pocket make test");
    assert.deepEqual(task.hiddenTests, [
        { file: "add.test.mjs", names: ["adds"] },
        { file: "fixtures/data.json", names: [] },
        { file: "mul.test.mjs", names: [] },
    ]);
    assert.equal(
        task.hiddenCommand,
        "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:adds)$' 'add.test.mjs'",
    );
    assert.equal(task.features.v, 1);
    assert.equal(task.features.kind, "implement", "a night shift's Jev numbers go in");
    assert.equal(task.features.language, "js");
    assert.deepEqual(task.owner, {
        keep: null,
        reason: "",
        scopeMatches: null,
        commandsConfirmed: null,
    });

    const dropped = Object.fromEntries(
        manifest.validation[task.id].hiddenDropped.map((d) => [d.name, d.reason]),
    );

    assert.match(dropped.stable, /passes at the parent/);
    assert.match(dropped.throws, /not fail by an assertion/);
    assert.match(dropped.multiplies, /does not compile or load at the parent/);
    assert.equal(manifest.validation[task.id].hiddenMerge, "pass");
    assert.match(manifest.validation[task.id].hiddenParent, /^exit 1$/);
    assert.match(
        readFileSync(join(data, "harvest-cache", "bketelsen", "pi-pocket-team", "10.log"), "utf8"),
        /^--- hidden command at the parent failed \(exit 1\): the last \d+ lines of its stdout ---\n[\s\S]*\bfail 1\b/m,
        "the failed command's stdout (the test report) is in the log",
    );
    assert.deepEqual(
        manifest.dropped.filter((d) => /window|merged on GitHub/.test(d.reason)).map((d) => d.pr),
        [`${REPO}#11`, `${REPO}#12`],
    );
    assert.ok(gh.calls.every((args) => args[0] === "pr" && args[1] === "view"));

    // A second run uses the validation cache: no command runs again.
    await harvest(ctx, threads);

    const second = await loadManifest(file);

    assert.equal(second.validation[task.id].cached, true);
    assert.deepEqual(second.tasks, manifest.tasks);
});

test("--revalidate runs a file's commands again, writes validation, and keeps the tasks as they are", async () => {
    const source = join(fixture.root, "manifests", "bketelsen", "pi-pocket-team.json");
    const manifest = JSON.parse(readFileSync(source, "utf8"));
    const [task] = manifest.tasks;

    task.owner = { keep: true, reason: "good", scopeMatches: true, commandsConfirmed: true };
    manifest.tasks.push({
        ...task,
        id: "pi-pocket-team-10-bad",
        hiddenCommand: "true",
        owner: { keep: false, reason: "dropped", scopeMatches: false, commandsConfirmed: false },
    });
    // An owner names a test that imports an API the reference made: the hidden command passes at the merge and
    // exits non-zero at the parent, but the test does not load there.
    manifest.tasks.push({
        ...task,
        id: "pi-pocket-team-10-api",
        hiddenTests: [
            { file: "add.test.mjs", names: ["adds"] },
            { file: "fixtures/data.json", names: [] },
            { file: "mul.test.mjs", names: ["multiplies"] },
        ],
        hiddenCommand:
            "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:adds|multiplies)$' 'add.test.mjs' 'mul.test.mjs'",
        owner: { keep: false, reason: "checked", scopeMatches: true, commandsConfirmed: true },
    });
    manifest.validation = {};

    const file = join(fixture.root, "reviewed.json");

    writeFileSync(file, JSON.stringify(manifest));

    const args = ["--revalidate", file, "--bwrap", FAKE_BWRAP, "--pocket", fixture.pocket];
    const env = testEnv(fixture, { BENCH_DATA: join(fixture.root, "reval-data") });
    const first = await runScript("harvest.mjs", args, env);
    const after1 = JSON.parse(readFileSync(file, "utf8"));

    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /^ok {3}pi-pocket-team-10$/m);
    assert.match(
        first.stdout,
        /^FAIL pi-pocket-team-10-bad: the hidden command passes at the parent \(dropped by the owner\)$/m,
    );
    assert.deepEqual(after1.tasks, manifest.tasks, "the tasks and their owner fields stay");
    assert.equal(after1.validation["pi-pocket-team-10"].ok, true);
    assert.equal(after1.validation["pi-pocket-team-10"].hiddenParent, "exit 1");
    assert.match(
        readFileSync(after1.validation["pi-pocket-team-10"].log, "utf8"),
        /^--- hidden command at the parent failed \(exit 1\)/m,
        "the revalidation's log outlives its scratch trees",
    );
    assert.equal(after1.validation["pi-pocket-team-10-bad"].ok, false);
    assert.equal(after1.validation["pi-pocket-team-10-api"].hiddenMerge, "pass");
    assert.equal(after1.validation["pi-pocket-team-10-api"].hiddenParent, "exit 1");
    assert.equal(after1.validation["pi-pocket-team-10-api"].ok, false);
    assert.equal(
        after1.validation["pi-pocket-team-10-api"].reason,
        'hidden test mul.test.mjs "multiplies" does not compile or load at the parent',
    );
    assert.match(
        first.stdout,
        /^FAIL pi-pocket-team-10-api: hidden test mul\.test\.mjs "multiplies"/m,
    );
    assert.equal(after1.validation["pi-pocket-team-10"].hiddenNames, "pass");

    // The owner keeps the bad task: the revalidation fails.
    after1.tasks[1].owner.keep = true;
    writeFileSync(file, JSON.stringify(after1));

    const second = await runScript("harvest.mjs", args, env);

    assert.equal(second.code, 1, second.stdout + second.stderr);
    assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("roster: repositories and checkout folders from the profiles' front matter", () => {
    const dir = join(fixture.root, "roster");

    const write = (name, text) => {
        writeFileSync(join(dir, name), text);
    };

    mkdirSync(dir, { recursive: true });
    write(
        "teg.md",
        "---\nmodel: x\nrepositories:\n  bketelsen/fleet: ~/projects/fleet\n  frostyard/x: /abs/x\nhome: ~/agents/teg\n---\n\n# Teg\n",
    );
    write("teg.md.bak", "---\nrepositories:\n  other/repo: ~/nope\n---\n");
    assert.deepEqual(repositoriesOf("---\nrepositories:\n  a/b: '~/c'\n---\n"), { "a/b": "~/c" });

    const roster = readRoster(dir, "/home/x");

    assert.deepEqual(roster.names, ["bketelsen/fleet", "frostyard/x"]);
    assert.equal(roster.checkouts["bketelsen/fleet"], "/home/x/projects/fleet");
    assert.equal(roster.checkouts["frostyard/x"], "/abs/x");
});

test("--revalidate keeps the reviewed hidden command's settings: a test that needs FEATURE=1 is accepted", async () => {
    const extra = makeExtraRepo(join(fixture.root, "extra-repo"));
    const file = join(fixture.root, "reviewed-extra.json");

    writeFileSync(
        file,
        JSON.stringify({
            schema: 1,
            repo: REPO,
            checkout: extra.repo,
            tasks: [
                {
                    id: "extra-1",
                    repo: REPO,
                    thread: "T1",
                    pr: `${REPO}#1`,
                    parent: extra.parent,
                    merge: extra.merge,
                    brief: "Fix add.",
                    briefSource: "delegation",
                    setup: "PI_POCKET_CHECKOUT=/pocket node link.mjs",
                    check: "true",
                    hiddenTests: [{ file: "feature.test.mjs", names: ["feature"] }],
                    hiddenCommand:
                        "FEATURE=1 PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:feature)$' 'feature.test.mjs'",
                    size: 10,
                    features: null,
                    owner: { keep: true, reason: "", scopeMatches: true, commandsConfirmed: true },
                },
            ],
            validation: {},
        }),
    );

    const result = await runScript(
        "harvest.mjs",
        ["--revalidate", file, "--bwrap", FAKE_BWRAP, "--pocket", fixture.pocket],
        testEnv(fixture, { BENCH_DATA: join(fixture.root, "reval-extra-data") }),
    );
    const entry = JSON.parse(readFileSync(file, "utf8")).validation["extra-1"];

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(entry.ok, true, entry.reason);
    assert.equal(entry.hiddenNames, "pass");
});

test("a scratch tree with a read-only folder and a read-only file (as Go's module cache) is removed", async () => {
    const tree = join(fixture.root, "readonly-tree");
    const deep = join(tree, "cache", "go", "mod@v1");

    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "CONTRIBUTORS"), "x\n");
    chmodSync(join(deep, "CONTRIBUTORS"), 0o444);
    chmodSync(deep, 0o555);
    chmodSync(join(tree, "cache", "go"), 0o555);
    await removeTree(tree);
    assert.equal(existsSync(tree), false);
    await removeTree(tree);

    // A cleanup that cannot remove a path logs it and does not throw.
    const locked = join(fixture.root, "locked");
    const lines = [];

    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o555);

    try {
        await cleanupTree(join(locked, "inner"), (line) => lines.push(line));
        assert.match(lines[0] ?? "", /^cleanup: cannot remove .*inner: /);
    } finally {
        chmodSync(locked, 0o755);
    }
});

test("a candidate whose validation throws is dropped with a reason, and the next candidate is still validated", async () => {
    const prs = {};
    const list = [1, 2].map((n) => {
        prs[`${REPO}#${n}`] = {
            state: "MERGED",
            mergedAt: "2026-10-01T00:00:00Z",
            mergeCommit: { oid: node.merge },
            additions: 10,
            deletions: 0,
        };

        return {
            thread: {
                id: `T${n}`,
                nightShift: true,
                brief: "b",
                briefSource: "night-shift",
                route: null,
            },
            pr: `${REPO}#${n}`,
            number: n,
            repo: REPO,
        };
    });
    const validated = [];
    const manifest = await harvestRepo(
        stubContext(
            fakeGh({ prs }),
            async (_ctx, c) => {
                validated.push(c.number);

                if (validated.length === 1) {
                    throw new Error("EACCES: permission denied, unlink 'x'\nstack");
                }

                return {
                    ok: true,
                    validation: {},
                    fields: {
                        parent: node.parent,
                        setup: "true",
                        check: "true",
                        hiddenTests: [],
                        hiddenCommand: null,
                        features: null,
                    },
                };
            },
            { parallel: 1 },
        ),
        REPO,
        list,
        [],
    );

    assert.equal(validated.length, 2);
    assert.equal(manifest.tasks.length, 1);
    assert.deepEqual(
        manifest.dropped.map((d) => d.reason),
        ["validation error: EACCES: permission denied, unlink 'x'"],
    );
});

test("a cached validation error is never reused: the candidate is validated again", async () => {
    const data = join(fixture.root, "rr5-data");
    const thread = { id: "T77", brief: "Fix add.", route: null, nightShift: false };
    const candidate = {
        repo: REPO,
        number: 77,
        thread,
        checkout: node.repo,
        merge: node.merge,
        parent: node.parent,
    };
    const key = validationKey({
        merge: node.merge,
        parent: node.parent,
        commands: await commandsAt(node.repo, node.merge),
        brief: thread.brief,
        route: null,
    });

    assert.equal(
        VALIDATION_VERSION,
        4,
        "the timeout record (discovery, staging) changed the validation",
    );
    mkdirSync(join(data, "harvest-cache", "bketelsen", "pi-pocket-team"), { recursive: true });
    writeFileSync(
        join(data, "harvest-cache", "bketelsen", "pi-pocket-team", "77.json"),
        JSON.stringify({
            key,
            outcome: {
                ok: false,
                reason: "validation error: EACCES from an earlier run",
                fields: null,
                validation: {},
            },
        }),
    );

    const result = await validateCandidate(
        {
            data,
            now: () => NOW,
            log: () => {},
            rosterNames: [REPO],
            hostNames: [],
            sandbox: {
                bwrap: FAKE_BWRAP,
                pocket: fixture.pocket,
                miseInstalls: join(fixture.root, "no-mise"),
                data,
            },
            timeouts: { setup: 60_000, check: 60_000, hidden: 60_000 },
        },
        candidate,
    );

    assert.equal(result.cached, undefined, "not the cached outcome");
    assert.equal(result.ok, true, result.reason);
    assert.equal(
        result.fields.hiddenCommand,
        "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:adds)$' 'add.test.mjs'",
    );
});

test("a failed fetch does not stop the harvest: the repository is harvested without it, and the next one too", async () => {
    const fleet = "bketelsen/fleet";
    const ref = (repo, n) => `${repo}#${n}`;
    const prs = {};
    const threads = [REPO, fleet].map((repo, i) => {
        prs[ref(repo, 5)] = {
            state: "MERGED",
            mergedAt: "2026-10-01T00:00:00Z",
            mergeCommit: { oid: node.merge },
            additions: 10,
            deletions: 0,
        };

        return {
            id: `T${50 + i}`,
            session: 500 + i,
            prs: [ref(repo, 5)],
            route: null,
            nightShift: false,
            brief: "Fix add.",
            briefSource: "delegation",
        };
    });
    const fetched = [];
    const lines = [];
    const out = join(fixture.root, "fetch-out");
    const written = await harvest(
        {
            ...stubContext(fakeGh({ prs }), async () => ({
                ok: true,
                validation: {},
                fields: {
                    parent: node.parent,
                    setup: "true",
                    check: "true",
                    hiddenTests: [],
                    hiddenCommand: null,
                    features: null,
                },
            })),
            log: (line) => lines.push(line),
            repos: new Set([REPO, fleet]),
            out,
            checkouts: { [REPO]: node.repo, [fleet]: node.repo },
            fetch: true,
            fetchRepo: async (checkout) => {
                fetched.push(checkout);

                if (fetched.length === 1) {
                    throw new Error(
                        "could not read Username for 'https://github.com': terminal prompts disabled\nmore",
                    );
                }
            },
        },
        threads,
    );

    assert.equal(fetched.length, 2, "both repositories tried their fetch");
    assert.deepEqual(
        lines.filter((line) => /fetch failed/.test(line)),
        [
            `${REPO}: fetch failed, harvested without it: could not read Username for 'https://github.com': terminal prompts disabled`,
        ],
    );
    assert.equal(written.length, 2);

    for (const [repo, file] of [
        [REPO, join(out, "bketelsen", "pi-pocket-team.json")],
        [fleet, join(out, "bketelsen", "fleet.json")],
    ]) {
        const manifest = await loadManifest(file);

        assert.deepEqual(
            manifest.tasks.map((t) => t.pr),
            [ref(repo, 5)],
            repo,
        );
    }
});

test("the parent of a rebase merge is the commit before the PR's rebased commits", async () => {
    const shapes = makeMergeShapes(join(fixture.root, "merge-shapes"));
    const { rebase } = shapes;

    assert.equal(await parentOf(shapes.repo, rebase.merge, rebase.commits), rebase.parent);
    assert.notEqual(rebase.parent, git(shapes.repo, "rev-parse", `${rebase.merge}^1`));
});

test("the parent of a squash merge of 3 commits and of a merge commit stays the first parent", async () => {
    const shapes = makeMergeShapes(join(fixture.root, "merge-shapes-2"));

    for (const shape of ["squash", "merge"]) {
        const { merge, parent, commits } = shapes[shape];

        assert.equal(await parentOf(shapes.repo, merge, commits), parent, shape);
        assert.equal(parent, git(shapes.repo, "rev-parse", `${merge}^1`), shape);
    }

    // A PR of 1 commit, or with no commits known: the first parent.
    const { merge, commits } = shapes.rebase;

    assert.equal(
        await parentOf(shapes.repo, merge, commits.slice(1)),
        git(shapes.repo, "rev-parse", `${merge}^1`),
    );
    assert.equal(
        await parentOf(shapes.repo, merge, []),
        git(shapes.repo, "rev-parse", `${merge}^1`),
    );
});

test("a harvest reads the PR's commits and validates a rebase merge at its real parent; an old gh cache is read again", async () => {
    const shapes = makeMergeShapes(join(fixture.root, "merge-shapes-3"));
    const prs = {};
    const list = [];

    const pr = (n, shape) => {
        prs[`${REPO}#${n}`] = {
            state: "MERGED",
            mergedAt: "2026-10-05T00:00:00Z",
            mergeCommit: { oid: shapes[shape].merge },
            additions: 10,
            deletions: 0,
            commits: shapes[shape].commits,
        };
        list.push({
            thread: {
                id: `T${n}`,
                nightShift: true,
                brief: "b",
                briefSource: "night-shift",
                route: null,
            },
            pr: `${REPO}#${n}`,
            number: n,
            repo: REPO,
        });
    };

    pr(1, "rebase");
    pr(2, "squash");
    pr(3, "merge");

    const parents = {};
    const ctx = stubContext(fakeGh({ prs }), async (_ctx, c) => {
        parents[c.number] = c.parent;

        return {
            ok: true,
            validation: {},
            fields: {
                parent: c.parent,
                setup: "true",
                check: "true",
                hiddenTests: [],
                hiddenCommand: null,
                features: null,
            },
        };
    });

    // A gh cache of an earlier harvest, with no commits: it is read again.
    mkdirSync(join(ctx.data, "harvest-cache", "bketelsen", "pi-pocket-team"), { recursive: true });
    writeFileSync(
        join(ctx.data, "harvest-cache", "bketelsen", "pi-pocket-team", "1.gh.json"),
        JSON.stringify({ ...prs[`${REPO}#1`], merge: shapes.rebase.merge, commits: undefined }),
    );
    ctx.checkouts = { [REPO]: shapes.repo };

    const manifest = await harvestRepo(ctx, REPO, list, []);

    assert.ok(PR_FIELDS.split(",").includes("commits"));
    assert.deepEqual(parents, {
        1: shapes.rebase.parent,
        2: shapes.squash.parent,
        3: shapes.merge.parent,
    });
    assert.equal(manifest.tasks.find((t) => t.pr === `${REPO}#1`).parent, shapes.rebase.parent);
});

test("Go modules: each hidden file belongs to the nearest go.mod at or above its folder", async () => {
    const go = makeNestedGoRepo(join(fixture.root, "nested-go"));

    assert.deepEqual(
        await goModulesAt(go.repo, go.rev, [
            "kit/jsonrpc/client_test.go",
            "kit/kit_test.go",
            "cmd/x_test.go",
        ]),
        { ".": "example.com/lodge", kit: "example.com/lodge/kit" },
    );
    assert.deepEqual(await goModulesAt(go.repo, go.rev, ["cmd/x_test.go"]), {
        ".": "example.com/lodge",
    });
});

/** A validation context of the fake bwrap in its own data dir. */
const validationContext = (data) => ({
    data,
    now: () => NOW,
    log: () => {},
    rosterNames: [REPO],
    hostNames: [],
    sandbox: {
        bwrap: FAKE_BWRAP,
        pocket: fixture.pocket,
        miseInstalls: join(fixture.root, "no-mise"),
        data,
    },
    timeouts: { setup: 60_000, check: 60_000, hidden: 60_000 },
});

test("the harvest stages the hidden files at the parent: a test that needs its file in git ls-files is valid", async () => {
    const tracked = makeTrackedRepo(join(fixture.root, "tracked-repo"));
    const result = await validateCandidate(validationContext(join(fixture.root, "tracked-data")), {
        repo: REPO,
        number: 90,
        thread: { id: "T90", brief: "Fix add.", route: null, nightShift: false },
        checkout: tracked.repo,
        merge: tracked.merge,
        parent: tracked.parent,
    });

    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.fields.hiddenTests, [{ file: "tracked.test.mjs", names: ["tracked"] }]);
    assert.equal(
        result.fields.hiddenCommand,
        "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:tracked)$' 'tracked.test.mjs'",
    );
});

test("--revalidate stages the hidden files at the parent: a test that needs its file in git ls-files passes", async () => {
    const tracked = makeTrackedRepo(join(fixture.root, "tracked-reval-repo"));
    const file = join(fixture.root, "reviewed-tracked.json");

    writeFileSync(
        file,
        JSON.stringify({
            schema: 1,
            repo: REPO,
            checkout: tracked.repo,
            tasks: [
                {
                    id: "tracked-1",
                    repo: REPO,
                    thread: "T1",
                    pr: `${REPO}#1`,
                    parent: tracked.parent,
                    merge: tracked.merge,
                    brief: "Fix add.",
                    briefSource: "delegation",
                    setup: "PI_POCKET_CHECKOUT=/pocket node link.mjs",
                    check: "PI_POCKET_CHECKOUT=/pocket make test",
                    hiddenTests: [{ file: "tracked.test.mjs", names: ["tracked"] }],
                    hiddenCommand:
                        "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:tracked)$' 'tracked.test.mjs'",
                    size: 10,
                    features: null,
                    owner: { keep: true, reason: "", scopeMatches: true, commandsConfirmed: true },
                },
            ],
            validation: {},
        }),
    );

    const result = await runScript(
        "harvest.mjs",
        ["--revalidate", file, "--bwrap", FAKE_BWRAP, "--pocket", fixture.pocket],
        testEnv(fixture, { BENCH_DATA: join(fixture.root, "reval-tracked-data") }),
    );
    const entry = JSON.parse(readFileSync(file, "utf8")).validation["tracked-1"];

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(entry.ok, true, entry.reason);
    assert.equal(entry.hiddenNames, "pass");
});

test("a repository's own command limit: fleet's check and hidden tests get 30 minutes, setup and others 10", async () => {
    const FLEET = "bketelsen/fleet";

    const limits = async (repo) => {
        const data = join(fixture.root, `limit-data-${repo.replace("/", "-")}`);
        const runs = [];
        const ctx = validationContext(data);

        delete ctx.timeouts;
        ctx.sandbox.onRun = ({ step, timeoutMs }) => runs.push([step ?? "discovery", timeoutMs]);

        const candidate = {
            repo,
            number: 91,
            thread: { id: "T91", brief: "Fix add.", route: null, nightShift: false },
            checkout: node.repo,
            merge: node.merge,
            parent: node.parent,
        };

        // A validation cached under the old limit timed out: it is not reused.
        mkdirSync(join(data, "harvest-cache", ...repo.split("/")), { recursive: true });
        writeFileSync(
            join(data, "harvest-cache", ...repo.split("/"), "91.json"),
            JSON.stringify({
                key: validationKey({
                    merge: node.merge,
                    parent: node.parent,
                    commands: await commandsAt(node.repo, node.merge),
                    brief: "Fix add.",
                    route: null,
                }),
                outcome: {
                    ok: false,
                    reason: "check failed at the merge (timed out)",
                    fields: null,
                    validation: { checkMerge: "timed out" },
                },
            }),
        );

        const result = await validateCandidate(ctx, candidate);

        assert.equal(result.cached, undefined, `${repo}: a cached timeout is validated again`);
        assert.equal(result.ok, true, result.reason);

        const fields = result.fields;
        const entry = await revalidateTask(
            {
                ...ctx,
                sandbox: {
                    ...ctx.sandbox,
                    onRun: ({ step, timeoutMs }) =>
                        runs.push([`reval ${step ?? "discovery"}`, timeoutMs]),
                },
            },
            {
                id: `limit-${repo.replace("/", "-")}`,
                repo,
                parent: node.parent,
                merge: node.merge,
                setup: fields.setup,
                check: fields.check,
                hiddenTests: fields.hiddenTests,
                hiddenCommand: fields.hiddenCommand,
            },
            node.repo,
        );

        assert.equal(entry.ok, true, entry.reason);

        return Object.fromEntries(runs);
    };

    const LONG = 30 * 60_000;

    assert.equal(commandMsOf(FLEET), LONG);
    assert.equal(commandMsOf(REPO), COMMAND_MS);

    for (const [repo, limit] of [
        [FLEET, LONG],
        [REPO, COMMAND_MS],
    ]) {
        const runs = await limits(repo);

        for (const step of [
            "check at the merge",
            "hidden command at the merge",
            "hidden command at the parent",
            "discovery",
            "reval check at the merge",
            "reval hidden command at the merge",
            "reval hidden command at the parent",
            "reval discovery",
        ]) {
            assert.equal(runs[step], limit, `${repo}: ${step}`);
        }

        for (const step of [
            "setup at the merge",
            "setup at the parent",
            "reval setup at the parent",
        ]) {
            assert.equal(runs[step], COMMAND_MS, `${repo}: ${step}`);
        }
    }
});

test("a PR with 100 or more commits is dropped: gh lists at most 100, so its parent is unknown", async () => {
    const shapes = makeMergeShapes(join(fixture.root, "merge-shapes-cap"));
    const commits = (count) =>
        Array.from({ length: count }, (_, i) => ({
            oid: i.toString(16).padStart(40, "0"),
            messageHeadline: `commit ${i}`,
            authoredDate: "2026-10-01T10:00:00Z",
        }));
    const prs = {};
    const list = [100, 99].map((count, i) => {
        const n = 60 + i;

        prs[`${REPO}#${n}`] = {
            state: "MERGED",
            mergedAt: "2026-10-05T00:00:00Z",
            mergeCommit: { oid: shapes.rebase.merge },
            additions: 10,
            deletions: 0,
            commits: commits(count),
        };

        return {
            thread: {
                id: `T${n}`,
                nightShift: true,
                brief: "b",
                briefSource: "night-shift",
                route: null,
            },
            pr: `${REPO}#${n}`,
            number: n,
            repo: REPO,
        };
    });
    const validated = [];
    const ctx = stubContext(fakeGh({ prs }), async (_ctx, c) => {
        validated.push(c.number);

        return {
            ok: true,
            validation: {},
            fields: {
                parent: c.parent,
                setup: "true",
                check: "true",
                hiddenTests: [],
                hiddenCommand: null,
                features: null,
            },
        };
    });

    ctx.checkouts = { [REPO]: shapes.repo };

    const manifest = await harvestRepo(ctx, REPO, list, []);

    assert.equal(
        TOO_MANY_COMMITS,
        "the PR has 100 or more commits: the list may be incomplete, so its parent is unknown",
    );
    assert.deepEqual(manifest.dropped, [
        { thread: "T60", pr: `${REPO}#60`, reason: TOO_MANY_COMMITS },
    ]);
    assert.deepEqual(validated, [61], "a PR of 99 commits is still a candidate");
});

test("the parent rule: a headline that GitHub cut with … matches its full subject", async () => {
    const shapes = makeMergeShapes(join(fixture.root, "merge-shapes-cut"));
    const { merge, parent, commits } = shapes.rebase;
    const cut = commits.map((c) => ({
        ...c,
        messageHeadline: `${c.messageHeadline.slice(0, 8)}…`,
    }));

    assert.equal(cut[0].messageHeadline, "rebase o…");
    assert.equal(await parentOf(shapes.repo, merge, cut), parent);

    // A cut headline that is not the start of the subject does not match.
    const wrong = commits.map((c) => ({ ...c, messageHeadline: "other…" }));

    assert.equal(
        await parentOf(shapes.repo, merge, wrong),
        git(shapes.repo, "rev-parse", `${merge}^1`),
    );
});

test("the parent rule: a squash-merged PR with a merge commit inside it keeps <merge>^1", async () => {
    const repo = join(fixture.root, "pr-with-merge");

    const commit = (file, subject, date) => {
        writeFileSync(join(repo, file), `${subject}\n`);
        git(repo, "add", ".");
        git(repo, "commit", "--quiet", "-m", subject, `--date=${date}`);

        return git(repo, "rev-parse", "HEAD");
    };

    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    commit("a.txt", "seed", "2026-09-01T10:00:00Z");
    git(repo, "checkout", "--quiet", "-b", "pr");
    commit("p.txt", "pr one", "2026-10-01T10:00:00Z");
    git(repo, "checkout", "--quiet", "main");
    commit("b.txt", "main moves on", "2026-10-01T11:00:00Z");
    git(repo, "checkout", "--quiet", "pr");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge branch 'main' into pr", "main");

    const inside = git(repo, "log", "-1", "--format=%aI");

    commit("p.txt", "pr two", "2026-10-01T12:00:00Z");
    git(repo, "checkout", "--quiet", "main");

    const before = git(repo, "rev-parse", "HEAD");

    git(repo, "merge", "--quiet", "--squash", "pr");
    git(repo, "commit", "--quiet", "-m", "The PR (#4)", "--date=2026-10-01T13:00:00Z");

    const merge = git(repo, "rev-parse", "HEAD");
    const commits = [
        ["pr one", "2026-10-01T10:00:00Z"],
        ["Merge branch 'main' into pr", inside],
        ["pr two", "2026-10-01T12:00:00Z"],
    ].map(([messageHeadline, authoredDate]) => ({ messageHeadline, authoredDate }));

    assert.equal(await parentOf(repo, merge, commits), before);
});

/**
 * A bwrap that hangs on the hidden-test discovery (the Node TAP reporter) of 1 tree (`at`: "merge" or "parent") and
 * passes every other run to the fake bwrap: the validation's own limit ends the hang.
 */
function hangingBwrap(at) {
    const file = join(fixture.root, `hang-${at}-bwrap.sh`);

    writeFileSync(
        file,
        [
            "#!/bin/sh",
            'case " $* " in',
            `    *"/${at}/work /work "*"--test-reporter=tap"*) exec sleep 600 ;;`,
            "esac",
            `exec '${FAKE_BWRAP}' "$@"`,
            "",
        ].join("\n"),
    );
    chmodSync(file, 0o755);

    return file;
}

test("a discovery that times out (at the merge, at the parent) is recorded, not cached, and validated again", async () => {
    for (const at of ["merge", "parent"]) {
        const data = join(fixture.root, `discovery-timeout-${at}`);
        const candidate = {
            repo: REPO,
            number: 92,
            thread: { id: "T92", brief: "Fix add.", route: null, nightShift: false },
            checkout: node.repo,
            merge: node.merge,
            parent: node.parent,
        };
        const hung = validationContext(data);

        hung.sandbox.bwrap = hangingBwrap(at);
        hung.sandbox.killGraceMs = 1000;
        hung.timeouts = { ...hung.timeouts, hidden: 5_000 };

        const first = await validateCandidate(hung, candidate);
        const cacheFile = join(data, "harvest-cache", "bketelsen", "pi-pocket-team", "92.json");

        assert.equal(first.ok, true, first.reason);
        assert.equal(first.fields.hiddenCommand, null, `${at}: no valid name was found`);
        assert.deepEqual(
            first.timedOutSteps,
            [`the discovery of the node hidden tests at the ${at}`],
            at,
        );
        assert.equal(existsSync(cacheFile), false, `${at}: the outcome is not cached`);

        // A second harvest validates again (no cached outcome), and finds the hidden tests.
        const second = await validateCandidate(validationContext(data), candidate);

        assert.equal(second.cached, undefined, at);
        assert.deepEqual(second.timedOutSteps, []);
        assert.equal(
            second.fields.hiddenCommand,
            "PI_POCKET_CHECKOUT=/pocket node --test --test-name-pattern='^(?:adds)$' 'add.test.mjs'",
        );
        assert.equal(existsSync(cacheFile), true, `${at}: an outcome with no timeout is cached`);
    }
});
