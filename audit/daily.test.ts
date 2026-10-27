// The audit end to end: `main` on the invented database, with a temporary Odrade folder, a fake process runner and a
// fake model. It writes 2 files in the day's folder and nothing else.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HOUR } from "./common.mjs";
import { defaultOdradeDir, main, parseArgs } from "./daily.mjs";
import { NOW } from "./fixtures/builders.mjs";
import { createFixtureDb } from "./fixtures/pocket-db.mjs";

/** Every file under a folder, with its hash. */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};

    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const file = path.join(entry.parentPath, entry.name);

            out[path.relative(dir, file)] = createHash("sha256")
                .update(fs.readFileSync(file))
                .digest("hex");
        }
    }

    return out;
}

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-e2e-"));
    const pocketDir = path.join(root, "pocket");
    const odradeDir = path.join(root, "odrade");
    const reports = path.join(odradeDir, "reports");
    const outDir = path.join(reports, "2026-10-23-daily-audit");

    fs.mkdirSync(pocketDir);
    fs.mkdirSync(path.join(reports, "2026-10-22-notes"), { recursive: true });
    fs.writeFileSync(path.join(odradeDir, "README.md"), "- reports/2026-10-22-notes");
    createFixtureDb(path.join(pocketDir, "pocket.sqlite"), NOW);

    // The folder of the day already holds another file, which the audit must leave alone.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "branch-cleanup.md"), "Brian's commands\n");

    // 2 earlier days: A1:T1 was there both days; X9 only yesterday.
    for (const [date, ids] of [
        ["2026-10-21", ["A1:T1"]],
        ["2026-10-22", ["A1:T1", "X9"]],
    ] as const) {
        const dir = path.join(reports, `${date}-daily-audit`);

        fs.mkdirSync(dir);
        fs.writeFileSync(
            path.join(dir, "findings.json"),
            JSON.stringify({ findings: ids.map((id) => ({ id })), llm: { cost: 0.01 } }),
        );
    }

    const calls: { command: string; args: string[] }[] = [];

    const run = (command: string, args: string[]) => {
        calls.push({ command, args });

        if (command === "git" && args.includes("log")) {
            // The audit's own commit, as `--format=%h%x09%cI` prints it.
            if (args.some((arg) => arg.includes("%h%x09%cI"))) {
                return "abc1234\t2026-10-23T13:11:11-04:00\n";
            }

            return new Date(NOW - 2 * HOUR).toISOString();
        }

        if (command === "git" && args.includes("status")) {
            return "?? reports/2026-10-23-daily-audit/\n";
        }

        throw new Error(`the audit ran ${command} ${args.join(" ")}`);
    };

    return {
        root,
        pocketDir,
        odradeDir,
        homesDir: path.join(root, "agents"),
        reports,
        outDir,
        calls,
        run,
        env: {
            PI_POCKET_DIR: pocketDir,
            ODRADE_DIR: odradeDir,
            // A temporary homes folder: a folder that does not exist gives no homes, and no real one is read.
            TEAM_HOMES_DIR: path.join(root, "agents"),
        },
    };
}

const fakeModel = (answer: object) => {
    const calls: string[] = [];

    return {
        calls,
        getModel: async () => ({
            model: { cost: { input: 0.3, output: 1.2 } },
            complete: async (_system: string, content: string) => {
                calls.push(content);

                return {
                    content: [{ type: "text", text: JSON.stringify(answer) }],
                    usage: { input: 900, output: 120, cost: { total: 0.0004 } },
                    stopReason: "stop",
                };
            },
        }),
    };
};

const answer = {
    pairs: [],
    summary: "T1 reopened 2 times.",
    proposals: [
        { title: "Stop the reopen churn", text: "T1 reopened 2 times in 24 h.", cites: ["A1:T1"] },
    ],
};

test("parseArgs: the defaults and each option", () => {
    assert.deepEqual(parseArgs([]), { hours: 24, llm: true, github: true, json: false });
    assert.deepEqual(
        parseArgs([
            "--hours",
            "72",
            "--date",
            "2026-10-24",
            "--out-dir",
            "/x",
            "--no-llm",
            "--no-github",
            "--json",
        ]),
        { hours: 72, date: "2026-10-24", outDir: "/x", llm: false, github: false, json: true },
    );
});

