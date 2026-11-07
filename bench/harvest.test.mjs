// The harvester: candidates from a fixture Pocket database, the briefs, the size strata and the cap, the order of
// night shifts and other delegations, a validation of a fixture PR behind the fake bwrap (hidden tests kept and
// dropped), the written manifest, the validation cache, and `--revalidate`. No network and no real gh.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    PER_STRATUM,
    harvest,
    harvestRepo,
    selectCandidates,
    stratumOf,
    stratumOrder,
} from "./lib/harvest.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { readRoster, repositoriesOf, seededShuffle } from "./lib/owners.mjs";
import { delegationTask, goalBrief, readThreads } from "./lib/pocket.mjs";
import { FAKE_BWRAP, makeFixture, runScript, testEnv } from "./fixtures/helpers.mjs";
import { fakeGh, makeNodeRepo, makePocketDb, wrapped } from "./fixtures/harvest.mjs";

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
