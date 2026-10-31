// The Desk's Dashboard view: the numbers of `GET dashboard` for 1 range and 1 scope. It only reads: it never starts
// collection, and it has no control that changes a thread. Pure helpers first (tested in desk-web.test.js), then the
// view, made with the module's `pocket`.

/** How often the open view reads the numbers again, while the tab is visible. */
export const REFRESH_MS = 60_000;
/** The date presets, in days; 30 is the default. */
export const PRESETS = [7, 30, 90];
export const DEFAULT_PRESET = 30;

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

// ─── Values: unknown is null, never 0 ───────────────────────────────────────

/** Whether a value is unknown: null, undefined, or not a finite number. */
export const isUnknown = (value) =>
    value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));

/** A count with thousands separators, or null when it is unknown. */
export const formatCount = (value) =>
    isUnknown(value) ? null : Math.round(value).toLocaleString("en-US");

/** 1 decimal at most: "80", "66.7". */
const oneDecimal = (value) => {
    const text = value.toFixed(1);

    return text.endsWith(".0") ? text.slice(0, -2) : text;
};

/** A rate from 0 to 1 as a percent, "66.7%", or null when it is unknown. */
export const formatRate = (rate) => (isUnknown(rate) ? null : `${oneDecimal(rate * 100)}%`);

/** Successes per week, "1.9", or null. */
export const formatPerWeek = (value) => (isUnknown(value) ? null : oneDecimal(value));

/** A duration: "45 min" under 1 hour, "9 h" under 2 days, else "5.4 d"; null when unknown. */
export const formatDuration = (ms) => {
    if (isUnknown(ms)) {
        return null;
    }

    if (ms < HOUR_MS) {
        return `${Math.round(ms / 60_000)} min`;
    }

    if (ms < 2 * DAY_MS) {
        return `${oneDecimal(ms / HOUR_MS)} h`;
    }

    return `${oneDecimal(ms / DAY_MS)} d`;
};

