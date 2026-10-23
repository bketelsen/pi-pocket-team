// Small pure helpers that the audit's checks, report and LLM step share.

/** A line that looks like a secret is dropped, not masked (design rule 5). */
export const SECRET = /ghp_|github_pat_|\bsk-|AKIA[0-9A-Z]{8}|-----BEGIN|password=|token=/i;

/** The longest quote the report may hold. */
export const MAX_QUOTE = 80;

export const MINUTE = 60_000;
export const HOUR = 3600_000;
export const DAY = 86_400_000;

/** `2026-10-23T14:05Z`: a time to the minute, in UTC. */
export const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

/** Money in the report: a dollar sign and always 2 decimals (`$486.80`). */
export const money = (value) => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

/** Money with more decimals for a tiny amount, such as the LLM's cost (`$0.0027`); at least 2 decimals. */
export const moneyFine = (value) =>
    `$${value
        .toFixed(4)
        .replace(/(\.\d\d)00$/, "$1")
        .replace(/(\.\d{3})0$/, "$1")}`;

export const dollars = (value) => Math.round(value * 100) / 100;

/** A line that is safe to keep: it is dropped (undefined) when it matches the secret filter. */
export const safeLine = (line) => (SECRET.test(String(line)) ? undefined : String(line));

/** A quote of at most 80 characters, or undefined when it matches the secret filter. */
export function quote(text, max = MAX_QUOTE) {
    const line = String(text).replace(/\s+/g, " ").trim();

    if (SECRET.test(line)) {
        return undefined;
    }

    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export const median = (values) => {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Add 1 to a counter object. */
export const bump = (counts, key, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
};

/** The PR refs (`owner/name#n`) in a text; a bare `name#n` takes the owner of the thread's repository. */
export function refsIn(text, repo) {
    const refs = [...text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)/g)].map((m) => `${m[1]}#${m[2]}`);
    const owner = repo?.split("/")[0];

    for (const [, name, number] of text.matchAll(/\b([a-z][\w.-]*)#(\d+)/g)) {
        if (owner && !text.includes(`/${name}#${number}`)) {
            refs.push(`${owner}/${name}#${number}`);
        }
    }

    return [...new Set(refs)];
}

/** The date `YYYY-MM-DD` of a time in America/New_York. */
export function newYorkDate(ms) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(ms);
}

/** The clock time `HH:MM` of a time in America/New_York. */
export function newYorkClock(ms) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(ms);
}

/** A merged PR whose head branch still exists 1 hour after the merge. `pr` is a GraphQL pull request. */
export const branchLeft = (pr, now) =>
    pr?.state === "MERGED" && Boolean(pr.headRef) && Date.parse(pr.mergedAt) < now - HOUR;