test("parseArgs: a bad option throws; --state-dir is gone", () => {
    for (const argv of [
        ["--state-dir", "/x"],
        ["--bogus"],
        ["--hours"],
        ["--hours", "0"],
        ["--hours", "x"],
        ["--date", "tomorrow"],
        ["--out-dir"],
    ]) {
        assert.throws(() => parseArgs(argv), /usage: node audit\/daily\.mjs/, argv.join(" "));
    }
});

test("main writes exactly README.md and findings.json in the day's folder, and touches nothing else", async () => {
    const t = setup();
    const before = snapshot(t.root);
    const lines: string[] = [];
    const model = fakeModel(answer);
    const result = await main(["--no-github", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: model.getModel,
        log: (line: string) => lines.push(line),
    });
    const after = snapshot(t.root);

    // The only files that changed or appeared: the 2 outputs.
    const changed = Object.keys(after)
        .filter((file) => before[file] !== after[file])
        .sort();

    assert.deepEqual(
        changed,
        [
            path.join("odrade", "reports", "2026-10-23-daily-audit", "README.md"),
            path.join("odrade", "reports", "2026-10-23-daily-audit", "findings.json"),
        ].sort(),
    );
    assert.deepEqual(
        Object.keys(before).filter((file) => !(file in after)),
        [],
    );
    assert.deepEqual(fs.readdirSync(t.outDir).sort(), [
        "README.md",
        "branch-cleanup.md",
        "findings.json",
    ]);
    assert.equal(
        fs.readFileSync(path.join(t.outDir, "branch-cleanup.md"), "utf8"),
        "Brian's commands\n",
    );

    // The one line at the end: the path, the findings and the proposals.
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /README\.md: \d+ findings, 1 proposals$/);
    assert.equal(result.line, lines[0]);

    // Only git ran (never gh, with --no-github), and only log and status.
    assert.ok(t.calls.every((call) => call.command === "git"));
    assert.deepEqual([...new Set(t.calls.map((call) => call.args[3]))].sort(), ["log", "status"]);
});

test("main: the report holds the LLM proposal, the owner from the table, and the day compare", async () => {
    const t = setup();
    const model = fakeModel(answer);

    await main(["--no-github", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: model.getModel,
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");
    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));

    assert.match(readme, /^# Audit 2026-10-23 \(24 h to 10:00\)/);
    assert.match(readme, /T1 reopened 2 times\./);
    assert.match(
        readme,
        /1\. \*\*Stop the reopen churn\*\* \(`desk\.ts` \(rule\) or Odrade's workflow \(habit\), Sheeana \(code\), Odrade \(habit\), S\)/,
    );
    assert.match(readme, /\[A1:T1\]/);
    assert.match(readme, /- Repeating 3\+ days: `A1:T1`/);
    assert.match(readme, /- Gone since 2026-10-22: `X9`/);
    assert.match(readme, /Audit code: abc1234 \(2026-10-23T13:11:11-04:00\)\./);
    assert.match(readme, /LLM: deepseek\/deepseek-flash, 900 in, 120 out, \$0\.0004/);

    // The JSON: findings with rank, owner and repeat days; the LLM use; the skipped GitHub checks.
    const a1 = json.findings.find((f: { id: string }) => f.id === "A1:T1");

    assert.equal(json.version, 1);
    assert.equal(json.date, "2026-10-23");
    assert.deepEqual(json.code, { commit: "abc1234", date: "2026-10-23T13:11:11-04:00" });
    assert.equal(a1.repeatDays, 2);
    // medium 2 × (1 + log2(2 cases)) + 2 days it repeats + $1.25 of empty reopen / 5.
    assert.equal(a1.rank, 6.25);
    assert.equal(a1.owner, "Sheeana (code), Odrade (habit)");
    assert.equal(json.llm.inputTokens, 900);
    assert.equal(json.llm.cost, 0.0004);
    assert.match(json.skipped.B1, /source unavailable: github: disabled by --no-github/);
    assert.deepEqual(json.github, { calls: 0, capReached: false });
    assert.equal(json.skipped.A1, undefined);

    // The model got the finding text, and never a report body.
    assert.equal(model.calls.length, 1);
    assert.ok(!model.calls[0]!.includes("First report text"));
});

/** A `run` like `setup`'s, but with its own answer to the lookup of the audit's own commit. */
const codeRun = (codeLog: () => string) => (command: string, args: string[]) => {
    if (command === "git" && args.includes("log")) {
        return args.some((arg) => arg.includes("%h%x09%cI"))
            ? codeLog()
            : new Date(NOW - 2 * HOUR).toISOString();
    }

    if (command === "git" && args.includes("status")) {
        return "?? reports/2026-10-23-daily-audit/\n";
    }

    throw new Error(`the audit ran ${command} ${args.join(" ")}`);
};

test("main: a lookup of the audit's own commit that throws says unknown, and the run goes on", async () => {
    const t = setup();

    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: codeRun(() => {
            throw new Error("not a git repository");
        }),
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");
    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));

    assert.equal(json.code, null);
    assert.match(readme, /Audit code: unknown\./);
    assert.match(readme, /LLM: not used \(--no-llm\)\./);
});

