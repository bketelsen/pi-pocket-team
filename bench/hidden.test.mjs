// The hidden-test reporters and rules, from canned output (Go and pytest need no toolchain here), the proposed
// commands, and Node 24's name-pattern behavior (run for real: Node is the only toolchain CI has).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    classify,
    discoveryCommand,
    escapeRegex,
    goFileOutcome,
    goOutcome,
    goTestNames,
    hiddenCommand,
    hiddenFiles,
    makeTargets,
    nodeOutcome,
    parseNameStatus,
    proposeCommands,
    pytestOutcome,
} from "./lib/hidden.mjs";

// `go test -json -count=1 ./ok ./broken` of go 1.27 (times cut): `broken` does not build; in `ok`, TestAdd fails by
// t.Fatalf, TestOld passes, TestPanic panics.
const GO_PARENT = [
    '{"ImportPath":"example.com/gox/broken [example.com/gox/broken.test]","Action":"build-output","Output":"# example.com/gox/broken [example.com/gox/broken.test]\\n"}',
    '{"ImportPath":"example.com/gox/broken [example.com/gox/broken.test]","Action":"build-output","Output":"broken/b_test.go:3:32: undefined: Y\\n"}',
    '{"ImportPath":"example.com/gox/broken [example.com/gox/broken.test]","Action":"build-fail"}',
    '{"Action":"output","Package":"example.com/gox/broken","Output":"FAIL\\texample.com/gox/broken [build failed]\\n","OutputType":"frame"}',
    '{"Action":"fail","Package":"example.com/gox/broken","Elapsed":0,"FailedBuild":"example.com/gox/broken [example.com/gox/broken.test]"}',
    '{"Action":"run","Package":"example.com/gox/ok","Test":"TestAdd"}',
    '{"Action":"output","Package":"example.com/gox/ok","Test":"TestAdd","Output":"    a_test.go:3: got -1\\n","OutputType":"error"}',
    '{"Action":"output","Package":"example.com/gox/ok","Test":"TestAdd","Output":"--- FAIL: TestAdd (0.00s)\\n","OutputType":"frame"}',
    '{"Action":"fail","Package":"example.com/gox/ok","Test":"TestAdd","Elapsed":0}',
    '{"Action":"run","Package":"example.com/gox/ok","Test":"TestOld"}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestOld","Elapsed":0}',
    '{"Action":"run","Package":"example.com/gox/ok","Test":"TestPanic"}',
    '{"Action":"output","Package":"example.com/gox/ok","Test":"TestPanic","Output":"--- FAIL: TestPanic (0.00s)\\n","OutputType":"frame"}',
    '{"Action":"output","Package":"example.com/gox/ok","Test":"TestPanic","Output":"panic: assignment to entry in nil map [recovered, repanicked]\\n"}',
    '{"Action":"fail","Package":"example.com/gox/ok","Test":"TestPanic","Elapsed":0}',
    '{"Action":"output","Package":"example.com/gox/ok","Output":"FAIL\\texample.com/gox/ok\\t0.009s\\n","OutputType":"frame"}',
    '{"Action":"fail","Package":"example.com/gox/ok","Elapsed":0.011}',
].join("\n");

const GO_MERGE = [
    '{"Action":"pass","Package":"example.com/gox/broken","Test":"TestY","Elapsed":0}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestAdd","Elapsed":0}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestOld","Elapsed":0}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestPanic","Elapsed":0}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestSub/inner","Elapsed":0}',
    '{"Action":"pass","Package":"example.com/gox/ok","Test":"TestSub","Elapsed":0}',
].join("\n");

test("go: --- FAIL in a package that built is an assertion; a panic is not; a build failure breaks the package", () => {
    const { tests, broken } = goOutcome(GO_PARENT);

    assert.deepEqual([...broken], ["example.com/gox/broken"]);
    assert.equal(tests.get("example.com/gox/ok\0TestAdd"), "assertion");
    assert.equal(tests.get("example.com/gox/ok\0TestOld"), "pass");
    assert.equal(tests.get("example.com/gox/ok\0TestPanic"), "fail");
});

