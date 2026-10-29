/**
 * Model router (shadow): classifies a delegated night shift's brief with TypeSafe Jev and records the model tier it
 * would pick for the worker. It never changes a model.
 *
 * It reads the night shift's brief (the objective and the stop condition), masks it, and sends it to
 * https://api.typesafe.ai/v1/systemone. It also reads `~/.ssh/config` (read only) for the host names it masks, and an
 * optional `~/.config/pi-pocket-team/router.json` for the tiers. The TypeSafe key is a module secret setting. Nothing is
 * logged, and every failure leaves the delegation as it was: the router records a line and nothing else.
 *
 * Parts (the 4 Jev questions, the task kinds, the kind floors, the demand formula, parseAnalysis) are adapted from
 * pi-jev-model-router 0.9.0, MIT License, Copyright (c) 2026 Shah Rukh.
 *
 * MIT License
 *
 * Copyright (c) 2026 Shah Rukh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { readFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";

// ─── What Jev is asked, and how its answer becomes a tier ────────────────────

/** The one endpoint. There is no environment override: a variable could send the key elsewhere. */
export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** How long 1 classification may take, in total. */
export const TIMEOUT_MS = 3500;

/** The tiers, cheapest first. */
export const TIERS = ["quick", "standard", "high", "premium"] as const;
export type Tier = (typeof TIERS)[number];

/** The kinds of work Jev picks from, with the text it judges each one by. */
export const TASK_KINDS: Record<string, string> = {
    plan: "Deciding what to build, sequencing work, or designing an approach before editing",
    implement: "Writing or changing code, scripts, or configuration to produce a concrete result",
    write: "Producing prose, documentation, comments, or other non-code content from scratch",
    debug: "Diagnosing a failure, error, or unexpected behavior and finding its root cause",
    refactor: "Restructuring existing code without changing intended behavior",
    review: "Auditing code, a diff, a document, or a plan for problems and risks",
    research: "Searching, reading, and synthesizing external information or unfamiliar APIs",
    explain: "Answering a question or explaining how something works",
    operate: "Running commands, tooling, git, deploys, or environment setup",
    chat: "Small talk, acknowledgements, or a request with no real work attached",
};

/** The cheapest tier a kind of work may get. */
export const KIND_FLOORS: Record<string, Tier> = {
    chat: "quick",
    explain: "quick",
    write: "quick",
    operate: "standard",
    implement: "standard",
    debug: "standard",
    refactor: "standard",
    research: "standard",
    plan: "high",
    review: "high",
};

/** One tier's candidate models, in the order they are tried, and the thinking level that comes with it. */
export type TierChoice = { models: readonly string[]; thinking: string };
export type Tiers = Record<Tier, TierChoice>;

/** The tiers when `router.json` is absent. Only the owner's allowed list decides what is usable. */
export const DEFAULT_TIERS: Tiers = {
    quick: {
        models: ["github-copilot/gpt-6-luna", "anthropic/claude-haiku-5-5"],
        thinking: "low",
    },
    standard: {
        models: ["deepseek/deepseek-flash", "github-copilot/gemini-3.8-flash"],
        thinking: "medium",
    },
    high: {
        models: ["github-copilot/claude-sonnet-5.5", "github-copilot/gpt-6.1-sol"],
        thinking: "medium",
    },
    premium: {
        models: [
            "github-copilot/claude-opus-5.5",
            "anthropic/claude-opus-5-5",
            "github-copilot/gpt-6-astra",
        ],
        thinking: "high",
    },
};

/** A copy of `tiers`, so no caller can change another one's tiers. */
function copyTiers(tiers: Tiers): Tiers {
    return {
        quick: { models: [...tiers.quick.models], thinking: tiers.quick.thinking },
        standard: { models: [...tiers.standard.models], thinking: tiers.standard.thinking },
        high: { models: [...tiers.high.models], thinking: tiers.high.thinking },
        premium: { models: [...tiers.premium.models], thinking: tiers.premium.thinking },
    };
}

