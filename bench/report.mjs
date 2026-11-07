#!/usr/bin/env node
// The summary of a stage's results, in Markdown: per model, attempts, failures by kind (limit, provider, harness,
// partial usage), list cost, input, output and cache tokens, median and max wall time; then the total cost.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { STAGES, resultsDir } from "./lib/common.mjs";
import { loadResults, markdownTable, summarize } from "./lib/report.mjs";

const USAGE = `usage: node bench/report.mjs --stage <${STAGES.join("|")}> [--results <dir>]`;

let values;

try {
    ({ values } = parseArgs({
        options: { stage: { type: "string" }, results: { type: "string" } },
    }));
} catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(1);
}

if (!STAGES.includes(values.stage)) {
    console.error(USAGE);
    process.exit(1);
}

const results = await loadResults(join(resultsDir(values.results), values.stage));

console.log(`# Bench ${values.stage}: ${results.length} attempt(s)\n`);
console.log(markdownTable(summarize(results)));
