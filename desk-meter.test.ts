// The subscription meter's pure rules (`_desk-meter.ts`, plan T1747): the parser, the reading states, the burn and
// the projection, the granted resets, the ledger at list price, the line and the hold reason, on fixed answers and a
// fixed clock, in America/New_York. Nothing reads Brian's data, the network or the clock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
    addLedger,
    AGENT_READS,
    AGENT_RETRY_MS,
    agentCostView,
    attributeConversations,
    type AgentAttribution,
    type AgentLinks,
    type AgentResolver,
    type SessionAgent,
    CLAUDE_CLI_VERSION,
    claudeCliVersionIn,
    emptyMeterState,
    grantsLine,
    holdReason,
    ledgerLine,
    type LedgerUsage,
    localMidnight,
    mainWindow,
    type MeterSettings,
    type MeterState,
    meterFooter,
    meterLine,
    meterSettings,
    meterStatusLine,
    meterView,
    nextReadAt,
    OWNER_DEPTH,
    parseAnthropicUsage,
    type ProviderReading,
    pruneMeter,
    recordAttempt,
} from "./_desk-meter.ts";

const ZONE = "America/New_York";
const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SETTINGS: MeterSettings = {
    providers: ["anthropic"],
    pollMinutes: 5,
    digestAt: 75,
    holdAt: null,
};
const RESET_ISO = "2026-11-18T16:00:00Z";
const RESET = Date.parse(RESET_ISO);

// The R4 answer of the plan (2026-11-14 02:56 UTC), with ids removed; the code-name keys stay null.
const R4 = {
    limits: [
        {
            kind: "weekly_all",
            group: "weekly",
            percent: 95,
            severity: "critical",
            resets_at: RESET_ISO,
            scope: null,
            is_active: true,
        },
        {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 19,
            severity: "normal",
            resets_at: RESET_ISO,
            scope: { model: { display_name: "Fable" } },
            is_active: false,
        },
    ],
    five_hour: null,
    seven_day: { utilization: 95, resets_at: RESET_ISO },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_breakdown: {
        as_of: "2026-11-14T02:56:00Z",
        window_started_at: "2026-11-11T16:00:00Z",
        rows: [{ key: "claude_code", percent: 100 }],
    },
    extra_usage: { is_enabled: false },
    spend: { enabled: false },
    tangelo: null,
};

/** An answer with 1 `weekly_all` window (or a scoped one). */
function weekly(percent: number, resetsAt: string, scoped = false): Record<string, unknown> {
    return {
        limits: [
            scoped
                ? {
                      kind: "weekly_scoped",
                      percent,
                      severity: "normal",
                      resets_at: resetsAt,
                      scope: { model: { display_name: "Fable" } },
                      is_active: false,
                  }
                : {
                      kind: "weekly_all",
                      percent,
                      severity: "normal",
                      resets_at: resetsAt,
                      scope: null,
                      is_active: true,
                  },
        ],
    };
}

function reading(body: unknown, at: number): ProviderReading {
    const result = parseAnthropicUsage(body, at);

    assert.ok(!("error" in result), "the answer parses");

    return result;
}

function read(state: MeterState, body: unknown, at: number): void {
    recordAttempt(state, "anthropic", at, reading(body, at));
}

function anthropicRow(state: MeterState, now: number, settings = SETTINGS) {
    const row = meterView(state, settings, now, ZONE).providers[0];

    assert.ok(row !== undefined);
    assert.equal(row.provider, "anthropic");

    return row;
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

test("R4: the main window, its reset, and the line", () => {
    const now = Date.parse("2026-11-14T02:56:29Z");
    const state = emptyMeterState();

    read(state, R4, now);

    const row = anthropicRow(state, now);
    const main = row.windows.find((window) => window.id === row.mainWindowId);

    assert.equal(row.mainWindowId, "weekly_all");
    assert.equal(main?.percent, 95);
    assert.equal(main?.resetsAt, RESET);
    assert.equal(main?.state, "fresh");
    assert.ok(
        row.line.startsWith("Anthropic: week 95% used (critical), resets Wed 11:00 (in 4d 13h)"),
        row.line,
    );
    assert.ok(row.line.endsWith("· week, Fable 19%"), row.line);
    assert.equal(meterLine(row, now, ZONE), row.line);
});

test("R8: a drop at the same resetsAt is a reset; the old samples go", () => {
    const before = Date.parse("2026-11-14T03:08:46Z");
    const after = Date.parse("2026-11-14T03:16:52Z");
    const state = emptyMeterState();

    read(state, weekly(97, RESET_ISO), before);
    read(state, weekly(0, RESET_ISO), after);

    const row = anthropicRow(state, after);

    assert.ok(row.line.includes("reset seen 22:16"), row.line);
    assert.deepEqual(state.providers.anthropic?.samples[`weekly_all@${String(RESET)}`], [
        { at: after, percent: 0 },
    ]);
    assert.equal(state.providers.anthropic?.resetSeenAt.weekly_all, after);
});

test("parser: kinds, the limits rule, bad percents, duplicates, the main window, bad bodies", () => {
    const at = Date.parse("2026-11-14T03:00:00Z");
    const session = reading(
        { limits: [{ kind: "session", percent: 12, resets_at: "2026-11-14T05:00:00+00:00" }] },
        at,
    );

    assert.equal(session.windows[0]?.id, "five_hour");
    assert.equal(session.windows[0]?.lengthMs, 5 * HOUR);
    assert.equal(session.windows[0]?.resetsAt, Date.parse("2026-11-14T05:00:00Z"));

    assert.deepEqual(
        reading({ limits: [], seven_day: { utilization: 50, resets_at: RESET_ISO } }, at).windows,
        [],
    );

    const legacy = reading(
        {
            five_hour: { utilization: 10, resets_at: "2026-11-14T05:00:00Z" },
            seven_day: { utilization: 60, resets_at: RESET_ISO },
            seven_day_opus: null,
        },
        at,
    );

    assert.deepEqual(
        legacy.windows.map((window) => window.id),
        ["five_hour", "weekly_all"],
    );

    assert.deepEqual(reading(weekly("95" as unknown as number, RESET_ISO), at).windows, []);
    assert.deepEqual(reading(weekly(NaN, RESET_ISO), at).windows, []);

    const twice = reading(
        {
            limits: [
                { kind: "weekly_all", percent: 40, resets_at: RESET_ISO },
                { kind: "weekly_all", percent: 90, resets_at: RESET_ISO },
            ],
        },
        at,
    );

    assert.equal(twice.windows.length, 1);
    assert.equal(twice.windows[0]?.percent, 40);

    const active = reading(
        {
            limits: [
                { kind: "five_hour", percent: 10, resets_at: RESET_ISO, is_active: true },
                { kind: "weekly_all", percent: 90, resets_at: RESET_ISO, is_active: true },
            ],
        },
        at,
    );

    assert.equal(mainWindow(active.windows)?.id, "five_hour");
    assert.deepEqual(parseAnthropicUsage("not json", at), {
        error: "usage answer is not an object",
    });
    assert.deepEqual(parseAnthropicUsage([], at), { error: "usage answer is not an object" });
});

test("burn and projection come from provider samples; scoped windows get none", () => {
    const start = Date.parse("2026-11-14T00:00:00Z");
    const reset = iso(start + 4 * DAY);
    const state = emptyMeterState();

    read(state, weekly(90, reset), start);
    read(state, weekly(91, reset), start + 60 * MINUTE);
    read(state, weekly(92, reset), start + 120 * MINUTE);

    const main = anthropicRow(state, start + 120 * MINUTE).windows[0];

    assert.equal(main?.burnPerHour, 1);
    assert.equal(main?.burnSpanMinutes, 120);
    assert.equal(main?.hoursToFull, 8);
    assert.equal(main?.fullBeforeReset, true);

    const two = emptyMeterState();

    read(two, weekly(90, reset), start);
    read(two, weekly(92, reset), start + 120 * MINUTE);
    assert.equal(anthropicRow(two, start + 120 * MINUTE).windows[0]?.burnPerHour, undefined);

    const scoped = emptyMeterState();

    read(scoped, weekly(90, reset, true), start);
    read(scoped, weekly(91, reset, true), start + 60 * MINUTE);
    read(scoped, weekly(92, reset, true), start + 120 * MINUTE);

    const window = anthropicRow(scoped, start + 120 * MINUTE).windows[0];

    assert.equal(window?.scoped, true);
    assert.equal(window?.percent, 92);
    assert.equal(window?.burnPerHour, undefined);
    assert.equal(window?.projectedAtReset, undefined);
    assert.equal(window?.hoursToFull, undefined);
});

test("the hint: room that the reset will waste", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    const reset = iso(now + 20 * HOUR);
    const state = emptyMeterState();

    read(state, weekly(38, reset), now - 120 * MINUTE);
    read(state, weekly(39, reset), now - 60 * MINUTE);
    read(state, weekly(40, reset), now);

    const row = anthropicRow(state, now);

    assert.equal(row.windows[0]?.projectedAtReset, 60);
    assert.equal(row.windows[0]?.fullBeforeReset, false);
    assert.ok(row.line.includes("about 40% may go unused at reset"), row.line);
    assert.ok(row.line.includes("~60% at reset"), row.line);
});

