// The LLM step on a fake model: the real model is never called. A valid answer goes through; each invalid answer
// falls back; the input cap, the cost guard and the 2-days-over-$0.50 rule hold.
import assert from "node:assert/strict";
import test from "node:test";
import { makeFinding } from "./checks.mjs";
import {
    MAX_DAILY_COST,
    MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
    MAX_PAIRS,
    MAX_PROPOSALS,
    PAIR_CHARS,
    SYSTEM_PROMPT,
    TOP_FINDINGS,
    estimateCost,
    estimateTokens,
    fitInput,
    pairText,
    parseAnswer,
    runLlm,
    selectPairs,
    validateAnswer,
} from "./llm.mjs";
import { annotate } from "./report.mjs";

const finding = (check: string, subject: string | undefined, text: string, over: object = {}) =>
    makeFinding({
        check,
        subject,
        severity: "high",
        text,
        evidence: [`desk/${subject}.md`],
        cases: 8,
        ...over,
    });

const ranked = () =>
    annotate(
        [
            finding(
                "A1",
                "T36",
                "T36 reopened 8 times (8 in 24 h). 6 reopens did no work, and cost $16.19",
                { waste: 16.19, evidence: ["desk/T36.md", "6 empty reopens of T36, $16.19"] },
            ),
            finding(
                "B1",
                "acme/widgets#7",
                "T95: 2 repair wake-ups for acme/widgets#7, but no check failed there",
                { cases: 2 },
            ),
            finding("A3", "T53", "T53 got 3 close-out wake-ups", { severity: "low", cases: 3 }),
        ],
        [],
        {},
    );
const metrics = {
    A1: { total: 47, empty: 31, emptyCost: 16.19 },
    B1: { total: 6 },
    A3: { sent: 42 },
};

type Answer = Record<string, unknown>;
const valid = (): Answer => ({
    pairs: [],
    summary: "T36 reopened 8 times. 2 repairs were false.",
    proposals: [
        {
            title: "Do not reopen a done thread",
            text: "T36 reopened 8 times, and 6 reopens did no work ($16.19).",
            cites: ["A1:T36"],
        },
        {
            title: "A cancelled run is not a failure",
            text: "2 repair wake-ups were false.",
            cites: ["B1:acme/widgets#7"],
        },
    ],
});

const pairsFixture = () => [
    {
        finding: "E1?:T65",
        check: "E1?",
        thread: "T65",
        a: { from: "team_message", at: 1, text: "first A" },
        b: { from: "team_message", at: 2, text: "first B" },
    },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
        finding: "E3",
        check: "E3",
        thread: `T${n}`,
        a: { from: "night-shift", at: n, text: `night ${n}` },
        b: { from: "team_message", at: n + 1, text: `message ${n}` },
    })),
];

/** A fake model. It records what it was sent; `answer` may be an object, or a string for a raw answer. */
function fake(
    answer: Answer | string,
    over: { cost?: { input: number; output: number }; usage?: object; stopReason?: string } = {},
) {
    const calls: { systemPrompt: string; content: string; options: { maxTokens: number } }[] = [];
    const getModel = async () => ({
        model: { cost: over.cost ?? { input: 0.3, output: 1.2 } },
        complete: async (systemPrompt: string, content: string, options: { maxTokens: number }) => {
            calls.push({ systemPrompt, content, options });

            return {
                content: [
                    {
                        type: "text",
                        text: typeof answer === "string" ? answer : JSON.stringify(answer),
                    },
                ],
                usage: over.usage ?? { input: 1234, output: 321, cost: { total: 0.0009 } },
                stopReason: over.stopReason ?? "stop",
            };
        },
    });

    return { calls, getModel };
}

const run = (model: { getModel: () => Promise<unknown> }, over: object = {}) =>
    runLlm({ ranked: ranked(), metrics, pairs: [], getModel: model.getModel as never, ...over });

