// Summaries of result files: per model, attempts, failures by kind, list cost, tokens and wall time.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { median } from "./common.mjs";

/** Every result file under a folder (recursive), parsed. Unreadable files are skipped. */
export async function loadResults(folder) {
    const results = [];
    let entries;

    try {
        entries = await readdir(folder, { withFileTypes: true, recursive: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
        }

        try {
            results.push(JSON.parse(await readFile(join(entry.parentPath, entry.name), "utf8")));
        } catch {
            // A half-written or foreign file: not a result.
        }
    }

    return results.filter((r) => r && r.task && r.model && r.usage);
}

/** The failure kinds of a result: limit, provider, harness, and partial usage. */
export function failureKinds(result) {
    const kinds = [];

    if (result.failure) {
        kinds.push(result.failure);
    }

    if (result.harness) {
        kinds.push("harness");
    }

    if (result.usage?.partial) {
        kinds.push("partial");
    }

    return kinds;
}

/** The summary rows, 1 per model, sorted by model id. */
export function summarize(results) {
    const byModel = new Map();

    for (const result of results) {
        const list = byModel.get(result.model) ?? [];

        list.push(result);
        byModel.set(result.model, list);
    }

    return [...byModel.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, list]) => {
            const failures = { limit: 0, provider: 0, harness: 0, partial: 0 };

            for (const result of list) {
                for (const kind of failureKinds(result)) {
                    failures[kind] = (failures[kind] ?? 0) + 1;
                }
            }

            const sum = (key) =>
                list.reduce((total, r) => total + (Number(r.usage?.[key]) || 0), 0);
            // A model with no list price has no list cost, whatever Pi reports.
            const cost = list.reduce(
                (total, r) => total + (r.priced ? Number(r.usage?.cost) || 0 : 0),
                0,
            );
            const walls = list.map((r) => r.wallMs);

            return {
                model,
                attempts: list.length,
                failures,
                cost: Math.round(cost * 1e4) / 1e4,
                input: sum("input"),
                output: sum("output"),
                cacheRead: sum("cacheRead"),
                cacheWrite: sum("cacheWrite"),
                tokens: sum("tokens"),
                wallMedianMs: median(walls),
                wallMaxMs: walls.length ? Math.max(...walls) : null,
                priceMissing: list.some((r) => r.priceMissing),
            };
        });
}

/** Minutes with 1 decimal, or "-". */
const minutes = (ms) => (ms == null ? "-" : (ms / 60_000).toFixed(1));

/** A Markdown table of summary rows, and the total cost. */
export function markdownTable(rows) {
    const lines = [
        "| Model | Attempts | Limit | Provider | Harness | Partial usage | List cost $ | Input | Output | Cache read | Cache write | Median wall min | Max wall min |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ];

    for (const row of rows) {
        lines.push(
            `| ${row.model}${row.priceMissing ? " (price missing)" : ""} | ${row.attempts} | ${row.failures.limit} | ${row.failures.provider} | ${row.failures.harness} | ${row.failures.partial} | ${row.cost.toFixed(4)} | ${row.input} | ${row.output} | ${row.cacheRead} | ${row.cacheWrite} | ${minutes(row.wallMedianMs)} | ${minutes(row.wallMaxMs)} |`,
        );
    }

    const total = rows.reduce((sum, row) => sum + row.cost, 0);

    lines.push("", `Total list cost: $${total.toFixed(4)}`);

    return lines.join("\n");
}