/** 2 decimals, and never a negative zero. */
const round2 = (value: number): number => {
    const rounded = Math.round(value * 100) / 100;

    return rounded === 0 ? 0 : rounded;
};

const clamp = (value: number, low: number, high: number): number =>
    Math.min(high, Math.max(low, value));

/** True when a UTC time is in DeepSeek's peak: 01:00 to 04:00 and 06:00 to 10:00. */
export function inDeepseekPeak(ms: number): boolean {
    const hour = new Date(ms).getUTCHours();

    return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

// ─── Masking ─────────────────────────────────────────────────────────────────

/**
 * The last labels that make a dotted name a file name, not a host name. A name ends in 1 of these: it stays. Anything
 * else with a lowercase last label of 2 to 24 letters is a host name, and goes. A deny-list keeps a new network TLD
 * masked without a code change, and code such as `api.memo` is masked too: more masking is safe.
 */
const FILE_EXTENSIONS = new Set([
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "md",
    "mdx",
    "sh",
    "bash",
    "zsh",
    "py",
    "go",
    "rs",
    "rb",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "yml",
    "yaml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "txt",
    "log",
    "lock",
    "css",
    "scss",
    "less",
    "html",
    "htm",
    "xml",
    "svg",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "ico",
    "pdf",
    "csv",
    "sql",
    "zip",
    "gz",
    "tgz",
    "xz",
    "tar",
    "bz2",
    "deb",
    "rpm",
    "iso",
    "img",
    "qcow2",
    "raw",
    "nix",
    "lua",
    "vue",
    "svelte",
    "wasm",
    "so",
    "sock",
    "pid",
    "bak",
    "tmp",
    "orig",
    "diff",
    "patch",
    "mod",
    "sum",
    "gradle",
    "plist",
    "desktop",
    "service",
    "timer",
    "mount",
    "socket",
    "target",
    "path",
    "ign",
    "bu",
    "pem",
    "crt",
    "key",
    "pub",
    "d",
]);

/** The file extensions that are also top-level domains: with 2 or more dots, a name that ends in one is a host. */
const TLD_EXTENSIONS = new Set(["sh", "so", "md", "py", "rs", "pub", "zip"]);

/** Sentence punctuation a candidate can collect at its end: it stays in the text, after the mask. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/g;
const WWW_PATTERN = /\bwww\.[^\s<>"'`)\]]+/gi;
/** A protocol-relative URL (`//example.sh/api`): its authority is a host, so it never counts as a file path. */
const RELATIVE_URL_PATTERN = /(?<![\w:/.])\/\/[^\s/<>"'`)\]][^\s<>"'`)\]]*/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IPV6_CANDIDATE =
    /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f:.]+(?:%[0-9A-Za-z_.-]+)?(?:\/\d{1,3})?)[.,;:!?)]*(?![0-9A-Za-z:])/g;
const IPV4_CANDIDATE =
    /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?::\d{1,5})?[.,;:!?)]*(?!\w)/g;
const FQDN_CANDIDATE =
    /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9_-])/g;
const SECRET_PATTERNS = [
    /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{8,}\b/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bxox[bps]-[A-Za-z0-9-]{10,}\b/g,
];

/**
 * The host names of an SSH config: the names on its `Host` and `HostName` lines, case-insensitive, with `Host a b` and
 * `HostName=x` both read, and double quotes taken off (`Host "build01"`). A pattern (`*`, `?`, `!`) is left out. Every
 * literal alias stays, a 1-letter one too: `Host x` masks the word "x", which costs Jev a little and keeps the host
 * private. Lowercase, unique, in the order the file gives them.
 */
export function sshHostNames(configText: string): string[] {
    const names: string[] = [];

    for (const raw of configText.split(/\r?\n/)) {
        const line = raw.trim();

        if (line === "" || line.startsWith("#")) {
            continue;
        }

        const match = /^(?:hostname|host)\b[\s=]*(.+)$/i.exec(line);

        if (match === null) {
            continue;
        }

        for (const part of match[1].split(/[\s,]+/)) {
            const name = part.replaceAll('"', "").trim().toLowerCase();

            if (name === "" || /[*?!]/.test(name) || names.includes(name)) {
                continue;
            }

            names.push(name);
        }
    }

    return names;
}