test("states: stale after 2 polls, awaiting after the reset", () => {
    const at = Date.parse("2026-11-14T12:00:00Z");
    const state = emptyMeterState();

    read(state, weekly(70, RESET_ISO), at);

    const stale = anthropicRow(state, at + 11 * MINUTE);

    assert.equal(stale.windows[0]?.state, "stale");
    assert.equal(stale.windows[0]?.percent, 70);
    assert.ok(stale.line.includes("(read 11 min ago"), stale.line);

    // A stale reading keeps its percent and age, and gets no estimate (plan D2), also with 3 samples that give a burn.
    const start = Date.parse("2026-11-14T00:00:00Z");
    const burning = emptyMeterState();

    read(burning, weekly(90, RESET_ISO), start);
    read(burning, weekly(91, RESET_ISO), start + 60 * MINUTE);
    read(burning, weekly(92, RESET_ISO), start + 120 * MINUTE);

    const fresh = anthropicRow(burning, start + 120 * MINUTE).windows[0];

    assert.equal(fresh?.burnPerHour, 1);

    const old = anthropicRow(burning, start + 131 * MINUTE);
    const oldWindow = old.windows[0];

    assert.equal(oldWindow?.state, "stale");
    assert.equal(oldWindow?.percent, 92);
    assert.equal(oldWindow?.burnPerHour, undefined);
    assert.equal(oldWindow?.burnSpanMinutes, undefined);
    assert.equal(oldWindow?.hoursToFull, undefined);
    assert.equal(oldWindow?.fullBeforeReset, undefined);
    assert.equal(oldWindow?.projectedAtReset, undefined);
    assert.ok(old.line.includes("(read 11 min ago)"), old.line);
    assert.ok(!old.line.includes("%/h"), old.line);
    assert.ok(!old.line.includes("full in"), old.line);
    assert.ok(!old.line.includes("at reset"), old.line);

    const passed = emptyMeterState();

    read(passed, weekly(70, iso(at + HOUR)), at);

    const awaiting = anthropicRow(passed, at + 2 * HOUR);

    assert.equal(awaiting.windows[0]?.state, "awaiting");
    assert.equal(awaiting.windows[0]?.percent, undefined);
    assert.ok(awaiting.line.includes("reset passed, awaiting provider report"), awaiting.line);
});

test("grants: the line and the expiry warning; an ineligible answer", () => {
    const now = Date.parse("2026-11-14T03:00:00Z");
    const state = emptyMeterState();

    read(
        state,
        {
            ...weekly(50, RESET_ISO),
            cedar_ember: {
                eligible: true,
                grants: [
                    {
                        label: "Weekly",
                        type: "weekly",
                        resets_left: 2,
                        ends_at: iso(now + 3 * DAY),
                    },
                    {
                        label: "Fable",
                        type: "full",
                        resets_left: 2,
                        ends_at: "2027-03-09T07:59:00Z",
                    },
                ],
            },
        },
        now,
    );

    const row = anthropicRow(state, now);

    assert.equal(
        grantsLine(row, now, ZONE),
        "resets granted: Weekly ×2 (expire Mon 16 Nov 22:00) · Fable ×2 (expire Tue 9 Mar 02:59)",
    );
    assert.ok(row.line.includes("a Weekly reset expires in 3d unused"), row.line);
    assert.ok(!row.line.includes("a Fable reset"), row.line);

    const ineligible = reading(
        {
            ...weekly(50, RESET_ISO),
            cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
        },
        now,
    );

    assert.equal(ineligible.grantsNote, "not readable (surface)");
    assert.equal(ineligible.grants, undefined);

    const other = emptyMeterState();

    recordAttempt(other, "anthropic", now, ineligible);
    assert.equal(grantsLine(anthropicRow(other, now), now, ZONE), "grants: not readable (surface)");
});

