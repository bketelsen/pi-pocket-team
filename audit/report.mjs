// The daily audit's report: rank, owner and size, "maybe fixed", the day compare, and the Markdown.
//
// The owner and the size come from a fixed table (design Section 5), never from the model. Nothing here reads a
// source: the functions take the findings, the earlier days and the LLM result, and return plain values.
import fs from "node:fs";
import path from "node:path";
import { HOUR, MINUTE, SECRET, iso, money, moneyFine, newYorkClock } from "./common.mjs";

/** Weight of a severity in the rank. */
export const WEIGHT = { high: 3, medium: 2, low: 1 };
/** The sweep's period: a finding is "maybe fixed" when its last case is not newer than the install plus 1 sweep. */
export const SWEEP_MS = 10 * MINUTE;
/** At most this many lines in "Other findings". */
export const MAX_OTHER = 15;
/** The folder name of a day's report. */
export const DAY_FOLDER = /^(\d{4}-\d{2}-\d{2})-daily-audit$/;

// ---------- Owner and size ----------

const DESK = {
    component: "`desk.ts` (rule) or Odrade's workflow (habit)",
    owner: "Sheeana (code), Odrade (habit)",
    size: "S",
};
const SHIFT = {
    component: "`night-shift.ts`, or the brief template",
    owner: "Sheeana, Odrade",
    size: "S",
};

/** The component, owner and size of a check (design Section 5). */
export function ownerOf(check) {
    const group = check[0];

    if (check === "E3" || group === "F") {
        return SHIFT;
    }

    if ("ABCDE".includes(group)) {
        return DESK;
    }

    if (group === "G") {
        return { component: "Pocket schedules", owner: "Odrade", size: "S" };
    }

    if (check === "H1") {
        return { component: "repository settings", owner: "Brian", size: "S" };
    }

    if (group === "H") {
        return {
            component: "agents' briefs and CI",
            owner: "Odrade, the repository's owner",
            size: "S–M",
        };
    }

    if (group === "I") {
        return { component: "Odrade's notes", owner: "Odrade", size: "S" };
    }

    return { component: "models and briefs", owner: "Brian decides, Odrade proposes", size: "M" };
}

/** The live module that fixes a check, for rule 4; undefined when no module does. */
export function moduleOf(check) {
    if (check === "E3" || check[0] === "F") {
        return "night-shift.ts";
    }

    return "ABCDE".includes(check[0]) ? "desk.ts" : undefined;
}

// ---------- Rank, maybe fixed ----------

/** `weight(severity) × (1 + log2(cases)) + days it repeats + waste in $ / 5`. */
export function rankOf(finding, repeatDays = 0) {
    const value =
        WEIGHT[finding.severity] * (1 + Math.log2(Math.max(1, finding.cases ?? 1))) +
        repeatDays +
        (finding.waste ?? 0) / 5;

    return Math.round(value * 100) / 100;
}

/**
 * Rule 4: the last case of the finding is older than the live module's install time plus 1 sweep. `installed` holds
 * each module's modification time (ms) or null.
 */
export function isMaybeFixed(finding, installed) {
    const file = moduleOf(finding.check);
    const at = file ? installed?.[file] : null;

    if (!at || !finding.lastSeen) {
        return false;
    }

    return Date.parse(finding.lastSeen) <= at + SWEEP_MS;
}

// ---------- Earlier days ----------

/**
 * The earlier days: `<parent of outDir>/YYYY-MM-DD-daily-audit/findings.json` with a date before `date`, oldest first.
 * A file that is not valid JSON is left out. Nothing is written.
 */
