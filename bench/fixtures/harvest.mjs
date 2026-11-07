// Fixtures of the harvester, scorer and calibration tests: a Node-only fixture repository with a merged PR (a fix
// with hidden tests), a small Pocket database with Pocket's tables, and a fake `gh`. Nothing here reads the real
// Pocket database, GitHub or a model.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA } from "../../audit/fixtures/pocket-db.mjs";
import { git } from "./helpers.mjs";

/** Write files (path -> text) under a folder. */
export function writeFiles(dir, files) {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
}

/**
 * A repository shaped like pi-pocket-team (a `link.mjs` with a `link` script, a Makefile `test` target): the parent
 * has a bug in `add`; the PR (merged with `--no-ff`, so the merge's first parent is the parent) fixes it, adds `mul`,
 * and adds tests: `adds` fails by an assertion at the parent, `stable` passes there, `throws` fails by a TypeError,
 * and `mul.test.mjs` does not load at the parent (it imports `mul`). Returns `{ repo, parent, merge }`.
 */
export function makeNodeRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFiles(repo, {
        "package.json": `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { link: "node link.mjs", test: "node --test" } })}\n`,
        "link.mjs": "// The fixture's link step: nothing to link.\n",
        Makefile: "test:\n\tnode --test\n",
        "lib.mjs": "export const add = (a, b) => a - b;\n",
        ".gitignore": "node_modules\n",
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "parent");

    const parent = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "--quiet", "-b", "fix");
    writeFiles(repo, {
        "lib.mjs": "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n",
        "add.test.mjs": [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import { add } from "./lib.mjs";',
            'import data from "./fixtures/data.json" with { type: "json" };',
            "",
            'test("adds", () => assert.equal(add(data.a, data.b), 3));',
            'test("stable", () => assert.equal(1, 1));',
            'test("throws", () => {\n    if (add(1, 2) !== 3) {\n        throw new TypeError("wrong sum");\n    }\n});',
            "",
        ].join("\n"),
        "mul.test.mjs": [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import { mul } from "./lib.mjs";',
            "",
            'test("multiplies", () => assert.equal(mul(2, 3), 6));',
            "",
        ].join("\n"),
        "fixtures/data.json": '{ "a": 1, "b": 2 }\n',
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "fix add, add mul");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge the fix", "fix");

    return { repo, parent, merge: git(repo, "rev-parse", "HEAD") };
}

/**
 * A second repository of the same shape whose PR adds hidden tests with needs of their own: `tool.test.mjs` runs the
 * support script `fixtures/sum.sh` (mode 100755), and `feature.test.mjs` passes only with `FEATURE=1` in its
 * environment. At the parent, both fail by an assertion (the sum is wrong). Returns `{ repo, parent, merge }`.
 */
export function makeExtraRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFiles(repo, {
        "package.json": `${JSON.stringify({ name: "extra", private: true, type: "module", scripts: { link: "node link.mjs" } })}\n`,
        "link.mjs": "// The fixture's link step: nothing to link.\n",
        "lib.mjs": "export const add = (a, b) => a - b;\n",
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "parent");

    const parent = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "--quiet", "-b", "fix");
    writeFiles(repo, {
        "lib.mjs": "export const add = (a, b) => a + b;\n",
        "fixtures/sum.sh": "#!/bin/sh\necho 3\n",
        "tool.test.mjs": [
            'import assert from "node:assert/strict";',
            'import { execFileSync } from "node:child_process";',
            'import { test } from "node:test";',
            'import { add } from "./lib.mjs";',
            "",
            'test("tool", () => assert.equal(String(add(1, 2)), execFileSync("./fixtures/sum.sh", { encoding: "utf8" }).trim()));',
            "",
        ].join("\n"),
        "feature.test.mjs": [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import { add } from "./lib.mjs";',
            "",
            'test("feature", () => {',
            "    assert.equal(add(1, 2), 3);",
            '    assert.equal(process.env.FEATURE, "1");',
            "});",
            "",
        ].join("\n"),
    });
    chmodSync(join(repo, "fixtures", "sum.sh"), 0o755);
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "fix add, add tests");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge the fix", "fix");

    return { repo, parent, merge: git(repo, "rev-parse", "HEAD") };
}

/**
 * A repository of the same shape whose PR adds `tracked.test.mjs`: its test `tracked` first runs
 * `git ls-files --error-unmatch tracked.test.mjs` (an error, not an assertion, when the file is untracked), then
 * checks the sum (an assertion at the parent). Returns `{ repo, parent, merge }`.
 */
