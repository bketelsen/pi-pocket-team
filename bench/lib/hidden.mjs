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
//   subtests, 1 `go test` per package.
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
 * Go: `go test -json` per package, limited to the names the files declare (`goNames`: file -> names).
 */
export function discoveryCommand(language, files, { prefix = "", goNames = {} } = {}) {
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
        const byDir = new Map();

        for (const file of files) {
            const names = goNames[file] ?? [];

            if (names.length) {
                byDir.set(dirOf(file), [...(byDir.get(dirOf(file)) ?? []), ...names]);
            }
        }

        const parts = [...byDir].map(
            ([dir, names]) =>
                `${prefix}go test -json -count=1 -run ${shellQuote(exactPattern(names))} ${goPackage(dir)}`,
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
 * Languages run in the order node, go, python, joined with `&&`.
 */
export function hiddenCommand(valid, { prefix = "" } = {}) {
    const parts = [];
    const node = valid.filter((v) => v.language === "node" && v.names.length);

    if (node.length) {
        const names = [...new Set(node.flatMap((v) => v.names))].sort();

        parts.push(
            `${prefix}node --test --test-name-pattern=${shellQuote(exactPattern(names))} ${node.map((v) => shellQuote(v.file)).join(" ")}`,
        );
    }

    const byDir = new Map();

    for (const v of valid.filter((v) => v.language === "go" && v.names.length)) {
        byDir.set(dirOf(v.file), [...(byDir.get(dirOf(v.file)) ?? []), ...v.names]);
    }

    for (const [dir, names] of [...byDir].sort()) {
        parts.push(
            `${prefix}go test -count=1 -run ${shellQuote(exactPattern([...new Set(names)].sort()))} ${goPackage(dir)}`,
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
 * The Go outcome per hidden file: `goNames` (file -> declared names) and the module path give each name its package.
 * Returns `{ units, broken }` like `nodeOutcome` (a file is broken when its package did not build).
 */
export function goFileOutcome(text, { files, goNames, module }) {
    const { tests, broken: pkgs } = goOutcome(text);
    const units = new Map();
    const broken = new Set();

    for (const file of files) {
        const pkg = goImportPath(module, dirOf(file));
        const map = new Map();

        for (const name of goNames[file] ?? []) {
            const status = tests.get(`${pkg}\0${name}`);

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

/** Split a shell command at `&&` outside quotes; each part trimmed. */
export function splitAnd(command) {
    const parts = [];
    let quote = null;
    let start = 0;
    const text = String(command);

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];

        if (quote) {
            if (c === "\\" && quote === '"') {
                i += 1;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === "\\") {
            i += 1;
        } else if (c === "'" || c === '"') {
            quote = c;
        } else if (c === "&" && text[i + 1] === "&") {
            parts.push(text.slice(start, i).trim());
            start = i + 2;
            i += 1;
        }
    }

    parts.push(text.slice(start).trim());

    return parts.filter((part) => part !== "");
}

/** A word of a command as it can be written: plain, or in single or double quotes. */
const wordPattern = (word) => {
    const body = escapeRegex(word);

    return new RegExp(`(^|\\s)(?:'${body}'|"${body}"|${body})(?=\\s|$)`, "g");
};

/** The pytest junit file of discovery segment `i`, in the sandbox's cache. */
export const junitOf = (i) => `/cache/hidden-junit-${i}.xml`;

/**
 * The discovery commands of a reviewed hidden command: each `&&` segment keeps every word (the environment prefix,
 * the flags, a loader), and gets the machine-readable reporter at its runner: `go test` gets `-json`; `node --test`
 * gets the TAP reporter and runs 1 named file at a time after a marker line (`FILE_MARK`); pytest gets
 * `--junitxml=<junitOf(i)>`. `nodeFiles`: the named Node files. Returns `{ node: [cmd], go: [cmd], python: [{ command,
 * junit }] }`, or `{ error }` for a segment with no runner found.
 */
export function reporterCommands(hiddenCommand, { nodeFiles = [] } = {}) {
    const out = { node: [], go: [], python: [] };

    for (const [i, segment] of splitAnd(hiddenCommand).entries()) {
        if (/(^|\s)go\s+test(?=\s|$)/.test(segment)) {
            out.go.push(segment.replace(/(^|\s)go\s+test(?=\s|$)/, "$1go test -json"));
        } else if (/(^|\s)node(?=\s)/.test(segment) && /(^|\s)--test(?=\s|$)/.test(segment)) {
            const bare = segment
                .replace(/(^|\s)--test-reporter(?:-destination)?(?:=\S+|\s+\S+)(?=\s|$)/g, "$1")
                .replace(/(^|\s)--test(?=\s|$)/, "$1--test --test-reporter=tap");
            const present = nodeFiles.filter((file) => wordPattern(file).test(segment));
            const others = present
                .reduce((text, file) => text.replace(wordPattern(file), "$1"), bare)
                .trimEnd();

            for (const file of present) {
                out.node.push(
                    `printf '%s\\n' ${shellQuote(`${FILE_MARK}${file}`)}; ${others} ${shellQuote(file)}`,
                );
            }
        } else if (/(^|[\s/])(?:pytest|py\.test)(?=\s|$)/.test(segment)) {
            const junit = junitOf(i);

            out.python.push({
                command: `${segment.replace(/(^|\s)--junitxml(?:=\S+|\s+\S+)(?=\s|$)/g, "$1").trimEnd()} --junitxml=${junit}`,
                junit,
            });
        } else {
            return { error: `cannot add a reporter to the hidden command: ${segment}` };
        }
    }

    return out;
}
