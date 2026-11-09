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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** The 4 judgments the demand reads: a stored route holds them, so a caller with no full `Analysis` can give these. */
export type Judgments = Pick<Analysis, "kind" | "complexity" | "capability" | "deepReasoning">;

/**
 * The demand of Jev's judgments, 0 to 3, not rounded: `0.55 × complexity + 0.45 × capability`, plus 0.75 when the work
 * needs deep reasoning (0.65 or more), minus 0.25 when it surely does not (0.2 or less), then raised to the kind's floor.
 * `floored` names the floor's tier when the floor raised it.
 */
function demandOf(analysis: Judgments): { demand: number; floored?: Tier } {
    let demand = 0.55 * analysis.complexity + 0.45 * analysis.capability;

    if (analysis.deepReasoning >= 0.65) {
        demand += 0.75;
    } else if (analysis.deepReasoning <= 0.2) {
        demand -= 0.25;
    }

    demand = clamp(demand, 0, 3);

    const floor = Math.max(0, TIERS.indexOf(KIND_FLOORS[analysis.kind] ?? "quick"));

    return demand < floor ? { demand: floor, floored: TIERS[floor] } : { demand };
}

/**
 * The tier Jev's judgments ask for, then the first model of that tier the owner allows and that works now. When the
 * tier holds none, the nearer tiers are tried in turn. Nothing here changes a model: the answer is a suggestion only.
 */