test("holdReason: fresh windows that are not scoped only", () => {
    const now = Date.parse("2026-11-14T02:56:29Z");
    const state = emptyMeterState();

    read(state, R4, now);
    assert.equal(
        holdReason(meterView(state, SETTINGS, now, ZONE), ["anthropic"], 90, now, ZONE),
        "Anthropic week 95% ≥ 90%, resets Wed 11:00",
    );

    const fable = emptyMeterState();

    read(
        fable,
        {
            limits: [
                { kind: "weekly_all", percent: 19, resets_at: RESET_ISO, is_active: true },
                {
                    kind: "weekly_scoped",
                    percent: 95,
                    resets_at: RESET_ISO,
                    scope: { model: { display_name: "Fable" } },
                },
            ],
        },
        now,
    );
    assert.equal(
        holdReason(meterView(fable, SETTINGS, now, ZONE), ["anthropic"], 90, now, ZONE),
        undefined,
    );

    const later = now + 11 * MINUTE;

    assert.equal(
        holdReason(meterView(state, SETTINGS, later, ZONE), ["anthropic"], 90, later, ZONE),
        undefined,
    );
    assert.equal(
        holdReason(meterView(state, SETTINGS, now, ZONE), ["openai"], 90, now, ZONE),
        undefined,
    );
});

test("backoff: 429s, a success, a refused sign-in", () => {
    const state = emptyMeterState();
    let at = Date.parse("2026-11-14T03:00:00Z");

    assert.equal(nextReadAt(state, "anthropic", SETTINGS), 0);

    for (const minutes of [15, 30, 60, 60]) {
        recordAttempt(state, "anthropic", at, { error: "rate limited", status: 429 });
        assert.equal(nextReadAt(state, "anthropic", SETTINGS), at + minutes * MINUTE);
        at += minutes * MINUTE;
    }

    assert.equal(state.providers.anthropic?.lastAttempt?.error, "HTTP 429");

    read(state, weekly(10, RESET_ISO), at);
    assert.equal(nextReadAt(state, "anthropic", SETTINGS), at + 5 * MINUTE);
    assert.equal(state.providers.anthropic?.backoff429, 0);

    at += 5 * MINUTE;
    recordAttempt(state, "anthropic", at, { error: "unauthorized", status: 401 });
    assert.equal(nextReadAt(state, "anthropic", SETTINGS), at + 30 * MINUTE);
    assert.equal(state.providers.anthropic?.lastAttempt?.error, "sign-in refused, 401");
});

test("ledger: buckets, no cost, no timestamp, pruning, partial, today in the zone", () => {
    const state = emptyMeterState();
    const base = {
        provider: "anthropic",
        model: "claude-opus-5-5",
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
    };
    const noon = Date.parse("2026-11-20T12:00:00Z");

    addLedger(state, { ...base, timestamp: noon + MINUTE, cost: 1.5 });
    addLedger(state, { ...base, timestamp: noon + 3 * MINUTE, cost: 2.5 });
    assert.deepEqual(state.buckets[String(noon)]?.anthropic?.["claude-opus-5-5"], {
        entries: 2,
        input: 20,
        output: 40,
        cacheRead: 60,
        cacheWrite: 80,
        cost: 4,
        unknownCost: 0,
    });

    addLedger(state, { ...base, timestamp: noon + 4 * MINUTE });
    assert.equal(state.buckets[String(noon)]?.anthropic?.["claude-opus-5-5"]?.cost, 4);
    assert.equal(state.buckets[String(noon)]?.anthropic?.["claude-opus-5-5"]?.unknownCost, 1);
    assert.equal(state.buckets[String(noon)]?.anthropic?.["claude-opus-5-5"]?.entries, 3);

    const keys = Object.keys(state.buckets).length;

    addLedger(state, { ...base, cost: 9 });
    assert.equal(state.skipped, 1);
    assert.equal(Object.keys(state.buckets).length, keys);

    const old = noon - 9 * DAY;
    const recent = noon - DAY;

    addLedger(state, { ...base, timestamp: old, cost: 1 });
    addLedger(state, { ...base, timestamp: recent, cost: 1 });
    pruneMeter(state, noon);
    assert.equal(state.buckets[String(old)], undefined);
    assert.ok(state.buckets[String(recent)] !== undefined);

    const partial = anthropicRow(state, noon + 5 * MINUTE).ledger;

    assert.equal(partial.partial, true);
    assert.equal(partial.unknownCost, 1);

    state.coverage = { since: noon - 8 * DAY, complete: true, done: 3, total: 3 };
    assert.equal(anthropicRow(state, noon + 5 * MINUTE).ledger.partial, false);

    const day = emptyMeterState();

    addLedger(day, { ...base, timestamp: Date.parse("2026-11-20T04:30:00Z"), cost: 2000 });
    addLedger(day, { ...base, timestamp: Date.parse("2026-11-20T05:30:00Z"), cost: 263.4 });

    const row = anthropicRow(day, noon);

    assert.equal(row.ledger.today, 263.4);
    assert.equal(row.ledger.days7, 2263.4);
    assert.equal(row.ledger.lastHour, 0);
    assert.deepEqual(row.ledger.top, [{ model: "claude-opus-5-5", cost: 2263.4 }]);
    assert.equal(
        ledgerLine(row),
        "list price: $0 last hour, $263 today, $2,263 in 7 days (partial); top: claude-opus-5-5 $2,263",
    );
});

test("ledger: names such as __proto__, constructor and toString are own keys and never touch Object.prototype", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const state = emptyMeterState();
    const names = ["__proto__", "constructor", "toString"];

    for (const name of names) {
        addLedger(state, {
            provider: "anthropic",
            model: name,
            timestamp: now - MINUTE,
            input: 1,
            output: 1,
            cacheRead: 1,
            cacheWrite: 1,
            cost: 10,
        });
        addLedger(state, {
            provider: name,
            model: "m",
            timestamp: now - MINUTE,
            input: 1,
            output: 1,
            cacheRead: 1,
            cacheWrite: 1,
            cost: 1,
        });
    }

    for (const key of [
        "entries",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cost",
        "unknownCost",
    ]) {
        assert.equal(Object.hasOwn(Object.prototype, key), false, `Object.prototype.${key}`);
    }

    const byModel = Object.values(state.buckets)[0]?.anthropic;

    assert.ok(byModel !== undefined);

    for (const name of names) {
        assert.ok(Object.hasOwn(byModel, name), name);
        assert.equal(byModel[name]?.entries, 1);
        assert.equal(byModel[name]?.cost, 10);
    }

    const row = anthropicRow(state, now);

    assert.equal(row.ledger.days7, 30);
    assert.equal(row.ledger.lastHour, 30);
    assert.deepEqual(
        row.ledger.top.map((item) => [item.model, item.cost]),
        [
            ["__proto__", 10],
            ["constructor", 10],
            ["toString", 10],
        ],
    );

    // A window id from the provider can be such a name too.
    read(state, { limits: [{ kind: "__proto__", percent: 50, resets_at: RESET_ISO }] }, now);
    read(
        state,
        { limits: [{ kind: "__proto__", percent: 10, resets_at: RESET_ISO }] },
        now + MINUTE,
    );
    assert.equal(state.providers.anthropic?.resetSeenAt.__proto__, now + MINUTE);
    assert.equal(Object.hasOwn(Object.prototype, "percent"), false);
});