/** An escaped regular expression body: a host name is matched as text, not as a pattern. */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A candidate address split into its core and the sentence punctuation after it: an address at the end of a sentence
 * (`Check 192.168.1.4.`) is still an address, and the period stays.
 */
function splitTrailing(candidate: string): { core: string; tail: string } {
    const tail = TRAILING_PUNCTUATION.exec(candidate)?.[0] ?? "";

    return { core: candidate.slice(0, candidate.length - tail.length), tail };
}

/**
 * Every IPv6 token in `text` that `isIPv6` confirms, as `[ip]`, with its `/prefix`, `%zone` and sentence punctuation
 * kept. A time such as `10:00` has 1 colon and stays.
 */
function maskIpv6(text: string): string {
    const isAddress = (core: string): boolean => {
        const address = core.split("/")[0]!.split("%")[0]!;

        return address.split(":").length - 1 >= 2 && isIPv6(address);
    };

    return text.replace(IPV6_CANDIDATE, (whole: string) => {
        // `2001:db8::` ends in colons that belong to it: the punctuation without colons goes first, then all of it.
        const tail = /[.,;!?)]*$/.exec(whole)![0];
        const core = whole.slice(0, whole.length - tail.length);

        if (isAddress(core)) {
            return `[ip]${tail}`;
        }

        const split = splitTrailing(whole);

        return isAddress(split.core) ? `[ip]${split.tail}` : whole;
    });
}

/** Every IPv4 address, with an optional `/cidr` and `:port`, as `[ip]`, and its punctuation kept. */
function maskIpv4(text: string): string {
    return text.replace(IPV4_CANDIDATE, (whole: string) => {
        const { core, tail } = splitTrailing(whole);
        const address = core.split("/")[0]!.split(":")[0]!;

        return isIPv4(address) ? `[ip]${tail}` : whole;
    });
}

/**
 * Every fully qualified host name, as `[host]`: a dotted name whose last label is 2 to 24 letters (any case) and is not
 * a file extension. `acme.example.info` goes; `team.ts`, `node.js` and `package.json` stay. A suffix that is a file
 * extension and also a top-level domain (`sh`, `md`, `py`, ...) is ambiguous: such a name goes too (`install.sh`,
 * `README.md`), unless it is surely a file. It is surely a file when a `/` comes before it (`docs/plans/x.md`,
 * `./install.sh`), or when its stem holds `_` (`set_up.py`), which no host name has. More masking is safe; a host
 * that reaches Jev is not.
 */
function maskFqdn(text: string): string {
    return text.replace(FQDN_CANDIDATE, (whole: string, offset: number, all: string) => {
        // DNS names have no case: `BUILD.EXAMPLE.COM` goes as `build.example.com` does.
        const last = whole.slice(whole.lastIndexOf(".") + 1).toLowerCase();

        if (TLD_EXTENSIONS.has(last)) {
            const inPath = offset > 0 && all[offset - 1] === "/";
            const underscore = whole.slice(0, whole.lastIndexOf(".")).includes("_");

            return inPath || underscore ? whole : "[host]";
        }

        return FILE_EXTENSIONS.has(last) ? whole : "[host]";
    });
}

/** Every given host name, as a whole word and in any case, as `[host]`. The longest name goes first. */
function maskNames(text: string, hostNames: readonly string[]): string {
    let out = text;
    const longest = [...hostNames]
        .filter((name) => name !== "")
        .sort((a, b) => b.length - a.length);

    for (const name of longest) {
        out = out.replace(
            new RegExp(`(?<![A-Za-z0-9_-])${escaped(name)}(?![A-Za-z0-9_-])`, "gi"),
            "[host]",
        );
    }

    return out;
}

/**
 * A brief with what names this network taken out: URLs, emails, IP addresses, host names, this machine's SSH hosts, and
 * secret-like tokens. A repository name such as `bketelsen/pi-pocket` stays, and so does a file name such as `team.ts`.
 */