export function decide(analysis: Analysis, options: DecideOptions): Decision {
    const { demand, floored } = demandOf(analysis);
    const notes: string[] = floored === undefined ? [] : [`${analysis.kind} floors at ${floored}`];
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

// ─── Features ────────────────────────────────────────────────────────────────

/**
 * The facts of 1 delegation that are known when it starts, version 1. Stored data (JSON only): never rename a field or
 * change what one means; a new fact is a new field, or a new version. The Jev fields are absent when Jev did not answer.
 */
export type Features = {
    v: 1;
    /** Jev's kind of work. */
    kind?: string;
    /** Jev's judgments, 0 to 3, and the probability of deep reasoning, at 2 decimals. */
    complexity?: number;
    capability?: number;
    deepReasoning?: number;
    /** The demand of the judgments (the route's `demand`), at 2 decimals. */
    demand?: number;
    /** The brief's length in characters (code points), before masking. */
    briefChars: number;
    /** Distinct tokens of the masked brief that hold a `/` or end in a known file extension; never a URL. */
    pathsNamed: number;
    /** Distinct `owner/name` tokens that are repositories on the team roster. */
    reposNamed: number;
    /** The first repository folder's language, from its marker files; `unknown` with no folder. */
    language: "go" | "ts" | "js" | "python" | "other" | "unknown";
    /**
     * A named path is a risk path: it matches a glob of a folder's `.github/risk-paths.json` that gets the label
     * `risk:high`, so any glob of a version 1 list, and an L1 or L2 glob of a version 2 list (frostyard/core ADR-0078).
     * Null when no folder has a readable list. The meaning stays "a named path is a risk path": the L3 and L4 globs of a
     * version 2 list are not risk paths.
     */
    riskPathNamed: boolean | null;
    /** A named path's folder holds a test file; null when no path is named or no folder exists. */
    testsBeside: boolean | null;
};

/** What `features` reads beside the brief: the roster's repository names, and the host names to mask. */
export type FeatureOptions = {
    /** Every repository name on the team roster, such as `bketelsen/pi-pocket-team`. Without it, `reposNamed` is 0. */
    roster?: readonly string[];
    /** The host names `maskBrief` takes out (this machine's SSH hosts). */
    hostNames?: readonly string[];
};

/** The test files `testsBeside` looks for in a named path's folder. */
const TEST_FILE = /(?:_test\.go|\.test\.ts|\.test\.mjs)$|^test_.*\.py$/;

/** The placeholders `maskBrief` and the key redaction write: a token that holds one is no path. */
const MASKED = /\[(?:url|host|ip|email|secret|TYPESAFE_API_KEY)\]/;

/**
 * A token of the brief without the quotes, brackets and sentence punctuation around it, a `:line` or `:line:column`
 * after a file, a `#12` after a repository, a possessive `'s`, and a leading `./`.
 */
function cleanToken(token: string): string {
    return token
        .replace(/^[`'"(<{*]+/, "")
        .replace(/[`'")>}*,.;:!?]+$/, "")
        .replace(/'s$/, "")
        .replace(/[`'")>}*,.;:!?]+$/, "")
        .replace(/#\d+$/, "")
        .replace(/:\d+(?::\d+)?$/, "")
        .replace(/^\.\//, "");
}

/** A token that names a path: it holds a `/` or ends in a known file extension. A token of only `/` and `.` names none. */
function isPathToken(token: string): boolean {
    if (!/[^/.]/.test(token)) {
        return false;
    }

    if (token.includes("/")) {
        return true;
    }

    const dot = token.lastIndexOf(".");

    return dot > 0 && FILE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/** `path` when it is a folder that exists, else undefined. */
function folderAt(path: string): string | undefined {
    try {
        return statSync(path).isDirectory() ? path : undefined;
    } catch {
        return undefined;
    }
}

/** The language of a repository folder, by its marker files, in this order. */
function languageOf(dir: string | undefined): Features["language"] {
    if (dir === undefined || folderAt(dir) === undefined) {
        return "unknown";
    }

    let names: Set<string>;

    try {
        names = new Set(readdirSync(dir));
    } catch {
        return "unknown";
    }

    if (names.has("go.mod")) {
        return "go";
    }

    if (names.has("tsconfig.json")) {
        return "ts";
    }

    if (names.has("package.json")) {
        return "js";
    }

    return names.has("pyproject.toml") || names.has("requirements.txt") ? "python" : "other";
}

/**
 * A named path as a `/`-separated path inside `dir`, by its text: an absolute one only when it is inside `dir`, a
 * relative one only when it stays inside. Undefined otherwise. The risk globs match this text; a file read also needs
 * `realInside`.
 */
function insideRepo(dir: string, path: string): string | undefined {
    const root = resolve(dir);
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, full);

    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return undefined;
    }

    return rel.split(sep).join("/");
}

/**
 * `target` as the file system resolves it (symbolic links followed), when that is inside `realRoot` (the folder's own
 * resolved path); else undefined. Every file read of `features` goes through it: a link to a place outside the
 * repository is never followed.
 */
function realInside(realRoot: string, target: string): string | undefined {
    let real: string;

    try {
        real = realpathSync(target);
    } catch {
        return undefined;
    }

    const rel = relative(realRoot, real);

    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : real;
}

/**
 * The globs of a folder's `.github/risk-paths.json` that name a risk path, or undefined when it is absent, unreadable,
 * not a list, or a link to a file outside the folder. In a version 2 list only the L1 and L2 globs are risk paths
 * (frostyard/core ADR-0078); an entry with no `level`, in a version 1 list, is one.
 */
function riskGlobs(dir: string, realRoot: string): string[] | undefined {
    const file = realInside(realRoot, join(dir, ".github", "risk-paths.json"));

    if (file === undefined) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { paths?: unknown } | null;

        if (!Array.isArray(parsed?.paths)) {
            return undefined;
        }

        return parsed.paths.flatMap((entry: unknown) => {
            const { glob, level } = (entry ?? {}) as { glob?: unknown; level?: unknown };

            if (typeof glob !== "string" || glob === "") {
                return [];
            }

            return level === undefined || level === "L1" || level === "L2" ? [glob] : [];
        });
    } catch {
        return undefined;
    }
}

// The glob matcher of the risk paths list (frostyard/core ADR-0068): a port of `matchGlob` in the vendored
// `scripts/lib/risk-paths.mjs`, which is not installed with the module. `model-router.test.ts` checks that both match
// the same paths.

/** The globs 1 glob stands for, with its `{a,b}` groups expanded; none when it is not valid. */
function expandGlobBraces(glob: string): string[] {
    const parts: string[][] = [];
    let literal = "";
    let i = 0;

    while (i < glob.length) {
        const c = glob[i]!;

        if (c === "}") {
            return [];
        }

        if (c !== "{") {
            literal += c;
            i++;
            continue;
        }

        const close = glob.indexOf("}", i + 1);
        const nextOpen = glob.indexOf("{", i + 1);

        if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
            return [];
        }

        const alternatives = glob.slice(i + 1, close).split(",");

        if (alternatives.length < 2 || alternatives.some((each) => each === "")) {
            return [];
        }

        parts.push([literal], alternatives);
        literal = "";
        i = close + 1;
    }

    parts.push([literal]);
    let expansions = [""];

    for (const alternatives of parts) {
        const next = expansions.flatMap((prefix) => alternatives.map((each) => prefix + each));

        if (next.length > 256) {
            return [];
        }

        expansions = next;
    }

    return expansions;
}

/** 1 segment of a glob as a pattern: `*` is any run of characters but `/`, `?` is 1 such character. */
function globSegment(segment: string): RegExp {
    let source = "^";

    for (const c of segment) {
        source +=
            c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.*+?^$()|[\]{}\\/]/g, "\\$&");
    }

    return new RegExp(`${source}$`, "u");
}

/** Whether the glob's segments match the path's segments; `**` matches 0 or more whole segments. */
function matchGlobSegments(globSegments: string[], pathSegments: string[]): boolean {
    const patterns = globSegments.map((segment) =>
        segment === "**" ? null : globSegment(segment),
    );
    const memo = new Map<number, boolean>();

    const visit = (g: number, p: number): boolean => {
        const key = g * (pathSegments.length + 1) + p;
        const known = memo.get(key);

        if (known !== undefined) {
            return known;
        }

        const pattern = patterns[g];
        const result =
            g === patterns.length
                ? p === pathSegments.length
                : pattern === null
                  ? visit(g + 1, p) || (p < pathSegments.length && visit(g, p + 1))
                  : p < pathSegments.length &&
                    pattern!.test(pathSegments[p]!) &&
                    visit(g + 1, p + 1);

        memo.set(key, result);

        return result;
    };

    return visit(0, 0);
}

/** Whole-path, case-sensitive match of a risk-paths glob against a repository path, as `matchGlob` matches. */
export function matchRiskGlob(glob: string, path: string): boolean {
    if (path === "") {
        return false;
    }

    const pathSegments = path.split("/");

    return expandGlobBraces(glob).some((expansion) =>
        matchGlobSegments(expansion.split("/"), pathSegments),
    );
}

/**
 * The facts of a delegation known when it starts (version 1): Jev's judgments when `analysis` is given, and what the
 * brief and the repository folders show. It makes no network call and never throws. It reads only the folders'
 * marker files, their risk paths lists, and the folders of named paths inside them, each by its resolved path: a
 * symbolic link to a place outside a folder is never followed. The brief is masked first (`maskBrief`), so a URL or a
 * host never counts as a path.
 */
export function features(
    brief: string,
    repoDirs: readonly string[],
    analysis?: Judgments,
    options: FeatureOptions = {},
): Features {
    const roster = new Set((options.roster ?? []).map((name) => name.toLowerCase()));
    const masked = maskBrief(brief, options.hostNames ?? []);
    const paths = new Set<string>();
    const repos = new Set<string>();

    for (const raw of masked.split(/\s+/)) {
        if (raw === "" || MASKED.test(raw)) {
            continue;
        }

        const token = cleanToken(raw);

        // A roster repository is a repository and, by its `/`, a path too: the 2 counts are separate.
        if (roster.has(token.toLowerCase())) {
            repos.add(token.toLowerCase());
        }

        if (isPathToken(token)) {
            paths.add(token);
        }
    }

    // Each folder with its resolved path (a folder that is itself a link, or sits below one, resolves first): the reads
    // below never leave it, through a symbolic link either.
    const dirs = repoDirs.flatMap((dir) => {
        if (dir === "" || folderAt(dir) === undefined) {
            return [];
        }

        try {
            return [{ dir, real: realpathSync(dir) }];
        } catch {
            return [];
        }
    });
    const named = [...paths];
    let riskPathNamed: boolean | null = null;
    let testsBeside: boolean | null = null;

    for (const { dir, real } of dirs) {
        const globs = riskGlobs(dir, real);

        if (globs === undefined) {
            continue;
        }

        riskPathNamed ??= false;

        // The globs match the path's text: no file is read for it.
        for (const path of named) {
            const rel = insideRepo(dir, path);

            if (rel !== undefined && globs.some((glob) => matchRiskGlob(glob, rel))) {
                riskPathNamed = true;
            }
        }
    }

    if (named.length > 0 && dirs.length > 0) {
        testsBeside = false;

        // Each folder is read once, however many named paths share it.
        const read = new Set<string>();

        for (const { dir, real } of dirs) {
            for (const path of named) {
                const rel = insideRepo(dir, path);

                if (rel === undefined || testsBeside) {
                    continue;
                }

                const full = join(dir, rel);
                const self = realInside(real, full);
                const folder =
                    self !== undefined && folderAt(self) !== undefined
                        ? self
                        : realInside(real, dirname(full));

                if (folder === undefined || read.has(folder) || folderAt(folder) === undefined) {
                    continue;
                }

                read.add(folder);

                try {
                    testsBeside = readdirSync(folder).some((name) => TEST_FILE.test(name));
                } catch {
                    // An unreadable folder holds no test that counts.
                }
            }
        }
    }

    return {
        v: 1,
        ...(analysis === undefined
            ? {}
            : {
                  kind: analysis.kind,
                  complexity: round2(analysis.complexity),
                  capability: round2(analysis.capability),
                  deepReasoning: round2(analysis.deepReasoning),
                  demand: round2(demandOf(analysis).demand),
              }),
        briefChars: [...brief].length,
        pathsNamed: paths.size,
        reposNamed: repos.size,
        language: languageOf(repoDirs.find((dir) => dir !== "")),
        riskPathNamed,
        testsBeside,
    };
}

/** The SHA-256 of the brief as it was given, not masked, in hex: it ties a route to its brief and keeps no text. */
export const briefHash = (brief: string): string =>
    createHash("sha256").update(brief, "utf8").digest("hex");

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
    /**
     * The model the supervisor named. On an `explicit` route (written by an older `team.ts`) the router did not run. On
     * a `shadow`, `failed` or `off` route with a `worker`, the router ran beside the named worker, and the named worker
     * ran: the suggestion is a record to compare with it, and it changes nothing.
     */
    worker?: string;
    jevModel?: string;
    jevId?: string;
    latencyMs?: number;
    /**
     * The delegation's facts known at its start (version 1, `features`), on every route a router of version 3 or later
     * records: off and failed ones too, with the Jev fields absent then. An older route has none.
     */
    features?: Features;
    /** The SHA-256 hex of the brief as it was given, not masked (`briefHash`). An older route has none. */
    briefHash?: string;
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
        return route.worker === undefined
            ? `Route: failed (${route.reason}); no worker named, nothing changes`
            : `Route: failed, named ${route.worker} runs (${route.reason})`;
    }

    if (route.worker !== undefined) {
        // Short on purpose: with 32-character model names it stays within 120 characters, so the desk event holds it whole.
        return `Route: ${route.tier ?? "?"}: ${route.model ?? "?"} (${route.kind ?? "?"} ${fixed(route.demand, 1)}); named ${route.worker} runs; shadow`;
    }

    const profile = route.profileModel === undefined ? "" : `; profile: ${route.profileModel}`;

    return `Route: ${route.kind ?? "?"} (kind ${fixed(route.kindConfidence, 2)}), complexity ${fixed(route.complexity, 1)}/3, demand ${fixed(route.demand, 1)} → ${route.tier ?? "?"}: ${route.model ?? "?"}, thinking ${route.thinking ?? "?"} (no worker named${profile}; shadow, not applied)`;
}

const withLine = (fields: RouteFields): Route => ({ ...fields, line: routeLine(fields) });

// ─── The module ──────────────────────────────────────────────────────────────

/**
 * A brief to classify, and when the work starts. `worker` is the model the supervisor named, when it named one: the
 * router still classifies the brief and records its suggestion, and the record carries the `worker`. The named worker
 * runs either way.
 */
export type RouteRequest = {
    brief: string;
    startAt: number;
    profileModel?: string;
    worker?: string;
    /** The delegation's repository folders, for `features` (version 3): the roster checkout, or none. */
    repoDirs?: readonly string[];
    /** Every repository name on the team roster, for `features` (version 3). */
    roster?: readonly string[];
};

/** What another module finds on `globalThis[Symbol.for("pi-pocket-team.model-router")]`. */
export type RouterApi = {
    version: 3;
    /**
     * Classify a brief and record the suggestion. It never throws. With a `worker` in the request, the route carries it
     * (version 2): the router ran beside the named worker. Every route carries the brief's `features` and `briefHash`
     * (version 3), when the mode is off and when Jev fails too.
     */
    route: (request: RouteRequest) => Promise<Route>;
    /** Record that the supervisor named the worker, so the router did not run. Kept for a `team.ts` of version 1. */
    explicit: (request: { worker: string; profileModel?: string }) => Route;
    /**
     * The brief's features with no Jev fields, for a route `team.ts` records itself (the router failed or took too
     * long): the same function, with no network call. It never throws (version 3).
     */
    features: (brief: string, repoDirs: readonly string[], roster?: readonly string[]) => Features;
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

    /** The SSH host names the last route read: `features` alone masks with them, and reads no file for them. */
    let knownHosts: readonly string[] = [];

    /** The facts every route records: the brief's features and its hash. */
    type Facts = { features?: Features; briefHash: string };

    /** A route that holds no suggestion: the delegation goes on as it would without the router. */
    const failed = (
        reason: string,
        at: number,
        facts: Facts,
        worker?: string,
        notes?: string[],
    ): Route =>
        withLine({
            mode: mode(),
            status: "failed",
            ...(worker === undefined ? {} : { worker }),
            ...facts,
            reason,
            ...(notes === undefined || notes.length === 0 ? {} : { notes }),
            at,
        });

    /**
     * The brief's features, with Jev's judgments when there are any, and its hash. A failure to read the folders leaves
     * the features out: the route itself never fails for them.
     */
    const factsOf = (
        request: RouteRequest,
        hostNames: readonly string[],
        analysis?: Judgments,
    ): Facts => {
        const hash = briefHash(request.brief);

        try {
            return {
                features: features(request.brief, request.repoDirs ?? [], analysis, {
                    roster: request.roster ?? [],
                    hostNames,
                }),
                briefHash: hash,
            };
        } catch {
            return { briefHash: hash };
        }
    };

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
        const hostNames = await sshNames();

        knownHosts = hostNames;

        if (held === "off") {
            return withLine({
                mode: held,
                status: "off",
                ...(request.worker === undefined ? {} : { worker: request.worker }),
                ...factsOf(request, hostNames),
                reason: "the router's mode is off",
                at: now,
            });
        }

        const key = apiKey();

        if (key === undefined) {
            return failed("no TypeSafe key set", now, factsOf(request, hostNames), request.worker);
        }

        let analysisOut: Analysis | undefined;

        try {
            // The owner's list and the tiers file are read while Jev answers: the whole route stays near the timeout.
            const models = usableModels(host);
            const tiersFile = readTiers(tiersPath());

            // Jev can fail first: these 2 are then never awaited, and must not reject unhandled.
            models.catch(() => undefined);
            tiersFile.catch(() => undefined);
            // The key itself goes before the call, and out of the answer too: it never reaches Jev or the record.
            const masked = redact(maskBrief(request.brief, hostNames), key);

            const analysis = await classify(masked, key);

            analysisOut = analysis;
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
                return failed(
                    "no usable model in the allowed list",
                    now,
                    factsOf(request, hostNames, analysis),
                    request.worker,
                    all,
                );
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
                ...(request.worker === undefined ? {} : { worker: request.worker }),
                ...(jevModel === undefined ? {} : { jevModel }),
                ...(jevId === undefined ? {} : { jevId }),
                latencyMs: analysis.latencyMs,
                ...factsOf(request, hostNames, analysis),
                reason: "shadow: recorded only",
                ...(all.length === 0 ? {} : { notes: all }),
                at: now,
            });
        } catch (error) {
            // Jev's answer, when the failure came after it: its judgments still go in the features.
            return failed(
                reasonOf(error, key),
                now,
                factsOf(request, hostNames, analysisOut),
                request.worker,
            );
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

    /** The features alone, for a route that `team.ts` records itself: no Jev fields, and no file read for the hosts. */
    const featuresOnly = (
        brief: string,
        repoDirs: readonly string[],
        roster?: readonly string[],
    ): Features =>
        features(brief, repoDirs, undefined, { roster: roster ?? [], hostNames: knownHosts });

    // Another module finds this version here. A new version sets its own before the old one's cleanup runs.
    const published: RouterApi = { version: 3, route, explicit, features: featuresOnly };
    const shared = globalThis as unknown as Record<symbol, RouterApi | undefined>;

    shared[API] = published;
    web.onDispose(() => {
        if (shared[API] === published) {
            delete shared[API];
        }
    });
}