test("claudeCliVersionIn reads pi-ai's claudeCodeVersion from a text", () => {
    assert.equal(
        claudeCliVersionIn(
            ['const something = "x";', 'const claudeCodeVersion = "9.8.7";', "export {}"].join(
                "\n",
            ),
        ),
        "9.8.7",
    );
});

test("claudeCliVersionIn falls back to CLAUDE_CLI_VERSION for a text with no usable version", () => {
    assert.equal(claudeCliVersionIn(undefined), CLAUDE_CLI_VERSION);
    assert.equal(claudeCliVersionIn(""), CLAUDE_CLI_VERSION);
    assert.equal(claudeCliVersionIn('export const other = "1.2.3";'), CLAUDE_CLI_VERSION);
    // A value goes into an HTTP header: no newline, no colon, no letters.
    assert.equal(
        claudeCliVersionIn('const claudeCodeVersion = "1.2.3\r\nx-evil: 1";'),
        CLAUDE_CLI_VERSION,
    );
    assert.equal(claudeCliVersionIn('const claudeCodeVersion = "abc";'), CLAUDE_CLI_VERSION);
});

test("pi-ai's real file still holds a claudeCodeVersion of the accepted form", () => {
    const file = readFileSync(
        join(
            import.meta.dirname,
            "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
        ),
        "utf8",
    );
    const match = /const claudeCodeVersion = "([^"]+)"/.exec(file);

    // When this fails, pi-ai renamed or moved the constant: `claudeCliVersionIn` no longer finds it.
    assert.ok(match !== null, "pi-ai has no claudeCodeVersion");
    assert.match(match[1] ?? "", /^\d+(\.\d+){1,3}$/);
    assert.equal(claudeCliVersionIn(file), match[1]);
});

test("meterSettings: off, defaults, bad values", () => {
    assert.deepEqual(meterSettings(undefined), { settings: undefined, warnings: [] });
    assert.deepEqual(meterSettings({}), { settings: SETTINGS, warnings: [] });

    const poll = meterSettings({ pollMinutes: 2 });

    assert.equal(poll.settings?.pollMinutes, 5);
    assert.deepEqual(poll.warnings, [
        "desk.json meter.pollMinutes must be a whole number from 5 to 60: 2 is not, so the meter uses 5.",
    ]);

    const low = meterSettings({ holdAt: 40 });

    assert.equal(low.settings?.holdAt, null);
    assert.deepEqual(low.warnings, [
        "desk.json meter.holdAt must be a whole number from 50 to 100, or null: 40 is not, so the meter uses null (no hold).",
    ]);

    const hold = meterSettings({ holdAt: 90 });

    assert.equal(hold.settings?.holdAt, 90);
    assert.deepEqual(hold.warnings, []);
});

test("lines with no provider report", () => {
    const now = Date.parse("2026-11-14T03:00:00Z");
    const state = emptyMeterState();
    const view = meterView(state, SETTINGS, now, ZONE);

    assert.deepEqual(
        view.providers.map((row) => row.line),
        [
            "Anthropic: no provider report (not read yet)",
            "OpenAI: no provider report (Pi's ChatGPT sign-in has no usage endpoint)",
        ],
    );

    recordAttempt(state, "anthropic", now, { error: "unauthorized", status: 401 });
    assert.equal(
        anthropicRow(state, now).line,
        "Anthropic: no provider report (sign-in refused, 401)",
    );
});

test("no list price becomes a percent", () => {
    const now = Date.parse("2026-11-14T03:00:00Z");
    const state = emptyMeterState();

    for (let n = 0; n < 50; n += 1) {
        addLedger(state, {
            provider: "anthropic",
            model: "claude-opus-5-5",
            timestamp: now - n * MINUTE,
            input: 1,
            output: 1,
            cacheRead: 1,
            cacheWrite: 1,
            cost: 500,
        });
    }

    const view = meterView(state, SETTINGS, now, ZONE);
    const row = view.providers[0];

    assert.equal(row?.ledger.days7, 25_000);
    assert.deepEqual(row?.windows, []);
    assert.equal(row?.mainWindowId, undefined);
    assert.equal(row?.line, "Anthropic: no provider report (not read yet)");
    assert.ok(!JSON.stringify(view).includes('"percent"'));
    assert.equal(holdReason(view, ["anthropic"], 50, now, ZONE), undefined);

    const off = meterView(state, { ...SETTINGS, providers: [] }, now, ZONE);

    assert.equal(
        off.providers[0]?.line,
        "Anthropic: no provider report (provider reads off in meter.providers)",
    );
});

test("meterStatusLine: the provider read, the ledger's coverage and the hold, in the zone", () => {
    const now = Date.parse("2026-11-14T02:56:29Z");
    const state = emptyMeterState();
    const line = (settings = SETTINGS) =>
        meterStatusLine(meterView(state, settings, now, ZONE), now, ZONE);

    assert.equal(
        line(),
        "Meter: provider read never; ledger filling 0 of 0 conversations; hold off",
    );
    assert.equal(
        line({ ...SETTINGS, providers: [] }),
        "Meter: provider reads off; ledger filling 0 of 0 conversations; hold off",
    );

    state.coverage = { since: now - 8 * DAY, complete: false, done: 120, total: 400 };
    read(state, weekly(75, RESET_ISO), now - 25 * MINUTE);

    assert.equal(
        line(),
        "Meter: provider read 25 min ago (last attempt ok); ledger filling 120 of 400 conversations; hold off",
    );

    state.coverage = { since: now - 8 * DAY, complete: true, done: 400, total: 400 };

    assert.equal(
        line({ ...SETTINGS, holdAt: 90 }),
        "Meter: provider read 25 min ago (last attempt ok); ledger complete since Thu 5 Nov 21:56; hold at 90%",
    );

    recordAttempt(state, "anthropic", now - MINUTE, { error: "HTTP 429", status: 429 });

    assert.equal(
        line(),
        "Meter: provider read 25 min ago (last attempt: HTTP 429 at 21:55); ledger complete since Thu 5 Nov 21:56; hold off",
    );

    const later = now + 2 * HOUR;

    assert.equal(
        meterStatusLine(meterView(state, SETTINGS, later, ZONE), later, ZONE),
        "Meter: provider read 2h25m ago (last attempt: HTTP 429 at 21:55); ledger complete since Thu 5 Nov 21:56; hold off",
    );
});