test("main: a lookup of the audit's own commit with empty output says unknown", async () => {
    const t = setup();

    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: codeRun(() => ""),
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");
    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));

    assert.equal(json.code, null);
    assert.match(readme, /Audit code: unknown\./);
    assert.ok(!readme.includes("Audit code: ("), "no half line");
});

test("main: the report and the JSON hold no report body, no secret and no pair text", async () => {
    const t = setup();

    await main(["--no-github", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: fakeModel(answer).getModel,
        log: () => undefined,
    });

    for (const file of ["README.md", "findings.json"]) {
        const text = fs.readFileSync(path.join(t.outDir, file), "utf8");

        assert.ok(!text.includes("First report text"), file);
        assert.ok(!text.includes("[via linked session"), file);
        assert.ok(!/ghp_|github_pat_|sk-|AKIA|BEGIN|password=|token=/i.test(text), file);
        assert.ok(!text.includes(t.pocketDir), file);
    }
});

test("main --no-llm: the plain ranked list, with the reason, and no model call", async () => {
    const t = setup();
    const model = fakeModel(answer);

    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: model.getModel,
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");
    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));

    assert.equal(model.calls.length, 0);
    assert.match(readme, /None\. LLM text not used: --no-llm/);
    assert.match(readme, /None written\. The top findings by rank:/);
    assert.match(readme, /LLM: not used \(--no-llm\)\./);
    assert.equal(json.llm.used, false);
    assert.equal(json.llm.reason, "--no-llm");
});

test("main: an LLM answer that fails the checks falls back to the plain list and says why", async () => {
    const t = setup();
    const bad = {
        ...answer,
        proposals: [{ title: "x", text: "T1 reopened 999 times.", cites: ["A1:T1"] }],
    };

    await main(["--no-github", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: fakeModel(bad).getModel,
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");

    assert.match(
        readme,
        /LLM text failed the checks: no proposal passed the checks: proposal 1 the number 999 is in no cited finding/,
    );
    assert.match(readme, /None written\./);
    assert.ok(!readme.includes("999 times"));
});

test("main: the default folder is $ODRADE_DIR/reports/<date>-daily-audit, and --date sets the date", async () => {
    const t = setup();

    await main(["--no-github", "--no-llm", "--date", "2026-10-25"], {
        env: t.env,
        now: NOW,
        run: t.run,
        log: () => undefined,
    });

    const dir = path.join(t.reports, "2026-10-25-daily-audit");

    assert.deepEqual(fs.readdirSync(dir).sort(), ["README.md", "findings.json"]);
    assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /^# Audit 2026-10-25 /);
    // The earlier days are the sibling folders that hold a findings.json: the last one is 2026-10-22.
    assert.match(
        fs.readFileSync(path.join(dir, "README.md"), "utf8"),
        /Gone since 2026-10-22: `X9`/,
    );
});

test("the default ODRADE_DIR is Odrade's home folder when it exists, else her desk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-odrade-"));

    assert.equal(defaultOdradeDir({ HOME: root }), path.join(root, "projects", "odrade"));

    fs.mkdirSync(path.join(root, "agents", "odrade"), { recursive: true });

    assert.equal(defaultOdradeDir({ HOME: root }), path.join(root, "agents", "odrade"));
});

