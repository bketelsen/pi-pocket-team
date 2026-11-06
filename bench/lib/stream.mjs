// Reading Pi's JSON event stream: strict LF framing on bytes, usage totals, and stream timing.
// The authoritative usage of an assistant message is `message_end.message.usage`; while it streams, the latest
// `message_update.usage` is its cumulative usage. Total = the ended messages + the in-flight one.

/**
 * A byte splitter: `push(chunk)` returns the complete lines (LF only, an optional CR before it stripped), `end()`
 * returns the last line without LF, if any. It never splits on Unicode line separators (unlike `readline`).
 */
export function lineSplitter() {
    let rest = Buffer.alloc(0);

    const decode = (bytes) => {
        const text = bytes.toString("utf8");

        return text.endsWith("\r") ? text.slice(0, -1) : text;
    };

    return {
        push(chunk) {
            const lines = [];
            let buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
            let index;

            while ((index = buffer.indexOf(0x0a)) >= 0) {
                lines.push(decode(buffer.subarray(0, index)));
                buffer = buffer.subarray(index + 1);
            }

            rest = Buffer.from(buffer);

            return lines;
        },
        end() {
            const last = rest.length ? decode(rest) : null;

            rest = Buffer.alloc(0);

            return last === null || last === "" ? [] : [last];
        },
    };
}

/** An empty usage record. */
export const zeroUsage = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    cost: 0,
    partial: false,
});

/** Pi's usage object as the bench's usage fields. Tokens = input + output + cacheRead + cacheWrite. */
export function normalUsage(usage) {
    const input = Number(usage?.input) || 0;
    const output = Number(usage?.output) || 0;
    const cacheRead = Number(usage?.cacheRead) || 0;
    const cacheWrite = Number(usage?.cacheWrite) || 0;

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        tokens: input + output + cacheRead + cacheWrite,
        cost: Number(usage?.cost?.total) || 0,
    };
}

/** The sum of usage records (`partial` is true when any is). */
export function addUsage(...records) {
    const sum = zeroUsage();

    for (const record of records) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "tokens", "cost"]) {
            sum[key] += Number(record?.[key]) || 0;
        }

        sum.partial ||= Boolean(record?.partial);
    }

    sum.cost = Math.round(sum.cost * 1e9) / 1e9;

    return sum;
}

const DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/**
 * A tracker of 1 Pi run. `push(event, at)` takes each parsed event and its arrival time (ms, monotonic);
 * `usage()` gives the running total; `summary()` the final facts of the run.
 */
export function usageTracker() {
    let ended = zeroUsage();
    let inflight = null;
    let open = null;
    let lastAssistantEnd = null;
    let sawAssistantStart = false;
    let sawFinal = false;
    // When the request of the next assistant message left: the last turn start, tool end, or end of a user or
    // tool-result message. Pi emits an assistant `message_start` only when the provider stream starts, so time to
    // first token counts from here, not from `message_start`.
    let requestAt = null;
    const messages = [];

    const isAssistant = (event) => event.message?.role === "assistant";

    return {
        push(event, at) {
            switch (event?.type) {
                case "turn_start":
                case "tool_execution_end":
                    requestAt = at;
                    break;
                case "message_start":
                    if (isAssistant(event)) {
                        sawAssistantStart = true;
                        open = {
                            startAt: requestAt ?? at,
                            firstDeltaAt: null,
                            endAt: null,
                            output: 0,
                        };
                        inflight = zeroUsage();
                    }

                    break;
                case "message_update":
                    if (open) {
                        if (event.usage) {
                            inflight = normalUsage(event.usage);
                        }

                        if (
                            open.firstDeltaAt == null &&
                            DELTAS.has(event.assistantMessageEvent?.type)
                        ) {
                            open.firstDeltaAt = at;
                        }
                    }

                    break;
                case "message_end":
                    if (!isAssistant(event)) {
                        requestAt = at;
                    }

                    if (isAssistant(event)) {
                        const usage = normalUsage(event.message.usage);

                        ended = addUsage(ended, usage);
                        lastAssistantEnd = event.message;

                        const message = open ?? { startAt: at, firstDeltaAt: null };

                        messages.push({ ...message, endAt: at, output: usage.output });
                        open = null;
                        inflight = null;
                    }

                    break;
                case "agent_end":
                case "agent_settled":
                    sawFinal = true;
                    break;
                default:
                    break;
            }
        },
        /** The usage so far: the ended messages plus the in-flight one. */
        usage() {
            return inflight ? addUsage(ended, inflight) : { ...ended };
        },
        summary() {
            const usage = this.usage();

            usage.partial = !sawFinal || open !== null;

            return {
                usage,
                sawAssistantStart,
                providerError: lastAssistantEnd?.stopReason === "error",
                stream: streamStats(messages),
            };
        },
    };
}

/** The median of numbers, or null. */
const medianOf = (values) => {
    const sorted = [...values].sort((a, b) => a - b);

    if (sorted.length === 0) {
        return null;
    }

    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Stream timing of the assistant messages (`{ startAt, firstDeltaAt, endAt, output }`, ms).
 * Time to first token = first content delta - the request (`startAt`); generation = message end - first delta.
 * `outputTokens` and `genMs` count only the messages with a first delta and an end, so the rate is consistent.
 */
export function streamStats(messages) {
    const ttfts = messages
        .filter((m) => m.firstDeltaAt != null)
        .map((m) => Math.round(m.firstDeltaAt - m.startAt));
    const timed = messages.filter((m) => m.firstDeltaAt != null && m.endAt != null);
    const outputTokens = timed.reduce((sum, m) => sum + m.output, 0);
    const genMs = Math.round(timed.reduce((sum, m) => sum + (m.endAt - m.firstDeltaAt), 0));

    return {
        messages: messages.length,
        ttftMsMedian: medianOf(ttfts),
        ttftMsFirst: ttfts[0] ?? null,
        outputTokens,
        genMs,
        outputTps: genMs > 0 ? Math.round((outputTokens / (genMs / 1000)) * 100) / 100 : null,
    };
}