export function maskBrief(text: string, hostNames: readonly string[]): string {
    let out = text
        .replace(URL_PATTERN, "[url]")
        .replace(RELATIVE_URL_PATTERN, "[url]")
        .replace(WWW_PATTERN, "[url]");

    out = out.replace(EMAIL_PATTERN, "[email]");
    out = maskIpv6(out);
    out = maskIpv4(out);
    out = maskFqdn(out);
    out = maskNames(out, hostNames);

    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, "[secret]");
    }

    return out;
}

// ─── The Jev call ────────────────────────────────────────────────────────────

/** What Jev judges, and how it labels each judgment. No folder, history, spend, or environment goes with it. */
function buildQuestions(): Record<string, unknown> {
    return {
        task_kind: {
            type: "choice",
            instructions:
                "Which single kind of work does `request` ask for? Judge the work the user wants done, not the topic they mention. Read `conversation_excerpt` when the request is a short follow-up that only makes sense in context. Pick the closest kind even when the request is ambiguous.",
            criteria: TASK_KINDS,
        },
        complexity: {
            type: "score",
            instructions:
                "How hard is `request` to do well, judged only on the work itself? Use the conversation excerpt and environment to judge scope. Ignore how much any model costs.",
            criteria: [
                "Trivial: one obvious step, no design decisions, answer is known or mechanical",
                "Moderate: a few dependent steps using familiar patterns, little ambiguity",
                "Complex: multiple files or interacting constraints, real tradeoffs to weigh",
                "Architectural: cross-cutting design, high stakes, long horizon, easy to get subtly wrong",
            ],
        },
        capability_deserved: {
            type: "score",
            instructions:
                "Setting price aside entirely, how much model capability does this request deserve to get a good outcome? Judge by stakes, difficulty, and how much a stronger model would measurably improve the result.",
            criteria: [
                "Minimal: any fast small model answers this just as well",
                "Standard: a competent mid-tier model is enough",
                "High: a strong frontier model materially improves the outcome",
                "Maximum: correctness matters more than cost; use the best available",
            ],
        },
        needs_deep_reasoning: {
            type: "noul",
            instructions:
                "Does answering `request` well require extended multi-step reasoning (algorithm design, subtle debugging, proof, careful long-horizon planning) rather than recall, lookup, or a short direct edit?",
            criteria: {
                true: "The work hinges on reasoning through non-obvious steps or edge cases",
                false: "The work is recall, lookup, formatting, or a short direct change",
            },
        },
    };
}

/** The request body: the masked brief as the state, and the 4 questions. */
export function jevBody(maskedBrief: string): {
    state: { request: string };
    model: string;
    questions: Record<string, unknown>;
} {
    return { state: { request: maskedBrief }, model: "jev-latest", questions: buildQuestions() };
}

/** Jev's answer, as the router reads it. */
export type Analysis = {
    kind: string;
    kindConfidence: number;
    kindProbabilities: Record<string, number>;
    /** 0 to 3. */
    complexity: number;
    complexityConfidence: number;
    /** The capability the work deserves, 0 to 3. */
    capability: number;
    capabilityConfidence: number;
    /** Probability the work needs extended reasoning. */
    deepReasoning: number;
    latencyMs: number;
    /** The versioned Jev model that answered, such as `jev-1.14.0`. The alias `jev-latest` moves. */
    jevModel?: string;
    jevId?: string;
};

const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;