test("main: with no ODRADE_DIR and no TEAM_HOMES_DIR, the home folder of the user decides both", async () => {
    const t = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-home-"));
    const odradeHome = path.join(root, "agents", "odrade");

    fs.mkdirSync(path.join(odradeHome, "reports"), { recursive: true });
    fs.writeFileSync(path.join(odradeHome, "README.md"), "- reports/2026-10-22-notes");
    // The desk is there too: Odrade's home wins.
    fs.mkdirSync(path.join(root, "projects", "odrade", "reports"), { recursive: true });

    await main(["--no-github", "--no-llm", "--date", "2026-10-25"], {
        env: { HOME: root, PI_POCKET_DIR: t.pocketDir },
        now: NOW,
        run: t.run,
        log: () => undefined,
    });

    const dir = path.join(odradeHome, "reports", "2026-10-25-daily-audit");

    assert.deepEqual(fs.readdirSync(dir).sort(), ["README.md", "findings.json"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "projects", "odrade", "reports")), []);
    // The homes folder is `HOME/agents`: Odrade's home has no `.git`, so there is no home in it.
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8")).metrics.I3,
        { homes: 0, dirty: 0 },
    );
});

test("main: the date is the run date in New York", async () => {
    const t = setup();
    // 2026-10-24 01:30 UTC is 2026-10-23 21:30 in New York.
    const late = Date.UTC(2026, 9, 24, 1, 30);

    await main(["--no-github", "--no-llm"], {
        env: t.env,
        now: late,
        run: t.run,
        log: () => undefined,
    });

    assert.ok(fs.existsSync(path.join(t.reports, "2026-10-23-daily-audit", "findings.json")));
    assert.ok(!fs.existsSync(path.join(t.reports, "2026-10-24-daily-audit")));
});

test("main --json prints the JSON and leaves the one line to stderr", async () => {
    const t = setup();
    const printed: string[] = [];

    await main(["--no-github", "--no-llm", "--json", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        log: (text: string) => printed.push(text),
    });

    assert.equal(printed.length, 1);
    assert.equal(JSON.parse(printed[0]!).date, "2026-10-23");
});

test("main exits cleanly when a source is not available: the checks are skipped, the files are written", async () => {
    const t = setup();

    fs.rmSync(path.join(t.pocketDir, "pocket.sqlite"));
    fs.writeFileSync(path.join(t.pocketDir, "pocket.sqlite"), "not a database");

    const lines: string[] = [];

    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        log: (line: string) => lines.push(line),
    });

    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));
    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");

    assert.match(json.skipped.A1, /source unavailable: desk/);
    assert.match(json.skipped.A4, /source unavailable: entries/);
    assert.equal(json.skipped.I1, undefined);
    assert.match(readme, /## Skipped checks\n\n- A1: source unavailable/);
    assert.equal(lines.length, 1);
});

test("main runs twice on the same day and overwrites its 2 files", async () => {
    const t = setup();
    const options = { env: t.env, now: NOW, run: t.run, log: () => undefined };

    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], options);
    await main(["--no-github", "--no-llm", "--out-dir", t.outDir], options);

    assert.deepEqual(fs.readdirSync(t.outDir).sort(), [
        "README.md",
        "branch-cleanup.md",
        "findings.json",
    ]);
});

test("main: 1 bad proposal is dropped alone; the other stays, and the JSON and the report say why", async () => {
    const t = setup();
    const mixed = {
        ...answer,
        proposals: [
            ...answer.proposals,
            { title: "Bad one", text: "T1 reopened 42 times.", cites: ["A1:T1"] },
        ],
    };

    await main(["--no-github", "--out-dir", t.outDir], {
        env: t.env,
        now: NOW,
        run: t.run,
        getModel: fakeModel(mixed).getModel,
        log: () => undefined,
    });

    const readme = fs.readFileSync(path.join(t.outDir, "README.md"), "utf8");
    const json = JSON.parse(fs.readFileSync(path.join(t.outDir, "findings.json"), "utf8"));

    assert.match(readme, /1\. \*\*Stop the reopen churn\*\*/);
    assert.ok(!readme.includes("Bad one"));
    assert.match(
        readme,
        /Dropped by the checks: proposal 2 \(the number 42 is in no cited finding\)/,
    );
    assert.deepEqual(json.llm.dropped, [
        { item: "proposal 2", reason: "the number 42 is in no cited finding" },
    ]);
    assert.equal(json.llm.proposals.length, 1);
    assert.equal(json.llm.failed, undefined);
    assert.match(readme, /Spend \$\d+\.\d\d ·/);
});