test("the limits are the design's", () => {
    assert.equal(MAX_INPUT_TOKENS, 30000);
    assert.equal(MAX_OUTPUT_TOKENS, 2000);
    assert.equal(MAX_DAILY_COST, 0.5);
    assert.equal(MAX_PAIRS, 10);
    assert.equal(PAIR_CHARS, 1500);
    assert.equal(TOP_FINDINGS, 12);
    assert.equal(MAX_PROPOSALS, 5);
    assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("a valid answer goes into the record, with the tokens and the cost from the usage", async () => {
    const model = fake(valid());
    const llm = await run(model);

    assert.equal(llm.used, true);
    assert.equal(llm.failed, undefined);
    assert.equal(llm.model, "deepseek/deepseek-flash");
    assert.equal(llm.proposals.length, 2);
    assert.equal(llm.proposals[0].cites[0], "A1:T36");
    assert.match(llm.summary, /T36 reopened 8 times/);
    assert.equal(llm.inputTokens, 1234);
    assert.equal(llm.outputTokens, 321);
    assert.equal(llm.cost, 0.0009);
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0]!.options.maxTokens, 2000);
    assert.equal(model.calls[0]!.systemPrompt, SYSTEM_PROMPT);
});

test("the model sees finding texts, metrics and pair texts only: no evidence, no owner, no transcript", async () => {
    const model = fake(valid());

    await run(model, { pairs: pairsFixture() });

    const sent = JSON.parse(model.calls[0]!.content);

    assert.deepEqual(Object.keys(sent).sort(), ["findings", "metrics", "pairs"]);
    assert.deepEqual(Object.keys(sent.findings[0]).sort(), [
        "cases",
        "id",
        "severity",
        "text",
        "waste",
    ]);
    assert.ok(!model.calls[0]!.content.includes("desk/T36.md"));
    assert.ok(!model.calls[0]!.content.includes("Sheeana"));
    assert.deepEqual(Object.keys(sent.metrics).sort(), ["A1", "A3", "B1"]);
    // 1 E1 candidate and the 5 newest of 7 E3 pairs.
    assert.equal(sent.pairs.length, 6);
});

test("the answer may come in a code fence", async () => {
    const llm = await run(fake(`\`\`\`json\n${JSON.stringify(valid())}\n\`\`\``));

    assert.equal(llm.proposals.length, 2);
    assert.deepEqual(parseAnswer('```\n{"a":1}\n```'), { a: 1 });
});

test("pair verdicts are counted; a verdict outside same, different, partial is dropped", async () => {
    const answer = {
        ...valid(),
        pairs: [
            { id: "P1", verdict: "same", why: "x" },
            { id: "P2", verdict: "different", why: "x" },
            { id: "P3", verdict: "partial", why: "x" },
            { id: "P4", verdict: "identical", why: "x" },
            { id: "P99", verdict: "same", why: "x" },
            { id: "P2", verdict: "same", why: "twice" },
        ],
    };
    const llm = await run(fake(answer), { pairs: pairsFixture() });

    assert.deepEqual(
        llm.verdicts.map((v: { pair: string; verdict: string }) => [v.pair, v.verdict]),
        [
            ["P1", "same"],
            ["P2", "different"],
            ["P3", "partial"],
        ],
    );
    assert.deepEqual(llm.verdictCounts, { same: 1, different: 1, partial: 1 });
    // The record holds verdicts and finding ids, never the pair texts or the model's reasons.
    assert.ok(!JSON.stringify(llm).includes("first A"));
    assert.ok(!JSON.stringify(llm).includes("twice"));
    assert.equal(llm.verdicts[0].finding, "E1?:T65");
});

// ---------- The fallback ----------

async function failsWith(answer: Answer | string, reason: RegExp, over: object = {}) {
    const llm = await run(fake(answer), over);

    assert.equal(llm.failed, true, JSON.stringify(answer));
    assert.match(llm.reason, reason);
    assert.equal(llm.proposals, undefined);
    assert.equal(llm.summary, undefined);
    assert.equal(llm.used, true);
    // The call happened, so its use is on record.
    assert.equal(llm.inputTokens, 1234);

    return llm;
}