/** Jev's payload as an `Analysis`. A kind that is not one of the 10 throws. */
export function parseAnalysis(payload: unknown, latencyMs: number): Analysis {
    const root = (payload ?? {}) as {
        answers?: Record<string, Record<string, unknown>>;
        model?: unknown;
        id?: unknown;
    };
    const answers = root.answers ?? {};
    const kind = answers.task_kind ?? {};
    const complexity = answers.complexity ?? {};
    const capability = answers.capability_deserved ?? {};
    const reasoning = answers.needs_deep_reasoning ?? {};
    const chosen = text(kind.choice) ?? "chat";

    if (!Object.hasOwn(TASK_KINDS, chosen)) {
        throw new Error(`Jev returned an unknown task kind: ${chosen}`);
    }

    const jevModel = text(root.model);
    const jevId = text(root.id);

    return {
        kind: chosen,
        kindConfidence: num(kind.confidence) ?? 0,
        kindProbabilities: (kind.probabilities ?? {}) as Record<string, number>,
        complexity: num(complexity.score) ?? 1,
        complexityConfidence: num(complexity.confidence) ?? 0,
        capability: num(capability.score) ?? 1,
        capabilityConfidence: num(capability.confidence) ?? 0,
        deepReasoning: num(reasoning.noul) ?? num(reasoning.noul_score) ?? 0,
        latencyMs,
        ...(jevModel === undefined ? {} : { jevModel }),
        ...(jevId === undefined ? {} : { jevId }),
    };
}

const timeoutText = (timeoutMs: number): string =>
    `Jev timed out after ${String(timeoutMs / 1000)} s`;

/**
 * 1 classification of a masked brief: exactly 1 POST, no retry, and the timeout in total. A non-OK status throws an
 * error with the status only; a timeout says so. No error message holds the key or the response body.
 */
export async function classify(
    maskedBrief: string,
    key: string,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Analysis> {
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const send = options.fetch ?? fetch;
    const signal = AbortSignal.timeout(timeoutMs);
    const started = Date.now();
    let response: Response;

    try {
        response = await send(ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(jevBody(maskedBrief)),
            signal,
        });
    } catch (error) {
        if (signal.aborted || (error as { name?: unknown })?.name === "TimeoutError") {
            throw new Error(timeoutText(timeoutMs));
        }

        const name = (error as { name?: unknown })?.name;

        throw new Error(`Jev could not be reached (${typeof name === "string" ? name : "error"})`);
    }

    if (!response.ok) {
        throw new Error(`Jev returned the status ${String(response.status)}`);
    }

    let payload: unknown;

    try {
        payload = await response.json();
    } catch {
        throw new Error("Jev returned a response that is not JSON");
    }

    return parseAnalysis(payload, Date.now() - started);
}

// ─── The decision ────────────────────────────────────────────────────────────

export type DecideOptions = {
    /** The models the owner lets subagents use. */
    allowed: readonly string[];
    /** The allowed models that cannot be used now. */
    unusable: ReadonlySet<string>;
    /** When the work starts: DeepSeek's peak hours apply to then. */
    at: number;
    tiers: Tiers;
};

/** A tier, its model and thinking level, and the notes that explain the choice. */
export type Decision = {
    demand: number;
    tier?: Tier;
    model?: string;
    thinking?: string;
    notes: string[];
};

/**
 * The tier Jev's judgments ask for, then the first model of that tier the owner allows and that works now. When the
 * tier holds none, the nearer tiers are tried in turn. Nothing here changes a model: the answer is a suggestion only.
 */
export function decide(analysis: Analysis, options: DecideOptions): Decision {
    const notes: string[] = [];
    let demand = 0.55 * analysis.complexity + 0.45 * analysis.capability;

    if (analysis.deepReasoning >= 0.65) {
        demand += 0.75;
    } else if (analysis.deepReasoning <= 0.2) {
        demand -= 0.25;
    }

    demand = clamp(demand, 0, 3);

    const floor = Math.max(0, TIERS.indexOf(KIND_FLOORS[analysis.kind] ?? "quick"));

    if (demand < floor) {
        notes.push(`${analysis.kind} floors at ${TIERS[floor]}`);

        demand = floor;
    }

    let index = clamp(Math.round(demand), 0, 3);

    if (analysis.kindConfidence > 0 && analysis.kindConfidence < 0.34 && index > 1) {
        notes.push("low kind confidence");

        index = 1;
    }

    for (const step of [0, 1, -1, 2, -2, 3, -3]) {
        const at = index + step;

        if (at < 0 || at >= TIERS.length) {
            continue;
        }

        const tier = TIERS[at]!;
        const choice = options.tiers[tier];
        const model = choice.models.find(
            (each) =>
                options.allowed.includes(each) &&
                !options.unusable.has(each) &&
                !(each.startsWith("deepseek/") && inDeepseekPeak(options.at)),
        );

        if (model !== undefined) {
            return { demand: round2(demand), tier, model, thinking: choice.thinking, notes };
        }
    }

    return { demand: round2(demand), notes };
}

