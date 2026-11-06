#!/usr/bin/env node
// The budget guard's command line: `set --budget <usd>`, `show`, `reap`. The data dir is env `BENCH_DATA`, else
// `~/.local/share/pi-pocket-team/bench`.
import { parseArgs } from "node:util";
import { dataDir } from "./lib/common.mjs";
import { describeSpend, readSpend, reap, setBudget } from "./lib/budget.mjs";

const USAGE = `usage: node bench/budget.mjs set --budget <usd>
       node bench/budget.mjs show
       node bench/budget.mjs reap`;

let parsed;

try {
    parsed = parseArgs({
        allowPositionals: true,
        options: { budget: { type: "string" } },
    });
} catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(1);
}

const [command] = parsed.positionals;
const data = dataDir();

if (command === "set") {
    const budget = Number(parsed.values.budget);

    if (parsed.values.budget === undefined || !Number.isFinite(budget) || budget < 0) {
        console.error(`set needs --budget <usd>\n${USAGE}`);
        process.exit(1);
    }

    console.log(describeSpend(await setBudget(data, budget)));
} else if (command === "show") {
    const spend = await readSpend(data);

    console.log(describeSpend(spend));

    for (const r of spend.reservations) {
        console.log(
            `  reserved $${r.cap} ${r.stage} ${r.task} ${r.model} try ${r.try} pid ${r.pid} at ${r.at}`,
        );
    }
} else if (command === "reap") {
    const dead = await reap(data);

    console.log(`reaped ${dead.length} reservation(s) at their full cap`);
    console.log(describeSpend(await readSpend(data)));
} else {
    console.error(USAGE);
    process.exit(1);
}