test("bad JSON falls back", async () => {
    await failsWith("this is not json", /not valid JSON/);
    await failsWith('{"summary": "cut off', /not valid JSON/);
    await failsWith("[1,2]", /not a JSON object/);
});

test("6 proposals fall back", async () => {
    const one = valid().proposals as object[];

    await failsWith(
        { ...valid(), proposals: Array.from({ length: 6 }, () => one[0]) },
        /6 proposals/,
    );
});

test("5 proposals are allowed", async () => {
    const one = (valid().proposals as object[])[0];
    const llm = await run(fake({ ...valid(), proposals: Array.from({ length: 5 }, () => one) }));

    assert.equal(llm.proposals.length, 5);
});

test("a proposal that cites an unknown id, or nothing, falls back", async () => {
    await failsWith(
        {
            ...valid(),
            proposals: [{ title: "t", text: "T36 reopened 8 times.", cites: ["A1:T99"] }],
        },
        /cites A1:T99, which is not one of the top findings/,
    );
    await failsWith(
        { ...valid(), proposals: [{ title: "t", text: "x", cites: [] }] },
        /cites no finding/,
    );
    await failsWith({ ...valid(), proposals: [{ title: "t", text: "x" }] }, /cites no finding/);
    await failsWith(
        { ...valid(), proposals: [{ title: "", text: "x", cites: ["A1:T36"] }] },
        /no title or text/,
    );
});

test("a proposal with a number that is not in the cited finding falls back", async () => {
    await failsWith(
        {
            ...valid(),
            proposals: [{ title: "t", text: "T36 reopened 999 times.", cites: ["A1:T36"] }],
        },
        /number 999/,
    );
    // 42 is in A3's metrics, not in A1's finding: citing A1 only is not enough.
    await failsWith(
        {
            ...valid(),
            proposals: [{ title: "t", text: "There were 42 wake-ups.", cites: ["A1:T36"] }],
        },
        /number 42/,
    );
});

test("numbers from the cited finding's text, evidence, cases, waste and ids, 1 to 5, and rounded dollars pass", () => {
    const top = ranked();
    const check = (text: string) =>
        validateAnswer(
            { proposals: [{ title: "t", text, cites: ["A1:T36"] }] },
            { findings: top, metrics, pairs: [] },
        ).ok;

    assert.equal(check("T36 reopened 8 times."), true); // the text, the id and the cases
    assert.equal(check("6 of them did no work."), true); // the text
    assert.equal(check("It cost $16 ($16.19)."), true); // rounded, and the waste field
    assert.equal(check("Do it in 3 steps, in 5 minutes."), true); // 1 to 5
    assert.equal(check("It happened 6 times."), true); // 6 is in the finding text
    assert.equal(check("It happened 7 times."), false);
    assert.equal(check("It cost $17."), false);
    assert.equal(check("It is in 1,162 places."), false);
});

test("a proposal may not use the metrics: they are totals of all threads, not facts of the cited finding", async () => {
    // 47, 31 and 16.19 are in the A1 metrics (all threads). 31 and 47 are not in the finding of T36.
    await failsWith(
        {
            ...valid(),
            proposals: [{ title: "t", text: "31 of 47 reopens did no work.", cites: ["A1:T36"] }],
        },
        /number (31|47)/,
    );

    // The same numbers are fine in the summary, which may use the metrics.
    const llm = await run(fake({ ...valid(), summary: "31 of 47 reopens did no work." }));

    assert.equal(llm.failed, undefined);
    assert.equal(llm.summary, "31 of 47 reopens did no work.");
});

test("a proposal may use a per-thread number of its own cited finding, not of another one", async () => {
    const own = validateAnswer(
        {
            proposals: [
                {
                    title: "t",
                    text: "T36 had 6 empty reopens that cost $16.19.",
                    cites: ["A1:T36"],
                },
            ],
        },
        { findings: ranked(), metrics, pairs: [] },
    );
    const other = validateAnswer(
        {
            proposals: [
                {
                    title: "t",
                    text: "T53 had 6 empty reopens that cost $16.19.",
                    cites: ["A3:T53"],
                },
            ],
        },
        { findings: ranked(), metrics, pairs: [] },
    );

    assert.equal(own.ok, true);
    assert.equal(other.ok, false);
    assert.match(other.reason!, /number (6|16\.19)/);
});