test("meterFooter: a fresh or stale main window at digestAt or more; none below, none awaiting, none unread", () => {
    const now = Date.parse("2026-11-14T02:56:29Z");

    const footer = (percent: number, at: number, when = now) => {
        const state = emptyMeterState();

        read(state, weekly(percent, RESET_ISO), at);

        return meterFooter(meterView(state, SETTINGS, when, ZONE), 75);
    };

    assert.deepEqual(footer(75, now), [
        "Meter: Anthropic: week 75% used, resets Wed 11:00 (in 4d 13h)",
    ]);
    assert.deepEqual(footer(74, now), []);
    assert.deepEqual(footer(80, now - 25 * MINUTE), [
        "Meter: Anthropic: week 80% used (read 25 min ago), resets Wed 11:00 (in 4d 13h)",
    ]);
    assert.deepEqual(footer(95, now, RESET + MINUTE), [], "an awaiting window has no percent");
    assert.deepEqual(meterFooter(meterView(emptyMeterState(), SETTINGS, now, ZONE), 75), []);
});

test("the module has no run-time import and reads no clock", () => {
    const text = readFileSync(join(import.meta.dirname, "_desk-meter.ts"), "utf8");
    const imports = text.split("\n").filter((line) => /^\s*import\b/.test(line));

    for (const line of imports) {
        assert.match(line, /^\s*import type\b/);
    }

    assert.ok(!text.includes("Date.now("));
});

// ─── The cost by agent ──────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-20T12:00:00Z");
/** New York's midnight of the test's day: 05:00 UTC in EST. */
const MIDNIGHT = Date.parse("2026-11-20T05:00:00Z");

/** The sum of 1 counter over every bucket of the ledger. */
const ledgerTotal = (state: MeterState, key: "entries" | "unknownCost"): number =>
    Object.values(state.buckets).reduce(
        (sum, byProvider) =>
            sum +
            Object.values(byProvider).reduce(
                (each, byModel) =>
                    each + Object.values(byModel).reduce((one, bucket) => one + bucket[key], 0),
                0,
            ),
        0,
    );

/** 1 ledger entry of `conversation`, at `at`, with `cost` (absent: no cost). */
const entryOf = (
    conversation: number | undefined,
    at: number,
    cost: number | undefined,
    provider = "anthropic",
    model = "claude-opus-5-5",
): LedgerUsage => ({
    provider,
    model,
    timestamp: at,
    input: 100,
    output: 10,
    cacheRead: 1000,
    cacheWrite: 0,
    ...(cost === undefined ? {} : { cost }),
    ...(conversation === undefined ? {} : { conversation }),
});

test("addLedger: each answer counts in its conversation's quarter hour, and only with a valid conversation", () => {
    const state = emptyMeterState();
    const quarter = String(Date.parse("2026-11-20T12:00:00Z"));
    const next = String(Date.parse("2026-11-20T12:15:00Z"));

    addLedger(state, entryOf(7, Date.parse("2026-11-20T12:01:00Z"), 2));
    addLedger(state, entryOf(7, Date.parse("2026-11-20T12:14:00Z"), 3));
    addLedger(state, entryOf(7, Date.parse("2026-11-20T12:15:00Z"), 5));
    addLedger(state, entryOf(8, Date.parse("2026-11-20T12:02:00Z"), 9));

    assert.deepEqual(state.conversations[quarter]?.["7"]?.anthropic?.["claude-opus-5-5"], {
        entries: 2,
        input: 200,
        output: 20,
        cacheRead: 2000,
        cacheWrite: 0,
        cost: 5,
        unknownCost: 0,
    });
    assert.equal(state.conversations[quarter]?.["8"]?.anthropic?.["claude-opus-5-5"]?.cost, 9);
    assert.equal(state.conversations[next]?.["7"]?.anthropic?.["claude-opus-5-5"]?.cost, 5);

    // The 5-minute buckets sum the same answers, whatever their conversation.
    assert.equal(ledgerTotal(state, "entries"), 4);

    // A cost the answer did not give counts in `unknownCost` on both sides.
    addLedger(state, entryOf(7, Date.parse("2026-11-20T12:05:00Z"), undefined));
    assert.equal(
        state.conversations[quarter]?.["7"]?.anthropic?.["claude-opus-5-5"]?.unknownCost,
        1,
    );
    assert.equal(ledgerTotal(state, "unknownCost"), 1);

    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        addLedger(state, entryOf(bad, Date.parse("2026-11-20T12:07:00Z"), 1));
    }

    addLedger(state, entryOf(undefined, Date.parse("2026-11-20T12:08:00Z"), 1));

    assert.deepEqual(
        Object.keys(state.conversations[quarter] ?? {}).sort(),
        ["7", "8"],
        "no other conversation, and no name such as NaN",
    );
    assert.equal(ledgerTotal(state, "entries"), 11);

    // An answer with no timestamp counts nowhere, and no quarter hour is made for it.
    const quarters = Object.keys(state.conversations).length;

    addLedger(state, { ...entryOf(9, NOW, 1), timestamp: undefined });
    assert.equal(state.skipped, 1);
    assert.equal(Object.keys(state.conversations).length, quarters);
});

test("pruneMeter: the conversation quarter hours older than 8 days go", () => {
    const state = emptyMeterState();
    const old = Date.parse("2026-11-11T12:00:00Z");

    addLedger(state, entryOf(1, old, 1));
    addLedger(state, entryOf(2, NOW - DAY, 1));
    pruneMeter(state, NOW);

    assert.equal(state.conversations[String(old)], undefined);
    assert.ok(state.conversations[String(NOW - DAY)] !== undefined);
    assert.equal(Object.keys(state.conversations).length, 1);
});

