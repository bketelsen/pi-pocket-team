// Hidden tests (plan section Scoring, S2) and the proposed commands of a task.
//
// Hidden tests are the reference PR's added or changed test files (`*_test.go`, `*.test.ts`, `*.test.mjs`,
// `test_*.py`) and its support files under a `testdata/` or `fixtures/` folder. At harvest they run, with a
// machine-readable reporter, at the parent with the files copied over it and at the merge. A test name is valid only
// when it fails by an assertion at the parent and passes at the merge: a test that does not compile or load at the
// parent (it uses an API that the reference made) is dropped, so an alternative implementation never fails on a name.
//
// The unit of a name, per language:
// - Node: a top-level test (a `test()` or a `describe()` suite). Node 24 matches `--test-name-pattern` against a test
//   when it starts; a `t.test()` subtest exists only while its parent runs, so a pattern that names only a subtest
//   runs nothing, and a pattern that names the parent runs all its subtests. The pattern `^(?:a|b)$` therefore runs
//   exactly the named top-level tests of the named files.
// - Go: a top-level `func TestX(t *testing.T)` declared in a hidden file; `-run '^(?:TestX)$'` runs it and its
//   subtests, 1 `go test` per package. A file belongs to the module of the nearest `go.mod` at or above its folder; a
//   package of a nested module runs as `go -C <module folder> test ... ./<folder in the module>`.
// - pytest: a node id (`file::Class::name`), given to pytest as it is.

/** A support file of the hidden tests. */
const SUPPORT = /(?:^|\/)(?:testdata|fixtures)\//;

/** The language of a hidden test file, or null. Support files have none. */
export function testLanguage(file) {
    if (SUPPORT.test(file)) {
        return null;
    }

    const base = file.split("/").pop();

    if (/_test\.go$/.test(base)) {
        return "go";
    }

    if (/\.test\.(?:ts|mjs)$/.test(base)) {
        return "node";
    }

    if (/^test_.*\.py$/.test(base)) {
        return "python";
    }

    return null;
}

/**
 * The hidden files of a change: `changed` is `[{ status, path }]` from `git diff --name-status` (A, M, T count; D
 * does not). Returns `{ tests: [{ file, language }], support: [file] }`, sorted by path.
 */
export function hiddenFiles(changed) {
    const kept = changed
        .filter(({ status }) => /^[AMT]/.test(status))
        .map(({ path }) => path)
        .sort();

    return {
        tests: kept.flatMap((file) => {
            const language = testLanguage(file);

            return language ? [{ file, language }] : [];
        }),
        support: kept.filter((file) => SUPPORT.test(file)),
    };
}

/** Parse `git diff --name-status` output into `[{ status, path }]` (a rename's new path). */
export const parseNameStatus = (text) =>
    text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const parts = line.split("\t");

            return { status: parts[0], path: parts.at(-1) };
        });

/** A word as 1 shell argument (single quotes). */
export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/** Text as a regular expression body that matches it exactly. */
export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern that matches exactly these names. */
export const exactPattern = (names) => `^(?:${names.map(escapeRegex).join("|")})$`;

// ---------------------------------------------------------------------------------------------------------------
// Proposed commands
// ---------------------------------------------------------------------------------------------------------------

/** The targets of a Makefile (rule lines; `:=` and `::=` assignments are not rules). */
export function makeTargets(text) {
    const targets = new Set();

    for (const line of String(text ?? "").split("\n")) {
        const match = /^([A-Za-z0-9_.%/ -]+?)\s*:(?![:=])/.exec(line);

        if (match && !line.startsWith("\t")) {
            for (const name of match[1].split(/\s+/)) {
                targets.add(name);
            }
        }
    }

    return targets;
}

/** The venv of a Python repository: in the sandbox's cache, never in `/work`. */
export const VENV = "/cache/venv";

/**
 * The setup and check commands of a repository, from its top-level files at the merge commit. `files`: the top-level
 * names; `makefile` and `packageJson`: the text of those files, or null. Returns `{ setup, check, prefix }`; `check`
 * is null when nothing fits. `prefix` goes before every command that runs the repository's tests.
 */