test("the model gets no rank; a rank, or a number that only the rank holds, is refused", async () => {
    const top = ranked();
    const rankValue = top[0].rank;

    assert.ok(
        rankValue !== undefined &&
            !JSON.stringify([
                top[0].text,
                top[0].evidence,
                top[0].cases,
                top[0].waste,
                top[0].id,
            ]).includes(String(rankValue)),
    );

    const model = fake(valid());

    await run(model);
    assert.ok(!/rank|score/i.test(model.calls[0]!.content));
    assert.ok(!model.calls[0]!.content.includes(String(rankValue)));
    assert.ok(!/rank|score/i.test(model.calls[0]!.content.replace(/"text":"[^"]*"/g, "")));

    // A second proposal that passes keeps the answer alive, so the reasons of the dropped item can be read.
    const check = (text: string, summary = "") =>
        validateAnswer(
            {
                summary,
                proposals: [
                    { title: "t", text, cites: ["A1:T36"] },
                    { title: "ok", text: "T36 reopened 8 times.", cites: ["A1:T36"] },
                ],
            },
            { findings: top, metrics, pairs: [] },
        );

    assert.deepEqual(check(`T36 has a rank of ${rankValue}.`).dropped[0], {
        item: "proposal 1",
        reason: "mentions a rank or a score",
    });
    // The number alone is also refused, since no cited finding holds it.
    assert.equal(
        check(`T36 matters at ${rankValue} points.`).dropped[0]!.reason,
        `the number ${rankValue} is in no cited finding`,
    );
    assert.equal(
        check("T36 is the top ranked one.").dropped[0]!.reason,
        "mentions a rank or a score",
    );
    assert.deepEqual(check("T36 reopened 8 times.", "T36 has the top rank.").dropped, [
        { item: "summary", reason: "mentions a rank or a score" },
    ]);
    assert.deepEqual(check("T36 reopened 8 times.", `The score is ${rankValue}.`).dropped, [
        { item: "summary", reason: "mentions a rank or a score" },
    ]);
});

test("the system prompt ties each number to its finding and calls a proposal a suggestion", () => {
    assert.match(SYSTEM_PROMPT, /Each number must belong to the finding it comes from/);
    assert.match(SYSTEM_PROMPT, /metrics are totals of all threads/);
    assert.match(SYSTEM_PROMPT, /A proposal is a suggestion for a person/);
    assert.match(SYSTEM_PROMPT, /Never write a rank/);
});

test("a summary that fails is dropped alone: the proposals stay", async () => {
    const dropsSummary = async (summary: unknown, reason: string) => {
        const llm = await run(fake({ ...valid(), summary }));

        assert.equal(llm.failed, undefined, reason);
        assert.equal(llm.proposals.length, 2);
        assert.equal(llm.summary, "");
        assert.deepEqual(llm.dropped, [{ item: "summary", reason }]);
    };

    await dropsSummary("One. Two. Three. Four.", "has more than 3 sentences");
    await dropsSummary("There were 777 failures.", "the number 777 is in no finding");
    await dropsSummary("Use the password=abc here.", "holds text that matches the secret filter");
    await dropsSummary(5, "is not text");
});

test("the summary may use the metrics and any finding", async () => {
    const llm = await run(
        fake({ ...valid(), summary: "42 wake-ups went out. 47 reopens. 6 repairs." }),
    );

    // 42, 47 and 6 are in the metrics of the findings the model saw.
    assert.equal(llm.failed, undefined);
    assert.equal(llm.summary, "42 wake-ups went out. 47 reopens. 6 repairs.");
    assert.deepEqual(llm.dropped, []);
});

test("each proposal is checked alone: only the bad one is dropped, with its reason on record", async () => {
    const [first, second] = valid().proposals as { title: string; text: string; cites: string[] }[];
    const bad = { title: "I1", text: "6 of 42 reports are missing.", cites: ["A3:T53"] };
    const llm = await run(
        fake({
            ...valid(),
            proposals: [first, second, { ...bad, text: "T53 got 3 wake-ups, 42 times." }, first],
        }),
    );

    assert.equal(llm.failed, undefined);
    assert.deepEqual(
        llm.proposals.map((p: { title: string }) => p.title),
        [first!.title, second!.title, first!.title],
    );
    assert.deepEqual(llm.dropped, [
        { item: "proposal 3", reason: "the number 42 is in no cited finding" },
    ]);
    assert.equal(llm.used, true);
});

test("each kind of proposal failure drops that proposal only", () => {
    const top = ranked();
    const good = { title: "ok", text: "T36 reopened 8 times.", cites: ["A1:T36"] };
    const reasons = (bad: object) =>
        validateAnswer({ proposals: [bad, good] }, { findings: top, metrics, pairs: [] });
    const cases: [object, string][] = [
        [{ title: "", text: "x", cites: ["A1:T36"] }, "has no title or text"],
        [{ title: "t", text: "x", cites: [] }, "cites no finding"],
        [
            { title: "t", text: "x", cites: ["A1:T99"] },
            "cites A1:T99, which is not one of the top findings",
        ],
        [
            { title: "t", text: "token=1", cites: ["A1:T36"] },
            "holds text that matches the secret filter",
        ],
        [{ title: "t", text: "x 999", cites: ["A1:T36"] }, "the number 999 is in no cited finding"],
        [null, "has no title or text"],
    ];

    for (const [bad, reason] of cases) {
        const result = reasons(bad);

        assert.equal(result.ok, true, reason);
        assert.deepEqual(result.dropped, [{ item: "proposal 1", reason }]);
        assert.equal(result.proposals!.length, 1);
    }
});

test("the whole answer falls back only when no proposal passes, or there are more than 5, or the JSON is bad", async () => {
    const bad = { title: "t", text: "T36 reopened 999 times.", cites: ["A1:T36"] };

    const none = await failsWith(
        { ...valid(), proposals: [bad, { ...bad, text: "x 777" }] },
        /no proposal passed the checks: proposal 1 the number 999 is in no cited finding; proposal 2 the number 777/,
    );

    assert.deepEqual(none.dropped.length, 2);
    await failsWith({ ...valid(), proposals: [] }, /the answer has no proposals/);
    await failsWith({ summary: "x" }, /the answer has no proposals/);
    await failsWith({ ...valid(), proposals: Array.from({ length: 6 }, () => bad) }, /6 proposals/);
    await failsWith("{ nope", /not valid JSON/);
});

test("a secret in a proposal falls back", async () => {
    await failsWith(
        {
            ...valid(),
            proposals: [
                { title: "t", text: "T36 reopened 8 times, token=abc.", cites: ["A1:T36"] },
            ],
        },
        /secret filter/,
    );
});

test("a failed answer keeps the valid pair verdicts and says why", async () => {
    const llm = await failsWith(
        {
            pairs: [{ id: "P1", verdict: "same" }],
            proposals: [{ title: "t", text: "x", cites: ["nope"] }],
        },
        /nope/,
        { pairs: pairsFixture() },
    );

    assert.deepEqual(llm.verdictCounts, { same: 1, different: 0, partial: 0 });
});

test("a call that throws, or a model that stops with an error, falls back with the reason", async () => {
    const throwing = {
        getModel: async () => ({
            model: { cost: { input: 1, output: 1 } },
            complete: async () => {
                throw new Error("rate limited\nmore detail");
            },
        }),
    };
    const llm = await run(throwing);

    assert.equal(llm.failed, true);
    assert.equal(llm.used, true);
    assert.equal(llm.reason, "the call failed: rate limited");

    const stopped = await run(fake(valid(), { stopReason: "error" }));

    assert.equal(stopped.failed, true);
    assert.match(stopped.reason, /the model stopped/);
});

// ---------- No model, no call ----------

test("--no-llm: no call, and the reason is on record", async () => {
    let asked = false;
    const llm = await runLlm({
        ranked: ranked(),
        metrics,
        enabled: false,
        getModel: async () => {
            asked = true;

            return {} as never;
        },
    });

    assert.equal(asked, false);
    assert.deepEqual([llm.used, llm.reason, llm.proposals], [false, "--no-llm", undefined]);
});

test("a missing model or its auth falls back with the reason, and never leaks a secret", async () => {
    const missing = await runLlm({
        ranked: ranked(),
        metrics,
        getModel: async () => {
            throw new Error("the model deepseek/deepseek-flash is not available");
        },
    });

    assert.equal(missing.used, false);
    assert.match(
        missing.reason,
        /the model or its auth is not available: the model deepseek\/deepseek-flash is not available/,
    );

    const leaky = await runLlm({
        ranked: ranked(),
        metrics,
        getModel: async () => {
            throw new Error("auth failed for ghp_abcdef123456 and sk-abc");
        },
    });

    assert.ok(!/ghp_|sk-/.test(JSON.stringify(leaky)));
    assert.match(leaky.reason, /\[dropped\]/);
});

test("no findings: no call", async () => {
    const model = fake(valid());
    const llm = await runLlm({ ranked: [], metrics: {}, getModel: model.getModel as never });

    assert.equal(model.calls.length, 0);
    assert.equal(llm.reason, "no findings");
});

// ---------- The cost guard ----------

test("the cost guard: an estimate above $0.50 makes no call", async () => {
    const model = fake(valid(), { cost: { input: 1, output: 300 } });
    const llm = await run(model);

    assert.equal(model.calls.length, 0);
    assert.equal(llm.used, false);
    assert.match(llm.reason, /the estimated cost \$0\.6\d* is above \$0\.5/);
    assert.ok(llm.estimateCost > 0.5);
});

test("the cost guard: an estimate under $0.50 makes the call", async () => {
    const model = fake(valid(), { cost: { input: 1, output: 240 } });
    const llm = await run(model);

    assert.equal(model.calls.length, 1);
    assert.equal(llm.used, true);
    assert.ok(llm.estimateCost > 0.48 && llm.estimateCost < 0.5);
});

test("estimateCost uses dollars per million tokens, with 2000 output tokens", () => {
    assert.equal(estimateCost({ cost: { input: 0.3, output: 1.2 } }, 30000, 2000), 0.0114);
    assert.equal(estimateCost({}, 30000, 2000), 0);
});

test("2 earlier days over $0.50 skip the call; 1 day, or exactly $0.50, does not", async () => {
    const day = (cost: number | undefined) => ({
        date: "d",
        json: { findings: [], llm: cost === undefined ? undefined : { cost } },
    });
    const skipped = fake(valid());
    const llm = await run(skipped, { earlier: [day(0.1), day(0.51), day(0.9)] });

    assert.equal(skipped.calls.length, 0);
    assert.equal(llm.used, false);
    assert.match(llm.reason, /the 2 earlier days each cost more than \$0\.5/);

    for (const earlier of [
        [day(0.9), day(0.2)],
        [day(0.2), day(0.9)],
        [day(0.5), day(0.5)],
        [day(0.9)],
        [day(undefined), day(0.9)],
        [],
    ]) {
        const model = fake(valid());

        await run(model, { earlier });
        assert.equal(model.calls.length, 1);
    }
});

// ---------- The input cap ----------

test("pairText drops a line with a secret and cuts to 1,500 characters", () => {
    assert.equal(pairText("fine\nuse ghp_abc here\nalso fine"), "fine\nalso fine");
    assert.equal(pairText("x".repeat(5000)).length, 1500);
    assert.equal(pairText("password=1\ntoken=2"), "");
});

test("selectPairs: the E1 candidates first, then at most 5 E3 samples, at most 10 in all", () => {
    const e1 = Array.from({ length: 8 }, (_, i) => ({
        finding: `E1?:T${i}`,
        check: "E1?",
        a: { from: "x", at: i, text: "a" },
        b: { from: "x", at: i, text: "b" },
    }));
    const e3 = Array.from({ length: 9 }, (_, i) => ({
        finding: "E3",
        check: "E3",
        a: { from: "night-shift", at: i, text: "a" },
        b: { from: "team_message", at: i, text: "b" },
    }));

    assert.equal(selectPairs([...e3, ...e1]).length, 10);
    assert.deepEqual(
        selectPairs([...e3, ...e1]).map((p: { check: string }) => p.check),
        [...Array(8).fill("E1?"), "E3", "E3"],
    );
    assert.equal(selectPairs(e3).length, 5);
    assert.deepEqual(
        selectPairs(e3).map((p: { id: string }) => p.id),
        ["P1", "P2", "P3", "P4", "P5"],
    );
    assert.equal(
        selectPairs(pairsFixture()).filter((p: { check: string }) => p.check === "E3").length,
        5,
    );
});

const bigFinding = (n: number, chars: number) =>
    annotate(
        [finding("A3", `T${n}`, "x".repeat(chars), { severity: "high", cases: 100 - n })],
        [],
        {},
    )[0];
const bigPairs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        finding: "E3",
        check: "E3",
        a: { from: "night-shift", at: i, text: "a".repeat(2000) },
        b: { from: "team_message", at: i, text: "b".repeat(2000) },
    }));