// ─── The tiers file ──────────────────────────────────────────────────────────

/** The tiers file, when the server sets no other path. */
export const tiersPath = (): string =>
    process.env.PI_POCKET_TEAM_ROUTER_CONFIG ??
    join(homedir(), ".config", "pi-pocket-team", "router.json");

/**
 * The tiers of `router.json`: `{ "tiers": { "quick": { "models": [...], "thinking": "low" } } }`. A file that is absent
 * gives the default tiers; one that is not valid gives the default tiers and a note. It never throws.
 */
export async function readTiers(path: string): Promise<{ tiers: Tiers; notes: string[] }> {
    let contents: string;

    try {
        contents = await readFile(path, "utf8");
    } catch (error) {
        const code = (error as { code?: unknown }).code;

        return code === "ENOENT"
            ? { tiers: copyTiers(DEFAULT_TIERS), notes: [] }
            : {
                  tiers: copyTiers(DEFAULT_TIERS),
                  notes: [`${path} could not be read: the default tiers are used`],
              };
    }

    const invalid = {
        tiers: copyTiers(DEFAULT_TIERS),
        notes: [`${path} is not a valid router file: the default tiers are used`],
    };

    if (contents.length > 20_000) {
        return invalid;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(contents);
    } catch {
        return invalid;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return invalid;
    }

    const held = (parsed as { tiers?: unknown }).tiers;

    if (typeof held !== "object" || held === null) {
        return invalid;
    }

    const tiers = copyTiers(DEFAULT_TIERS);
    let given = false;

    for (const tier of TIERS) {
        const entry = (held as Record<string, unknown>)[tier];

        if (entry === undefined) {
            continue;
        }

        if (typeof entry !== "object" || entry === null) {
            return invalid;
        }

        const models = (entry as { models?: unknown }).models;
        const thinking = (entry as { thinking?: unknown }).thinking;

        if (
            !Array.isArray(models) ||
            models.length === 0 ||
            !models.every((each) => typeof each === "string" && each.trim() !== "") ||
            typeof thinking !== "string" ||
            thinking.trim() === ""
        ) {
            return invalid;
        }

        tiers[tier] = {
            models: models.map((each: string) => each.trim()),
            thinking: thinking.trim(),
        };
        given = true;
    }

    return given ? { tiers, notes: [] } : invalid;
}

// ─── The record ──────────────────────────────────────────────────────────────

/**
 * What the router recorded about one delegation. Stored data (JSON only): never rename a field or change what one
 * means, and leave a field out rather than store `undefined` in it.
 */
export type Route = {
    /** The mode the router was in. */
    mode: "off" | "shadow";
    /** `shadow`: a suggestion, not applied. `explicit`: the supervisor named the worker. `failed`: no suggestion. */
    status: "shadow" | "explicit" | "failed" | "off";
    kind?: string;
    kindConfidence?: number;
    complexity?: number;
    capability?: number;
    deepReasoning?: number;
    demand?: number;
    tier?: Tier;
    /** The model the router would pick for the worker. */
    model?: string;
    thinking?: string;
    /** The agent's profile model: the model of the session itself, which the router never changes. */
    profileModel?: string;
    /** The model the supervisor named, for an `explicit` route. */
    worker?: string;
    jevModel?: string;
    jevId?: string;
    latencyMs?: number;
    reason: string;
    notes?: string[];
    at: number;
    /** The 1 line that goes to the desk thread and to the supervisor. */
    line: string;
};

/** The record without its line: the line is made from it. */
type RouteFields = Omit<Route, "line">;

const fixed = (value: number | undefined, digits: number): string => (value ?? 0).toFixed(digits);