export function proposeCommands({ files, makefile = null, packageJson = null }) {
    const has = (name) => files.includes(name);
    let pkg = null;

    try {
        pkg = packageJson ? JSON.parse(packageJson) : null;
    } catch {
        pkg = null;
    }

    const scripts = pkg?.scripts ?? {};
    const python = has("pyproject.toml") || has("requirements.txt") || has("requirements-dev.txt");
    let setup = "true";
    let prefix = "";

    if (has("link.mjs") && typeof scripts.link === "string") {
        setup = "PI_POCKET_CHECKOUT=/pocket node link.mjs";
        prefix = "PI_POCKET_CHECKOUT=/pocket ";
    } else if (pkg) {
        setup = "npm ci";
    } else if (has("go.mod")) {
        setup = "go mod download";
    } else if (python) {
        const installs = [
            ...(has("requirements.txt") ? ["-r requirements.txt"] : []),
            ...(has("requirements-dev.txt") ? ["-r requirements-dev.txt"] : []),
            ...(has("pyproject.toml") ? ["-e ."] : []),
        ];

        setup = `python3 -m venv ${VENV} && ${VENV}/bin/pip install -q ${installs.join(" ")} pytest`;
        prefix = `PATH=${VENV}/bin:$PATH `;
    }

    const targets = makeTargets(has("Makefile") ? makefile : "");
    let check = null;

    if (targets.has("test")) {
        check = "make test";
    } else if (targets.has("verify")) {
        check = "make verify";
    } else if (typeof scripts.test === "string") {
        check = "npm test";
    } else if (has("go.mod")) {
        check = "go test ./...";
    } else if (python) {
        check = `${VENV}/bin/python -m pytest`;
    }

    return { setup, check: check === null ? null : `${prefix}${check}`, prefix };
}

// ---------------------------------------------------------------------------------------------------------------
// Commands of the hidden tests
// ---------------------------------------------------------------------------------------------------------------

/** The line before each file's TAP in the Node discovery output. */
export const FILE_MARK = "# bench-file: ";

/** The junit file pytest writes at discovery, in the sandbox's cache. */
export const JUNIT = "/cache/hidden-junit.xml";

/** The folder of a file (`.` at the top). */
const dirOf = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");

/** A Go package argument for a folder. */
const goPackage = (dir) => (dir === "." ? "./" : `./${dir}`);

/** A word as written when it needs no quotes (a plain path), else single-quoted. */
const plainWord = (text) => (/^[A-Za-z0-9_./-]+$/.test(text) ? text : shellQuote(text));

/** The folders at and above a file's folder, nearest first, `.` last. */
export function folderChain(file) {
    const chain = [];
    let dir = dirOf(file);

    while (dir !== ".") {
        chain.push(dir);
        dir = dirOf(dir);
    }

    chain.push(".");

    return chain;
}

/**
 * The Go module of a file: the nearest folder at or above the file's folder that holds a `go.mod`. `goMods`: module
 * folder -> module path (null for a `go.mod` with no `module` line), for every folder of the tree that holds a
 * `go.mod`. Returns `{ dir, module, pkgDir }` (`pkgDir`: the file's folder relative to the module folder), or null
 * when no folder above the file holds a `go.mod`.
 */
export function goModuleOf(file, goMods) {
    const dir = folderChain(file).find((d) => Object.hasOwn(goMods, d));

    if (dir === undefined) {
        return null;
    }

    const own = dirOf(file);
    const pkgDir = dir === "." ? own : own === dir ? "." : own.slice(dir.length + 1);

    return { dir, module: goMods[dir], pkgDir };
}

/**
 * The Go test files grouped by package: `[{ moduleDir, pkgDir, names }]` in the order of `files`; a file with no
 * module (or a module with no path) or no names is left out. Without `goMods`, every file is in the root module.
 */
function goGroups(files, goNames, goMods) {
    const groups = new Map();

    for (const file of files) {
        const names = goNames[file] ?? [];
        const mod = goMods ? goModuleOf(file, goMods) : { dir: ".", pkgDir: dirOf(file) };

        if (!names.length || !mod || (goMods && !mod.module)) {
            continue;
        }

        const key = `${mod.dir}\0${mod.pkgDir}`;
        const group = groups.get(key) ?? { moduleDir: mod.dir, pkgDir: mod.pkgDir, names: [] };

        group.names.push(...names);
        groups.set(key, group);
    }

    return [...groups.values()];
}