test("the input cap drops pairs first", () => {
    // 12 findings of about 2,250 tokens, and 5 pairs of about 750 tokens: over the cap by a little.
    const findings = Array.from({ length: 12 }, (_, i) => bigFinding(i, 9000));
    const fit = fitInput(findings, {}, bigPairs(5));

    assert.ok(fit.tokens <= MAX_INPUT_TOKENS);
    assert.equal(fit.findings.length, 12);
    assert.ok(fit.dropped.pairs >= 1);
    assert.equal(fit.dropped.findings, 0);
    assert.equal(fit.pairs.length, 5 - fit.dropped.pairs);
});

test("the input cap then drops findings from the bottom", () => {
    const findings = Array.from({ length: 12 }, (_, i) => bigFinding(i, 12000));
    const fit = fitInput(findings, {}, bigPairs(5));

    assert.ok(fit.tokens <= MAX_INPUT_TOKENS);
    assert.equal(fit.dropped.pairs, 5);
    assert.equal(fit.pairs.length, 0);
    assert.ok(fit.dropped.findings >= 1);
    // The best findings stay: the first ones, in order.
    assert.deepEqual(
        fit.findings.map((f: { id: string }) => f.id),
        findings.slice(0, fit.findings.length).map((f: { id: string }) => f.id),
    );
});

test("only the top 12 findings go in, and a small input is not cut", () => {
    const findings = Array.from({ length: 20 }, (_, i) => bigFinding(i, 100));
    const fit = fitInput(findings, {}, []);

    assert.equal(fit.findings.length, 12);
    assert.deepEqual(fit.dropped, { pairs: 0, findings: 0 });
});

test("a run with a huge input still calls the model once, within the cap, and records what it dropped", async () => {
    const model = fake({ proposals: [], summary: "" });
    const findings = Array.from({ length: 12 }, (_, i) => bigFinding(i, 12000));
    const llm = await runLlm({
        ranked: findings,
        metrics: {},
        pairs: bigPairs(5),
        getModel: model.getModel as never,
    });

    assert.equal(model.calls.length, 1);
    assert.ok(
        estimateTokens(model.calls[0]!.systemPrompt + model.calls[0]!.content) <=
            MAX_INPUT_TOKENS + 5,
    );
    assert.equal(llm.inputCut.pairs, 5);
    assert.ok(llm.inputCut.findings > 0);
    assert.ok(llm.estimateTokens <= MAX_INPUT_TOKENS);
});