test("go: the valid names of the hidden files", () => {
    const files = ["ok/a_test.go", "broken/b_test.go"];
    const goNames = {
        "ok/a_test.go": ["TestAdd", "TestOld", "TestPanic", "TestSub"],
        "broken/b_test.go": ["TestY"],
    };
    const module = "example.com/gox";
    const parent = goFileOutcome(GO_PARENT, { files, goNames, module });
    const merge = goFileOutcome(GO_MERGE, { files, goNames, module });
    const { valid, dropped } = classify({ files, parent, merge });

    assert.deepEqual([...valid], [["ok/a_test.go", ["TestAdd"]]]);

    const reasons = Object.fromEntries(dropped.map((d) => [d.name, d.reason]));

    assert.match(reasons.TestY, /does not compile/);
    assert.match(reasons.TestOld, /passes at the parent/);
    assert.match(reasons.TestPanic, /not fail by an assertion/);
    assert.match(
        reasons.TestSub,
        /missing/,
        "a test that did not run (the panic ended the binary)",
    );
});

test("go: test names, discovery and hidden commands", () => {
    const text = [
        "package ok",
        'import "testing"',
        "func TestAdd(t *testing.T) {}",
        "func Testable(t *testing.T) {}",
        "func TestMain(m *testing.M) {}",
        "func helper(t *testing.T) {}",
        "func Test_under(tt *testing.T) {}",
    ].join("\n");

    assert.deepEqual(goTestNames(text), ["TestAdd", "Test_under"]);
    assert.equal(
        discoveryCommand("go", ["a_test.go", "pkg/b_test.go"], {
            goNames: { "a_test.go": ["TestA"], "pkg/b_test.go": ["TestB", "TestC"] },
        }),
        "go test -json -count=1 -run '^(?:TestA)$' ./; go test -json -count=1 -run '^(?:TestB|TestC)$' ./pkg",
    );
    assert.equal(
        hiddenCommand([
            { file: "pkg/b_test.go", language: "go", names: ["TestB"] },
            { file: "pkg/c_test.go", language: "go", names: ["TestC"] },
            { file: "a_test.go", language: "go", names: ["TestA"] },
        ]),
        "go test -count=1 -run '^(?:TestA)$' ./ && go test -count=1 -run '^(?:TestB|TestC)$' ./pkg",
    );
});

// pytest's junit XML: an assertion failure, an exception, a setup error, a pass, a parametrized pass in a class,
// and a collection error of another module.
const JUNIT_PARENT = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="2" failures="2" tests="6">
<testcase classname="tests.test_fleet" name="test_count" time="0.001"><failure message="assert 2 == 3&#10; +  where 2 = count()">def test_count():
&gt;       assert count() == 3
E       assert 2 == 3