/** The attribution of 1 conversation, as `attributeConversations` gives it. */
async function attributed(
    links: Partial<AgentLinks>,
    personas: Record<number, string | undefined>,
    ids: number[],
    patch: Partial<AgentResolver> = {},
): Promise<{ found: Map<number, AgentAttribution>; reads: number[]; cache: Map<number, unknown> }> {
    const reads: number[] = [];
    const resolver: AgentResolver = {
        persona: async (session) => {
            reads.push(session);

            return personas[session];
        },
        links: {
            owners: new Map(),
            desk: new Map(),
            linkedFrom: new Map(),
            ...links,
        },
        cache: new Map(),
        now: NOW,
        maxReads: AGENT_READS,
        ...patch,
    };
    const found = await attributeConversations(ids, resolver);

    return { found, reads, cache: resolver.cache };
}

test("attributeConversations: the identity, the Desk's link, and the session that started it", async () => {
    const owners = new Map<number, number | null>([
        [1, null],
        [2, null],
        [3, null],
        [9, null],
    ]);

    // The session's own identity (Team's persona) comes first.
    const identity = await attributed(
        { owners, desk: new Map([[1, "clerk"]]), linkedFrom: new Map([[1, 9]]) },
        { 1: "odrade" },
        [1],
    );

    assert.deepEqual(identity.found.get(1), {
        kind: "agent",
        agent: "odrade",
        via: "identity",
        session: 1,
    });
    assert.deepEqual(identity.reads, [1]);

    // Then the Desk's link, when no identity answers.
    const desk = await attributed({ owners, desk: new Map([[2, "clerk"]]) }, {}, [2]);

    assert.deepEqual(desk.found.get(2), {
        kind: "agent",
        agent: "clerk",
        via: "desk",
        session: 2,
    });

    // Then the session that started it: the agent is that session's, and only 1 session is read twice.
    const linked = await attributed(
        { owners, linkedFrom: new Map([[3, 9]]) },
        { 9: "duncan" },
        [3],
    );

    assert.deepEqual(linked.found.get(3), {
        kind: "agent",
        agent: "duncan",
        via: "linked",
        session: 3,
    });
    assert.deepEqual(linked.reads, [3, 9]);
});

test("attributeConversations: a subagent gets its root session's agent, 2 levels deep, also under a linked session", async () => {
    const owners = new Map<number, number | null>([
        [3, null],
        [9, null],
        [10, 3],
        [11, 10],
        [20, 9],
    ]);

    const deep = await attributed({ owners }, { 3: "odrade" }, [10, 11]);

    assert.deepEqual(deep.found.get(10), {
        kind: "agent",
        agent: "odrade",
        via: "identity",
        session: 3,
    });
    assert.deepEqual(deep.found.get(11), {
        kind: "agent",
        agent: "odrade",
        via: "identity",
        session: 3,
    });
    assert.deepEqual(deep.reads, [3], "the root session is read once");

    const underLinked = await attributed(
        { owners, linkedFrom: new Map([[9, 3]]) },
        { 3: "odrade" },
        [20],
    );

    assert.deepEqual(underLinked.found.get(20), {
        kind: "agent",
        agent: "odrade",
        via: "linked",
        session: 9,
    });
});

test("attributeConversations: unattributed, pending, a spent read budget, and a persona that throws", async () => {
    // A session that nothing names is unattributed, and its answer is cached.
    const none = await attributed({ owners: new Map([[4, null]]) }, {}, [4]);

    assert.deepEqual(none.found.get(4), { kind: "unattributed", session: 4 });
    assert.deepEqual(none.cache.get(4), { at: NOW });

    // A creator that is not read yet is pending, and no persona is read for it.
    const pending = await attributed({}, { 5: "odrade" }, [5]);

    assert.deepEqual(pending.found.get(5), { kind: "pending" });
    assert.deepEqual(pending.reads, []);

    // A call that spent its reads leaves the rest pending, and caches nothing of them.
    const spent = await attributed(
        {
            owners: new Map([
                [6, null],
                [7, null],
            ]),
        },
        { 6: "odrade", 7: "clerk" },
        [6, 7],
        { maxReads: 1 },
    );

    assert.deepEqual(spent.found.get(6), {
        kind: "agent",
        agent: "odrade",
        via: "identity",
        session: 6,
    });
    assert.deepEqual(spent.found.get(7), { kind: "pending" });
    assert.equal(spent.cache.has(7), false);
    assert.deepEqual(spent.reads, [6]);

    // A persona that throws is pending too, and is not cached: the next call reads it again.
    let calls = 0;
    const throwing: AgentResolver = {
        persona: async () => {
            calls += 1;

            throw new Error("the roster read failed");
        },
        links: { owners: new Map([[8, null]]), desk: new Map(), linkedFrom: new Map() },
        cache: new Map(),
        now: NOW,
        maxReads: AGENT_READS,
    };

    assert.deepEqual((await attributeConversations([8], throwing)).get(8), { kind: "pending" });
    assert.equal(throwing.cache.has(8), false);
    assert.deepEqual((await attributeConversations([8], throwing)).get(8), { kind: "pending" });
    assert.equal(calls, 2);
});

test("attributeConversations: a cycle in the creators or in the starting sessions has no agent", async () => {
    const cycle = new Map<number, number | null>([
        [7, 8],
        [8, 7],
    ]);

    const both = await attributed({ owners: cycle }, { 7: "odrade", 8: "odrade" }, [7, 8]);

    assert.deepEqual(both.found.get(7), { kind: "unattributed", session: 7 });
    assert.deepEqual(both.found.get(8), { kind: "unattributed", session: 8 });
    assert.deepEqual(both.reads, [], "a cycle reads no persona");

    const self = await attributed({ owners: new Map([[9, 9]]) }, {}, [9]);

    assert.deepEqual(self.found.get(9), { kind: "unattributed", session: 9 });

    // More than OWNER_DEPTH steps has no root either.
    const chain = new Map<number, number | null>();

    for (let id = 1; id <= OWNER_DEPTH + 2; id += 1) {
        chain.set(id, id + 1);
    }

    chain.set(OWNER_DEPTH + 3, null);

    const deep = await attributed({ owners: chain }, { [OWNER_DEPTH + 3]: "odrade" }, [1]);

    assert.deepEqual(deep.found.get(1), { kind: "unattributed", session: 1 });

    // A cycle of linked sessions stays a session that nobody names.
    const linked = await attributed(
        {
            owners: new Map([
                [40, null],
                [41, null],
            ]),
            linkedFrom: new Map([
                [40, 41],
                [41, 40],
            ]),
        },
        {},
        [40, 41],
    );

    assert.deepEqual(linked.found.get(40), { kind: "unattributed", session: 40 });
    assert.deepEqual(linked.found.get(41), { kind: "unattributed", session: 41 });
});

