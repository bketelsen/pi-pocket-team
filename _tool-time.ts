/** Shared date formatting and a failure-safe clock line for incoming agent-session messages. */

/** The parts of a time in 1 zone, as `Intl` gives them. */
function zoneParts(at: number, timeZone: string): Record<string, string> {
    return Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(new Date(at))
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
    );
}

/** The day of a time in 1 zone: `2026-10-28`. An entry that waited still goes in the day it closed. */
export function journalDay(at: number, timeZone: string): string {
    const parts = zoneParts(at, timeZone);

    return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
}

/** The time of day of a time in 1 zone: `14:32`, 24-hour. */
export function journalTime(at: number, timeZone: string): string {
    const parts = zoneParts(at, timeZone);

    return `${parts.hour ?? ""}:${parts.minute ?? ""}`;
}

/**
 * A time as a reader of the digest reads it, in 1 zone: `2026-10-29 15:20 EDT`. The zone's short name is the one `Intl`
 * gives, such as "EDT", or "GMT-4" where it has no other.
 */
export function deskTime(at: number, timeZone: string): string {
    const name =
        new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
            .formatToParts(new Date(at))
            .find((part) => part.type === "timeZoneName")?.value ?? timeZone;

    return `${journalDay(at, timeZone)} ${journalTime(at, timeZone)} ${name}`;
}

/** Recognize our clock even inside a forwarded brief, and a digest's existing timed header. */
const MESSAGE_CLOCK =
    /^Current time: \d{4,}-\d{2}-\d{2} \d{2}:\d{2} [^\r\n]+ \([^\r\n]+\)\.$|^Current time unavailable \(server clock or time zone could not be read\)\.$|^\[desk\] digest: \d+ new\. Now [^\r\n]+$/m;

/** Add at most 1 clock line per message. A repeated or forwarded stamp keeps its original time and text. */
export function withMessageTime(message: string, at?: number, timeZone?: string): string {
    return MESSAGE_CLOCK.test(message) ? message : `${toolTimeLine(at, timeZone)}\n${message}`;
}

/** Inject time and zone in tests; runtime reads a fresh clock and default zone, not the journal configuration. */
export function toolTimeLine(at?: number, timeZone?: string): string {
    try {
        at ??= Date.now();
        timeZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone;

        if (!Number.isFinite(at) || typeof timeZone !== "string" || timeZone.trim() === "") {
            throw new Error("The server clock or time zone is unavailable.");
        }

        const time = deskTime(at, timeZone);

        if (!/^\d{4,}-\d{2}-\d{2} \d{2}:\d{2} [^\r\n]+$/.test(time)) {
            throw new Error("The server time could not be formatted.");
        }

        return `Current time: ${time} (${timeZone}).`;
    } catch {
        return "Current time unavailable (server clock or time zone could not be read).";
    }
}