/** US dollars: "$0.00" for 0, 4 decimals under 1 cent, else 2; null when unknown. */
export const formatMoney = (usd) => {
    if (isUnknown(usd)) {
        return null;
    }

    if (usd !== 0 && Math.abs(usd) < 0.01) {
        return `$${usd.toFixed(4)}`;
    }

    return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** The UTC day "YYYY-MM-DD" of a time. */
export const utcDay = (at) => new Date(at).toISOString().slice(0, 10);

/** A time in UTC, "2026-10-30 12:05 UTC", or null. */
export const formatUtc = (at) =>
    isUnknown(at) ? null : `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A UTC day plus `days`. */
export const addDays = (day, days) => utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);

// ─── The query ───────────────────────────────────────────────────────────────

/** The default selection: the last 30 days, all tracked work. */
export const defaultSelection = () => ({
    preset: DEFAULT_PRESET,
    from: "",
    to: "",
    owner: "",
    repo: "",
});

/**
 * The route path for a selection. A preset sends `from` only (the route's `to` is its today), and never a `from` before
 * the recovery boundary's day. A custom range sends both dates as they are: the route judges them.
 */
export const dashboardPath = (selection, today, boundaryDay) => {
    const params = new URLSearchParams();

    if (selection.preset === "custom") {
        params.set("from", selection.from);
        params.set("to", selection.to);
    } else {
        let from = addDays(today, -((selection.preset ?? DEFAULT_PRESET) - 1));

        if (boundaryDay && from < boundaryDay) {
            from = boundaryDay;
        }

        params.set("from", from);
    }

    if (selection.owner) {
        params.set("owner", selection.owner);
    }

    if (selection.repo) {
        params.set("repo", selection.repo);
    }

    return `dashboard?${params.toString()}`;
};

/** The selection with an owner picked: a repository of another owner goes. Empty: all tracked work. */
export const withOwner = (selection, owner) => ({
    ...selection,
    owner,
    repo:
        owner && selection.repo && selection.repo.split("/")[0] === owner.toLowerCase()
            ? selection.repo
            : "",
});

/** The selection with a repository picked: its owner goes with it. Empty: the owner's scope stays. */
export const withRepo = (selection, repo) => ({
    ...selection,
    repo,
    owner: repo ? (repo.split("/")[0] ?? "") : selection.owner,
});

/** The repositories to offer: all of them, or the chosen owner's. The chosen one stays, also when it is gone. */
export const repoChoices = (choices, selection) => {
    const owner = selection.owner.toLowerCase();
    const repos = (choices?.repos ?? []).filter(
        (repo) => owner === "" || repo.split("/")[0] === owner,
    );

    return selection.repo && !repos.includes(selection.repo) ? [...repos, selection.repo] : repos;
};

/** The owners to offer. The chosen one stays, also when it is gone. */
export const ownerChoices = (choices, selection) => {
    const owners = choices?.owners ?? [];

    return selection.owner && !owners.includes(selection.owner.toLowerCase())
        ? [...owners, selection.owner]
        : owners;
};

/** What the snapshot shows: its range, its partial today, and its scope, in 1 line. */
export const rangeLine = (snapshot) => {
    const { range, scope } = snapshot;
    const days = `${range.days} day${range.days === 1 ? "" : "s"}`;
    const today = range.partialToday ? `, today up to ${formatUtc(snapshot.asOf)}` : "";
    const clamped = range.clamped ? ", moved to the recovery boundary's day" : "";
    const what =
        scope.kind === "all"
            ? "all tracked work"
            : scope.kind === "owner"
              ? `owner ${scope.owner}`
              : `repository ${scope.repo}`;

    return `Showing ${range.from} to ${range.to} UTC (${days})${today}${clamped} · ${what}`;
};

// ─── States ──────────────────────────────────────────────────────────────────

/** Whether a scope has no tracked work at all: no thread, no PR, no issue sample or count, no counted session. */
export const noTrackedWork = (totals) =>
    totals.population.delivery === 0 &&
    totals.population.coordinators === 0 &&
    totals.prs.tracked === 0 &&
    totals.timeToSolve.count === 0 &&
    totals.timeToSolve.nowUnresolved === 0 &&
    totals.usage.sessions === 0;

/**
 * Whether the usage facts can be shown: false when usage was never collected, or when its only read failed (no good
 * read yet). Then tokens and cost are unknown, not 0. A partial source, or a failed one after a good read, keeps its
 * collected facts.
 */
export const usageAvailable = (coverage) => {
    const usage = coverage?.sources?.usage;

    if (usage === undefined || usage === null) {
        return true;
    }

    return !(
        usage.status === "never" ||
        (usage.status === "failed" && (usage.lastGoodAt === null || usage.lastGoodAt === undefined))
    );
};

/** Why usage is unknown, or what its facts are, in 1 line; null for a source that is fine. */
export const usageNote = (coverage) => {
    const usage = coverage?.sources?.usage;

    if (usage?.status === "never") {
        return "Usage was never collected: tokens and cost are unknown.";
    }

    if (usage?.status === "failed") {
        return usageAvailable(coverage)
            ? "The last usage read failed: tokens and cost are the last good facts, and can be low."
            : "The first usage read failed: there is no good read yet, so tokens and cost are unknown.";
    }

    return null;
};

const SOURCE_NAMES = { threads: "Desk threads", github: "GitHub", usage: "Usage" };

/**
 * The states the view shows, each with a code, a tone (err, warn, info), and its words. `error`: the last refresh
 * failed (the snapshot shown is the last good one); `rangeError`: the route refused the custom range.
 */
export const dashboardStates = (snapshot, { error = null, rangeError = null } = {}) => {
    const states = [];

    if (rangeError) {
        states.push({
            code: "bad-range",
            tone: "err",
            text: `The range was refused: ${rangeError} The numbers below are the last good ones.`,
        });
    }

    if (error) {
        states.push({
            code: "refresh-failed",
            tone: "err",
            text: snapshot
                ? `The refresh failed: ${error}. The numbers below are stale: they are from ${formatUtc(snapshot.asOf)}.`
                : `The dashboard could not be read: ${error}.`,
        });
    }

    if (!snapshot) {
        return states;
    }

    const coverage = snapshot.coverage;

    if (coverage.status === "not started") {
        states.push({
            code: "not-started",
            tone: "warn",
            text: "Collection has not started: there is no recovery boundary and no numbers yet. The collector starts with the desk's next sweep.",
        });

        return states;
    }

    for (const [name, source] of Object.entries(coverage.sources)) {
        const label = SOURCE_NAMES[name] ?? name;

        if (source.status === "stale") {
            states.push({
                code: "stale-source",
                tone: "warn",
                text: `${label} is stale: the last good read was ${formatUtc(source.checkedAt ?? source.lastGoodAt) ?? "never"}.`,
            });
        } else if (source.status === "failed") {
            states.push({
                code: "failed-source",
                tone: "err",
                text: `${label}: the last read failed${source.error ? `: ${source.error}` : ""}. Last good: ${formatUtc(source.lastGoodAt) ?? "never"}.`,
            });
        } else if (source.status === "never" && name !== "usage") {
            states.push({ code: "never-source", tone: "warn", text: `${label} was never read.` });
        }
    }

    const usage = coverage.sources.usage;

    if (usage.status === "never" || usage.status === "failed") {
        states.push({
            code: "usage-unavailable",
            tone: "warn",
            text: `Usage is unavailable. ${usageNote(coverage)}`,
        });
    }

    const progress = coverage.progress;
    const partial = [];

    if (progress.github.complete === false || coverage.sources.github.status === "partial") {
        partial.push(
            `GitHub: ${progress.github.pending ?? "unknown"} ref read${progress.github.pending === 1 ? "" : "s"} pending`,
        );
    }

    if (progress.usage.complete === false || usage.status === "partial") {
        partial.push(
            `usage: ${progress.usage.pending ?? "unknown"} session${progress.usage.pending === 1 ? "" : "s"} pending${progress.usage.ledgerUnavailable ? `, ${progress.usage.ledgerUnavailable} ledger${progress.usage.ledgerUnavailable === 1 ? "" : "s"} unreadable` : ""}`,
        );
    }

    if (coverage.sources.threads.status === "partial") {
        partial.push("Desk threads: partial read");
    }

    if (partial.length > 0) {
        states.push({
            code: "partial",
            tone: "warn",
            text: `Partial coverage, the backfill goes on: ${partial.join("; ")}.`,
        });
    }

    if (noTrackedWork(snapshot.totals)) {
        states.push({
            code: "no-work",
            tone: "info",
            text: "No tracked work in this scope: the zeros below are true zeros.",
        });
    } else if (snapshot.totals.completion.denominator === 0) {
        states.push({
            code: "no-closures",
            tone: "info",
            text: "No eligible closures in this range: there is no completion rate.",
        });
    }

    return states;
};

// ─── The project table ───────────────────────────────────────────────────────

/** The table's columns: the key, the header, and the value to sort by (null sorts last). */
export const COLUMNS = [
    { key: "name", label: "Project", value: (row) => row.name.toLowerCase() },
    {
        key: "completion",
        label: "Completion",
        value: (row) => row.metrics.completion.rate,
    },
    { key: "successes", label: "Successes", value: (row) => row.metrics.completion.success },
    { key: "cycle", label: "Cycle time (median)", value: (row) => row.metrics.cycleTime.medianMs },
    {
        key: "solve",
        label: "Time to solve (median / P90 / n)",
        value: (row) => row.metrics.timeToSolve.medianMs,
    },
    { key: "open", label: "Open now", value: (row) => row.metrics.workload.total },
    { key: "merged", label: "PRs merged", value: (row) => row.metrics.prs.merged },
    {
        key: "tokens",
        label: "Tokens",
        value: (row) => (row.usageUnknown ? null : row.metrics.usage.totalTokens),
    },
    {
        key: "cost",
        label: "Cost (USD)",
        value: (row) => (row.usageUnknown ? null : row.metrics.usage.cost),
    },
];

/** Rows in order of 1 column: unknown values last in both directions, then by name. */
export const sortRows = (rows, sort) => {
    const column = COLUMNS.find((each) => each.key === sort.key) ?? COLUMNS[0];
    const sign = sort.dir === "desc" ? -1 : 1;

    return [...rows].sort((a, b) => {
        const left = column.value(a);
        const right = column.value(b);
        const leftUnknown = isUnknown(left);
        const rightUnknown = isUnknown(right);

        if (leftUnknown !== rightUnknown) {
            return leftUnknown ? 1 : -1;
        }

        if (!leftUnknown && left !== right) {
            return (left < right ? -1 : 1) * sign;
        }

        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
};

/**
 * The table's body rows: each owner's subtotal (from `rows.owners`, never computed here), then its projects, owners
 * and projects each in the sort's order; then the unattributed row, when the scope has one.
 */
export const tableRows = (snapshot, sort) => {
    // Every row has the same usage availability: the usage source is 1 for all scopes.
    const usageUnknown = !usageAvailable(snapshot.coverage);
    const projects = snapshot.rows.projects.map((row) => ({
        kind: "project",
        name: row.repo,
        owner: row.owner,
        metrics: row.metrics,
        usageUnknown,
    }));
    const owners = sortRows(
        snapshot.rows.owners.map((row) => ({
            kind: "owner",
            name: row.owner,
            owner: row.owner,
            metrics: row.metrics,
            usageUnknown,
        })),
        sort,
    );
    const rows = [];

    for (const owner of owners) {
        rows.push(owner);
        rows.push(
            ...sortRows(
                projects.filter((row) => row.owner === owner.owner),
                sort,
            ),
        );
    }

    if (snapshot.rows.unattributed !== null && snapshot.rows.unattributed !== undefined) {
        rows.push({
            kind: "unattributed",
            name: "Unattributed",
            owner: "",
            metrics: snapshot.rows.unattributed,
            usageUnknown,
        });
    }

    return rows;
};

/** 1 table cell's text for a column and a row: null is unknown. Tokens and cost are unknown when usage is. */
export const cellText = (key, row) => {
    const metrics = row.metrics;

    switch (key) {
        case "completion":
            return metrics.completion.denominator === 0
                ? "0 eligible"
                : `${formatRate(metrics.completion.rate)} (${metrics.completion.success}/${metrics.completion.denominator})`;
        case "successes":
            return formatCount(metrics.completion.success);
        case "cycle":
            return formatDuration(metrics.cycleTime.medianMs);

        case "solve": {
            const solve = metrics.timeToSolve;

            return solve.count === 0
                ? "0 eligible"
                : `${formatDuration(solve.medianMs)} / ${formatDuration(solve.p90Ms)} / ${solve.count}`;
        }

        case "open":
            return formatCount(metrics.workload.total);
        case "merged":
            return formatCount(metrics.prs.merged);
        case "tokens":
            return row.usageUnknown ? null : formatCount(metrics.usage.totalTokens);
        case "cost":
            return row.usageUnknown ? null : formatMoney(metrics.usage.cost);
        default:
            return null;
    }
};

/**
 * The trend's column layout for a number of days: 1 grid column for each day, and a gap that shrinks as the days grow,
 * so 1 to 366 days fit any width (at 0 gap, the bars touch).
 */
export const barLayout = (days) => {
    const gap = days <= 31 ? 2 : days <= 92 ? 1 : 0;

    return { gap, style: `--dash-days: ${Math.max(1, days)}; --dash-bar-gap: ${gap}px` };
};

/** The next sort after a tap on a column: the same column turns around; a new one starts descending, a name ascending. */
export const nextSort = (sort, key) =>
    sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" };

// ─── Definitions ─────────────────────────────────────────────────────────────

/** How each metric is counted: the view's help, and the docs' words (docs/desk-dashboard.md). */
export const HELP = {
    completion:
        "Delivery threads whose latest closure falls in the range and that are still closed now. Success: closed as done with outcome completed or verified. The denominator adds closed as done with outcome abandoned, and closed as failed. Dropped closures, frozen outcomes and unknown outcomes (old records with no outcome) are excluded and counted apart. A closure with no valid time is undated: it is in no range.",
    velocity:
        "The successful closures of the completion rate, divided by the weeks that elapsed in the range. A range that includes today ends now, so a partial day is not counted as a full one. The daily trend shows the same closures.",
    cycle: "Thread cycle time: from the thread's start to its latest close, for the successful closures in the range. The median of the valid samples. A success with no start time, or a start after its close, is excluded and counted. This is not Time to solve.",
    solve: "Time to solve: from the GitHub issue's creation to the merge of the PR that resolves it, wall clock (waiting and review included). Only issues linked to Desk work count, each once. An issue counts in the range of its resolving merge, not of its creation, and in its own repository, also when the PR is in another one. Median: the middle value, or the mean of the middle pair. P90: the nearest rank, ceil(0.9 × n). Open issues count as Now, not as samples. Issues with no clear resolving PR (not planned, ambiguous, incomplete, missing, inaccessible) are excluded with their reason.",
    workload:
        "Delivery threads that are starting, open, or parked now. This is the state now, not at the end of the range.",
    prs: "PRs attached to, seen by, or matched by branch to Desk threads, each once (owner/name#number, any case). Created, merged and closed unmerged count the PRs whose own GitHub time falls in the range: 1 PR can count in more than 1 of them, so they do not add up. Open is the state now. Window-only links, PRs missing on GitHub, and PRs in archived repositories are excluded and counted. Unread PRs and PRs with a missing lifecycle time are coverage gaps: the fetch time never stands in for them.",
    tokens: "Dated assistant-model usage of Desk-linked sessions and their subagents, by the UTC day of each request. Supervisor and Clerk sessions are shared: they are not counted. Total is the recorded total of each entry, not a sum of the other columns. Undated usage and compaction residuals are shown apart, never in the range total.",
    cost: "The sum of the cost that each entry recorded, in USD, with no repricing. It is an estimate from recorded usage, not an invoice or a subscription charge. An entry that reported 0 counts as 0 (subscription or provider pricing can report 0). An entry with no cost is unknown, not 0. The undated residual is outside the range total.",
    population:
        "Delivery threads: Desk threads with a session or an attributable PR, found threads included, and delegations that failed before a session started. Ask-only threads do not count. A plan's coordinator thread does not count for delivery: its task threads do. All tracked work includes unattributed records; an owner or a repository includes only the records attributed to it.",
    time: "Dates are UTC days. A range starts at 00:00 UTC of its first day (inclusive) and ends at 00:00 UTC after its last day (exclusive); a range that includes today ends at the snapshot time. Outcomes are the latest known: a reopened thread leaves its range until it closes again.",
};

// ─── The view ────────────────────────────────────────────────────────────────

/** What the module keeps between 2 openings of the view, in memory only: no browser storage. */
const memory = { selection: defaultSelection(), snapshot: null, sort: { key: "name", dir: "asc" } };

/**
 * The Dashboard component for this module's `pocket`. Each mounted view reads at once, then every `refreshMs` while
 * the tab is visible; it stops its timer and aborts its read when it unmounts, and when the module goes.
 */
export function makeDashboard(pocket, { refreshMs = REFRESH_MS } = {}) {
    const { html, useEffect, useRef, useState, Loader } = pocket;
    /** The stop functions of the mounted views: the module's dispose runs them. */
    const mounted = new Set();

    pocket.onDispose(() => {
        for (const stop of [...mounted]) {
            stop();
        }
    });

    /** A value, or a dash that a screen reader reads as "unknown". */
    const Value = ({ text }) =>
        text === null || text === undefined
            ? html`<span class="dash-unknown" title="unknown"
                  ><span aria-hidden="true">—</span><span class="dash-sr">unknown</span></span
              >`
            : html`<span>${text}</span>`;

    const Help = ({ text }) =>
        html`<details class="dash-help">
            <summary>How is this counted?</summary>
            <p>${text}</p>
        </details>`;

    /** 1 line of the card's detail list: a label and a value. */
    const Item = ({ label, text }) =>
        html`<div class="dash-item">
            <dt>${label}</dt>
            <dd><${Value} text=${text} /></dd>
        </div>`;

    const Card = ({ id, title, big, bigLabel, flag, children, help, note, after }) =>
        html`<article class="dash-card" aria-labelledby=${id}>
            <h3 id=${id}>${title}</h3>
            ${
                flag
                    ? html`<p class="dash-big dash-flag">${flag}</p>`
                    : html`<p class="dash-big">
                          <${Value} text=${big} />${bigLabel ? html` <span class="dash-big-label">${bigLabel}</span>` : null}
                      </p>`
            }
            ${note ? html`<p class="small dash-note">${note}</p>` : null}
            <dl class="dash-items">${children}</dl>
            ${after ?? null}
            <${Help} text=${help} />
        </article>`;

    const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

    function Cards({ snapshot }) {
        const { completion, velocity, cycleTime, timeToSolve, workload, prs, usage } =
            snapshot.totals;
        const usageKnown = usageAvailable(snapshot.coverage);
        const known = (value) => (usageKnown ? value : null);
        const note = usageNote(snapshot.coverage);
        const undated = usage.undated;
        const residual = undated.residual;
        const solveExcluded = Object.entries(timeToSolve.undated ?? {});

        return html`<div class="dash-cards">
            <${Card}
                id="dash-completion"
                title="Thread completion rate"
                big=${formatRate(completion.rate)}
                flag=${completion.flag}
                note=${`${formatCount(completion.success)} of ${formatCount(completion.denominator)} eligible closures`}
                help=${HELP.completion}
            >
                <${Item} label="Completed" text=${formatCount(completion.completed)} />
                <${Item} label="Verified" text=${formatCount(completion.verified)} />
                <${Item} label="Abandoned" text=${formatCount(completion.abandoned)} />
                <${Item} label="Failed" text=${formatCount(completion.failed)} />
                <${Item} label="Excluded: dropped" text=${formatCount(completion.excluded.dropped)} />
                <${Item} label="Excluded: frozen" text=${formatCount(completion.excluded.frozen)} />
                <${Item} label="Excluded: unknown outcome" text=${formatCount(completion.excluded.unknown)} />
                <${Item} label="Undated (in no range)" text=${formatCount(completion.undated)} />
            <//>
            <${Card}
                id="dash-velocity"
                title="Successful closures"
                big=${formatCount(velocity.successes)}
                note=${velocity.perWeek === null ? "No elapsed time: no velocity." : `${formatPerWeek(velocity.perWeek)} per week`}
                help=${HELP.velocity}
            >
                <${Item} label="Velocity per week" text=${formatPerWeek(velocity.perWeek)} />
                <${Item} label="Successes (raw count)" text=${formatCount(velocity.successes)} />
            <//>
            <${Card}
                id="dash-cycle"
                title="Thread cycle time (median)"
                big=${formatDuration(cycleTime.medianMs)}
                note="Thread start to its latest close"
                help=${HELP.cycle}
            >
                <${Item} label="Samples" text=${formatCount(cycleTime.samples)} />
                <${Item} label="Excluded: timestamps" text=${formatCount(cycleTime.excludedTimestamps)} />
            <//>
            <${Card}
                id="dash-solve"
                title="Time to solve"
                big=${formatDuration(timeToSolve.medianMs)}
                bigLabel=${timeToSolve.flag ? null : "median"}
                flag=${timeToSolve.flag}
                note="Issue created to resolving PR merged, wall clock, by merge date"
                help=${HELP.solve}
            >
                <${Item} label="P90" text=${formatDuration(timeToSolve.p90Ms)} />
                <${Item} label="Resolved issues (samples)" text=${formatCount(timeToSolve.count)} />
                <${Item} label="Unresolved now" text=${formatCount(timeToSolve.nowUnresolved)} />
                <${Item} label="Excluded: invalid duration" text=${formatCount(timeToSolve.dated?.invalid ?? 0)} />
                ${solveExcluded.map(
                    ([reason, count]) =>
                        html`<${Item} label=${`Excluded, undated: ${reason}`} text=${formatCount(count)} />`,
                )}
            <//>
            <${Card}
                id="dash-workload"
                title="Current workload"
                big=${formatCount(workload.total)}
                bigLabel="now"
                note="The state now, not at the end of the range"
                help=${HELP.workload}
            >
                <${Item} label="Starting" text=${formatCount(workload.starting)} />
                <${Item} label="Open" text=${formatCount(workload.open)} />
                <${Item} label="Parked" text=${formatCount(workload.parked)} />
            <//>
            <${Card}
                id="dash-prs"
                title="Tracked PRs"
                big=${formatCount(prs.merged)}
                bigLabel="merged in range"
                note="Created, merged and closed unmerged each go by their own GitHub time: they overlap, and do not add up."
                help=${HELP.prs}
            >
                <${Item} label="Created in range" text=${formatCount(prs.created)} />
                <${Item} label="Merged in range" text=${formatCount(prs.merged)} />
                <${Item} label="Closed unmerged in range" text=${formatCount(prs.closedUnmerged)} />
                <${Item} label="Open now" text=${formatCount(prs.openNow)} />
                <${Item} label="Tracked" text=${formatCount(prs.tracked)} />
                <${Item} label="Excluded: window only" text=${formatCount(prs.excluded.window)} />
                <${Item} label="Excluded: missing" text=${formatCount(prs.excluded.missing)} />
                <${Item} label="Excluded: archived" text=${formatCount(prs.excluded.frozen)} />
                <${Item} label="Gaps: not read yet" text=${formatCount(prs.coverage.unread)} />
                <${Item} label="Gaps: read failed" text=${formatCount(prs.coverage.errored)} />
                <${Item} label="Gaps: lifecycle time missing" text=${formatCount(prs.coverage.gaps)} />
            <//>
            <${Card}
                id="dash-tokens"
                title="Dated tokens"
                big=${known(formatCount(usage.totalTokens))}
                bigLabel="total"
                note=${note}
                help=${HELP.tokens}
            >
                <${Item} label="Input" text=${known(formatCount(usage.input))} />
                <${Item} label="Output" text=${known(formatCount(usage.output))} />
                <${Item} label="Cache read" text=${known(formatCount(usage.cacheRead))} />
                <${Item} label="Cache write" text=${known(formatCount(usage.cacheWrite))} />
                <${Item} label="Entries" text=${known(formatCount(usage.entries))} />
                <${Item} label="Sessions counted" text=${known(formatCount(usage.sessions))} />
                <${Item} label="Sessions gone (kept)" text=${known(formatCount(usage.missing))} />
                <${Item} label="Excluded: shared sessions" text=${known(formatCount(usage.excluded.shared))} />
                <${Item}
                    label="Unattributed: conflict / no repository"
                    text=${known(`${usage.unattributed.conflict} / ${usage.unattributed.noRepo + usage.unattributed.unassigned}`)}
                />
                <${Item}
                    label="Apart: undated tokens"
                    text=${known(formatCount(undated.counters.totalTokens))}
                />
                <${Item}
                    label="Apart: compaction residual tokens"
                    text=${known(residual ? formatCount(residual.counters.totalTokens) : null)}
                />
            <//>
            <${Card}
                id="dash-cost"
                title="Reported model cost (USD)"
                big=${known(formatMoney(usage.cost))}
                note=${note ?? "An estimate from recorded usage, not an invoice."}
                help=${HELP.cost}
                after=${
                    usageKnown && usage.zeroCostEntries > 0
                        ? html`<p class="small dash-note">
                              ${`${plural(usage.zeroCostEntries, "entry", "entries")} reported $0: subscription or provider pricing can report 0.`}
                          </p>`
                        : null
                }
            >
                <${Item} label="Entries with a cost" text=${known(formatCount(usage.costEntries))} />
                <${Item} label="Entries that reported $0" text=${known(formatCount(usage.zeroCostEntries))} />
                <${Item} label="Entries with no cost (unknown)" text=${known(formatCount(usage.unknownCostEntries))} />
                <${Item}
                    label="Apart: undated cost"
                    text=${known(undated.counters.costEntries > 0 ? formatMoney(undated.counters.cost) : null)}
                />
                <${Item}
                    label=${`Apart: compaction residual${residual ? ` (${plural(residual.sessions, "session")})` : ""}`}
                    text=${known(residual ? formatMoney(residual.counters.cost) : null)}
                />
            <//>
        </div>`;
    }

    function Trend({ snapshot }) {
        const daily = snapshot.daily;
        const max = Math.max(1, ...daily.map((day) => day.successes));
        const total = daily.reduce((sum, day) => sum + day.successes, 0);
        const busiest = daily.reduce((best, day) => (day.successes > best.successes ? day : best), {
            day: "",
            successes: 0,
        });
        const summary = `${plural(total, "successful closure")} in ${plural(daily.length, "day")}${busiest.successes > 0 ? `; most in 1 day: ${busiest.successes} on ${busiest.day}` : ""}.`;

        return html`<section class="desk-section dash-trend" aria-labelledby="dash-trend-title">
            <h2 id="dash-trend-title">Daily successful closures (UTC)</h2>
            <p class="small muted">${summary}</p>
            <div class="dash-chart">
                <span class="dash-axis small muted" aria-hidden="true">${max}</span>
                <ol
                    class="dash-bars"
                    style=${barLayout(daily.length).style}
                    aria-label="Successful closures by UTC day"
                >
                    ${daily.map(
                        (day) =>
                            html`<li class="dash-bar-item" title=${`${day.day}: ${day.successes}`}>
                                <span
                                    class=${day.successes === 0 ? "dash-bar zero" : "dash-bar"}
                                    style=${day.successes === 0 ? "" : `height: ${Math.max(4, (day.successes / max) * 100)}%`}
                                ></span>
                                <span class="dash-sr">${day.day}: ${plural(day.successes, "successful closure")}</span>
                            </li>`,
                    )}
                </ol>
            </div>
            <div class="dash-chart-labels small muted" aria-hidden="true">
                <span>${daily[0]?.day ?? ""}</span><span>${daily.at(-1)?.day ?? ""}</span>
            </div>
            <details class="dash-help">
                <summary>Daily table</summary>
                <table class="dash-daily">
                    <thead>
                        <tr><th scope="col">Day (UTC)</th><th scope="col">Successful closures</th></tr>
                    </thead>
                    <tbody>
                        ${daily.map(
                            (day) => html`<tr><td>${day.day}</td><td>${day.successes}</td></tr>`,
                        )}
                    </tbody>
                </table>
            </details>
        </section>`;
    }

    function Table({ snapshot, sort, onSort }) {
        const rows = tableRows(snapshot, sort);
        const columns = COLUMNS;

        const nameCell = (row) => {
            const label =
                row.kind === "owner"
                    ? `${row.name} (owner subtotal)`
                    : row.kind === "unattributed"
                      ? "Unattributed (no single repository)"
                      : row.kind === "total"
                        ? "Scope total"
                        : row.name;

            return html`<th scope="row" class="dash-name" data-label="Project">
                <span class="dash-repo" title=${label}>${label}</span>
            </th>`;
        };

        const row = (each) =>
            html`<tr class=${`dash-row dash-${each.kind}`}>
                ${nameCell(each)}
                ${columns
                    .slice(1)
                    .map(
                        (column) =>
                            html`<td data-label=${column.label}><${Value} text=${cellText(column.key, each)} /></td>`,
                    )}
            </tr>`;
        const ariaSort = (key) =>
            sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";

        return html`<section class="desk-section dash-projects" aria-labelledby="dash-projects-title">
            <h2 id="dash-projects-title">Projects</h2>
            <div class="dash-sort-phone">
                <label>
                    Sort by
                    <select
                        value=${sort.key}
                        onChange=${(event) => onSort({ key: event.currentTarget.value, dir: sort.dir })}
                    >
                        ${columns.map((column) => html`<option value=${column.key}>${column.label}</option>`)}
                    </select>
                </label>
                <button
                    type="button"
                    class="button"
                    onClick=${() => onSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}
                >
                    ${sort.dir === "asc" ? "Ascending" : "Descending"}
                </button>
            </div>
            <table class="dash-table">
                <caption class="dash-sr">
                    ${`Projects by repository, with owner subtotals. Sorted by ${(columns.find((column) => column.key === sort.key) ?? columns[0]).label}, ${sort.dir === "asc" ? "ascending" : "descending"}.`}
                </caption>
                <thead>
                    <tr>
                        ${columns.map(
                            (column) =>
                                html`<th scope="col" aria-sort=${ariaSort(column.key)}>
                                    <button
                                        type="button"
                                        class="dash-sort"
                                        onClick=${() => onSort(nextSort(sort, column.key))}
                                    >
                                        ${column.label}<span aria-hidden="true"
                                            >${sort.key === column.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span
                                        >
                                    </button>
                                </th>`,
                        )}
                    </tr>
                </thead>
                <tbody>
                    ${rows.length === 0 ? html`<tr><td colspan=${columns.length} class="muted">No project in this scope.</td></tr>` : rows.map(row)}
                </tbody>
                <tfoot>
                    ${row({
                        kind: "total",
                        name: "Scope total",
                        metrics: snapshot.totals,
                        usageUnknown: !usageAvailable(snapshot.coverage),
                    })}
                </tfoot>
            </table>
            ${
                snapshot.rows.unattributed
                    ? html`<p class="small muted">
                          The scope total includes the unattributed row: work with no repository, or with 2 or more
                          (a conflict). Project rows alone can sum lower than the total. Rates, medians and P90s of a
                          subtotal or the total come from their own records, never from the rows above them.
                      </p>`
                    : html`<p class="small muted">
                          Owner subtotals and the total come from their own records, never from the rows above them.
                      </p>`
            }
            <p class="small muted">
                "0 eligible": no eligible closure (completion), or no resolved issue (time to solve), in the range.
                "—": unknown, such as a cost that no entry reported.
            </p>
        </section>`;
    }

    const sourceRow = (name, source) =>
        html`<tr>
            <th scope="row">${SOURCE_NAMES[name] ?? name}</th>
            <td data-label="Status"><span class=${`dash-status-word ${source.status}`}>${source.status}</span></td>
            <td data-label="Last good"><${Value} text=${formatUtc(source.lastGoodAt)} /></td>
            <td data-label="Checked"><${Value} text=${formatUtc(source.checkedAt ?? source.at)} /></td>
            <td data-label="Error">${source.error ?? "none"}</td>
        </tr>`;

    function CoverageSection({ snapshot }) {
        const coverage = snapshot.coverage;
        const population = coverage.population;
        const github = coverage.progress.github;
        const usage = coverage.progress.usage;

        return html`<section class="desk-section dash-coverage" aria-labelledby="dash-coverage-title">
            <h2 id="dash-coverage-title">Coverage and definitions</h2>
            <dl class="dash-items">
                <${Item} label="Collection" text=${coverage.status} />
                <${Item} label="Recovery boundary" text=${formatUtc(coverage.boundary)} />
                <${Item} label="First day you can pick" text=${coverage.boundaryDay} />
                <${Item} label="Collection started" text=${formatUtc(coverage.initializedAt)} />
                <${Item}
                    label="GitHub refs pending"
                    text=${github.pending === null ? null : `${github.pending}${github.complete === true ? " (complete)" : github.complete === false ? " (not complete)" : ""}`}
                />
                <${Item} label="GitHub refs overdue" text=${formatCount(github.overdue)} />
                <${Item}
                    label="Usage sessions pending"
                    text=${usage.pending === null ? null : `${usage.pending}${usage.complete === true ? " (complete)" : usage.complete === false ? " (not complete)" : ""}`}
                />
                <${Item} label="Usage ledgers unreadable" text=${formatCount(usage.ledgerUnavailable)} />
            </dl>
            <table class="dash-sources">
                <caption class="small muted">Sources</caption>
                <thead>
                    <tr>
                        <th scope="col">Source</th>
                        <th scope="col">Status</th>
                        <th scope="col">Last good</th>
                        <th scope="col">Checked</th>
                        <th scope="col">Error</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(coverage.sources).map(([name, source]) => sourceRow(name, source))}
                </tbody>
            </table>
            <h3 class="dash-sub">Population</h3>
            <p class="small">${HELP.population}</p>
            <p class="small muted">
                ${`${plural(population.delivery, "delivery thread")} · ${plural(population.coordinators, "plan coordinator")} (not counted) · ${population.excluded.askOnly} ask-only and ${population.excluded.noWork} with no work (not counted) · ${population.gone} gone from the desk (kept)`}
            </p>
            <h3 class="dash-sub">Time</h3>
            <p class="small">${HELP.time}</p>
            <h3 class="dash-sub">Limitations</h3>
            <ul class="dash-limits small">
                ${coverage.limitations.map((each) => html`<li key=${each.code}>${each.text}</li>`)}
            </ul>
        </section>`;
    }

    function Dashboard() {
        const [selection, setSelection] = useState(() => ({ ...memory.selection }));
        const [snapshot, setSnapshot] = useState(memory.snapshot);
        const [error, setError] = useState(null);
        const [rangeError, setRangeError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [sort, setSortState] = useState(memory.sort);
        const [draft, setDraft] = useState(() => ({
            from: memory.selection.from || memory.snapshot?.range.from || "",
            to: memory.selection.to || memory.snapshot?.range.to || "",
        }));
        // The view's life: its timer, its read, and the selection of its last good answer.
        const life = useRef(null);

        /** Read the numbers for `next`. A refusal (400) keeps the last good numbers and selection. */
        const read = async (next) => {
            const current = life.current;

            if (current === null || current.gone) {
                return;
            }

            current.abort?.abort();

            const abort = new AbortController();

            current.abort = abort;
            current.inFlight = true;
            setBusy(true);

            try {
                const answer = await pocket.api(
                    dashboardPath(next, utcDay(Date.now()), memory.snapshot?.coverage.boundaryDay),
                    undefined,
                    { signal: abort.signal },
                );

                // An answer after the view left, or after a newer read began, changes nothing.
                if (current.gone || abort.signal.aborted) {
                    return;
                }

                memory.snapshot = answer;
                memory.selection = next;
                current.selection = next;
                current.readAt = Date.now();
                setSnapshot(answer);
                setSelection(next);
                setError(null);
                setRangeError(null);

                if (next.preset !== "custom") {
                    setDraft({ from: answer.range.from, to: answer.range.to });
                }
            } catch (failure) {
                if (current.gone || abort.signal.aborted) {
                    return;
                }

                current.readAt = Date.now();
                // The controls go back to the selection of the numbers shown: the timer reads that one again.
                setSelection(current.selection);

                if (failure?.status === 400) {
                    setRangeError(failure.message);
                } else {
                    setError(failure?.message ?? String(failure));
                }
            } finally {
                if (!current.gone && current.abort === abort) {
                    current.inFlight = false;
                    setBusy(false);
                }
            }
        };

        useEffect(() => {
            const current = {
                gone: false,
                abort: null,
                inFlight: false,
                readAt: 0,
                selection: { ...memory.selection },
                timer: null,
            };

            const tick = () => {
                if (document.visibilityState === "visible" && !current.inFlight) {
                    void read(current.selection);
                }
            };

            const onVisible = () => {
                if (
                    document.visibilityState === "visible" &&
                    Date.now() - current.readAt >= refreshMs
                ) {
                    tick();
                }
            };

            const stop = () => {
                current.gone = true;
                current.abort?.abort();
                clearInterval(current.timer);
                document.removeEventListener("visibilitychange", onVisible);
                mounted.delete(stop);
            };

            life.current = current;
            mounted.add(stop);
            document.addEventListener("visibilitychange", onVisible);
            current.timer = setInterval(tick, refreshMs);
            void read(current.selection);

            return stop;
        }, []);

        const pick = (next) => {
            setSelection(next);
            setRangeError(null);
            void read(next);
        };

        const setSort = (next) => {
            memory.sort = next;
            setSortState(next);
        };

        const applyCustom = (event) => {
            event.preventDefault();
            pick({ ...selection, preset: "custom", from: draft.from, to: draft.to });
        };

        const choices = snapshot?.choices;
        const owners = ownerChoices(choices, selection);
        const repos = repoChoices(choices, selection);
        const states = dashboardStates(snapshot, { error, rangeError });
        const notices = states.filter((state) => state.tone !== "info").length;
        const today = utcDay(snapshot?.asOf ?? Date.now());
        const boundaryDay = snapshot?.coverage.boundaryDay ?? "";
        const range = snapshot?.range;
        const notStarted = snapshot?.coverage.status === "not started";

        return html`<div class="desk dash">
            <header class="desk-head dash-head">
                <h1>Dashboard</h1>
                <p class="small muted">
                    Desk-tracked work only, not all GitHub activity. All dates and times are UTC.
                </p>
                <p class="small dash-asof" role="status">
                    ${
                        snapshot
                            ? html`As of <strong>${formatUtc(snapshot.asOf)}</strong>${" · coverage "}<strong
                                      >${snapshot.coverage.status}</strong
                                  >${
                                      notices > 0
                                          ? html` · <span class="dash-warn-word">${notices} notice${notices === 1 ? "" : "s"} below</span>`
                                          : " · all sources fresh"
                                  }`
                            : "Reading the dashboard…"
                    }
                    ${busy && snapshot ? html` · <span class="muted">updating…</span>` : null}
                </p>
            </header>
            <form class="dash-controls" aria-label="Scope and range" novalidate onSubmit=${applyCustom}>
                <div class="dash-scope">
                    <label>
                        Owner
                        <select
                            value=${selection.owner}
                            onChange=${(event) => pick(withOwner(selection, event.currentTarget.value))}
                        >
                            <option value="">All tracked work</option>
                            ${owners.map((owner) => html`<option value=${owner}>${owner}</option>`)}
                        </select>
                    </label>
                    <label>
                        Repository
                        <select
                            value=${selection.repo}
                            onChange=${(event) => pick(withRepo(selection, event.currentTarget.value))}
                        >
                            <option value="">${selection.owner ? `All of ${selection.owner}` : "All repositories"}</option>
                            ${repos.map((repo) => html`<option value=${repo}>${repo}</option>`)}
                        </select>
                    </label>
                </div>
                <div class="dash-presets" role="group" aria-label="Date range, UTC days">
                    ${PRESETS.map(
                        (days) =>
                            html`<button
                                type="button"
                                class="button dash-preset"
                                aria-pressed=${selection.preset === days ? "true" : "false"}
                                onClick=${() => pick({ ...selection, preset: days, from: "", to: "" })}
                            >
                                ${days} days
                            </button>`,
                    )}
                </div>
                <fieldset class="dash-custom">
                    <legend>Custom range (UTC, both days included)</legend>
                    <label>
                        From
                        <input
                            type="date"
                            value=${draft.from}
                            min=${boundaryDay || undefined}
                            max=${today}
                            onInput=${(event) => {
                                const value = event.currentTarget.value;

                                setDraft((now) => ({ ...now, from: value }));
                            }}
                        />
                    </label>
                    <label>
                        To
                        <input
                            type="date"
                            value=${draft.to}
                            min=${boundaryDay || undefined}
                            max=${today}
                            onInput=${(event) => {
                                const value = event.currentTarget.value;

                                setDraft((now) => ({ ...now, to: value }));
                            }}
                        />
                    </label>
                    <button
                        type="submit"
                        class="button"
                        aria-pressed=${selection.preset === "custom" ? "true" : "false"}
                        disabled=${draft.from === "" || draft.to === ""}
                    >
                        Apply custom range
                    </button>
                    <p class="small muted dash-wide">
                        ${`At most 366 days, not before ${boundaryDay || "the recovery boundary's day"}, not after ${today}.`}
                    </p>
                </fieldset>
                ${range ? html`<p class="small dash-range">${rangeLine(snapshot)}</p>` : null}
            </form>
            ${
                states.length > 0
                    ? html`<ul class="dash-states" aria-label="Notices">
                          ${states.map(
                              (state) =>
                                  html`<li class=${`dash-state ${state.tone}`} data-state=${state.code} role=${state.tone === "err" ? "alert" : undefined}>
                                      <strong>${state.tone === "err" ? "Error" : state.tone === "warn" ? "Note" : "Info"}:</strong>${" "}${state.text}
                                  </li>`,
                          )}
                      </ul>`
                    : null
            }
            ${
                snapshot === null
                    ? error
                        ? null
                        : html`<${Loader} label="Reading the dashboard" />`
                    : notStarted
                      ? html`<${CoverageSection} snapshot=${snapshot} />`
                      : html`<div class=${error ? "dash-body stale" : "dash-body"}>
                            <${Cards} snapshot=${snapshot} />
                            <${Trend} snapshot=${snapshot} />
                            <${Table} snapshot=${snapshot} sort=${sort} onSort=${setSort} />
                            <${CoverageSection} snapshot=${snapshot} />
                        </div>`
            }
        </div>`;
    }

    return Dashboard;
}