export function loadEarlier(outDir, date) {
    const parent = path.dirname(path.resolve(outDir));
    const days = [];

    let names = [];

    try {
        names = fs.readdirSync(parent);
    } catch {
        return days;
    }

    for (const name of names) {
        const day = DAY_FOLDER.exec(name)?.[1];

        if (!day || day >= date) {
            continue;
        }

        try {
            const json = JSON.parse(
                fs.readFileSync(path.join(parent, name, "findings.json"), "utf8"),
            );

            if (Array.isArray(json?.findings)) {
                days.push({ date: day, json });
            }
        } catch {
            // No findings.json that day, or it is not JSON.
        }
    }

    return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** How many earlier days in a row, newest first, hold the finding id. */
export function repeatDays(id, earlier) {
    let count = 0;

    for (const day of [...earlier].reverse()) {
        if (!day.json.findings.some((finding) => finding.id === id)) {
            break;
        }

        count += 1;
    }

    return count;
}

/** Findings with their rank, owner, size and `maybeFixed`; the ranked ones first (highest rank first). */
export function annotate(findings, earlier, installed, now = null) {
    const rows = findings.map((finding) => {
        const days = repeatDays(finding.id, earlier);
        const file = moduleOf(finding.check);
        // A module installed less than 1 h before the run has had no time to show its effect: the finding keeps its
        // rank, and is marked "installed recently" in place of "maybe fixed".
        const older = isMaybeFixed(finding, installed);
        const recent = older && now !== null && now - installed[file] < HOUR;
        const maybeFixed = older && !recent;

        return {
            ...finding,
            ...ownerOf(finding.check),
            repeatDays: days,
            maybeFixed,
            ...(maybeFixed
                ? { installedAt: iso(installed[file]) }
                : { rank: rankOf(finding, days) }),
            ...(recent ? { installedRecently: true, installedAt: iso(installed[file]) } : {}),
        };
    });

    return [
        ...rows
            .filter((row) => !row.maybeFixed)
            .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)),
        ...rows.filter((row) => row.maybeFixed).sort((a, b) => a.id.localeCompare(b.id)),
    ];
}

/** New today, repeating 3 or more days, and gone since the last earlier day. */
export function compareDays(findings, earlier) {
    const last = earlier.at(-1);

    if (!last) {
        return { previous: null, fresh: [], repeating: [], gone: [] };
    }

    const before = new Set(last.json.findings.map((finding) => finding.id));
    const today = new Set(findings.map((finding) => finding.id));

    return {
        previous: last.date,
        fresh: findings.filter((finding) => !before.has(finding.id)).map((finding) => finding.id),
        // Today, and the 2 days before it, in a row.
        repeating: findings
            .filter((finding) => repeatDays(finding.id, earlier) >= 2)
            .map((finding) => finding.id),
        gone: last.json.findings
            .filter((finding) => !today.has(finding.id))
            .map((finding) => finding.id),
    };
}

// ---------- Totals ----------

/** The totals of the report's second line, from the checks' metrics and the desk's events. */
export function totalsOf(data, ctx, metrics) {
    const touched = new Set(
        data.events
            .filter((event) => event.at >= ctx.since && event.at <= ctx.now)
            .map((event) => event.thread),
    );
    const botPrs = metrics.H3?.botPrs;

    return {
        spend: metrics.J1?.total ?? null,
        threadsTouched: data.sourceErrors?.desk ? null : touched.size,
        botPrs: botPrs ?? null,
        botMerged: metrics.H3?.states?.MERGED ?? null,
        failedShifts: metrics.F1 ? (metrics.F1.endings?.["ended: failed"] ?? 0) : null,
    };
}

// ---------- The JSON ----------

/** The JSON of a run: every finding, the metrics, the skipped checks and the LLM use. It holds no report text. */
export function buildJson({
    date,
    ctx,
    installed,
    findings,
    metrics,
    skipped,
    totals,
    github,
    llm,
}) {
    return {
        version: 1,
        date,
        window: { since: iso(ctx.since), until: iso(ctx.now), hours: ctx.hours },
        installed: Object.fromEntries(
            Object.entries(installed).map(([file, ms]) => [file, ms ? iso(ms) : null]),
        ),
        totals,
        findings,
        metrics,
        skipped,
        github,
        llm,
    };
}

// ---------- The Markdown ----------