/** `go test` of a package, with `-C <module folder>` for a nested module (the root module keeps `go test`). */
const goTest = (prefix, moduleDir, flags, pkgDir) =>
    `${prefix}go ${moduleDir === "." ? "" : `-C ${plainWord(moduleDir)} `}test ${flags} ${goPackage(pkgDir)}`;

/** The `func TestX(t *testing.T)` names of a Go test file. */
export function goTestNames(text) {
    return [
        ...String(text).matchAll(/^func\s+(Test[A-Za-z0-9_]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm),
    ]
        .map((m) => m[1])
        .filter((name) => name === "Test" || /^Test[^a-z]/.test(name));
}

/**
 * The discovery command of 1 language: it runs every test of the hidden files with a machine-readable reporter.
 * Go: `go test -json` per package, limited to the names the files declare (`goNames`: file -> names); `goMods`
 * (module folder -> module path, `goModuleOf`) puts each package in its own module, and without it every file is in
 * the root module.
 */
export function discoveryCommand(
    language,
    files,
    { prefix = "", goNames = {}, goMods = null } = {},
) {
    if (language === "node") {
        // 1 run per file, after a marker line: Node's TAP gives no location for a test that passes.
        return files
            .map(
                (file) =>
                    `printf '%s\\n' ${shellQuote(`${FILE_MARK}${file}`)}; ${prefix}node --test --test-reporter=tap ${shellQuote(file)}`,
            )
            .join("; ");
    }

    if (language === "go") {
        const parts = goGroups(files, goNames, goMods).map(({ moduleDir, pkgDir, names }) =>
            goTest(
                prefix,
                moduleDir,
                `-json -count=1 -run ${shellQuote(exactPattern(names))}`,
                pkgDir,
            ),
        );

        return parts.length ? parts.join("; ") : null;
    }

    if (language === "python") {
        return `rm -f ${JUNIT}; ${prefix}${VENV}/bin/python -m pytest -p no:cacheprovider -q --junitxml=${JUNIT} ${files.map(shellQuote).join(" ")}`;
    }

    return null;
}

/**
 * The hidden command: it runs only the valid names. `valid`: `[{ file, language, names }]` with at least 1 name.
 * Languages run in the order node, go, python, joined with `&&`. Go: the packages of the root module first (in the
 * order of their folders), then those of nested modules by module folder and folder (`goMods` as in
 * `discoveryCommand`).
 */
export function hiddenCommand(valid, { prefix = "", goMods = null } = {}) {
    const parts = [];
    const node = valid.filter((v) => v.language === "node" && v.names.length);

    if (node.length) {
        const names = [...new Set(node.flatMap((v) => v.names))].sort();

        parts.push(
            `${prefix}node --test --test-name-pattern=${shellQuote(exactPattern(names))} ${node.map((v) => shellQuote(v.file)).join(" ")}`,
        );
    }

    const go = valid.filter((v) => v.language === "go" && v.names.length);
    const groups = goGroups(
        go.map((v) => v.file),
        Object.fromEntries(go.map((v) => [v.file, v.names])),
        goMods,
    );

    // The root module's packages keep the order (and the text) of a repository with 1 module.
    const root = groups
        .filter((g) => g.moduleDir === ".")
        .map((g) => [g.pkgDir, g.names])
        .sort();
    const nested = groups
        .filter((g) => g.moduleDir !== ".")
        .sort((a, b) =>
            a.moduleDir === b.moduleDir
                ? a.pkgDir.localeCompare(b.pkgDir, "en")
                : a.moduleDir.localeCompare(b.moduleDir, "en"),
        )
        .map((g) => [g.moduleDir, g.pkgDir, g.names]);

    for (const [moduleDir, pkgDir, names] of [
        ...root.map(([pkgDir, names]) => [".", pkgDir, names]),
        ...nested,
    ]) {
        parts.push(
            goTest(
                prefix,
                moduleDir,
                `-count=1 -run ${shellQuote(exactPattern([...new Set(names)].sort()))}`,
                pkgDir,
            ),
        );
    }

    const ids = valid.filter((v) => v.language === "python").flatMap((v) => v.names);

    if (ids.length) {
        parts.push(
            `${prefix}${VENV}/bin/python -m pytest -p no:cacheprovider -q ${ids.map(shellQuote).join(" ")}`,
        );
    }

    return parts.length ? parts.join(" && ") : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Reporters: Node's TAP, `go test -json`, pytest's junit XML
// ---------------------------------------------------------------------------------------------------------------

/** A TAP name as Node writes it, unescaped (`\#` and `\\`). */
const tapName = (text) => text.replace(/\\([#\\])/g, "$1");

/** A YAML scalar of Node's TAP diagnostics, without its quotes. */
function yamlScalar(raw) {
    const text = raw.trim();

    if (text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1).replaceAll("''", "'");
    }

    if (text.startsWith('"') && text.endsWith('"')) {
        try {
            return JSON.parse(text);
        } catch {
            return text.slice(1, -1);
        }
    }

    return text;
}

/**
 * Node's TAP as a tree: `[{ name, ok, skip, info: { location, code, name, failureType, exitCode }, children }]` at the
 * top level. Children come before their parent's result line, 4 spaces deeper.
 */
export function parseTap(text) {
    const pending = [[]];
    const lines = String(text).split("\n");
    let last = null;
    let inYaml = false;
    let yamlIndent = 0;

    for (const line of lines) {
        if (inYaml) {
            if (line.trim() === "...") {
                inYaml = false;
                continue;
            }

            const indent = line.length - line.trimStart().length;
            const field = /^\s*([A-Za-z]+):\s?(.*)$/.exec(line);

            if (last && field && indent === yamlIndent && !field[2].startsWith("|")) {
                last.info[field[1]] = yamlScalar(field[2]);
            }

            continue;
        }

        const result = /^( *)(not ok|ok) \d+(?: - (.*?))?(?: # (SKIP|TODO)\b.*)?$/i.exec(line);

        if (result) {
            const depth = Math.floor(result[1].length / 4);
            const node = {
                name: tapName(result[3] ?? ""),
                ok: result[2] === "ok",
                skip: Boolean(result[4]),
                info: {},
                children: pending[depth + 1] ?? [],
            };

            pending[depth + 1] = [];
            pending[depth] ??= [];
            pending[depth].push(node);
            last = node;
            continue;
        }

        if (last && /^ *---$/.test(line)) {
            inYaml = true;
            yamlIndent = line.length - line.trimStart().length;
        }
    }

    return pending[0];
}

/** The failing leaves of a TAP node: its own failure, or its failing subtests' when it failed only by them. */
function failingLeaves(node) {
    if (node.ok) {
        return [];
    }

    const kids = node.children.filter((child) => !child.ok);

    if (node.info.failureType === "subtestsFailed" && kids.length) {
        return kids.flatMap(failingLeaves);
    }

    return [node, ...kids.flatMap(failingLeaves)];
}

/** True when a TAP failure is an assertion (`ERR_ASSERTION` or `AssertionError`). */
const tapAssertion = (leaf) =>
    leaf.info.code === "ERR_ASSERTION" || leaf.info.name === "AssertionError";

/** The file of a TAP node, from its `location` (or a descendant's), among `files`; null when none matches. */
function tapFile(node, files) {
    const location = node.info.location?.replace(/:\d+:\d+$/, "");

    if (location) {
        const file = files.find((f) => location === f || location.endsWith(`/${f}`));

        if (file) {
            return file;
        }
    }

    for (const child of node.children) {
        const file = tapFile(child, files);

        if (file) {
            return file;
        }
    }

    return null;
}

/**
 * The outcome of Node's TAP for `files`: `{ units: Map(file -> Map(name -> status)), broken: Set(file) }`. A status is
 * `pass`, `assertion` (failed, every failing leaf by an assertion), `fail` (failed otherwise) or `skip`. A file entry
 * (a top-level result named as a file: Node reports a file that fails to load so) that failed is `broken`.
 */
export function nodeOutcome(text, files) {
    const units = new Map(files.map((f) => [f, new Map()]));
    const broken = new Set();

    const visit = (nodes, fileHint) => {
        for (const node of nodes) {
            if (files.includes(node.name)) {
                // A result named as a file: a file that failed to load (or ran no test), or, in an older Node, the
                // wrapper of each file's tests.
                if (node.children.length) {
                    visit(node.children, node.name);
                } else if (!node.ok) {
                    broken.add(node.name);
                }

                continue;
            }

            const file = fileHint ?? tapFile(node, files);

            if (!file) {
                continue;
            }

            const leaves = failingLeaves(node);
            const status = node.skip
                ? "skip"
                : node.ok
                  ? "pass"
                  : leaves.length && leaves.every(tapAssertion)
                    ? "assertion"
                    : "fail";

            units.get(file).set(node.name, status);
        }
    };

    // The discovery output: 1 TAP stream per file, each after a marker line. Text with no marker is 1 stream whose
    // tests are placed by their `location`.
    const segments = [];
    let current = { file: null, lines: [] };

    for (const line of String(text).split("\n")) {
        if (line.startsWith(FILE_MARK)) {
            segments.push(current);
            current = { file: line.slice(FILE_MARK.length), lines: [] };
        } else {
            current.lines.push(line);
        }
    }

    segments.push(current);

    for (const segment of segments) {
        if (segment.file !== null && !files.includes(segment.file)) {
            continue;
        }

        visit(parseTap(segment.lines.join("\n")), segment.file);
    }

    return { units, broken };
}

/** The import path of a package folder in a Go module. */
export const goImportPath = (module, dir) => (dir === "." ? module : `${module}/${dir}`);

/** The module path of a `go.mod` text, or null. */
export const goModule = (text) => /^module\s+(\S+)/m.exec(String(text ?? ""))?.[1] ?? null;

/**
 * The outcome of `go test -json`: `{ tests: Map("pkg\0Test" -> status), broken: Set(pkg) }`. A test's status is
 * `pass`, `assertion` (`--- FAIL` with no panic in its output or its subtests'), `fail` (a panic) or `skip`. A
 * package that did not build (`[build failed]`, `[setup failed]`, `build-fail`) is broken.
 */
export function goOutcome(text) {
    const tests = new Map();
    const panics = new Set();
    const broken = new Set();

    for (const line of String(text).split("\n")) {
        let event;

        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (event.Action === "build-fail" && event.ImportPath) {
            broken.add(event.ImportPath.replace(/ \[.*\]$/, ""));
            continue;
        }

        if (!event.Package) {
            continue;
        }

        const top = event.Test?.split("/")[0];

        if (!top) {
            if (
                (event.Action === "output" && /\[(?:build|setup) failed\]/.test(event.Output)) ||
                (event.Action === "fail" && event.FailedBuild)
            ) {
                broken.add(event.Package);
            }

            continue;
        }

        const key = `${event.Package}\0${top}`;

        if (event.Action === "output" && /^panic: /m.test(event.Output ?? "")) {
            panics.add(key);
        }

        if (event.Test === top && ["pass", "fail", "skip"].includes(event.Action)) {
            tests.set(key, event.Action);
        }
    }

    for (const [key, action] of tests) {
        tests.set(key, action === "fail" ? (panics.has(key) ? "fail" : "assertion") : action);
    }

    for (const key of panics) {
        if (!tests.has(key)) {
            tests.set(key, "fail");
        }
    }

    return { tests, broken };
}

/** XML text with its entities decoded. */
const unxml = (text) =>
    String(text ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
        .replace(/&amp;/g, "&");

/** The attributes of an XML start tag. */
function attributes(tag) {
    const out = {};

    for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
        out[match[1]] = unxml(match[2]);
    }

    return out;
}

/** The test cases of a junit XML file: `[{ classname, name, file, kind, type, message, body }]`. */
export function parseJunit(xml) {
    const cases = [];

    for (const match of String(xml).matchAll(
        /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
    )) {
        const attrs = attributes(match[1]);
        const inner = match[2] ?? "";
        const element = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
        const sub = element ? attributes(element[2]) : {};

        cases.push({
            classname: attrs.classname ?? "",
            name: attrs.name ?? "",
            file: attrs.file ?? null,
            kind: element ? element[1] : "pass",
            type: sub.type ?? null,
            message: sub.message ?? "",
            body: unxml(element?.[3] ?? ""),
        });
    }

    return cases;
}

/** True when a pytest failure is an assertion. */
function pytestAssertion(test) {
    return (
        test.kind === "failure" &&
        (test.type === "AssertionError" ||
            /^(?:AssertionError\b|assert\s)/.test(test.message) ||
            /^\S+:\d+: AssertionError$/m.test(test.body))
    );
}

/** A Python file as a module path (`tests/test_x.py` -> `tests.test_x`). */
const modulePath = (file) => file.replace(/\.py$/, "").replaceAll("/", ".");

/**
 * The outcome of pytest's junit XML for `files`: `{ units: Map(file -> Map(nodeId -> status)), broken: Set(file) }`.
 * A collection error (a test case named as the module, with an error) is a broken file; an `<error>` of a test is
 * `fail` (a setup error is no assertion).
 */
export function pytestOutcome(xml, files) {
    const units = new Map(files.map((f) => [f, new Map()]));
    const broken = new Set();
    const modules = files
        .map((file) => [file, modulePath(file)])
        .sort((a, b) => b[1].length - a[1].length);

    for (const test of parseJunit(xml)) {
        const whole = test.classname === "" ? modules.find(([, m]) => m === test.name) : null;

        if (whole) {
            if (test.kind === "error" || test.kind === "failure") {
                broken.add(whole[0]);
            }

            continue;
        }

        const owner = modules.find(
            ([, m]) => test.classname === m || test.classname.startsWith(`${m}.`),
        );

        if (!owner) {
            continue;
        }

        const [file, module] = owner;
        const klass = test.classname.slice(module.length + 1);
        const id = [file, ...(klass ? klass.split(".") : []), test.name].join("::");
        const status =
            test.kind === "pass"
                ? "pass"
                : test.kind === "skipped"
                  ? "skip"
                  : pytestAssertion(test)
                    ? "assertion"
                    : "fail";

        units.get(file).set(id, status);
    }

    return { units, broken };
}

// ---------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------

/**
 * The valid names of 1 language. `parent` and `merge`: `{ units: Map(file -> Map(name -> status)), broken: Set(file) }`
 * (the parent run had the hidden files copied over it). Returns `{ valid: Map(file -> names), dropped: [{ file, name,
 * reason }] }`. Valid: the file loads at the parent, the name fails by an assertion there, and passes at the merge.
 * A Node name in 2 files is valid only when it is valid in both (1 pattern runs it in every named file).
 */
export function classify({ files, parent, merge }) {
    const valid = new Map();
    const dropped = [];

    for (const file of files) {
        const names = new Set([
            ...(parent.units.get(file)?.keys() ?? []),
            ...(merge.units.get(file)?.keys() ?? []),
        ]);

        for (const name of [...names].sort()) {
            const atParent = parent.units.get(file)?.get(name) ?? "missing";
            const atMerge = merge.units.get(file)?.get(name) ?? "missing";
            let reason = null;

            if (parent.broken.has(file)) {
                reason = "does not compile or load at the parent";
            } else if (atParent === "pass") {
                reason = "passes at the parent";
            } else if (atParent !== "assertion") {
                reason = `does not fail by an assertion at the parent (${atParent})`;
            } else if (merge.broken.has(file) || atMerge !== "pass") {
                reason = `does not pass at the merge (${merge.broken.has(file) ? "broken" : atMerge})`;
            }

            if (reason) {
                dropped.push({ file, name, reason });
            } else {
                valid.set(file, [...(valid.get(file) ?? []), name]);
            }
        }
    }

    return { valid, dropped };
}

/** Drop a name valid in 1 file but present and not valid in another (Node: 1 pattern for all files). */
export function dropSharedNames(valid, dropped) {
    const bad = new Set(dropped.map((d) => d.name));

    for (const [file, names] of valid) {
        const kept = names.filter((name) => !bad.has(name));

        for (const name of names.filter((n) => bad.has(n))) {
            dropped.push({ file, name, reason: "the same name is not valid in another file" });
        }

        if (kept.length) {
            valid.set(file, kept);
        } else {
            valid.delete(file);
        }
    }

    return valid;
}

/**
 * The Go outcome per hidden file: `goNames` (file -> declared names) and the module give each name its package.
 * `goMods` (module folder -> module path, `goModuleOf`) maps each file to the import path of its own module; without
 * it, every file is in the root module `module`. Returns `{ units, broken }` like `nodeOutcome` (a file is broken when
 * its package did not build).
 */
export function goFileOutcome(text, { files, goNames, module = null, goMods = null }) {
    const { tests, broken: pkgs } = goOutcome(text);
    const units = new Map();
    const broken = new Set();

    for (const file of files) {
        const mod = goMods ? goModuleOf(file, goMods) : { dir: ".", module, pkgDir: dirOf(file) };
        const pkg = mod?.module ? goImportPath(mod.module, mod.pkgDir) : null;
        const map = new Map();

        for (const name of goNames[file] ?? []) {
            const status = pkg ? tests.get(`${pkg}\0${name}`) : null;

            if (status) {
                map.set(name, status);
            } else {
                map.set(name, "missing");
            }
        }

        units.set(file, map);

        if (pkgs.has(pkg)) {
            broken.add(file);
        }
    }

    return { units, broken };
}

// ---------------------------------------------------------------------------------------------------------------
// Reporters added to a reviewed hidden command (`--revalidate`)
// ---------------------------------------------------------------------------------------------------------------

/** The reason of a hidden command that revalidation cannot parse. */
const unsupported = (what) =>
    `the hidden command uses shell syntax that revalidation does not support: ${what}`;

/**
 * A hidden command as `&&` segments of shell words, quote-aware: single quotes, double quotes, backslash escapes.
 * Each word is `{ value, raw }`: `value` is the word as the shell gives it (quotes removed, no expansion), `raw` the
 * text as written (it keeps an expansion such as `$PATH` as the shell would do it). Only `&&` joins segments. A list
 * or pipe operator (`;`, `||`, `|`, `&`), a newline, a redirection (`<`, `>`), a subshell or group (`(`, `)`), or a
 * command substitution (a backtick, `$(`, also inside double quotes) gives `{ error }`.
 */
export function shellSegments(command) {
    const text = String(command);
    const segments = [[]];
    let word = null;
    let quote = null;

    const start = (i) => {
        word ??= { value: "", from: i };
    };

    const end = (i) => {
        if (word) {
            segments.at(-1).push({ value: word.value, raw: text.slice(word.from, i) });
            word = null;
        }
    };

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];

        if (quote === "'") {
            if (c === "'") {
                quote = null;
            } else {
                word.value += c;
            }

            continue;
        }

        if (quote === '"') {
            if (c === "`" || (c === "$" && text[i + 1] === "(")) {
                return { error: unsupported(c === "`" ? "`" : "$(") };
            }

            if (c === '"') {
                quote = null;
            } else if (c === "\\" && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1])) {
                word.value += text[i + 1];
                i += 1;
            } else {
                word.value += c;
            }

            continue;
        }

        if (c === "\\") {
            if (text[i + 1] === "\n" || i + 1 >= text.length) {
                return { error: unsupported("a backslash at the end of a line") };
            }

            start(i);
            word.value += text[i + 1];
            i += 1;
            continue;
        }

        if (c === "'" || c === '"') {
            start(i);
            quote = c;
            continue;
        }

        if (c === "\n") {
            return { error: unsupported("a newline") };
        }

        if (c === " " || c === "\t") {
            end(i);
            continue;
        }

        if (c === "&") {
            if (text[i + 1] === "&") {
                end(i);
                segments.push([]);
                i += 1;
                continue;
            }

            return { error: unsupported("&") };
        }

        if (c === "|") {
            return { error: unsupported(text[i + 1] === "|" ? "||" : "|") };
        }

        if (";<>()`".includes(c)) {
            return { error: unsupported(c) };
        }

        if (c === "$" && text[i + 1] === "(") {
            return { error: unsupported("$(") };
        }

        start(i);
        word.value += c;
    }

    if (quote) {
        return { error: unsupported(`an unclosed ${quote === "'" ? "single" : "double"} quote`) };
    }

    end(text.length);

    if (segments.some((segment) => segment.length === 0)) {
        return { error: unsupported("an empty command around &&") };
    }

    return { segments };
}

/** A word that the bench adds, quoted for the shell. */
const added = (value) => ({ value, raw: shellQuote(value) });

/** A segment's words as shell text: each word as it was written, each added word quoted. */
const shellText = (words) => words.map((w) => w.raw).join(" ");

/** The pytest junit file of discovery segment `i`, in the sandbox's cache. */
export const junitOf = (i) => `/cache/hidden-junit-${i}.xml`;

/** An environment assignment word (`NAME=value`) as written: its name is plain text. */
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw);

