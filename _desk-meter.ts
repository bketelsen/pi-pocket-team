/**
 * The subscription meter: the pure rules. It parses the provider's usage answer (Anthropic's `/api/oauth/usage`),
 * keeps the reading states of each provider (fresh, stale, awaiting, none), computes the burn and the projection from
 * the provider's own readings, shows the granted resets, keeps a ledger at list price in 5-minute buckets, and writes
 * the text line and the board's hold reason. The design is plan T1747 (sections Design, Where it shows, Board and
 * Delivery).
 *
 * The provider report is the only source of percent and reset time. The ledger is list price: context, never a
 * percent, and no function here converts 1 into the other. A scoped window (a model's share of the week) gets no burn,
 * no projection and no hold. An unknown number is absent, never 0.
 *
 * It reads no clock and no zone of its own: the caller gives `now` and `zone` (an IANA name), so a test can use a
 * fixed time and another zone. `desk.ts` loads it as it loads its other `_` helpers; it imports nothing at run time.
 */

// ─── Constants and settings ──────────────────────────────────────────────────

/**
 * The Claude Code version that pi-ai sends in `user-agent: claude-cli/<version>` on each Claude request. pi-ai does
 * not export it, so `desk-meter.test.ts` reads it from pi-ai's file and fails when the 2 differ.
 */
export const CLAUDE_CLI_VERSION = "2.1.280";

/**
 * The slack of a read's time: the caller reads when `now >= nextReadAt(...) - READ_SLACK_MS`, so a pass that comes
 * a few seconds early does not skip a whole poll.
 */
export const READ_SLACK_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Ledger buckets: 5 minutes (UTC). */
const BUCKET_MS = 5 * MINUTE_MS;
/** How long the ledger keeps a bucket: 8 days. */
const BUCKET_KEEP_MS = 8 * DAY_MS;
/** How long samples and "reset seen" marks stay: 24 hours. */
const SAMPLE_KEEP_MS = DAY_MS;
/** The burn's look-back: the samples of the last 3 hours. */
const BURN_LOOK_MS = 3 * HOUR_MS;
/** The burn needs samples that span at least 60 minutes. */
const BURN_MIN_SPAN_MS = 60 * MINUTE_MS;
/** A drop of at least this many points at the same `resetsAt` is a reset. */
const RESET_DROP = 5;

export type MeterSettings = {
    providers: "anthropic"[];
    pollMinutes: number;
    digestAt: number;
    holdAt: number | null;
};

const METER_PROVIDERS = ["anthropic"] as const;

const METER_BOUNDS = {
    pollMinutes: { min: 5, max: 60, fallback: 5 },
    digestAt: { min: 1, max: 100, fallback: 75 },
} as const;

const HOLD_BOUNDS = { min: 50, max: 100 } as const;

