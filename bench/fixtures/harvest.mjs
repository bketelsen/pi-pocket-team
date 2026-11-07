// Fixtures of the harvester, scorer and calibration tests: a Node-only fixture repository with a merged PR (a fix
// with hidden tests), a small Pocket database with Pocket's tables, and a fake `gh`. Nothing here reads the real
// Pocket database, GitHub or a model.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
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