export function makeTrackedRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFiles(repo, {
        "package.json": `${JSON.stringify({ name: "tracked", private: true, type: "module", scripts: { link: "node link.mjs" } })}\n`,
        "link.mjs": "// The fixture's link step: nothing to link.\n",
        Makefile: "test:\n\tnode --test\n",
        "lib.mjs": "export const add = (a, b) => a - b;\n",
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "parent");

    const parent = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "--quiet", "-b", "fix");
    writeFiles(repo, {
        "lib.mjs": "export const add = (a, b) => a + b;\n",
        "tracked.test.mjs": [
            'import assert from "node:assert/strict";',
            'import { execFileSync } from "node:child_process";',
            'import { test } from "node:test";',
            'import { add } from "./lib.mjs";',
            "",
            'test("tracked", () => {',
            '    execFileSync("git", ["ls-files", "--error-unmatch", "tracked.test.mjs"], { stdio: "ignore" });',
            "    assert.equal(add(1, 2), 3);",
            "});",
            "",
        ].join("\n"),
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "fix add, add a test");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge the fix", "fix");

    return { repo, parent, merge: git(repo, "rev-parse", "HEAD") };
}

/**
 * A repository with the 3 shapes of a GitHub merge on `main`, one after another: a rebase merge of a PR of 2 commits
 * (the 2 commits on `main`, with their author dates), a squash merge of a PR of 3 commits (1 new commit), and a merge
 * commit of a PR of 2 commits. Each shape is `{ merge, parent, commits }`; `commits` is the PR's commits as
 * `gh pr view --json commits` gives them (the oids of the branch before the rebase or the squash).
 */
export function makeMergeShapes(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");

    const commit = (file, subject, date) => {
        writeFiles(repo, { [file]: `${subject}\n` });
        git(repo, "add", ".");
        git(repo, "commit", "--quiet", "-m", subject, "-m", "A body line.", `--date=${date}`);

        return git(repo, "rev-parse", "HEAD");
    };

    const ghCommit = (subject, date, i) => ({
        oid: String(i).repeat(40),
        messageHeadline: subject,
        authoredDate: date,
        authors: [{ login: "bench", name: "bench" }],
    });

    commit("a.txt", "seed", "2026-09-01T10:00:00Z");

    const base = commit("b.txt", "base", "2026-09-02T10:00:00Z");
    // A rebase merge: the PR's 2 commits, rewritten on main with their subjects and author dates.
    const rebased = [
        ["rebase one", "2026-10-01T10:00:00Z"],
        ["rebase two", "2026-10-01T11:00:00Z"],
    ];

    rebased.forEach(([subject, date]) => commit("r.txt", subject, date));

    const rebase = {
        merge: git(repo, "rev-parse", "HEAD"),
        parent: base,
        commits: rebased.map(([subject, date], i) => ghCommit(subject, date, i + 1)),
    };
    // A squash merge: the PR's 3 commits became 1 commit on main.
    const squashed = [
        ["squash one", "2026-10-02T10:00:00Z"],
        ["squash two", "2026-10-02T11:00:00Z"],
        ["squash three", "2026-10-02T12:00:00Z"],
    ];
    const squash = {
        parent: rebase.merge,
        merge: commit("s.txt", "Squash the PR (#2)", "2026-10-02T13:00:00Z"),
        commits: squashed.map(([subject, date], i) => ghCommit(subject, date, i + 4)),
    };
    // A merge commit of a PR of 2 commits.
    const merged = [
        ["merge one", "2026-10-03T10:00:00Z"],
        ["merge two", "2026-10-03T11:00:00Z"],
    ];

    git(repo, "checkout", "--quiet", "-b", "pr");
    merged.forEach(([subject, date]) => commit("m.txt", subject, date));
    git(repo, "checkout", "--quiet", "main");
    commit("main.txt", "main moves on", "2026-10-03T12:00:00Z");

    const mainHead = git(repo, "rev-parse", "HEAD");

    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge the PR (#3)", "pr");

    const merge = {
        merge: git(repo, "rev-parse", "HEAD"),
        parent: mainHead,
        commits: merged.map(([subject, date], i) => ghCommit(subject, date, i + 7)),
    };

    return { repo, rebase, squash, merge };
}

/**
 * A Go repository with a nested module: `go.mod` (module `example.com/lodge`) and `kit/go.mod` (module
 * `example.com/lodge/kit`), a test file of each, and `kit/jsonrpc/client_test.go`. 1 commit; returns `{ repo, rev }`.
 * No Go toolchain is needed: the tests read the files only.
 */
export function makeNestedGoRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFiles(repo, {
        "go.mod": "module example.com/lodge\n\ngo 1.24\n",
        "cmd/x_test.go": "package cmd\n",
        "kit/go.mod": "module example.com/lodge/kit\n\ngo 1.24\n",
        "kit/kit_test.go": "package kit\n",
        "kit/jsonrpc/client_test.go": "package jsonrpc\n",
    });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "two modules");

    return { repo, rev: git(repo, "rev-parse", "HEAD") };
}