/** The 1 line for a route, by the route's status. */
export function routeLine(route: RouteFields): string {
    if (route.status === "off") {
        return "Route: off (the router's mode is off); nothing changes";
    }

    if (route.status === "explicit") {
        return `Route: worker ${route.worker ?? "?"} named by the supervisor; the router did not run`;
    }

    if (route.status === "failed") {
        return `Route: failed (${route.reason}); no worker named, nothing changes`;
    }

    const profile = route.profileModel === undefined ? "" : `; profile: ${route.profileModel}`;

    return `Route: ${route.kind ?? "?"} (kind ${fixed(route.kindConfidence, 2)}), complexity ${fixed(route.complexity, 1)}/3, demand ${fixed(route.demand, 1)} → ${route.tier ?? "?"}: ${route.model ?? "?"}, thinking ${route.thinking ?? "?"} (no worker named${profile}; shadow, not applied)`;
}

const withLine = (fields: RouteFields): Route => ({ ...fields, line: routeLine(fields) });

// ─── The module ──────────────────────────────────────────────────────────────

/** A brief to classify, and when the work starts. */
export type RouteRequest = { brief: string; startAt: number; profileModel?: string };

/** What another module finds on `globalThis[Symbol.for("pi-pocket-team.model-router")]`. */
export type RouterApi = {
    version: 1;
    /** Classify a brief and record the suggestion. It never throws. */
    route: (request: RouteRequest) => Promise<Route>;
    /** Record that the supervisor named the worker, so the router did not run. */
    explicit: (request: { worker: string; profileModel?: string }) => Route;
};

/** Where another module finds this one's live API: a global, never an import. */
const API = Symbol.for("pi-pocket-team.model-router");

/** The SSH config the masked host names come from. */
const sshPath = (): string =>
    process.env.PI_POCKET_TEAM_SSH_CONFIG ?? join(homedir(), ".ssh", "config");

/** The SSH host names, or none when the file cannot be read. */
async function sshNames(): Promise<string[]> {
    try {
        return sshHostNames(await readFile(sshPath(), "utf8"));
    } catch {
        return [];
    }
}

/** The owner's allowed models, and the ones that cannot be used now. */
async function usableModels(host: Host): Promise<{ allowed: string[]; unusable: Set<string> }> {
    const allowed = [...host.subagentModels()];
    const unusable = new Set<string>();

    await Promise.all(
        allowed.map(async (spec) => {
            try {
                const problem = await host.modelProblem(host.resolveModel(spec));

                if (problem !== undefined) {
                    unusable.add(spec);
                }
            } catch {
                unusable.add(spec);
            }
        }),
    );

    return { allowed, unusable };
}

/** The longest reason a route keeps: it goes to the supervisor and to the desk. */
const MAX_REASON = 200;

