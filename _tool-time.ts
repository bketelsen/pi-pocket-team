/** Shared date formatting and a failure-safe clock line for Team and Desk tool results. */
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

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

const CLOCK_TOOLS = {
    team: new Set(["team_delegate", "team_work", "team_message", "team_memory", "team_sessions"]),
    desk: new Set(["desk", "plan"]),
};

/** Match exact owned names so the 2 hooks cannot stamp each other's or unrelated nested tools. */
export function isClockTool(owner: "team" | "desk", name: string): boolean {
    return CLOCK_TOOLS[owner].has(name);
}

/** Prefix the first text item so head-retain limits keep the clock; preserve all other fields and items. */
export function withToolTime<T extends ToolExecutionResult>(result: T) {
    const output = [...(result.output ?? [])];
    const firstText = output.findIndex((item) => item.type === "text");
    const line = toolTimeLine();
    const item = output[firstText];

    if (item?.type === "text") {
        output[firstText] = { ...item, text: `${line}\n${item.text}` };
    } else {
        output.unshift({ type: "text", text: line });
    }

    return { ...result, output };
}

/** Read the clock and the server's zone for this result, never from the journal configuration or a cached formatter. */
export function toolTimeLine(): string {
    try {
        const at = Date.now();
        const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

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
