#!/usr/bin/env node
// The daily audit of pi-pocket-team operations. Read-only: it reads Pocket's database, GitHub, git and Odrade's
// notes, and writes exactly 2 files: `<out-dir>/README.md` and `<out-dir>/findings.json`.
//
//     node audit/daily.mjs [--hours 24] [--date YYYY-MM-DD] [--out-dir DIR] [--no-llm] [--no-github] [--json]
//
// Environment: PI_POCKET_DIR (default ~/.pi-pocket), ODRADE_DIR (default ~/projects/odrade). The default out
// folder is `$ODRADE_DIR/reports/<date>-daily-audit/`; earlier days are read from its sibling folders. See
// docs/plans/daily-audit.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { HOUR, newYorkDate } from "./common.mjs";
import { runChecks } from "./checks.mjs";
import { runLlm } from "./llm.mjs";
import {
    annotate,
    buildJson,
    compareDays,
    loadEarlier,
    renderReport,
    scrubJson,
    scrubMarkdown,
    totalsOf,
} from "./report.mjs";
import { defaultRun, loadData, makeGit } from "./sources.mjs";

const USAGE =
    "usage: node audit/daily.mjs [--hours N] [--date YYYY-MM-DD] [--out-dir DIR] [--no-llm] [--no-github] [--json]";

/** Read the command line. Throws an Error with the usage on a bad option. */
export function parseArgs(argv) {
    const options = { hours: 24, llm: true, github: true, json: false };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        const value = () => {
            i += 1;

            if (argv[i] === undefined) {
                throw new Error(`${arg} needs a value. ${USAGE}`);
            }

            return argv[i];
        };

        if (arg === "--hours") {
            options.hours = Number(value());

            if (!Number.isFinite(options.hours) || options.hours <= 0) {
                throw new Error(`--hours needs a number above 0. ${USAGE}`);
            }
        } else if (arg === "--date") {
            options.date = value();

            if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
                throw new Error(`--date needs YYYY-MM-DD. ${USAGE}`);
            }
        } else if (arg === "--out-dir") {
            options.outDir = value();
        } else if (arg === "--no-llm") {
            options.llm = false;
        } else if (arg === "--no-github") {
            options.github = false;
        } else if (arg === "--json") {
            options.json = true;
        } else {
            throw new Error(`unknown option ${arg}. ${USAGE}`);
        }
    }

    return options;
}

/** The audit's own last commit and its date, or null. The repo root is the parent folder of `audit/`. */
function codeVersion(run) {
    try {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
        const [commit, date] = makeGit(run ?? defaultRun)
            .call(root, ["log", "-1", "--format=%h%x09%cI"])
            .trim()
            .split("\t");

        return commit && date ? { commit, date } : null;
    } catch {
        return null;
    }
}

/**
 * Run the audit. Everything outside the process is injectable: `env`, `now`, `run` (the process runner of `gh` and
 * `git`), `getModel` (the LLM) and `log`. Returns `{ readme, json, outDir, line }`.
 */
export async function main(
    argv = process.argv.slice(2),
    { env = process.env, now = Date.now(), run, getModel, log = console.log } = {},
) {
    const options = parseArgs(argv);
    const date = options.date ?? newYorkDate(now);
    const pocketDir = env.PI_POCKET_DIR ?? path.join(os.homedir(), ".pi-pocket");
    const odradeDir = env.ODRADE_DIR ?? path.join(os.homedir(), "projects", "odrade");
    const outDir = path.resolve(
        options.outDir ?? path.join(odradeDir, "reports", `${date}-daily-audit`),
    );
    const ctx = { now, since: now - options.hours * HOUR, hours: options.hours };

    const data = loadData({
        pocketDir,
        odradeDir,
        now,
        hours: options.hours,
        useGithub: options.github,
        ...(run ? { run } : {}),
    });
    const result = runChecks(data, ctx);
    const earlier = loadEarlier(outDir, date);
    const findings = annotate(result.findings, earlier, data.installed, ctx.now);
    const llm = await runLlm({
        ranked: findings.filter((finding) => !finding.maybeFixed),
        metrics: result.metrics,
        pairs: result.pairs,
        earlier,
        enabled: options.llm,
        ...(getModel ? { getModel } : {}),
    });
    const totals = totalsOf(data, ctx, result.metrics);
    const github = { ...data.githubCalls };
    const code = codeVersion(run);
    const json = scrubJson(
        buildJson({
            date,
            ctx,
            installed: data.installed,
            code,
            findings,
            metrics: result.metrics,
            skipped: result.skipped,
            totals,
            github,
            llm,
        }),
    );
    const readme = scrubMarkdown(
        renderReport({
            date,
            ctx,
            code,
            findings,
            comparison: compareDays(findings, earlier),
            metrics: result.metrics,
            skipped: result.skipped,
            totals,
            github,
            llm,
        }),
    );

    // The only writes of the whole run: 2 files in the day's folder.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "README.md"), readme);
    fs.writeFileSync(path.join(outDir, "findings.json"), `${JSON.stringify(json, null, 2)}\n`);

    const line = `${path.join(outDir, "README.md")}: ${findings.length} findings, ${llm.proposals?.length ?? 0} proposals`;

    if (options.json) {
        log(JSON.stringify(json, null, 2));
        console.error(line);
    } else {
        log(line);
    }

    return { readme, json, outDir, line };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 2;
    });
}