/**
 * The runner of a segment's words: `{ kind, at }` where `at` is the index of the word after which the reporter goes
 * (`go test` and `go -C <dir> test` or `go -C=<dir> test`: after `test`; `node --test`: after `--test`; pytest: at the
 * end), or null. The words before the program may only be environment assignments. `cd` is no runner.
 */
function runnerOf(words) {
    let p = 0;

    while (p < words.length && isAssignment(words[p])) {
        p += 1;
    }

    const program = words[p]?.value;
    const base = program?.split("/").pop();

    if (program === "go") {
        // `-C` must be go's first flag: `go -C dir test` or `go -C=dir test` (a nested module's folder).
        const flag = words[p + 1]?.value;
        const test = flag === "-C" ? p + 3 : flag?.startsWith("-C=") ? p + 2 : p + 1;

        return words[test]?.value === "test" ? { kind: "go", at: test } : null;
    }

    if (base === "node") {
        const test = words.findIndex((w, i) => i > p && w.value === "--test");

        return test > 0 ? { kind: "node", at: test, program: p } : null;
    }

    if (base === "pytest" || base === "py.test") {
        return { kind: "python", at: words.length - 1 };
    }

    if (
        /^python[0-9.]*$/.test(base ?? "") &&
        words[p + 1]?.value === "-m" &&
        words[p + 2]?.value === "pytest"
    ) {
        return { kind: "python", at: words.length - 1 };
    }

    return null;
}

