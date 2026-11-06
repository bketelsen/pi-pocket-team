// Reading Pi's JSON stream: LF framing on bytes, usage totals, partial usage, provider errors and stream timing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, lineSplitter, streamStats, usageTracker } from "./lib/stream.mjs";

const usage = (input, output, cost, cacheRead = 0, cacheWrite = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { total: cost },
});

test("the splitter splits on LF only, across chunks, and keeps U+2028 inside a record", () => {
    const split = lineSplitter();
    const text = `{"a":"x\u2028y"}\r\n{"b":1}\n{"c"`;
    const bytes = Buffer.from(text, "utf8");
    // Split in the middle of the 3-byte U+2028.
    const cut = bytes.indexOf(0xe2) + 1;
    const lines = [...split.push(bytes.subarray(0, cut)), ...split.push(bytes.subarray(cut))];

    assert.deepEqual(lines, ['{"a":"x\u2028y"}', '{"b":1}']);
    assert.deepEqual(split.push(Buffer.from(":2}")), []);
    assert.deepEqual(split.end(), ['{"c":2}']);
});

test("usage: ended messages plus the latest update of the in-flight one", () => {
    const tracker = usageTracker();
    const start = { type: "message_start", message: { role: "assistant" } };
    const delta = (u) => ({
        type: "message_update",
        usage: u,
        assistantMessageEvent: { type: "text_delta", delta: "x" },
    });

    tracker.push({ type: "message_start", message: { role: "user" } }, 0);
    tracker.push(start, 0);
    tracker.push(delta(usage(10, 1, 0.1)), 100);
    tracker.push(delta(usage(10, 5, 0.2)), 200);
    tracker.push(
        { type: "message_end", message: { role: "assistant", usage: usage(10, 6, 0.25, 4, 2) } },
        300,
    );
    assert.equal(tracker.usage().cost, 0.25);
    assert.equal(tracker.usage().tokens, 22);

    tracker.push(start, 400);
    tracker.push(delta(usage(20, 2, 0.5)), 500);
    assert.equal(tracker.usage().cost, 0.75);
    assert.equal(tracker.usage().tokens, 44);

    const summary = tracker.summary();

    assert.equal(summary.usage.partial, true, "no message_end, no final event");
    assert.equal(summary.sawAssistantStart, true);
    assert.equal(summary.providerError, false);
});

test("a complete run is not partial; stopReason error on the last message is a provider error", () => {
    const tracker = usageTracker();

    tracker.push({ type: "message_start", message: { role: "assistant" } }, 0);
    tracker.push(
        {
            type: "message_end",
            message: { role: "assistant", usage: usage(1, 1, 0.01), stopReason: "error" },
        },
        10,
    );
    tracker.push({ type: "agent_end", messages: [] }, 11);

    const summary = tracker.summary();

    assert.equal(summary.usage.partial, false);
    assert.equal(summary.providerError, true);
});

test("compaction usage (compaction_end result.usage) counts in the total", () => {
    const tracker = usageTracker();

    tracker.push({ type: "compaction_start", reason: "threshold" }, 0);
    tracker.push(
        {
            type: "compaction_end",
            reason: "threshold",
            result: { usage: usage(1000, 200, 0.05, 30) },
        },
        1,
    );
    assert.equal(tracker.usage().cost, 0.05);
    assert.equal(tracker.usage().tokens, 1230);

    // An aborted compaction has no result.
    tracker.push({ type: "compaction_end", reason: "threshold", aborted: true }, 2);
    tracker.push({ type: "message_start", message: { role: "assistant" } }, 3);
    tracker.push(
        { type: "message_end", message: { role: "assistant", usage: usage(100, 50, 0.01) } },
        4,
    );
    assert.equal(tracker.usage().cost, 0.06);
    assert.equal(tracker.usage().tokens, 1380);
});

test("a run with no assistant message", () => {
    const summary = usageTracker().summary();

    assert.equal(summary.sawAssistantStart, false);
    assert.deepEqual(addUsage(), { ...summary.usage, partial: false });
});

test("stream timing: TTFT, generation time and output tokens per second", () => {
    const stats = streamStats([
        { startAt: 0, firstDeltaAt: 400, endAt: 2400, output: 100 },
        { startAt: 3000, firstDeltaAt: 3200, endAt: 4200, output: 50 },
        { startAt: 5000, firstDeltaAt: 6000, endAt: 7000, output: 30 },
        // An error message with no content delta: not timed.
        { startAt: 8000, firstDeltaAt: null, endAt: 8100, output: 0 },
    ]);

    assert.deepEqual(stats, {
        messages: 4,
        ttftMsMedian: 400,
        ttftMsFirst: 400,
        outputTokens: 180,
        genMs: 4000,
        outputTps: 45,
    });
    assert.equal(streamStats([]).outputTps, null);
});

test("the tracker times deltas of text, thinking and tool calls", () => {
    const tracker = usageTracker();

    tracker.push({ type: "message_start", message: { role: "assistant" } }, 1000);
    tracker.push(
        { type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
        1100,
    );
    tracker.push(
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
        1250,
    );
    tracker.push(
        { type: "message_end", message: { role: "assistant", usage: usage(5, 70, 0) } },
        2250,
    );

    const { stream } = tracker.summary();

    assert.equal(stream.ttftMsFirst, 250);
    assert.equal(stream.genMs, 1000);
    assert.equal(stream.outputTps, 70);
});

test("time to first token counts from the request, not from the assistant message_start", () => {
    const tracker = usageTracker();
    const delta = { type: "message_update", assistantMessageEvent: { type: "text_delta" } };
    const end = { type: "message_end", message: { role: "assistant", usage: usage(5, 10, 0) } };

    tracker.push({ type: "turn_start" }, 0);
    tracker.push({ type: "message_end", message: { role: "user" } }, 10);
    tracker.push({ type: "message_start", message: { role: "assistant" } }, 900);
    tracker.push(delta, 905);
    tracker.push(end, 1905);
    tracker.push({ type: "tool_execution_end" }, 3000);
    tracker.push({ type: "message_start", message: { role: "assistant" } }, 3700);
    tracker.push(delta, 3800);
    tracker.push(end, 4800);

    const { stream } = tracker.summary();

    assert.equal(stream.ttftMsFirst, 895);
    assert.equal(stream.ttftMsMedian, (895 + 800) / 2);
    assert.equal(stream.genMs, 2000);
});