tests/test_fleet.py:4: AssertionError</failure></testcase>
<testcase classname="tests.test_fleet" name="test_zero" time="0.001"><failure message="ZeroDivisionError: division by zero">tests/test_fleet.py:7: ZeroDivisionError</failure></testcase>
<testcase classname="tests.test_fleet" name="test_fixture" time="0.001"><error message="failed on setup with &quot;fixture 'db' not found&quot;">fixture 'db' not found</error></testcase>
<testcase classname="tests.test_fleet" name="test_same" time="0.001" />
<testcase classname="tests.test_fleet.TestHosts" name="test_name[a-b]" time="0.001"><failure message="AssertionError: wrong" type="AssertionError">x</failure></testcase>
<testcase classname="" name="tests.test_new" time="0.000"><error message="collection failure">ImportError while importing test module 'tests/test_new.py'.
E   ImportError: cannot import name 'route' from 'fleet'</error></testcase>
</testsuite></testsuites>`;

const JUNIT_MERGE = `<testsuites><testsuite name="pytest">
<testcase classname="tests.test_fleet" name="test_count" time="0.001"/>
<testcase classname="tests.test_fleet" name="test_zero" time="0.001"/>
<testcase classname="tests.test_fleet" name="test_fixture" time="0.001"/>
<testcase classname="tests.test_fleet" name="test_same" time="0.001"/>
<testcase classname="tests.test_fleet.TestHosts" name="test_name[a-b]" time="0.001"/>
<testcase classname="tests.test_new" name="test_route" time="0.001"/>
</testsuite></testsuites>`;

test("pytest: an assertion failure is valid; an exception, a setup error and a collection error are not", () => {
    const files = ["tests/test_fleet.py", "tests/test_new.py"];
    const parent = pytestOutcome(JUNIT_PARENT, files);
    const merge = pytestOutcome(JUNIT_MERGE, files);

    assert.deepEqual([...parent.broken], ["tests/test_new.py"]);

    const { valid, dropped } = classify({ files, parent, merge });

    assert.deepEqual(
        [...valid],
        [
            [
                "tests/test_fleet.py",
                [
                    "tests/test_fleet.py::TestHosts::test_name[a-b]",
                    "tests/test_fleet.py::test_count",
                ],
            ],
        ],
    );

    const reasons = Object.fromEntries(dropped.map((d) => [d.name.split("::").pop(), d.reason]));

    assert.match(reasons.test_zero, /not fail by an assertion/);
    assert.match(reasons.test_fixture, /not fail by an assertion/);
    assert.match(reasons.test_same, /passes at the parent/);
    assert.match(reasons.test_route, /does not compile/);
    assert.equal(
        hiddenCommand(
            [...valid].map(([file, names]) => ({ file, language: "python", names })),
            { prefix: "PATH=/cache/venv/bin:$PATH " },
        ),
        "PATH=/cache/venv/bin:$PATH /cache/venv/bin/python -m pytest -p no:cacheprovider -q 'tests/test_fleet.py::TestHosts::test_name[a-b]' 'tests/test_fleet.py::test_count'",
    );
});

test("hidden files: tests by name, support files under testdata/ or fixtures/, deleted files left out", () => {
    const changed = parseNameStatus(
        [
            "M\tpkg/a_test.go",
            "A\tteam.test.ts",
            "A\tbench/x.test.mjs",
            "A\ttests/test_x.py",
            "D\told_test.go",
            "M\tpkg/testdata/in.json",
            "A\tbench/fixtures/helpers.mjs",
            "M\tlib.mjs",
            "A\tx.test.js",
        ].join("\n"),
    );
    const { tests, support } = hiddenFiles(changed);

    assert.deepEqual(tests, [
        { file: "bench/x.test.mjs", language: "node" },
        { file: "pkg/a_test.go", language: "go" },
        { file: "team.test.ts", language: "node" },
        { file: "tests/test_x.py", language: "python" },
    ]);
    assert.deepEqual(support, ["bench/fixtures/helpers.mjs", "pkg/testdata/in.json"]);
});

test("proposed commands: link.mjs, npm, go, python; check by Makefile test, verify, npm test, go, pytest", () => {
    assert.deepEqual(
        makeTargets("a b: c\nverify: x\nX := 1\n\ttest: no\n"),
        new Set(["a", "b", "verify"]),
    );
    assert.deepEqual(
        proposeCommands({
            files: ["link.mjs", "package.json", "Makefile"],
            makefile: "verify: lint\n",
            packageJson: JSON.stringify({
                scripts: { link: "node link.mjs", test: "node --test" },
            }),
        }),
        {
            setup: "PI_POCKET_CHECKOUT=/pocket node link.mjs",
            check: "PI_POCKET_CHECKOUT=/pocket make verify",
            prefix: "PI_POCKET_CHECKOUT=/pocket ",
        },
    );
    assert.deepEqual(
        proposeCommands({
            files: ["package.json"],
            packageJson: JSON.stringify({ scripts: { test: "x" } }),
        }),
        { setup: "npm ci", check: "npm test", prefix: "" },
    );
    assert.deepEqual(
        proposeCommands({
            files: ["go.mod", "Makefile"],
            makefile: "test: ## run\n\tgo test ./...\n",
        }),
        { setup: "go mod download", check: "make test", prefix: "" },
    );
    assert.deepEqual(proposeCommands({ files: ["go.mod"] }), {
        setup: "go mod download",
        check: "go test ./...",
        prefix: "",
    });

    const python = proposeCommands({ files: ["requirements-dev.txt", "pyproject.toml"] });

    assert.equal(
        python.setup,
        "python3 -m venv /cache/venv && /cache/venv/bin/pip install -q -r requirements-dev.txt -e . pytest",
    );
    assert.equal(python.check, "PATH=/cache/venv/bin:$PATH /cache/venv/bin/python -m pytest");
    assert.equal(proposeCommands({ files: ["README.md"] }).check, null);
});

test("node: the name pattern runs exactly the named top-level tests (Node 24 behavior, run for real)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hidden-"));

    t.after(() => rm(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "lib.mjs"), "export const add = (a, b) => a - b;\n");
    writeFileSync(
        join(dir, "a.test.mjs"),
        [
            'import assert from "node:assert/strict";',
            'import { describe, it, test } from "node:test";',
            'import { add } from "./lib.mjs";',
            'test("adds (1+2) [x]", () => assert.equal(add(1, 2), 3));',
            'test("stable", () => assert.equal(1, 1));',
            'test("throws", () => { if (add(1, 2) !== 3) throw new TypeError("no"); });',
            'test("parent", async (t) => { await t.test("child", () => assert.ok(add(1, 1) === 2)); });',
            'describe("suite", () => { it("leaf", () => assert.equal(add(2, 2), 4)); });',
        ].join("\n"),
    );
    writeFileSync(
        join(dir, "b.test.mjs"),
        'import { mul } from "./lib.mjs";\nimport { test } from "node:test";\ntest("mul", () => mul);\n',
    );

    const files = ["a.test.mjs", "b.test.mjs"];
    // The inner runner must not see the outer one's context (it would report to it, not as TAP).
    const env = { ...process.env };

    delete env.NODE_TEST_CONTEXT;

    const run = (command) =>
        spawnSync("bash", ["-c", command], { cwd: dir, encoding: "utf8", env });
    const { units, broken } = nodeOutcome(run(discoveryCommand("node", files)).stdout, files);

    assert.deepEqual([...broken], ["b.test.mjs"], "a missing export is a load failure");
    assert.deepEqual(Object.fromEntries(units.get("a.test.mjs")), {
        "adds (1+2) [x]": "assertion",
        stable: "pass",
        throws: "fail",
        parent: "assertion",
        suite: "assertion",
    });

    // Only the named top-level tests run: "stable" is not named, so a pattern of the failing tests passes nothing.
    const named = hiddenCommand([
        { file: "a.test.mjs", language: "node", names: ["adds (1+2) [x]", "parent"] },
    ]);
    const tap = run(`${named.replace("node --test", "node --test --test-reporter=tap")}`).stdout;
    const ran = [...tap.matchAll(/^(?:not )?ok \d+ - (.*)$/gm)].map((m) => m[1]);

    assert.deepEqual(ran.sort(), ["adds (1+2) [x]", "parent"]);
    assert.equal(escapeRegex("a.b(c)"), "a\\.b\\(c\\)");

    // A subtest name alone selects nothing: its parent never starts.
    const child = run(
        "node --test --test-reporter=tap --test-name-pattern='^parent child$' a.test.mjs",
    );

    assert.doesNotMatch(child.stdout, /ok \d+ - child/);
});