test("attributeConversations: the cache keeps an agent for good, and reads a session with none again after an hour", async () => {
    const reads: number[] = [];
    const cache = new Map<number, { agent?: string; at: number }>();
    const resolver: AgentResolver = {
        persona: async (session) => {
            reads.push(session);

            return undefined;
        },
        links: {
            owners: new Map([
                [1, null],
                [2, null],
            ]),
            desk: new Map(),
            linkedFrom: new Map(),
        },
        cache,
        now: NOW,
        maxReads: AGENT_READS,
    };

    assert.deepEqual((await attributeConversations([1], resolver)).get(1), {
        kind: "unattributed",
        session: 1,
    });
    assert.deepEqual(reads, [1]);

    // Still fresh: no read.
    resolver.now = NOW + AGENT_RETRY_MS - 1;
    await attributeConversations([1], resolver);
    assert.deepEqual(reads, [1]);

    // An hour later: read again.
    resolver.now = NOW + AGENT_RETRY_MS;
    await attributeConversations([1], resolver);
    assert.deepEqual(reads, [1, 1]);

    // An agent is kept, whatever the time.
    cache.set(2, { agent: "odrade", via: "identity", at: NOW });
    resolver.now = NOW + 30 * DAY;
    assert.deepEqual((await attributeConversations([2], resolver)).get(2), {
        kind: "agent",
        agent: "odrade",
        via: "identity",
        session: 2,
    });
    assert.deepEqual(reads, [1, 1]);
});

test("attributeConversations: a linked chain keeps its progress also when each call comes after AGENT_RETRY_MS", async () => {
    const reads: number[] = [];
    const cache = new Map<number, SessionAgent>();
    const resolver: AgentResolver = {
        persona: async (session) => {
            reads.push(session);

            return session === 3 ? "duncan" : undefined;
        },
        links: {
            owners: new Map<number, number | null>([
                [1, null],
                [2, null],
                [3, null],
            ]),
            desk: new Map(),
            linkedFrom: new Map([
                [1, 2],
                [2, 3],
            ]),
        },
        cache,
        now: NOW,
        maxReads: 1,
    };

    assert.deepEqual((await attributeConversations([1], resolver)).get(1), { kind: "pending" });
    resolver.now = NOW + AGENT_RETRY_MS;
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), { kind: "pending" });
    resolver.now = NOW + 2 * AGENT_RETRY_MS;
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), {
        kind: "agent",
        agent: "duncan",
        via: "linked",
        session: 1,
    });
    assert.deepEqual(reads, [1, 2, 3]);

    // A chain that ends with no agent drops its progress: the "none" answer waits AGENT_RETRY_MS as before.
    cache.clear();
    reads.length = 0;

    resolver.persona = async (session) => {
        reads.push(session);

        return undefined;
    };

    resolver.maxReads = 3;
    resolver.now = NOW;
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), {
        kind: "unattributed",
        session: 1,
    });
    assert.deepEqual(cache.get(1), { at: NOW });
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), {
        kind: "unattributed",
        session: 1,
    });
    assert.deepEqual(reads, [1, 2, 3]);
});

test("attributeConversations: a chain of 3 linked sessions resolves in 3 calls, 1 persona read each", async () => {
    const reads: number[] = [];
    const cache = new Map<number, SessionAgent>();
    const resolver: AgentResolver = {
        persona: async (session) => {
            reads.push(session);

            return session === 3 ? "duncan" : undefined;
        },
        links: {
            owners: new Map<number, number | null>([
                [1, null],
                [2, null],
                [3, null],
            ]),
            desk: new Map(),
            linkedFrom: new Map([
                [1, 2],
                [2, 3],
            ]),
        },
        cache,
        now: NOW,
        maxReads: 1,
    };

    // The first call spends its 1 read on session 1, and keeps its source before it reads the chain.
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), { kind: "pending" });
    assert.deepEqual(reads, [1]);
    assert.deepEqual(cache.get(1), { source: 2, at: NOW });

    // The second call skips session 1's read and spends it on session 2, whose source it keeps too.
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), { kind: "pending" });
    assert.deepEqual(reads, [1, 2]);
    assert.deepEqual(cache.get(2), { source: 3, at: NOW });

    // The third call reaches the identity at the end of the chain.
    assert.deepEqual((await attributeConversations([1], resolver)).get(1), {
        kind: "agent",
        agent: "duncan",
        via: "linked",
        session: 1,
    });
    assert.deepEqual(reads, [1, 2, 3]);
    assert.deepEqual(cache.get(1), { agent: "duncan", via: "linked", at: NOW });
    assert.deepEqual(cache.get(2), { agent: "duncan", via: "linked", at: NOW });
    assert.deepEqual(cache.get(3), { agent: "duncan", via: "identity", at: NOW });

    // Every session of the chain answers now, and no call reads a persona again.
    for (const session of [1, 2, 3]) {
        assert.deepEqual((await attributeConversations([session], resolver)).get(session), {
            kind: "agent",
            agent: "duncan",
            via: session === 3 ? "identity" : "linked",
            session,
        });
    }

    assert.deepEqual(reads, [1, 2, 3]);
});