/**
 * The discovery commands of a reviewed hidden command: each `&&` segment keeps every word as written (the
 * environment assignments, the flags, a loader, a name pattern), and gets the machine-readable reporter as a word at
 * its runner: `go test` gets `-json` after `test`; `node --test` gets `--test-reporter=tap` after `--test` (a reporter
 * of the owner's is taken out) and runs 1 named file at a time after a marker line (`FILE_MARK`); pytest gets
 * `--junitxml=<junitOf(i)>` at the end (a `--junitxml` of the owner's is taken out). `nodeFiles`: the named Node files.
 * Returns `{ node: [cmd], go: [cmd], python: [{ command, junit }] }`, or `{ error }`.
 */
export function reporterCommands(hiddenCommand, { nodeFiles = [] } = {}) {
    const parsed = shellSegments(hiddenCommand);

    if (parsed.error) {
        return { error: parsed.error };
    }

    const out = { node: [], go: [], python: [] };

    for (const [i, words] of parsed.segments.entries()) {
        const runner = runnerOf(words);

        if (!runner) {
            return { error: `cannot add a reporter to the hidden command: ${shellText(words)}` };
        }

        if (runner.kind === "go") {
            out.go.push(
                shellText([
                    ...words.slice(0, runner.at + 1),
                    added("-json"),
                    ...words.slice(runner.at + 1),
                ]),
            );
        } else if (runner.kind === "node") {
            const kept = [];

            for (let k = 0; k < words.length; k += 1) {
                const value = words[k].value;

                if (k > runner.program && /^--test-reporter(?:-destination)?$/.test(value)) {
                    k += 1;
                } else if (k > runner.program && /^--test-reporter(?:-destination)?=/.test(value)) {
                    // The owner's reporter: the bench's TAP reporter takes its place.
                } else if (k > runner.program && nodeFiles.includes(value)) {
                    // A named file: each runs on its own below.
                } else {
                    kept.push(words[k]);

                    if (k === runner.at) {
                        kept.push(added("--test-reporter=tap"));
                    }
                }
            }

            const present = nodeFiles.filter((file) =>
                words.some((w, k) => k > runner.program && w.value === file),
            );

            for (const file of present) {
                out.node.push(
                    `printf '%s\\n' ${shellQuote(`${FILE_MARK}${file}`)}; ${shellText([...kept, added(file)])}`,
                );
            }
        } else {
            const junit = junitOf(i);
            const kept = [];

            for (let k = 0; k < words.length; k += 1) {
                if (words[k].value === "--junitxml") {
                    k += 1;
                } else if (!words[k].value.startsWith("--junitxml=")) {
                    kept.push(words[k]);
                }
            }

            out.python.push({ command: shellText([...kept, added(`--junitxml=${junit}`)]), junit });
        }
    }

    return out;
}