function wholeIn(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function shown(value: unknown): string {
    return JSON.stringify(value) ?? "?";
}

/**
 * The `meter` key of `desk.json`. Absent (or `null`): the meter is off (`settings` undefined). Not an object: off,
 * with 1 warning. Each value in its bounds, else its default with 1 warning; an absent value is its default.
 */
export function meterSettings(raw: unknown): { settings?: MeterSettings; warnings: string[] } {
    const warnings: string[] = [];

    if (raw === undefined || raw === null) {
        return { settings: undefined, warnings };
    }

    if (typeof raw !== "object" || Array.isArray(raw)) {
        return {
            settings: undefined,
            warnings: ["desk.json meter must be an object: the meter is off."],
        };
    }

    const record = raw as Record<string, unknown>;
    const settings: MeterSettings = {
        providers: ["anthropic"],
        pollMinutes: METER_BOUNDS.pollMinutes.fallback,
        digestAt: METER_BOUNDS.digestAt.fallback,
        holdAt: null,
    };

    if (record.providers !== undefined) {
        if (Array.isArray(record.providers)) {
            const providers: "anthropic"[] = [];

            for (const item of record.providers as unknown[]) {
                if ((METER_PROVIDERS as readonly unknown[]).includes(item)) {
                    if (!providers.includes(item as "anthropic")) {
                        providers.push(item as "anthropic");
                    }

                    continue;
                }

                warnings.push(
                    `desk.json meter.providers: ${shown(item)} is not a provider the meter can read, so the meter drops it.`,
                );
            }

            settings.providers = providers;
        } else {
            warnings.push(
                `desk.json meter.providers must be a list: ${shown(record.providers)} is not, so the meter uses ["anthropic"].`,
            );
        }
    }

    for (const name of ["pollMinutes", "digestAt"] as const) {
        const value = record[name];
        const bounds = METER_BOUNDS[name];

        if (value === undefined) {
            continue;
        }

        if (wholeIn(value, bounds.min, bounds.max)) {
            settings[name] = value;
            continue;
        }

        warnings.push(
            `desk.json meter.${name} must be a whole number from ${String(bounds.min)} to ${String(bounds.max)}: ${shown(value)} is not, so the meter uses ${String(bounds.fallback)}.`,
        );
    }

    if (record.holdAt !== undefined && record.holdAt !== null) {
        if (wholeIn(record.holdAt, HOLD_BOUNDS.min, HOLD_BOUNDS.max)) {
            settings.holdAt = record.holdAt;
        } else {
            warnings.push(
                `desk.json meter.holdAt must be a whole number from ${String(HOLD_BOUNDS.min)} to ${String(HOLD_BOUNDS.max)}, or null: ${shown(record.holdAt)} is not, so the meter uses null (no hold).`,
            );
        }
    }

    return { settings, warnings };
}

// ─── The provider's answer ───────────────────────────────────────────────────

/** 1 usage window as the provider reports it. */
export type ProviderWindow = {
    id: string;
    kind: string;
    label: string;
    /** 0 to 100, an integer. */
    percent: number;
    resetsAt?: number;
    severity?: string;
    active: boolean;
    /** A model's share (for example "week, Fable"): no burn, no projection, no hold. */
    scoped: boolean;
    lengthMs?: number;
};

/** 1 granted reset (`cedar_ember`). Using one is only Brian's action. */
export type Grant = { label: string; type?: string; resetsLeft: number; endsAt?: number };

/** 1 successful read of a provider. */
export type ProviderReading = {
    provider: "anthropic";
    at: number;
    windows: ProviderWindow[];
    grants?: Grant[];
    grantsNote?: string;
};

const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** The older fields, read only when the answer has no `limits` array. */
const LEGACY_FIELDS: {
    field: string;
    id: string;
    label: string;
    lengthMs: number;
    scoped: boolean;
}[] = [
    {
        field: "five_hour",
        id: "five_hour",
        label: "5-hour",
        lengthMs: FIVE_HOURS_MS,
        scoped: false,
    },
    { field: "seven_day", id: "weekly_all", label: "week", lengthMs: WEEK_MS, scoped: false },
    {
        field: "seven_day_opus",
        id: "seven_day_opus",
        label: "week, Opus",
        lengthMs: WEEK_MS,
        scoped: true,
    },
    {
        field: "seven_day_sonnet",
        id: "seven_day_sonnet",
        label: "week, Sonnet",
        lengthMs: WEEK_MS,
        scoped: true,
    },
];

const ZONED_DATE = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A date string with a zone (`Z` or an offset), as epoch ms; else undefined. */
function zonedDate(value: unknown): number | undefined {
    if (typeof value !== "string" || !ZONED_DATE.test(value)) {
        return undefined;
    }

    const ms = Date.parse(value);

    return Number.isFinite(ms) ? ms : undefined;
}

/** A finite number, clamped to 0..100 and rounded; else undefined. */
function percentOf(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.round(Math.min(100, Math.max(0, value)));
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** The window shape of 1 `limits` item, or undefined when it has no usable kind. */
function limitShape(
    item: Record<string, unknown>,
): Pick<ProviderWindow, "id" | "kind" | "label" | "scoped" | "lengthMs"> | undefined {
    const kind = item.kind;

    if (typeof kind !== "string") {
        return undefined;
    }

    if (kind === "session" || kind === "five_hour") {
        return { id: "five_hour", kind, label: "5-hour", scoped: false, lengthMs: FIVE_HOURS_MS };
    }

    if (kind === "weekly_all") {
        return { id: "weekly_all", kind, label: "week", scoped: false, lengthMs: WEEK_MS };
    }

    if (kind === "weekly_scoped") {
        const scope = item.scope;
        const model = isPlainObject(scope) ? scope.model : undefined;
        const name = (isPlainObject(model) ? nonEmpty(model.display_name) : undefined) ?? "model";

        return {
            id: `weekly_scoped:${name}`,
            kind,
            label: `week, ${name}`,
            scoped: true,
            lengthMs: WEEK_MS,
        };
    }

    // An unknown kind: scoped when it names a scope, so it never holds by mistake.
    return { id: kind, kind, label: kind.replaceAll("_", " "), scoped: isPlainObject(item.scope) };
}

function grantsOf(block: unknown): Pick<ProviderReading, "grants" | "grantsNote"> {
    if (!isPlainObject(block)) {
        return {};
    }

    if (block.eligible === false) {
        const reason = typeof block.ineligible_reason === "string" ? block.ineligible_reason : "";

        return { grantsNote: `not readable (${reason || "not eligible"})` };
    }

    if (block.eligible !== true) {
        return {};
    }

    const grants: Grant[] = [];

    for (const item of Array.isArray(block.grants) ? (block.grants as unknown[]) : []) {
        if (!isPlainObject(item)) {
            continue;
        }

        const left = item.resets_left;

        if (typeof left !== "number" || !Number.isFinite(left) || left <= 0) {
            continue;
        }

        const type = nonEmpty(item.type);
        const endsAt = zonedDate(item.ends_at);
        const grant: Grant = { label: nonEmpty(item.label) ?? type ?? "granted", resetsLeft: left };

        if (type !== undefined) {
            grant.type = type;
        }

        if (endsAt !== undefined) {
            grant.endsAt = endsAt;
        }

        grants.push(grant);
    }

    return { grants };
}

/**
 * Anthropic's usage answer as a reading (plan D3, D5). `limits` (an array, also an empty one) wins over the older
 * fields. A window with no finite number as its percent is dropped; a second window with the same id is dropped.
 */
export function parseAnthropicUsage(
    body: unknown,
    at: number,
): ProviderReading | { error: string } {
    if (!isPlainObject(body)) {
        return { error: "usage answer is not an object" };
    }

    const windows: ProviderWindow[] = [];

    const add = (
        shape: Pick<ProviderWindow, "id" | "kind" | "label" | "scoped" | "lengthMs">,
        rawPercent: unknown,
        rawReset: unknown,
        rawSeverity: unknown,
        active: boolean,
    ): void => {
        const percent = percentOf(rawPercent);

        if (percent === undefined || windows.some((window) => window.id === shape.id)) {
            return;
        }

        const window: ProviderWindow = {
            id: shape.id,
            kind: shape.kind,
            label: shape.label,
            percent,
            active,
            scoped: shape.scoped,
        };
        const resetsAt = zonedDate(rawReset);

        if (resetsAt !== undefined) {
            window.resetsAt = resetsAt;
        }

        if (typeof rawSeverity === "string") {
            window.severity = rawSeverity;
        }

        if (shape.lengthMs !== undefined) {
            window.lengthMs = shape.lengthMs;
        }

        windows.push(window);
    };

    if (Array.isArray(body.limits)) {
        for (const item of body.limits as unknown[]) {
            if (!isPlainObject(item)) {
                continue;
            }

            const shape = limitShape(item);

            if (shape !== undefined) {
                add(shape, item.percent, item.resets_at, item.severity, item.is_active === true);
            }
        }
    } else {
        for (const legacy of LEGACY_FIELDS) {
            const value = body[legacy.field];

            if (!isPlainObject(value)) {
                continue;
            }

            add(
                { ...legacy, kind: legacy.field },
                value.utilization,
                value.resets_at,
                undefined,
                false,
            );
        }
    }

    return { provider: "anthropic", at, windows, ...grantsOf(body.cedar_ember) };
}

/** `a` before `b` by the earlier `resetsAt`; an absent one counts as later. */
function earlierReset(a: ProviderWindow, b: ProviderWindow): number {
    return (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity);
}

/**
 * The main window: among windows that are not scoped, the first active one; else the highest percent, then the
 * earlier `resetsAt`, then answer order. A scoped window is main only when no other window exists.
 */
export function mainWindow(windows: readonly ProviderWindow[]): ProviderWindow | undefined {
    const open = windows.filter((window) => !window.scoped);
    const pool = open.length > 0 ? open : windows;
    const active = pool.find((window) => window.active);

    if (active !== undefined) {
        return active;
    }

    let best: ProviderWindow | undefined;

    for (const window of pool) {
        if (
            best === undefined ||
            window.percent > best.percent ||
            (window.percent === best.percent && earlierReset(window, best) < 0)
        ) {
            best = window;
        }
    }

    return best;
}

// ─── State ───────────────────────────────────────────────────────────────────

/** 1 entry of the ledger: what `desk.ts` maps from `entryUsage()`. */
export type LedgerUsage = {
    provider: string;
    model: string;
    timestamp?: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** List price; absent when unknown. */
    cost?: number;
};

/** 1 provider reading's percent, for the burn. */
type Sample = { at: number; percent: number };

type Attempt = { at: number; ok: boolean; error?: string; status?: number };

/** What the meter keeps for 1 provider. */
type ProviderMeter = {
    lastSuccess?: ProviderReading;
    lastAttempt?: Attempt;
    /** By window instance: `<id>@<resetsAt>` (empty after `@` when the reset is unknown). */
    samples: Record<string, Sample[]>;
    /** By window id: when the meter last saw a reset of it. */
    resetSeenAt: Record<string, number>;
    /** The 429 answers since the last success. */
    backoff429: number;
};

/** 1 ledger bucket of 1 model: counters, and `cost` at list price. */
type Bucket = {
    entries: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** Entries with no cost: counted in `entries` and the tokens, not in `cost`. */
    unknownCost: number;
};

/**
 * The meter's memory, in plain JSON-like objects (no Map), so a test and `desk.ts` can read it. It is not stored: it
 * lives in the memory of `desk.ts`.
 */
export type MeterState = {
    providers: Record<string, ProviderMeter>;
    /** Bucket start (epoch ms, as a string) → provider → model → bucket. */
    buckets: Record<string, Record<string, Record<string, Bucket>>>;
    /** Ledger entries with no timestamp. */
    skipped: number;
    /** How far the ledger's backfill came: the caller writes it. */
    coverage: { since?: number; complete: boolean; done: number; total: number };
};

/**
 * A dictionary with no prototype: its keys come from outside (provider and model names, window ids), so a name such
 * as `__proto__`, `constructor` or `toString` is an own key like any other, and never reaches `Object.prototype`.
 */
function dict<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

export function emptyMeterState(): MeterState {
    return {
        providers: dict(),
        buckets: dict(),
        skipped: 0,
        coverage: { complete: false, done: 0, total: 0 },
    };
}

function providerMeter(state: MeterState, provider: string): ProviderMeter {
    let meter = state.providers[provider];

    if (meter === undefined) {
        meter = { samples: dict(), resetSeenAt: dict(), backoff429: 0 };
        state.providers[provider] = meter;
    }

    return meter;
}

function instanceKey(window: Pick<ProviderWindow, "id" | "resetsAt">): string {
    return `${window.id}@${window.resetsAt === undefined ? "" : String(window.resetsAt)}`;
}

/** 1 line of at most 120 characters. */
function oneLine(text: string): string {
    const line = text.split(/\r?\n/, 1)[0] ?? "";

    return line.length > 120 ? line.slice(0, 120) : line;
}

/**
 * Records 1 read. A success adds a sample to each window instance, finds resets (another `resetsAt`, or the same one
 * with a drop of at least 5 points: the old instance's samples go), and ends the backoff. A failure keeps the last
 * success and records why; a 429 adds 1 to the backoff.
 */
export function recordAttempt(
    state: MeterState,
    provider: string,
    at: number,
    result: ProviderReading | { error: string; status?: number },
): void {
    const meter = providerMeter(state, provider);

    if ("error" in result) {
        const status = result.status;
        let error: string;

        if (status === 401 || status === 403) {
            error = `sign-in refused, ${String(status)}`;
        } else if (status !== undefined) {
            error = `HTTP ${String(status)}`;
        } else {
            error = result.error;
        }

        meter.lastAttempt = { at, ok: false, error: oneLine(error) };

        if (status !== undefined) {
            meter.lastAttempt.status = status;
        }

        if (status === 429) {
            meter.backoff429 += 1;
        }

        return;
    }

    const before = meter.lastSuccess?.windows ?? [];

    for (const window of result.windows) {
        const old = before.find((item) => item.id === window.id);

        if (
            old !== undefined &&
            (old.resetsAt !== window.resetsAt || window.percent <= old.percent - RESET_DROP)
        ) {
            delete meter.samples[instanceKey(old)];
            meter.resetSeenAt[window.id] = at;
        }

        const key = instanceKey(window);

        (meter.samples[key] ??= []).push({ at, percent: window.percent });
    }

    meter.lastSuccess = result;
    meter.lastAttempt = { at, ok: true };
    meter.backoff429 = 0;
}

/**
 * When the next read of the provider is due: 0 with no attempt yet; else the last attempt plus `pollMinutes`, 15,
 * 30, then 60 minutes after 429s (at least `pollMinutes`), or 30 minutes after a refused sign-in (at least
 * `pollMinutes`). The exact time: the caller allows `READ_SLACK_MS`.
 */
export function nextReadAt(state: MeterState, provider: string, settings: MeterSettings): number {
    const meter = state.providers[provider];
    const attempt = meter?.lastAttempt;

    if (meter === undefined || attempt === undefined) {
        return 0;
    }

    let minutes = settings.pollMinutes;

    if (!attempt.ok && attempt.status === 429) {
        const backoff = meter.backoff429 >= 3 ? 60 : meter.backoff429 === 2 ? 30 : 15;

        minutes = Math.max(backoff, settings.pollMinutes);
    } else if (!attempt.ok && (attempt.status === 401 || attempt.status === 403)) {
        minutes = Math.max(30, settings.pollMinutes);
    }

    return attempt.at + minutes * MINUTE_MS;
}

function finiteOr0(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

/** Adds 1 ledger entry to its 5-minute bucket; an entry with no timestamp counts only in `skipped`. */
export function addLedger(state: MeterState, usage: LedgerUsage): void {
    const timestamp = usage.timestamp;

    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        state.skipped += 1;

        return;
    }

    const start = String(Math.floor(timestamp / BUCKET_MS) * BUCKET_MS);
    const byProvider = (state.buckets[start] ??= dict());
    const byModel = (byProvider[usage.provider] ??= dict());
    const bucket = (byModel[usage.model] ??= {
        entries: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        unknownCost: 0,
    });

    bucket.entries += 1;
    bucket.input += finiteOr0(usage.input);
    bucket.output += finiteOr0(usage.output);
    bucket.cacheRead += finiteOr0(usage.cacheRead);
    bucket.cacheWrite += finiteOr0(usage.cacheWrite);

    if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
        bucket.cost += usage.cost;
    } else {
        bucket.unknownCost += 1;
    }
}

/** Drops buckets older than 8 days, and samples and reset marks older than 24 hours. */
export function pruneMeter(state: MeterState, now: number): void {
    for (const start of Object.keys(state.buckets)) {
        if (Number(start) < now - BUCKET_KEEP_MS) {
            delete state.buckets[start];
        }
    }

    for (const meter of Object.values(state.providers)) {
        for (const [key, samples] of Object.entries(meter.samples)) {
            const kept = samples.filter((sample) => sample.at >= now - SAMPLE_KEEP_MS);

            if (kept.length === 0) {
                delete meter.samples[key];
            } else {
                meter.samples[key] = kept;
            }
        }

        for (const [id, at] of Object.entries(meter.resetSeenAt)) {
            if (at < now - SAMPLE_KEEP_MS) {
                delete meter.resetSeenAt[id];
            }
        }
    }
}

// ─── The view ────────────────────────────────────────────────────────────────

type MeterWindowView = {
    id: string;
    label: string;
    scoped: boolean;
    state: "fresh" | "stale" | "awaiting";
    /** Absent when awaiting. */
    percent?: number;
    resetsAt?: number;
    severity?: string;
    active: boolean;
    burnPerHour?: number;
    burnSpanMinutes?: number;
    hoursToFull?: number;
    fullBeforeReset?: boolean;
    projectedAtReset?: number;
    resetSeenAt?: number;
};

type MeterLedgerView = {
    lastHour: number;
    today: number;
    days7: number;
    partial: boolean;
    top: { model: string; cost: number }[];
    /** 7 days: answers with no cost. Absent when 0. */
    unknownCost?: number;
};

type MeterProviderView = {
    provider: string;
    label: string;
    line: string;
    /** Why the meter reads no report for this provider (the line's reason). Absent when it reads. */
    off?: string;
    lastAttempt?: { at: number; ok: boolean; error?: string };
    readAt?: number;
    mainWindowId?: string;
    windows: MeterWindowView[];
    grants?: Grant[];
    grantsNote?: string;
    ledger: MeterLedgerView;
};

/** What `desk usage`, the board line, the digest footer and the dashboard field show (plan S4). */
export type MeterView = {
    at: number;
    providers: MeterProviderView[];
    coverage: { since?: number; complete: boolean; done: number; total: number };
    /** `holdAt` when the hold is on. */
    hold?: number;
};

const VIEW_PROVIDERS: { provider: string; label: string }[] = [
    { provider: "anthropic", label: "Anthropic" },
    { provider: "openai", label: "OpenAI" },
];

const OFF_READS = "provider reads off in meter.providers";
const OFF_OPENAI = "Pi's ChatGPT sign-in has no usage endpoint";

function windowView(
    window: ProviderWindow,
    meter: ProviderMeter,
    readAt: number,
    settings: MeterSettings,
    now: number,
): MeterWindowView {
    const view: MeterWindowView = {
        id: window.id,
        label: window.label,
        scoped: window.scoped,
        state: "fresh",
        active: window.active,
    };

    if (window.resetsAt !== undefined) {
        view.resetsAt = window.resetsAt;
    }

    if (window.severity !== undefined) {
        view.severity = window.severity;
    }

    const seen = meter.resetSeenAt[window.id];

    if (seen !== undefined && now - seen < SAMPLE_KEEP_MS) {
        view.resetSeenAt = seen;
    }

    if (window.resetsAt !== undefined && window.resetsAt <= now) {
        view.state = "awaiting";

        return view;
    }

    view.state = now - readAt <= 2 * settings.pollMinutes * MINUTE_MS ? "fresh" : "stale";
    view.percent = window.percent;

    // A stale reading keeps its percent and its age, and gets no estimate (plan D2); a scoped window gets none either.
    if (window.scoped || view.state === "stale") {
        return view;
    }

    const samples = (meter.samples[instanceKey(window)] ?? [])
        .filter((sample) => sample.at >= now - BURN_LOOK_MS)
        .sort((a, b) => a.at - b.at);
    const oldest = samples[0];
    const newest = samples[samples.length - 1];

    if (samples.length < 3 || oldest === undefined || newest === undefined) {
        return view;
    }

    const span = newest.at - oldest.at;

    if (span < BURN_MIN_SPAN_MS) {
        return view;
    }

    const burn = (newest.percent - oldest.percent) / (span / HOUR_MS);

    view.burnPerHour = burn;
    view.burnSpanMinutes = Math.round(span / MINUTE_MS);

    if (window.lengthMs === undefined || window.resetsAt === undefined || burn <= 0) {
        return view;
    }

    const hoursToFull = (100 - window.percent) / burn;
    const hoursToReset = (window.resetsAt - now) / HOUR_MS;

    view.hoursToFull = hoursToFull;
    view.fullBeforeReset = now + hoursToFull * HOUR_MS < window.resetsAt;
    view.projectedAtReset = Math.min(100, window.percent + burn * hoursToReset);

    return view;
}

function ledgerView(
    state: MeterState,
    provider: string,
    now: number,
    zone: string,
): MeterLedgerView {
    const midnight = localMidnight(now, zone);
    const ledger: MeterLedgerView = { lastHour: 0, today: 0, days7: 0, partial: false, top: [] };
    const models = dict<number>();
    let unknownCost = 0;

    for (const [key, byProvider] of Object.entries(state.buckets)) {
        const start = Number(key);
        const byModel = byProvider[provider];

        if (byModel === undefined) {
            continue;
        }

        for (const [model, bucket] of Object.entries(byModel)) {
            if (start >= now - HOUR_MS) {
                ledger.lastHour += bucket.cost;
            }

            if (start >= midnight) {
                ledger.today += bucket.cost;
            }

            if (start >= now - 7 * DAY_MS) {
                ledger.days7 += bucket.cost;
                models[model] = (models[model] ?? 0) + bucket.cost;
                unknownCost += bucket.unknownCost;
            }
        }
    }

    ledger.top = Object.entries(models)
        .filter(([, cost]) => cost > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, 3)
        .map(([model, cost]) => ({ model, cost }));

    const coverage = state.coverage;

    ledger.partial =
        !coverage.complete || coverage.since === undefined || coverage.since > now - 7 * DAY_MS;

    if (unknownCost > 0) {
        ledger.unknownCost = unknownCost;
    }

    return ledger;
}

/** The meter's view for the tool, the board, the digest and the dashboard (plan S4): always Anthropic, then OpenAI. */
export function meterView(
    state: MeterState,
    settings: MeterSettings,
    now: number,
    zone: string,
): MeterView {
    const providers = VIEW_PROVIDERS.map(({ provider, label }): MeterProviderView => {
        const row: MeterProviderView = {
            provider,
            label,
            line: "",
            windows: [],
            ledger: ledgerView(state, provider, now, zone),
        };
        const reads = (settings.providers as string[]).includes(provider);

        if (provider === "openai") {
            row.off = OFF_OPENAI;
        } else if (!reads) {
            row.off = OFF_READS;
        }

        const meter = state.providers[provider];

        if (row.off === undefined && meter !== undefined) {
            const attempt = meter.lastAttempt;

            if (attempt !== undefined) {
                row.lastAttempt = { at: attempt.at, ok: attempt.ok };

                if (attempt.error !== undefined) {
                    row.lastAttempt.error = attempt.error;
                }
            }

            const reading = meter.lastSuccess;

            if (reading !== undefined) {
                row.readAt = reading.at;
                const main = mainWindow(reading.windows);

                if (main !== undefined) {
                    row.mainWindowId = main.id;
                }

                row.windows = reading.windows.map((window) =>
                    windowView(window, meter, reading.at, settings, now),
                );

                if (reading.grants !== undefined) {
                    row.grants = reading.grants.map((grant) => ({ ...grant }));
                }

                if (reading.grantsNote !== undefined) {
                    row.grantsNote = reading.grantsNote;
                }
            }
        }

        row.line = meterLine(row, now, zone);

        return row;
    });
    const coverage: MeterView["coverage"] = {
        complete: state.coverage.complete,
        done: state.coverage.done,
        total: state.coverage.total,
    };

    if (state.coverage.since !== undefined) {
        coverage.since = state.coverage.since;
    }

    const view: MeterView = { at: now, providers, coverage };

    if (typeof settings.holdAt === "number") {
        view.hold = settings.holdAt;
    }

    return view;
}

// ─── Times in the caller's zone ──────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ZonedParts = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: string;
};

