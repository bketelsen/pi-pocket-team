// The subscription meter's pure rules (`_desk-meter.ts`, plan T1747): the parser, the reading states, the burn and
// the projection, the granted resets, the ledger at list price, the line and the hold reason, on fixed answers and a
// fixed clock, in America/New_York. Nothing reads Brian's data, the network or the clock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
    addLedger,
    CLAUDE_CLI_VERSION,
    emptyMeterState,
    grantsLine,
    holdReason,
    ledgerLine,
    mainWindow,
    type MeterSettings,
    type MeterState,
    meterFooter,
    meterLine,
    meterSettings,
    meterStatusLine,
    meterView,
    nextReadAt,
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

test("CLAUDE_CLI_VERSION matches pi-ai's claudeCodeVersion", () => {
    const file = readFileSync(
        join(
            import.meta.dirname,
            "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
        ),
        "utf8",
    );
    const match = /const claudeCodeVersion = "([^"]+)"/.exec(file);

    assert.ok(match !== null, "pi-ai has no claudeCodeVersion");
    assert.equal(CLAUDE_CLI_VERSION, match[1]);
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