/**
 * A repository whose parent commit tracks a submodule at `mod` (a gitlink, mode 160000, to the seed commit; no
 * network, no `.gitmodules`), and a PR that changes only `README.md`. Returns `{ repo, parent, merge }`.
 */
export function makeSubmoduleRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFiles(repo, { "README.md": "seed\n" });
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "seed");

    const seed = git(repo, "rev-parse", "HEAD");

    git(repo, "update-index", "--add", "--cacheinfo", `160000,${seed},mod`);
    git(repo, "commit", "--quiet", "-m", "parent: a submodule at mod");

    const parent = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "--quiet", "-b", "fix");
    writeFiles(repo, { "README.md": "the reference\n" });
    git(repo, "commit", "--quiet", "-am", "the reference change");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge the reference", "fix");

    return { repo, parent, merge: git(repo, "rev-parse", "HEAD") };
}

/**
 * A Pocket database with a desk (`threads`: id -> thread), night-shift goals (`goals`: session -> goal) and the first
 * user message of sessions (`messages`: session -> text).
 */
export function makePocketDb(file, { threads, goals = {}, messages = {} }) {
    const db = new DatabaseSync(file);
    let docId = 0;
    let seq = 0;
    let entryId = 0;

    SCHEMA.forEach((sql) => db.exec(sql));

    const document = (kind, owner, value) => {
        docId += 1;
        db.prepare(
            "insert into documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) values (?,?,?,?,?,?,?,?)",
        ).run(docId, JSON.stringify(kind), 0, "", "conversation", owner, 1, "{}");
        seq += 1;
        db.prepare(
            "insert into document_revisions (document_id, seq, kind, version, content) values (?,?,?,?,?)",
        ).run(docId, seq, "base", 1, JSON.stringify(value));
    };

    document("x.desk.threads", 1, { next: { T: 100 }, threads, grants: [], seen: {} });

    for (const [session, goal] of Object.entries(goals)) {
        document("x.night-shift.goal", Number(session), { goal });
    }

    for (const [session, text] of Object.entries(messages)) {
        for (const content of [text, "a later message"]) {
            entryId += 1;
            db.prepare(
                "insert into entries (id, conversation_id, head, commit_seq, record) values (?,?,?,?,?)",
            ).run(
                entryId,
                Number(session),
                null,
                entryId,
                JSON.stringify({
                    kind: "pi.user",
                    model: [{ role: "user", content, timestamp: entryId }],
                }),
            );
        }
    }

    db.close();

    return file;
}

/** A delegation's first message, as Team wraps it: the identity block, the marker line, the task, the end tag. */
export const wrapped = (task, { nightShift = false } = {}) =>
    [
        "[via linked session session-x] Message from linked session session-x, written by another session's agent.",
        "<linked-session-message>",
        "Named identity for this Pi Pocket session:",
        "# Sheeana",
        "",
        "You are Sheeana. Task from the source session is not this line.",
        "",
        "Task from the source session:",
        task,
        ...(nightShift
            ? [
                  "",
                  "This task runs as a night shift. Round 1 comes as a separate message that starts with [night-shift].",
              ]
            : []),
        "</linked-session-message>",
    ].join("\n");

/**
 * A fake `gh` over a table of PRs (`owner/name#n` -> the `gh pr view --json` object) and diffs (`repo@base...head`
 * -> text). It records each call in `calls`, and refuses any command but `pr view` and a GET `api` compare.
 */
export function fakeGh({ prs = {}, diffs = {} } = {}) {
    const calls = [];

    const gh = async (args) => {
        calls.push(args);

        if (args[0] === "pr" && args[1] === "view") {
            const ref = `${args[args.indexOf("--repo") + 1]}#${args[2]}`;

            if (!(ref in prs)) {
                throw new Error(`no PR ${ref}`);
            }

            return JSON.stringify(prs[ref]);
        }

        if (args[0] === "api") {
            const match = /^repos\/([^/]+\/[^/]+)\/compare\/(.+)$/.exec(args.at(-1));
            const key = match && `${match[1]}@${match[2]}`;

            if (!key || !(key in diffs)) {
                throw new Error(`no diff ${args.at(-1)}`);
            }

            return diffs[key];
        }

        throw new Error(`fake gh: refused ${args.join(" ")}`);
    };

    gh.calls = calls;

    return gh;
}