test("agentCostView: the providers and their models, today at local midnight, the unattributed and the pending", () => {
    const state = emptyMeterState();

    state.coverage = { since: NOW - 8 * DAY, complete: true, done: 4, total: 4 };

    // Conversation 1 (odrade): $10 today, $30 two days ago on another provider, and 1 answer with no cost today.
    addLedger(state, entryOf(1, MIDNIGHT + HOUR, 10));
    addLedger(state, entryOf(1, NOW - 2 * DAY, 30, "openai", "gpt-5"));
    addLedger(state, entryOf(1, MIDNIGHT + 2 * HOUR, undefined));

    // Conversation 2 (unattributed): $5 today.
    addLedger(state, entryOf(2, MIDNIGHT + HOUR, 5));

    // Conversation 3 (pending): $2 before local midnight, $1 after it.
    addLedger(state, entryOf(3, MIDNIGHT - HOUR, 2));
    addLedger(state, entryOf(3, MIDNIGHT + HOUR, 1));

    // Conversation 5 (odrade again, the same root session): $1 today.
    addLedger(state, entryOf(5, MIDNIGHT + HOUR, 1));

    // Conversation 6 (lucilla, by the Desk's link): $20 today.
    addLedger(state, entryOf(6, MIDNIGHT + HOUR, 20));

    // Conversation 7: older than 7 days: no row sees it.
    addLedger(state, entryOf(7, NOW - 8 * DAY, 1000));

    const attributions = new Map<number, AgentAttribution>([
        [1, { kind: "agent", agent: "odrade", via: "identity", session: 100 }],
        [2, { kind: "unattributed", session: 200 }],
        [5, { kind: "agent", agent: "odrade", via: "identity", session: 100 }],
        [6, { kind: "agent", agent: "lucilla", via: "desk", session: 300 }],
        [7, { kind: "unattributed", session: 700 }],
    ]);
    const names = new Map([
        ["odrade", "Odrade"],
        ["lucilla", "Lucilla"],
    ]);
    const view = agentCostView(state, attributions, names, NOW, ZONE);

    assert.equal(view.at, NOW);
    assert.equal(view.partial, false);
    assert.equal(view.pending, 1);
    assert.deepEqual(
        view.rows.map((row) => [row.kind, row.label, row.sessions, row.today.cost, row.days7.cost]),
        [
            ["agent", "Odrade", 1, 11, 41],
            ["agent", "Lucilla", 1, 20, 20],
            ["unattributed", "Unattributed", 1, 5, 5],
            ["pending", "Not attributed yet", 1, 1, 3],
        ],
    );

    const odrade = view.rows[0];

    assert.ok(odrade !== undefined);
    assert.equal(odrade.agent, "odrade");
    assert.equal(odrade.days7.entries, 4);
    assert.equal(odrade.days7.input, 400);
    assert.equal(odrade.days7.output, 40);
    assert.equal(odrade.days7.cacheRead, 4000);
    assert.equal(odrade.days7.cacheWrite, 0);
    assert.equal(odrade.today.entries, 3);
    assert.equal(odrade.today.unknownCost, 1);
    assert.equal(odrade.days7.unknownCost, 1);

    // The providers come highest 7-day cost first, and each one's models too.
    assert.deepEqual(
        odrade.providers.map((each) => [each.provider, each.days7.cost, each.today.cost]),
        [
            ["openai", 30, 0],
            ["anthropic", 11, 11],
        ],
    );
    assert.deepEqual(
        odrade.providers[0]?.models.map((model) => [
            model.model,
            model.days7.cost,
            model.today.cost,
        ]),
        [["gpt-5", 30, 0]],
    );

    // A pending row counts conversations; an agent's row counts its root sessions.
    const pending = view.rows[3];

    assert.ok(pending !== undefined);
    assert.equal(pending.providers.length, 1);
    assert.equal(pending.providers[0]?.provider, "anthropic");
    assert.equal(pending.days7.entries, 2);

    // The ledger's coverage rule gives `partial`, and nothing has usage yet without it.
    const partial = emptyMeterState();

    addLedger(partial, entryOf(1, NOW, 1));
    assert.equal(agentCostView(partial, new Map(), names, NOW, ZONE).partial, true);

    const empty = agentCostView(emptyMeterState(), new Map(), names, NOW, ZONE);

    assert.deepEqual(empty.rows, []);
    assert.equal(empty.pending, 0);

    // 1 conversation with no attribution at all is pending too.
    const unknown = agentCostView(partial, new Map(), names, NOW, ZONE);

    assert.deepEqual(
        unknown.rows.map((row) => [row.kind, row.label]),
        [["pending", "Not attributed yet"]],
    );
    assert.equal(unknown.pending, 1);
});

test("agentCostView: in a zone whose midnight is not on a UTC hour, only the answer after it is today", () => {
    const now = Date.parse("2026-11-20T06:30:00Z");

    // Asia/Kolkata is UTC+5:30: its local midnight is 18:30 UTC the day before, on a quarter hour.
    assert.equal(localMidnight(now, "Asia/Kolkata"), Date.parse("2026-11-19T18:30:00Z"));
    // Asia/Kathmandu is UTC+5:45: 18:15 UTC, also on a quarter hour.
    assert.equal(localMidnight(now, "Asia/Kathmandu"), Date.parse("2026-11-19T18:15:00Z"));

    const state = emptyMeterState();

    // 23:55 and 00:05 local in each zone.
    addLedger(state, entryOf(1, Date.parse("2026-11-19T18:25:00Z"), 10)); // Kolkata 23:55
    addLedger(state, entryOf(1, Date.parse("2026-11-19T18:35:00Z"), 1)); // Kolkata 00:05
    addLedger(state, entryOf(2, Date.parse("2026-11-19T18:10:00Z"), 20)); // Kathmandu 23:55
    addLedger(state, entryOf(2, Date.parse("2026-11-19T18:20:00Z"), 2)); // Kathmandu 00:05

    const attributions = new Map<number, AgentAttribution>([
        [1, { kind: "agent", agent: "odrade", via: "identity", session: 1 }],
        [2, { kind: "agent", agent: "duncan", via: "identity", session: 2 }],
    ]);
    const today = (zone: string) =>
        agentCostView(state, attributions, new Map(), now, zone).rows.map((row) => [
            row.label,
            row.today.cost,
            row.days7.cost,
        ]);

    // In Kolkata's day, only the 00:05 answer of conversation 1 is today; both of conversation 2 are still yesterday.
    assert.deepEqual(today("Asia/Kolkata"), [
        ["duncan", 0, 22],
        ["odrade", 1, 11],
    ]);

    // In Kathmandu's day, its own 00:05 answer is today, and Kolkata's 23:55 answer is today too: both are after 18:15.
    assert.deepEqual(today("Asia/Kathmandu"), [
        ["duncan", 2, 22],
        ["odrade", 11, 11],
    ]);

    // In New York's day, both local times are still yesterday.
    assert.deepEqual(today(ZONE), [
        ["duncan", 0, 22],
        ["odrade", 0, 11],
    ]);
});

test("agentCostView: rows at the same cost sort by today's cost, then by their label", () => {
    const state = emptyMeterState();
    const attributions = new Map<number, AgentAttribution>([
        [1, { kind: "agent", agent: "zed", via: "identity", session: 1 }],
        [2, { kind: "agent", agent: "amy", via: "identity", session: 2 }],
        [3, { kind: "agent", agent: "bob", via: "identity", session: 3 }],
    ]);

    addLedger(state, entryOf(1, NOW - DAY, 5));
    addLedger(state, entryOf(2, NOW - DAY, 5));
    addLedger(state, entryOf(3, MIDNIGHT + HOUR, 5));

    const view = agentCostView(state, attributions, new Map(), NOW, ZONE);

    assert.deepEqual(
        view.rows.map((row) => [row.label, row.today.cost, row.days7.cost]),
        [
            ["bob", 5, 5],
            ["amy", 0, 5],
            ["zed", 0, 5],
        ],
    );
    assert.deepEqual(
        view.rows.slice(1).map((row) => row.label),
        ["amy", "zed"],
        "at the same 7-day cost and the same today cost, the label decides",
    );
});