const oneLine = (text, max = 170) => {
    const line = String(text).replace(/\s+/g, " ").trim();

    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/** The evidence a person can open: a desk file or a URL. */
export const evidenceLinks = (finding) =>
    finding.evidence
        .filter((line) => /^(desk\/\S+\.md|https:\/\/\S+)/.test(line))
        .map((line) => line.split(" ")[0]);

const unique = (list) => [...new Set(list)];

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

const metricLines = (metrics, github) => {
    const lines = [];
    const a1 = metrics.A1;
    const a2 = metrics.A2;

    if (a1) {
        lines.push(
            `- Reopens: ${a1.total}, ${a1.empty} empty (${money(a1.emptyCost)}).`,
            ...(Object.keys(a1.triggers ?? {}).length > 0
                ? [
                      `- Reopen triggers: ${Object.entries(a1.triggers)
                          .map(([key, count]) => `${key} ${count}`)
                          .join(", ")}.`,
                  ]
                : []),
        );
    }

    if (a2) {
        lines.push(
            `- Queue: ${plural(a2.continues, "continue")}, ${plural(a2.items, "item")}, ${a2.silentThenClosed} for done work (${money(a2.cost)}).`,
        );
    }

    if (metrics.A3) {
        lines.push(
            `- Close-out wake-ups: ${metrics.A3.sent} on ${plural(metrics.A3.threads, "thread")}.`,
        );
    }

    if (metrics.B1) {
        lines.push(
            `- Repairs: ${metrics.B1.total}, ${metrics.B1.withoutRealFailure} with no failing check.`,
        );
    }

    if (metrics.D1) {
        lines.push(
            `- Merged answers checked: ${metrics.D1.checked}, median lag ${metrics.D1.lagSeconds.median ?? "n/a"} s.`,
        );
    }

    if (metrics.E1) {
        lines.push(
            `- Reports: ${metrics.E1.total}, ${plural(metrics.E1.duplicates, "sure duplicate")}, ${plural(metrics.E1.candidates, "candidate")}.`,
        );
    }

    if (metrics.F1) {
        lines.push(
            `- Shift endings: ${
                Object.entries(metrics.F1.endings)
                    .map(([key, count]) => `${key} ${count}`)
                    .join(", ") || "none"
            }.`,
        );
    }

    if (metrics.G1) {
        lines.push(
            `- Schedules: ${
                Object.entries(metrics.G1.outcomes)
                    .map(([key, count]) => `${key} ${count}`)
                    .join(", ") || "none"
            }.`,
        );
    }

    if (metrics.H3) {
        lines.push(
            `- Bot PRs: ${metrics.H3.botPrs}, ${metrics.H3.withAFailingCommit} with a failing commit, ${metrics.H3.idle} idle.`,
        );
    }

    if (metrics.J1) {
        const top = Object.entries(metrics.J1.perAgent)
            .slice(0, 5)
            .map(([agent, cost]) => `${agent} ${money(cost)}`)
            .join(", ");

        lines.push(
            `- Spend: ${money(metrics.J1.total)}${metrics.J1.median7 === null ? "" : ` (7-day median ${money(metrics.J1.median7)} a day)`}. ${top}.`,
        );
    }

    lines.push(
        `- GitHub calls: ${github.calls}${github.capReached ? " (GitHub call cap reached)" : ""}.`,
    );

    return lines;
};

const findingLine = (finding) =>
    `- \`${finding.id}\` ${finding.severity}, ${finding.cases} case${finding.cases === 1 ? "" : "s"}${finding.rank === undefined ? "" : `, rank ${finding.rank}`}: ${oneLine(finding.text)}${finding.installedRecently ? ` (installed recently: ${moduleOf(finding.check)} at ${finding.installedAt})` : ""}`;

/** The LLM line at the end of the report. */
export function llmLine(llm) {
    if (!llm.used) {
        return `LLM: not used (${llm.reason}).`;
    }

    return `LLM: ${llm.model}, ${llm.inputTokens} in, ${llm.outputTokens} out, ${moneyFine(llm.cost)}${llm.reason ? `. ${llm.reason}` : ""}`;
}

/** The Markdown report. `findings` are annotated (see `annotate`); `llm` holds a validated summary and proposals, or a reason. */
export function renderReport({
    date,
    ctx,
    findings,
    comparison,
    metrics,
    skipped,
    totals,
    github,
    llm,
}) {
    const ranked = findings.filter((finding) => !finding.maybeFixed);
    const fixed = findings.filter((finding) => finding.maybeFixed);
    const proposals = llm.proposals ?? [];
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    const cited = new Set(proposals.flatMap((proposal) => proposal.cites));
    const out = [];
    const spend = totals.spend === null ? "n/a" : money(totals.spend);

    out.push(
        `# Audit ${date} (${ctx.hours} h to ${newYorkClock(ctx.now)})`,
        "",
        `Spend ${spend} · ${totals.threadsTouched ?? "n/a"} threads · ${totals.botPrs ?? "n/a"} PRs (${totals.botMerged ?? "n/a"} merged) · ${totals.failedShifts ?? "n/a"} failed shifts`,
        "",
        "## Summary",
        "",
        llm.summary
            ? llm.summary
            : `None. ${llm.failed ? `LLM text failed the checks: ${llm.reason}` : `LLM text not used: ${llm.reason}`}`,
        "",
        "## Proposals",
        "",
    );

    if (proposals.length > 0) {
        proposals.forEach((proposal, index) => {
            const first = byId.get(proposal.cites[0]);
            const owner = first ? ownerOf(first.check) : ownerOf("J1");
            const links = unique(
                proposal.cites.flatMap((id) => (byId.get(id) ? evidenceLinks(byId.get(id)) : [])),
            ).slice(0, 6);

            out.push(
                `${index + 1}. **${oneLine(proposal.title, 120)}** (${owner.component}, ${owner.owner}, ${owner.size})`,
                `   ${oneLine(proposal.text, 600)}`,
                ...(links.length > 0 ? [`   Evidence: ${links.join(", ")}.`] : []),
                `   [${proposal.cites.join(", ")}]`,
            );
        });
    } else {
        out.push(
            "None written. The top findings by rank:",
            "",
            ...(ranked.length === 0
                ? ["- No findings."]
                : ranked.slice(0, 5).map((finding) => {
                      const links = evidenceLinks(finding).slice(0, 4);

                      return `${findingLine(finding)} (${finding.component}, ${finding.owner}, ${finding.size})${links.length > 0 ? ` Evidence: ${links.join(", ")}.` : ""}`;
                  })),
        );
    }

    const dropped = llm.dropped ?? [];

    if (dropped.length > 0 && !llm.failed) {
        out.push(
            "",
            `Dropped by the checks: ${dropped.map((item) => `${item.item} (${item.reason})`).join("; ")}`,
        );
    }

    const others = ranked
        .filter((finding) => !cited.has(finding.id))
        .slice(proposals.length > 0 ? 0 : 5);

    out.push(
        "",
        "## Other findings",
        "",
        ...(others.length === 0
            ? ["- None."]
            : [
                  ...others.slice(0, MAX_OTHER).map(findingLine),
                  ...(others.length > MAX_OTHER
                      ? [`- … and ${others.length - MAX_OTHER} more in findings.json.`]
                      : []),
              ]),
        "",
        "## Maybe fixed",
        "",
        ...(fixed.length === 0
            ? ["- None."]
            : fixed.map(
                  (finding) =>
                      `- \`${finding.id}\` (last case ${finding.lastSeen}; ${moduleOf(finding.check)} installed ${finding.installedAt})`,
              )),
        "",
        "## New today · Repeating 3+ days · Gone since yesterday",
        "",
        ...(comparison.previous === null
            ? ["No earlier day to compare."]
            : [
                  `- New today: ${comparison.fresh.map((id) => `\`${id}\``).join(", ") || "none"}`,
                  `- Repeating 3+ days: ${comparison.repeating.map((id) => `\`${id}\``).join(", ") || "none"}`,
                  `- Gone since ${comparison.previous}: ${comparison.gone.map((id) => `\`${id}\``).join(", ") || "none"}`,
              ]),
        "",
        "## Metrics",
        "",
        ...metricLines(metrics, github),
        "",
        "## Skipped checks",
        "",
        ...(Object.keys(skipped).length === 0
            ? ["- None."]
            : Object.entries(skipped).map(([id, why]) => `- ${id}: ${oneLine(why, 140)}`)),
        "",
        llmLine(llm),
        "",
    );

    return out.join("\n");
}

// ---------- A last guard ----------

/** Drop every line of the Markdown that matches the secret filter. */
export const scrubMarkdown = (markdown) =>
    markdown
        .split("\n")
        .filter((line) => !SECRET.test(line))
        .join("\n");

/** Replace every string of a JSON value that matches the secret filter. */
export function scrubJson(value) {
    if (typeof value === "string") {
        return SECRET.test(value) ? "[dropped by the secret filter]" : value;
    }

    if (Array.isArray(value)) {
        return value.map(scrubJson);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, scrubJson(item)]),
        );
    }

    return value;
}