export default function createModelRouter(host: Host, web: Web) {
    web.settings([
        {
            name: "mode",
            label: "Mode",
            type: "choice",
            default: "shadow",
            choices: [
                { value: "off", label: "Off" },
                { value: "shadow", label: "Shadow (record only)" },
            ],
        },
        {
            name: "typesafeApiKey",
            label: "TypeSafe API key (Jev)",
            type: "text",
            secret: true,
            description:
                "The key of the TypeSafe account that answers Jev. The router sends it nothing but a brief with URLs, emails, IP addresses, host names and secrets masked, and it records a suggestion only.",
        },
    ]);

    const mode = (): Route["mode"] => (web.setting("mode") === "off" ? "off" : "shadow");

    const apiKey = (): string | undefined => {
        const value = web.setting("typesafeApiKey");
        const held = typeof value === "string" ? value.trim() : "";

        return held.length >= 4 && held.length <= 4096 ? held : undefined;
    };

    // The key never shows in a tool result or in a person's message: it shows as `[TYPESAFE_API_KEY]`.
    let unhide: (() => void) | undefined;
    let hidden: string | undefined;

    const hideKey = (): void => {
        const value = apiKey();

        if (value === hidden) {
            return;
        }

        unhide?.();
        unhide = undefined;
        hidden = undefined;

        if (value === undefined) {
            return;
        }

        unhide = host.hide({ value, label: "TYPESAFE_API_KEY" });
        hidden = value;
    };

    hideKey();
    web.onDispose(web.onSettings(hideKey));
    web.onDispose(() => unhide?.());

    /** A route that holds no suggestion: the delegation goes on as it would without the router. */
    const failed = (reason: string, at: number, notes?: string[]): Route =>
        withLine({
            mode: mode(),
            status: "failed",
            reason,
            ...(notes === undefined || notes.length === 0 ? {} : { notes }),
            at,
        });

    /** `text` with the key taken out: it never goes to Jev, to the desk, or to the supervisor. */
    const redact = (text: string, key: string): string =>
        text.replaceAll(key, "[TYPESAFE_API_KEY]");

    /** One line, 200 characters at most, without the key. */
    const reasonOf = (error: unknown, key: string): string =>
        redact(error instanceof Error ? error.message : String(error), key)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_REASON);

    const route = async (request: RouteRequest): Promise<Route> => {
        const now = Date.now();
        const held = mode();

        if (held === "off") {
            return withLine({
                mode: held,
                status: "off",
                reason: "the router's mode is off",
                at: now,
            });
        }

        const key = apiKey();

        if (key === undefined) {
            return failed("no TypeSafe key set", now);
        }

        try {
            // The owner's list and the tiers file are read while Jev answers: the whole route stays near the timeout.
            const models = usableModels(host);
            const tiersFile = readTiers(tiersPath());

            // Jev can fail first: these 2 are then never awaited, and must not reject unhandled.
            models.catch(() => undefined);
            tiersFile.catch(() => undefined);
            // The key itself goes before the call, and out of the answer too: it never reaches Jev or the record.
            const masked = redact(maskBrief(request.brief, await sshNames()), key);
            const analysis = await classify(masked, key);
            const [{ allowed, unusable }, { tiers, notes }] = await Promise.all([
                models,
                tiersFile,
            ]);
            const decision = decide(analysis, { allowed, unusable, at: request.startAt, tiers });
            const all = [...notes, ...decision.notes];
            const jevModel =
                analysis.jevModel === undefined ? undefined : redact(analysis.jevModel, key);
            const jevId = analysis.jevId === undefined ? undefined : redact(analysis.jevId, key);

            if (
                decision.model === undefined ||
                decision.tier === undefined ||
                decision.thinking === undefined
            ) {
                return failed("no usable model in the allowed list", now, all);
            }

            return withLine({
                mode: held,
                status: "shadow",
                kind: analysis.kind,
                kindConfidence: round2(analysis.kindConfidence),
                complexity: round2(analysis.complexity),
                capability: round2(analysis.capability),
                deepReasoning: round2(analysis.deepReasoning),
                demand: decision.demand,
                tier: decision.tier,
                model: decision.model,
                thinking: decision.thinking,
                ...(request.profileModel === undefined
                    ? {}
                    : { profileModel: request.profileModel }),
                ...(jevModel === undefined ? {} : { jevModel }),
                ...(jevId === undefined ? {} : { jevId }),
                latencyMs: analysis.latencyMs,
                reason: "shadow: recorded only",
                ...(all.length === 0 ? {} : { notes: all }),
                at: now,
            });
        } catch (error) {
            return failed(reasonOf(error, key), now);
        }
    };

    const explicit = (request: { worker: string; profileModel?: string }): Route =>
        withLine({
            mode: mode(),
            status: "explicit",
            worker: request.worker,
            ...(request.profileModel === undefined ? {} : { profileModel: request.profileModel }),
            reason: "the supervisor named the worker",
            at: Date.now(),
        });

    // Another module finds this version here. A new version sets its own before the old one's cleanup runs.
    const published: RouterApi = { version: 1, route, explicit };
    const shared = globalThis as unknown as Record<symbol, RouterApi | undefined>;

    shared[API] = published;
    web.onDispose(() => {
        if (shared[API] === published) {
            delete shared[API];
        }
    });
}
