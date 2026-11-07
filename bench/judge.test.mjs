// The judge's input: a cut diff shows the code before its tests, a diff under the limit stays as it is, a normal S3
// prompt renders byte for byte as before, a calibration prompt has no reference and no S1 or S2, and the frozen
// rubric's hash. No model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    CALIBRATION_CHECK,
    DIFF_LIMIT,
    JUDGES,
    JUDGE_PROMPT,
    JUDGE_PROMPT_CHANGED,
    JUDGE_PROMPT_SHA256,
    NO_REFERENCE_NOTE,
    checkJudgePrompt,
    cutDiff,
    diffStat,
    isTestPath,
    renderPrompt,
    runJudge,
    sectionPath,
    testsLast,
    unquotePath,
} from "./lib/judge.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const template = readFileSync(JUDGE_PROMPT, "utf8");

/** A file section of a diff with `lines` added lines. */
const section = (path, lines, mark = "x") =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${`+${mark}\n`.repeat(lines)}`;

test("test paths: test folders and test file names; other files are not", () => {
    for (const path of [
        "desk-x.test.ts",
        "bench/judge.test.mjs",
        "a/b.spec.tsx",
        "x.test.cjs",
        "pkg/foo_test.go",
        "foo_test.py",
        "tests/test_foo.py",
        "test/helpers.mjs",
        "src/__tests__/a.js",
        "internal/testdata/in.json",
        "bench/fixtures/fake-pi.cjs",
    ]) {
        assert.equal(isTestPath(path), true, path);
    }

    for (const path of [
        "desk.ts",
        "testing.md",
        "contest.ts",
        "test.ts",
        "foo.test.go",
        "latest/x.mjs",
        "a.test.md",
        "test_foo.go",
    ]) {
        assert.equal(isTestPath(path), false, path);
    }
});

test("a cut diff shows the non-test files first, each group in its order; a diff under the limit is unchanged", () => {
    // Git sorts by path: the test file comes first and fills the whole cut.
    const tests = section("desk-x.test.ts", DIFF_LIMIT / 2, "test");
    const code = section("desk.ts", 100, "code");
    const fixture = section("fixtures/a.json", 10, "fix");
    const docs = section("docs/a.md", 10, "doc");
    const diff = `${tests}${code}${fixture}${docs}`;
    const { text, cut } = cutDiff(diff, diffStat(diff));

    assert.equal(cut, true);
    assert.ok(diff.length > DIFF_LIMIT);

    const body = text.slice(text.indexOf("\n\ndiff --git ") + 2);

    assert.ok(body.startsWith(code), "the code's section comes first");
    assert.ok(body.startsWith(`${code}${docs}${tests.slice(0, 100)}`), "then docs, then tests");
    assert.equal(body.length, DIFF_LIMIT);
    assert.match(
        text,
        /^ desk-x\.test\.ts \| \+30000 -0\n desk\.ts \| \+100 -0\n/,
        "the stat first",
    );

    // The text before the first section stays first; a last section with no final newline still ends its line.
    const reordered = testsLast(`preamble\n${tests}${code.trimEnd()}`);

    assert.equal(reordered, `preamble\n${code.trimEnd()}\n${tests}`);

    // Under the limit: exactly as it is, even with a test file first.
    const small = `${section("a.test.ts", 3)}${section("a.ts", 3)}`;

    assert.deepEqual(cutDiff(small, diffStat(small)), { text: small, cut: false });
});

test("a quoted git path is decoded: a cut diff with a quoted test file first shows the production file first", () => {
    // git quotes a path with special characters: C-style escapes, octal bytes of UTF-8 (\303\251 is "é").
    const quoted = String.raw`"a/\303\251.test.ts" "b/\303\251.test.ts"`;
    const tests = `diff --git ${quoted}\nindex 0000000..1111111 100644\n${"+test\n".repeat(DIFF_LIMIT / 4)}`;
    const code = section("é.ts", 50, "code");
    const diff = `${tests}${code}`;
    const { text, cut } = cutDiff(diff, "stat");

    assert.equal(cut, true);
    assert.ok(
        text.startsWith(`stat\n\n${code}diff --git ${quoted}\n`),
        "the production section first",
    );
    // The sections keep their text: the quoted header is not rewritten.
    assert.equal(testsLast(diff), `${code}${tests}`);

    assert.equal(sectionPath(`diff --git ${quoted}\n`), "é.test.ts");
    assert.equal(
        sectionPath(String.raw`diff --git "a/t\"x\ty\\z.ts" "b/t\"x\ty\\z.spec.ts"` + "\n"),
        't"x\ty\\z.spec.ts',
    );
    assert.equal(sectionPath(String.raw`diff --git a/a.ts "b/test s/\303\251.ts"`), "test s/é.ts");
    assert.equal(sectionPath("diff --git a/a b.ts b/a b.ts\n"), "a b.ts");
    assert.equal(unquotePath(String.raw`"\n\101"`), "\nA");
    assert.equal(unquotePath("plain"), "plain");
});

test("a normal S3 prompt renders byte for byte as before the calibration change", () => {
    // The hashes of these renders, taken with the code before `reference: null` and `calibration` existed.
    const cases = [
        {
            brief: "Fix add in lib.mjs.",
            s1: true,
            s2: false,
            submitted: cutDiff("diff --git a/a b/a\n+x\n", ""),
            reference: cutDiff("diff --git a/b b/b\n+y\n", ""),
        },
        {
            brief: "  Brief  ",
            s1: null,
            s2: null,
            submitted: { text: " a.mjs | +1 -0\n\ndiff --git a/a b/a\n+x\n", cut: true },
            reference: { text: "ref", cut: true },
        },
        {
            brief: "B",
            s1: false,
            s2: true,
            submitted: cutDiff("", ""),
            reference: cutDiff("diff r", ""),
        },
    ];

    assert.deepEqual(
        cases.map((c) => sha256(renderPrompt(template, c))),
        [
            "3f7adfee6e65c2b16aa7a16fdeec8018dbff66f5ba419b976e4335cc1531ac1e",
            "1e172686c1e192d8fa9dd0cced6880e2877e758bc3f578313798ab9736bd20d0",
            "4a9b17765b9af4242735c031f7f5ab9a0701456cae6e87454498049e7186eb25",
        ],
    );
});

test("a calibration prompt: no merged change, S1 and S2 not run for this item", () => {
    const prompt = renderPrompt(template, {
        brief: "The task.",
        submitted: { text: "diff --git a/a b/a\n+x\n", cut: false },
        reference: null,
        calibration: true,
    });

    assert.ok(
        prompt.includes(`${NO_REFERENCE_NOTE}\n\n<reference-diff>\n(none)\n</reference-diff>`),
    );
    assert.match(prompt, new RegExp(`submitted tree: ${CALIBRATION_CHECK}\n`));
    assert.match(prompt, new RegExp(`failed before it: ${CALIBRATION_CHECK}\n`));
    assert.match(prompt, /The submitted diff is complete\./);
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
});

test("the freeze: judge-v1.md has the frozen hash; a changed rubric is refused before any try", async () => {
    assert.equal(sha256(readFileSync(JUDGE_PROMPT)), JUDGE_PROMPT_SHA256);
    await checkJudgePrompt();

    const root = mkdtempSync(join(tmpdir(), "bench-judge-"));

    try {
        const changed = join(root, "judge-v1.md");

        writeFileSync(changed, template.replace("4: mergeable as it is.", "4: good."));
        await assert.rejects(checkJudgePrompt(changed), { message: JUDGE_PROMPT_CHANGED });
        // runJudge refuses before it reserves, writes or runs anything.
        await assert.rejects(
            runJudge(
                { data: join(root, "data"), judgePromptFile: changed, log: () => {} },
                {
                    model: JUDGES[0],
                    prompt: "p",
                    dir: join(root, "judge"),
                    task: "t",
                    stage: "x",
                },
            ),
            { message: JUDGE_PROMPT_CHANGED },
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