function zonedParts(ms: number, zone: string): ZonedParts {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(ms);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((item) => item.type === type)?.value ?? "";

    return {
        year: Number(part("year")),
        month: Number(part("month")),
        day: Number(part("day")),
        hour: Number(part("hour")) % 24,
        minute: Number(part("minute")),
        second: Number(part("second")),
        weekday: part("weekday"),
    };
}

/** The zone's offset from UTC at `ms`, in ms (local minus UTC). */
function zoneOffset(ms: number, zone: string): number {
    const p = zonedParts(ms, zone);
    const whole = Math.floor(ms / 1000) * 1000;

    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** Local midnight in `zone` of the day that holds `now`; the offset is checked again at the guess (daylight saving). */
function localMidnight(now: number, zone: string): number {
    const p = zonedParts(now, zone);
    const wall = Date.UTC(p.year, p.month - 1, p.day);
    const guess = wall - zoneOffset(now, zone);

    return wall - zoneOffset(guess, zone);
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

/** `HH:MM` in `zone`. */
function hhmm(ms: number, zone: string): string {
    const p = zonedParts(ms, zone);

    return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `Wed 11:00` in `zone`. */
function clock(ms: number, zone: string): string {
    const p = zonedParts(ms, zone);

    return `${p.weekday} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `Thu 10 Dec 17:00` in `zone`. */
function dateTime(ms: number, zone: string): string {
    const p = zonedParts(ms, zone);

    return `${p.weekday} ${String(p.day)} ${MONTHS[p.month - 1] ?? "?"} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** A length of time: `4d 13h`, `2h`, `2h30m` or `25m` (each part floored). */
function span(ms: number): string {
    const total = Math.max(0, ms);
    const days = Math.floor(total / DAY_MS);
    const hours = Math.floor((total % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);

    if (days >= 1) {
        return `${String(days)}d ${String(hours)}h`;
    }

    if (hours >= 1) {
        return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h${String(minutes)}m`;
    }

    return `${String(minutes)}m`;
}

// ─── Texts ───────────────────────────────────────────────────────────────────

function resetsText(window: MeterWindowView, now: number, zone: string): string {
    return window.resetsAt === undefined
        ? ""
        : `, resets ${clock(window.resetsAt, zone)} (in ${span(window.resetsAt - now)})`;
}

function mainText(
    row: MeterProviderView,
    window: MeterWindowView,
    now: number,
    zone: string,
): string {
    if (window.state === "awaiting") {
        const seen =
            window.resetSeenAt === undefined
                ? ""
                : ` · reset seen ${hhmm(window.resetSeenAt, zone)}`;

        return `${row.label}: ${window.label}: reset passed, awaiting provider report${seen}`;
    }

    let text = `${row.label}: ${window.label} ${String(window.percent ?? "?")}% used`;

    if (window.state === "stale") {
        const age = now - (row.readAt ?? now);
        const ageText = age < HOUR_MS ? `${String(Math.floor(age / MINUTE_MS))} min` : span(age);
        const attempt =
            row.lastAttempt !== undefined && !row.lastAttempt.ok
                ? `; last attempt: ${row.lastAttempt.error ?? "failed"}`
                : "";

        text += ` (read ${ageText} ago${attempt})`;
    } else if (window.severity !== undefined && window.severity !== "normal") {
        text += ` (${window.severity})`;
    }

    text += resetsText(window, now, zone);

    if (window.burnPerHour !== undefined && window.burnSpanMinutes !== undefined) {
        text += ` · ~${window.burnPerHour.toFixed(1)}%/h over ${span(window.burnSpanMinutes * MINUTE_MS)}`;
    }

    if (window.fullBeforeReset === true && window.hoursToFull !== undefined) {
        text += ` · full in ~${span(window.hoursToFull * HOUR_MS)}, before reset`;
    } else if (window.projectedAtReset !== undefined) {
        text += ` · ~${String(Math.round(window.projectedAtReset))}% at reset`;
    }

    if (
        window.projectedAtReset !== undefined &&
        window.resetsAt !== undefined &&
        (window.resetsAt - now) / HOUR_MS <= 24 &&
        window.projectedAtReset <= 80
    ) {
        text += ` · about ${String(100 - Math.round(window.projectedAtReset))}% may go unused at reset`;
    }

    if (window.resetSeenAt !== undefined) {
        text += ` · reset seen ${hhmm(window.resetSeenAt, zone)}`;
    }

    return text;
}

/**
 * 1 line for 1 provider (plan S5), in `zone`: the main window with its percent, reset, burn and projection, then the
 * other windows, then the granted resets that expire within 7 days. The ledger is not in the line.
 */
export function meterLine(
    provider: MeterView["providers"][number],
    now: number,
    zone: string,
): string {
    const row = provider;

    if (row.readAt === undefined) {
        const failed =
            row.lastAttempt !== undefined && !row.lastAttempt.ok
                ? row.lastAttempt.error
                : undefined;
        const reason = row.off ?? failed ?? "not read yet";

        return `${row.label}: no provider report (${reason})`;
    }

    const main = row.windows.find((window) => window.id === row.mainWindowId);

    if (main === undefined) {
        return `${row.label}: provider report has no usage window`;
    }

    let text = mainText(row, main, now, zone);

    for (const window of row.windows) {
        if (window === main) {
            continue;
        }

        text +=
            window.state === "awaiting"
                ? ` · ${window.label}: reset passed`
                : ` · ${window.label} ${String(window.percent ?? "?")}%`;

        if (window.resetSeenAt !== undefined) {
            text += ` (reset seen ${hhmm(window.resetSeenAt, zone)})`;
        }
    }

    for (const grant of row.grants ?? []) {
        if (grant.resetsLeft <= 0 || grant.endsAt === undefined) {
            continue;
        }

        const left = grant.endsAt - now;

        if (left <= 0 || left > 7 * DAY_MS) {
            continue;
        }

        const when = left >= DAY_MS ? `${String(Math.floor(left / DAY_MS))}d` : span(left);

        text += ` · a ${grant.label} reset expires in ${when} unused`;
    }

    return text;
}

/**
 * The granted resets (plan D5), grouped by label: `resets granted: Weekly ×2 (first expires Thu 10 Dec 17:00) ·
 * Fable ×2 (expire Tue 9 Mar 02:59)`; or `grants: not readable (surface)`; or undefined with neither. `now` is part
 * of the contract; the text needs only `zone`.
 */
export function grantsLine(
    provider: MeterView["providers"][number],
    now: number,
    zone: string,
): string | undefined {
    const grants = provider.grants ?? [];

    if (grants.length > 0) {
        const groups: { label: string; grants: Grant[] }[] = [];

        for (const grant of grants) {
            const group = groups.find((item) => item.label === grant.label);

            if (group === undefined) {
                groups.push({ label: grant.label, grants: [grant] });
            } else {
                group.grants.push(grant);
            }
        }

        const parts = groups.map((group) => {
            const left = group.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
            const ends = group.grants
                .map((grant) => grant.endsAt)
                .filter((end): end is number => end !== undefined);
            let expiry = "";

            if (ends.length > 0) {
                const first = Math.min(...ends);
                const same =
                    ends.length === group.grants.length && ends.every((end) => end === first);

                if (left === 1) {
                    expiry = ` (expires ${dateTime(first, zone)})`;
                } else if (same) {
                    expiry = ` (expire ${dateTime(first, zone)})`;
                } else {
                    expiry = ` (first expires ${dateTime(first, zone)})`;
                }
            }

            return `${group.label} ×${String(left)}${expiry}`;
        });

        return `resets granted: ${parts.join(" · ")}`;
    }

    if (provider.grantsNote !== undefined) {
        return `grants: ${provider.grantsNote}`;
    }

    return undefined;
}

const DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(value: number): string {
    return `$${DOLLARS.format(Math.round(value))}`;
}

/**
 * The ledger at list price: `list price: $70 last hour, $228 today, $2,263 in 7 days (partial); top:
 * claude-opus-5-5 $2,263`. List price is not money spent on a subscription, and never a percent.
 */
export function ledgerLine(provider: MeterView["providers"][number]): string {
    const ledger = provider.ledger;
    let text = `list price: ${dollars(ledger.lastHour)} last hour, ${dollars(ledger.today)} today, ${dollars(ledger.days7)} in 7 days`;

    if (ledger.partial) {
        text += " (partial)";
    }

    if (ledger.top.length > 0) {
        text += `; top: ${ledger.top.map((item) => `${item.model} ${dollars(item.cost)}`).join(", ")}`;
    }

    if (ledger.unknownCost !== undefined && ledger.unknownCost > 0) {
        text += `; ${String(ledger.unknownCost)} answers with no cost`;
    }

    return text;
}

/**
 * The last line of `desk usage` (plan S1): `Meter: provider read 3 min ago (last attempt ok); ledger complete since
 * Fri 6 Nov 21:56; hold off`. The provider part names the first provider that the meter reads: `provider read never`
 * before its first success, `provider reads off` when it reads none; a failed last attempt shows `(last attempt:
 * <reason> at HH:MM)`. The ledger part is `ledger filling N of M conversations` until the backfill is complete. The hold
 * part is `hold off` or `hold at 90%`. Times in `zone`.
 */
export function meterStatusLine(view: MeterView, now: number, zone: string): string {
    const row = view.providers.find((item) => item.off === undefined);
    let read: string;

    if (row === undefined) {
        read = "provider reads off";
    } else {
        if (row.readAt === undefined) {
            read = "provider read never";
        } else {
            const age = Math.max(0, now - row.readAt);

            read = `provider read ${age < HOUR_MS ? `${String(Math.floor(age / MINUTE_MS))} min` : span(age)} ago`;
        }

        const attempt = row.lastAttempt;

        if (attempt?.ok === true) {
            read += " (last attempt ok)";
        } else if (attempt !== undefined) {
            read += ` (last attempt: ${attempt.error ?? "failed"} at ${hhmm(attempt.at, zone)})`;
        }
    }

    const coverage = view.coverage;
    const ledger = coverage.complete
        ? coverage.since === undefined
            ? "ledger complete"
            : `ledger complete since ${dateTime(coverage.since, zone)}`
        : `ledger filling ${String(coverage.done)} of ${String(coverage.total)} conversations`;
    const hold = view.hold === undefined ? "hold off" : `hold at ${String(view.hold)}%`;

    return `Meter: ${read}; ${ledger}; ${hold}`;
}

/**
 * The digest's last lines (plan S3): `Meter: <line>` for each provider whose main window is fresh or stale with a
 * percent of at least `digestAt`. None for an awaiting window, a provider with no report, or a lower percent.
 */
export function meterFooter(view: MeterView, digestAt: number): string[] {
    const lines: string[] = [];

    for (const row of view.providers) {
        const main = row.windows.find((window) => window.id === row.mainWindowId);

        if (
            main !== undefined &&
            (main.state === "fresh" || main.state === "stale") &&
            main.percent !== undefined &&
            main.percent >= digestAt
        ) {
            lines.push(`Meter: ${row.line}`);
        }
    }

    return lines;
}

/**
 * Why a board launch of these providers waits (plan B2), or undefined. A provider holds only on a fresh reading with
 * a window that is not scoped, at or above `holdAt`, whose reset is still ahead. A stale, awaiting or missing reading
 * never holds.
 */
export function holdReason(
    view: MeterView,
    providers: string[],
    holdAt: number,
    now: number,
    zone: string,
): string | undefined {
    const reasons: string[] = [];

    for (const row of view.providers) {
        if (!providers.includes(row.provider)) {
            continue;
        }

        let best: MeterWindowView | undefined;

        for (const window of row.windows) {
            if (
                window.state !== "fresh" ||
                window.scoped ||
                window.percent === undefined ||
                window.percent < holdAt ||
                window.resetsAt === undefined ||
                window.resetsAt <= now
            ) {
                continue;
            }

            if (
                best === undefined ||
                window.percent > (best.percent ?? 0) ||
                (window.percent === best.percent && window.resetsAt < (best.resetsAt ?? Infinity))
            ) {
                best = window;
            }
        }

        if (best?.percent !== undefined && best.resetsAt !== undefined) {
            reasons.push(
                `${row.label} ${best.label} ${String(best.percent)}% ≥ ${String(holdAt)}%, resets ${clock(best.resetsAt, zone)}`,
            );
        }
    }

    return reasons.length > 0 ? reasons.join("; ") : undefined;
}
