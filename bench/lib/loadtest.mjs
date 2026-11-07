// The halogen load test's rule: the bench's halogen concurrency is the highest level with no error where every
// attempt reaches 70% or more of the mean level-1 output tokens per second; never above 4, at least 1.

/** The share of the level-1 rate that each attempt of a level must reach. */
export const RATE_SHARE = 0.7;

/** The highest concurrency the bench uses on halogen. */
export const MAX_LEVEL = 4;

/**
 * Choose the concurrency from the table rows `{ level, round, attempt, outputTps, ttftMs, error }`.
 * Returns `{ concurrency, baselineTps, levels: { [level]: { ok, why } } }`.
 */
export function chooseConcurrency(rows, { share = RATE_SHARE, maxLevel = MAX_LEVEL } = {}) {
    const rates = rows
        .filter((row) => row.level === 1 && !row.error && Number.isFinite(row.outputTps))
        .map((row) => row.outputTps);
    const baselineTps = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    const levels = {};
    let concurrency = 1;

    for (const level of [...new Set(rows.map((row) => row.level))].sort((a, b) => a - b)) {
        const own = rows.filter((row) => row.level === level);
        let why = null;

        if (own.some((row) => row.error)) {
            why = "error";
        } else if (baselineTps == null) {
            why = "no level-1 rate";
        } else if (
            own.some(
                (row) => !Number.isFinite(row.outputTps) || row.outputTps < share * baselineTps,
            )
        ) {
            why = `an attempt below ${Math.round(share * 100)}% of ${baselineTps.toFixed(1)} tok/s`;
        }

        levels[level] = { ok: why === null, why };

        if (why === null && level <= maxLevel) {
            concurrency = Math.max(concurrency, level);
        }
    }

    return { concurrency: Math.min(Math.max(concurrency, 1), maxLevel), baselineTps, levels };
}

/** The load test's Markdown table. */
export function loadTable(rows) {
    const cell = (value) => (value == null ? "-" : String(value));
    const lines = [
        "| Level | Round | Attempt | tok/s | TTFT ms | Error |",
        "| ---: | ---: | ---: | ---: | ---: | --- |",
    ];

    for (const row of rows) {
        lines.push(
            `| ${row.level} | ${row.round} | ${row.attempt} | ${cell(row.outputTps)} | ${cell(row.ttftMs)} | ${row.error ?? ""} |`,
        );
    }

    return lines.join("\n");
}
