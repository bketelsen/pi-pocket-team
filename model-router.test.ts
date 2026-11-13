// The model router's pure parts: the masking, the Jev body and answer, the decision, the tiers file, the record's line,
// and the one HTTP call (with a fake fetch: no network). Nothing here starts a server or reads a real file.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Analysis,
    DEFAULT_TIERS,
    ENDPOINT,
    KIND_FLOORS,
    TASK_KINDS,
    TIERS,
    TIMEOUT_MS,
    type RouterApi,
    briefHash,
    classify,
    decide,
    features,
    inDeepseekPeak,
    jevBody,
    maskBrief,
    matchRiskGlob,
    parseAnalysis,
    readTiers,
    routeLine,
    sshHostNames,
} from "./model-router.ts";
import createModelRouter from "./model-router.ts";
import type { Host, Web } from "./_pocket.d.ts";
import { matchGlob } from "./scripts/lib/risk-paths.mjs";
import {
    BANDS,
    BENCH_REPOS,
    RULE_EXPERIMENT,
    RULE_PICKS,
    armOf,
    assignArm,
    briefNames,
    checkRule,
    ineligible,
    predictBand,
    readLiveTiers,
    readRule,
    readRulePicks,
} from "./model-router.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { install } from "./install.mjs";
import { predictTier, validateRule } from "./bench/analyze.mjs";
import { R2_BENCH_REPOS } from "./audit/checks.mjs";

// 12:00 UTC: outside DeepSeek's peak hours.
const NOON = Date.UTC(2026, 9, 23, 12, 0);
const PEAK = Date.UTC(2026, 9, 23, 7, 0);

/** An answer as Jev gives one, with the 4 judgments. */
const analysis = (over: Partial<Analysis> = {}): Analysis => ({
    kind: "implement",
    kindConfidence: 0.8,
    kindProbabilities: {},
    complexity: 1.8,
    complexityConfidence: 0.8,
    capability: 1.5,
    capabilityConfidence: 0.8,
    deepReasoning: 0.4,
    latencyMs: 120,
    ...over,
});

// ─── The SSH config's host names ─────────────────────────────────────────────

test("sshHostNames reads Host and HostName lines, in any case, and skips patterns", () => {
    const config = [
        "# my hosts",
        "Host alpha beta",
        "  HostName=Gamma.Example.COM",
        "host delta",
        'Host "build01" db',
        "Host a",
        "Host *",
        "Host 192.168.* prod",
        "Host ab",
        "HostName zeta",
        "",
        "  User brian",
        "Host !refused alpha",
    ].join("\n");

    // Every literal alias is kept, a 1-letter one too (`a`). Double quotes come off.
    assert.deepEqual(sshHostNames(config), [
        "alpha",
        "beta",
        "gamma.example.com",
        "delta",
        "build01",
        "db",
        "a",
        "prod",
        "ab",
        "zeta",
    ]);
    assert.deepEqual(sshHostNames(""), []);
    assert.deepEqual(sshHostNames('Host "just-quoted"'), ["just-quoted"]);
});

// ─── Masking ─────────────────────────────────────────────────────────────────

test("maskBrief takes URLs and emails out", () => {
    const masked = maskBrief(
        "See https://api.example.com/v1/x?q=1 and http://10.1.2.3:8080/p and www.bketelsen.dev/notes, then mail brian@example.com.",
        [],
    );

    assert.match(masked, /\[url\]/);
    assert.equal(masked.includes("example.com/v1"), false);
    assert.equal(masked.includes("www.bketelsen.dev"), false);
    assert.match(masked, /\[email\]/);
    assert.equal(masked.includes("brian@"), false);
});

test("maskBrief takes IPv4 addresses out, with a port or a CIDR too", () => {
    const masked = maskBrief(
        "ssh 10.1.2.3 and 192.168.0.1:2222 and 172.16.0.0/12 twice: 10.1.2.3",
        [],
    );

    assert.equal(masked, "ssh [ip] and [ip] and [ip] twice: [ip]");
});

test("maskBrief takes an IPv4 address at the end of a sentence out, and keeps the punctuation", () => {
    assert.equal(maskBrief("Check 192.168.1.4.", []), "Check [ip].");
    assert.equal(maskBrief("Check 192.168.1.4, then go", []), "Check [ip], then go");
    assert.equal(maskBrief("Check 192.168.1.4)", []), "Check [ip])");
    assert.equal(maskBrief("Check 192.168.1.4:2222.", []), "Check [ip].");
    assert.equal(maskBrief("Check 192.168.1.0/24,", []), "Check [ip],");
});

test("maskBrief takes IPv6 addresses out, and leaves a clock time alone", () => {
    assert.equal(maskBrief("::1", []), "[ip]");
    assert.equal(maskBrief("fe80::1%eth0", []), "[ip]");
    assert.equal(maskBrief("2001:db8::1/64", []), "[ip]");
    assert.equal(
        maskBrief("the logs at 10:00 and 01:00-04:00", []),
        "the logs at 10:00 and 01:00-04:00",
    );
});

test("maskBrief takes an IPv6 address at the end of a sentence out, and keeps the punctuation", () => {
    assert.equal(maskBrief("Check 2001:db8::1.", []), "Check [ip].");
    assert.equal(maskBrief("Check 2001:db8::1, then go", []), "Check [ip], then go");
    assert.equal(maskBrief("Check 2001:db8::1)", []), "Check [ip])");
    assert.equal(maskBrief("Check 2001:db8::1/64.", []), "Check [ip].");
    // An address that ends in its own colons keeps them: they are not sentence punctuation.
    assert.equal(maskBrief("Route 2001:db8:: and fd00::.", []), "Route [ip] and [ip].");
    assert.equal(maskBrief("Check fe80::1%eth0, too", []), "Check [ip], too");
});

test("maskBrief takes a dotted name that is not a file name out", () => {
    assert.equal(
        maskBrief("open api.example.info, build.example.ca and node.example.network", []),
        "open [host], [host] and [host]",
        "a last label that is no file extension is a host",
    );
    assert.equal(maskBrief("see acme.example.com", []), "see [host]");
    assert.equal(maskBrief("call api.memo now", []), "call [host] now", "code may be masked too");
    assert.equal(
        maskBrief("BUILD.EXAMPLE.COM is down", []),
        "[host] is down",
        "DNS names have no case",
    );
    assert.equal(
        maskBrief("api.example.sh and build.example.so and docs.example.md", []),
        "[host] and [host] and [host]",
        "a country code that is also a file extension, with 2 dots, is a host",
    );
    assert.equal(maskBrief("run install.sh, read pocket.d.ts", []), "run [host], read pocket.d.ts");
});

test("maskBrief masks a 1-dot name whose suffix is both a file extension and a domain, unless it is surely a file", () => {
    // `example.sh` can be a host: with no path before it and no `_` in it, it goes. `install.sh` goes the same way.
    assert.equal(
        maskBrief("Edit install.sh and deploy to example.sh; see README.md and docs/notes.md", []),
        "Edit [host] and deploy to [host]; see [host] and docs/notes.md",
    );
    assert.equal(
        maskBrief("run ./install.sh and my_tool.py", []),
        "run ./install.sh and my_tool.py",
    );
    // A protocol-relative URL is a URL, not a path: its `/` does not keep the host.
    assert.equal(maskBrief("fetch //example.sh/api now", []), "fetch [url] now");
    assert.equal(maskBrief('src="//cdn.example.md/x.js"', []), 'src="[url]"');
    assert.equal(
        maskBrief("see docs/notes.md and a/b//c.md", []),
        "see docs/notes.md and a/b//c.md",
    );
});

test("maskBrief leaves a file name and a version alone", () => {
    for (const kept of [
        "team.ts",
        "package.json",
        "./install.sh",
        "docs/README.md",
        "set_up.py",
        "node.js",
        "v0.26.0",
        "bketelsen/pi-pocket",
    ]) {
        assert.equal(maskBrief(`use ${kept} now`, []), `use ${kept} now`, kept);
    }
});

test("maskBrief takes this machine's SSH names out, as whole words in any case", () => {
    const masked = maskBrief("Deploy to BUILD-01 and build-01.example.net; build-012 stays.", [
        "build-01",
    ]);

    assert.equal(masked, "Deploy to [host] and [host]; build-012 stays.");
    // A 1-letter alias is masked too: the host stays private, and Jev loses only the word.
    assert.equal(
        maskBrief("Deploy to x, then check box", ["x"]),
        "Deploy to [host], then check box",
    );
});

test("maskBrief takes secret-like tokens out", () => {
    const masked = maskBrief(
        "token ghp_abcdefghijklmnop and github_pat_abcdefghijklmnop and sk-abcdefghijklmnopqrst and xoxb-1234567890-ab",
        [],
    );

    assert.equal(masked, "token [secret] and [secret] and [secret] and [secret]");
});

// ─── The Jev body and answer ────────────────────────────────────────────────

test("jevBody carries the masked brief and the 4 questions, and nothing about the machine", () => {
    const masked = maskBrief("Deploy to build-01 in /home/brian/x", ["build-01"]);
    const body = jevBody(masked);
    const json = JSON.stringify(body);

    assert.equal(body.state.request, "Deploy to [host] in /home/brian/x");
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(Object.keys(body.questions), [
        "task_kind",
        "complexity",
        "capability_deserved",
        "needs_deep_reasoning",
    ]);
    assert.deepEqual(Object.keys(body.state), ["request"], "the brief is all the state there is");
    assert.equal(json.includes("cwd"), false);
    assert.equal(json.includes("budget"), false);
    assert.deepEqual(body.questions.task_kind, {
        type: "choice",
        instructions: (body.questions.task_kind as { instructions: string }).instructions,
        criteria: TASK_KINDS,
    });
});

test("parseAnalysis reads the 4 judgments, the Jev model and the id", () => {
    const payload = {
        id: "req_123",
        model: "jev-1.14.0",
        answers: {
            task_kind: { choice: "debug", confidence: 0.72, probabilities: { debug: 0.72 } },
            complexity: { score: 2, confidence: 0.9 },
            capability_deserved: { score: 1.4, confidence: 0.5 },
            needs_deep_reasoning: { noul: 0.66 },
        },
    };
    const parsed = parseAnalysis(payload, 42);

    assert.equal(parsed.kind, "debug");
    assert.equal(parsed.kindConfidence, 0.72);
    assert.equal(parsed.complexity, 2);
    assert.equal(parsed.capability, 1.4);
    assert.equal(parsed.deepReasoning, 0.66);
    assert.equal(parsed.latencyMs, 42);
    assert.equal(parsed.jevModel, "jev-1.14.0");
    assert.equal(parsed.jevId, "req_123");
});

test("parseAnalysis throws on an unknown kind", () => {
    assert.throws(
        () => parseAnalysis({ answers: { task_kind: { choice: "garden" } } }, 1),
        /unknown task kind: garden/,
    );
});

// ─── The decision ───────────────────────────────────────────────────────────

test("decide reads the demand formula, and rounds it to a tier", () => {
    const decision = decide(analysis(), {
        allowed: [...DEFAULT_TIERS.high.models, ...DEFAULT_TIERS.premium.models],
        unusable: new Set(),
        at: NOON,
        tiers: DEFAULT_TIERS,
    });

    // 0.55 * 1.8 + 0.45 * 1.5 = 1.665, rounded to 2 places.
    assert.equal(decision.demand, 1.67);
    assert.equal(decision.tier, "high");
    assert.equal(decision.model, "github-copilot/claude-sonnet-5.5");
    assert.equal(decision.thinking, "medium");
});

test("decide lifts the demand when the work needs deep reasoning, and lowers it when it does not", () => {
    const options = {
        allowed: ["github-copilot/claude-opus-5.5"],
        unusable: new Set(),
        at: NOON,
        tiers: DEFAULT_TIERS,
    };

    // 1.665 + 0.75, and 1.665 - 0.25, each rounded to 2 places.
    assert.equal(decide(analysis({ deepReasoning: 0.7 }), options).demand, 2.42);
    assert.equal(
        Math.abs(decide(analysis({ deepReasoning: 0.1 }), options).demand - 1.415) < 0.01,
        true,
    );
});

test("decide raises a cheap plan to its kind's floor, and notes it", () => {
    const decision = decide(analysis({ kind: "plan", complexity: 0.4, capability: 0.4 }), {
        allowed: [...DEFAULT_TIERS.high.models],
        unusable: new Set(),
        at: NOON,
        tiers: DEFAULT_TIERS,
    });

    assert.equal(KIND_FLOORS.plan, "high");
    assert.equal(decision.demand, 2);
    assert.equal(decision.tier, "high");
    assert.ok(decision.notes.includes("plan floors at high"));
});

test("decide takes a model from a lower tier when the kind's confidence is low", () => {
    const decision = decide(analysis({ complexity: 3, capability: 3, kindConfidence: 0.2 }), {
        allowed: ["deepseek/deepseek-flash"],
        unusable: new Set(),
        at: NOON,
        tiers: DEFAULT_TIERS,
    });

    assert.equal(decision.tier, "standard");
    assert.equal(decision.model, "deepseek/deepseek-flash");
    assert.ok(decision.notes.includes("low kind confidence"));
});

test("decide skips DeepSeek in its peak hours", () => {
    const options = { unusable: new Set(), tiers: DEFAULT_TIERS };
    const allowed = [...DEFAULT_TIERS.standard.models];

    assert.equal(
        decide(analysis(), { ...options, allowed, at: NOON }).model,
        "deepseek/deepseek-flash",
    );
    assert.equal(
        decide(analysis(), { ...options, allowed, at: PEAK }).model,
        "github-copilot/gemini-3.8-flash",
    );
    assert.equal(inDeepseekPeak(PEAK), true);
    assert.equal(inDeepseekPeak(NOON), false);
});

test("decide skips a model that is not allowed or that cannot be used now", () => {
    const decision = decide(analysis({ complexity: 0.2, capability: 0.2, deepReasoning: 0.1 }), {
        allowed: [...DEFAULT_TIERS.quick.models],
        unusable: new Set(["github-copilot/gpt-6-luna"]),
        at: NOON,
        tiers: DEFAULT_TIERS,
    });

    assert.equal(decision.tier, "quick");
    assert.equal(decision.model, "anthropic/claude-haiku-5-5");
});

test("decide tries the nearer tiers in turn: +1, -1, +2, -2", () => {
    const options = { unusable: new Set(), at: NOON, tiers: DEFAULT_TIERS };

    // The work asks for standard; only premium is allowed: +1.
    assert.equal(
        decide(analysis({ complexity: 1, capability: 1, deepReasoning: 0.4 }), {
            ...options,
            allowed: [...DEFAULT_TIERS.premium.models],
        }).tier,
        "premium",
    );

    // The work asks for high; only quick and premium are allowed: +1 is premium.
    assert.equal(
        decide(analysis({ kind: "implement", complexity: 2, capability: 2, deepReasoning: 0.4 }), {
            ...options,
            allowed: ["github-copilot/claude-opus-5.5", "anthropic/claude-haiku-5-5"],
        }).tier,
        "premium",
    );

    // The work asks for premium; only quick is allowed: -3.
    assert.equal(
        decide(analysis({ kind: "implement", complexity: 3, capability: 3, deepReasoning: 0.4 }), {
            ...options,
            allowed: ["anthropic/claude-haiku-5-5"],
        }).tier,
        "quick",
    );
});

test("decide reports no tier when no model is usable", () => {
    const decision = decide(analysis(), {
        allowed: [],
        unusable: new Set(),
        at: NOON,
        tiers: DEFAULT_TIERS,
    });

    assert.equal(decision.tier, undefined);
    assert.equal(decision.model, undefined);
});

// ─── The tiers file ─────────────────────────────────────────────────────────

test("readTiers gives the default tiers when the file is missing, and reads a valid one", async () => {
    const folder = await mkdtemp(join(tmpdir(), "router-tiers-"));

    try {
        const missing = await readTiers(join(folder, "none.json"));

        assert.deepEqual(missing.tiers, DEFAULT_TIERS);
        assert.deepEqual(missing.notes, []);

        const path = join(folder, "router.json");

        await writeFile(
            path,
            JSON.stringify({
                tiers: {
                    high: { models: ["acme/big"], thinking: "high" },
                    quick: { models: ["acme/small"], thinking: "low" },
                },
            }),
        );
        const read = await readTiers(path);

        assert.deepEqual(read.tiers.high, { models: ["acme/big"], thinking: "high" });
        assert.deepEqual(read.tiers.quick, { models: ["acme/small"], thinking: "low" });
        assert.deepEqual(
            read.tiers.standard,
            DEFAULT_TIERS.standard,
            "a tier the file omits keeps the default",
        );
        assert.deepEqual(read.notes, []);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

test("readTiers gives the default tiers and a note when the file is not valid", async () => {
    const folder = await mkdtemp(join(tmpdir(), "router-tiers-"));

    try {
        for (const [name, contents] of [
            ["broken.json", "{ not json"],
            ["empty.json", "[]"],
            ["no-tiers.json", JSON.stringify({ other: true })],
            [
                "bad-tier.json",
                JSON.stringify({ tiers: { high: { models: [], thinking: "high" } } }),
            ],
            ["bad-thinking.json", JSON.stringify({ tiers: { high: { models: ["acme/big"] } } })],
        ]) {
            const path = join(folder, name);

            await writeFile(path, contents);
            const read = await readTiers(path);

            assert.deepEqual(read.tiers, DEFAULT_TIERS, name);
            assert.equal(read.notes.length, 1, name);
            assert.match(read.notes[0], /the default tiers are used/, name);
        }
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

// ─── The record's line ──────────────────────────────────────────────────────

test("routeLine says what the router would pick, in shadow mode", () => {
    const line = routeLine({
        mode: "shadow",
        status: "shadow",
        kind: "implement",
        kindConfidence: 0.82,
        complexity: 1.8,
        capability: 1.9,
        deepReasoning: 0.4,
        demand: 1.9,
        tier: "high",
        model: "github-copilot/claude-sonnet-5.5",
        thinking: "medium",
        profileModel: "github-copilot/claude-opus-5.5",
        reason: "shadow: recorded only",
        at: NOON,
    });

    assert.equal(
        line,
        "Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)",
    );
});

test("routeLine says a named worker won, a failure, and the mode being off", () => {
    assert.equal(
        routeLine({
            mode: "shadow",
            status: "explicit",
            worker: "github-copilot/claude-sonnet-5.5",
            reason: "the supervisor named the worker",
            at: NOON,
        }),
        "Route: worker github-copilot/claude-sonnet-5.5 named by the supervisor; the router did not run",
    );
    assert.equal(
        routeLine({
            mode: "shadow",
            status: "failed",
            reason: "Jev timed out after 3.5 s",
            at: NOON,
        }),
        "Route: failed (Jev timed out after 3.5 s); no worker named, nothing changes",
    );
    assert.equal(
        routeLine({ mode: "off", status: "off", reason: "the router's mode is off", at: NOON }),
        "Route: off (the router's mode is off); nothing changes",
    );
});

test("routeLine says a worker runs beside the router's suggestion, and a failure beside a named worker", () => {
    const shadow = {
        mode: "shadow" as const,
        status: "shadow" as const,
        kind: "implement",
        kindConfidence: 0.82,
        complexity: 1.8,
        capability: 1.9,
        deepReasoning: 0.4,
        demand: 1.94,
        tier: "high" as const,
        model: "github-copilot/claude-sonnet-5.5",
        thinking: "medium",
        profileModel: "github-copilot/claude-opus-5.5",
        reason: "shadow: recorded only",
        at: NOON,
    };

    assert.equal(
        routeLine({ ...shadow, worker: "deepseek/deepseek-flash" }),
        "Route: high: github-copilot/claude-sonnet-5.5 (implement 1.9); named deepseek/deepseek-flash runs; shadow",
    );
    assert.equal(
        routeLine({
            mode: "shadow",
            status: "failed",
            worker: "deepseek/deepseek-flash",
            reason: "Jev timed out after 3.5 s",
            at: NOON,
        }),
        "Route: failed, named deepseek/deepseek-flash runs (Jev timed out after 3.5 s)",
    );
    assert.equal(
        routeLine({
            mode: "off",
            status: "off",
            worker: "deepseek/deepseek-flash",
            reason: "the router's mode is off",
            at: NOON,
        }),
        "Route: off (the router's mode is off); nothing changes",
        "the off line does not change",
    );
});

// ─── The one call ───────────────────────────────────────────────────────────

/** A fake fetch that answers with `payload` and keeps what it was given. */
function fakeFetch(
    payload: unknown,
    status = 200,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });

        return new Response(JSON.stringify(payload), { status });
    }) as unknown as typeof fetch;

    return { fetch: fetchLike, calls };
}

const ANSWER = {
    answers: {
        task_kind: { choice: "implement", confidence: 0.8 },
        complexity: { score: 2 },
        capability_deserved: { score: 2 },
        needs_deep_reasoning: { noul: 0.3 },
    },
};

test("classify posts to the fixed endpoint with the key, and answers with the analysis", async () => {
    const fake = fakeFetch(ANSWER);
    const analysisOut = await classify("[host] and [ip]", "sk-test-key-1234567890", {
        fetch: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, ENDPOINT);
    assert.equal(fake.calls[0].init.method, "POST");
    assert.equal(
        (fake.calls[0].init.headers as Record<string, string>).Authorization,
        "Bearer sk-test-key-1234567890",
    );
    assert.equal(JSON.parse(String(fake.calls[0].init.body)).state.request, "[host] and [ip]");
    assert.equal(analysisOut.kind, "implement");
    assert.equal(typeof analysisOut.latencyMs, "number");
    assert.equal(TIMEOUT_MS, 3500);
});

test("classify calls once only, and its error holds the status and not the key", async () => {
    const fake = fakeFetch({ error: "slow down" }, 429);
    const key = "sk-test-key-1234567890";

    await assert.rejects(classify("brief", key, { fetch: fake.fetch }), (error: Error) => {
        assert.equal(fake.calls.length, 1, "no retry");
        assert.match(error.message, /429/);
        assert.equal(error.message.includes(key), false);
        assert.equal(error.message.includes("slow down"), false, "never the response body");

        return true;
    });
});

test("classify gives up at the timeout, quickly, and says so", async () => {
    const slow = ((_: string, init: RequestInit) =>
        new Promise((__, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as unknown as typeof fetch;
    const started = Date.now();

    await assert.rejects(
        classify("brief", "sk-test-key-1234567890", { fetch: slow, timeoutMs: 50 }),
        /Jev timed out after 0\.05 s/,
    );
    assert.equal(Date.now() - started < 1000, true);
});

test("classify does not put a failed fetch's text in its error", async () => {
    const key = "sk-test-key-1234567890";
    const broken = (async () => {
        throw new Error(`connect failed with ${key}`);
    }) as unknown as typeof fetch;

    await assert.rejects(classify("brief", key, { fetch: broken }), (error: Error) => {
        assert.equal(error.message.includes(key), false);

        return true;
    });
});

test("the tiers keep their order, cheapest first", () => {
    assert.deepEqual([...TIERS], ["quick", "standard", "high", "premium"]);
});

// ─── The module: settings, the key, and the published API ───────────────────

const KEY = "tsk-module-test-key-0123456789";
const ROUTER = Symbol.for("pi-pocket-team.model-router");

/** The module on a fake host and web: the settings it reads, the values it hides, and the API it publishes. */
function loadRouter(settings: Record<string, unknown>, allowed: string[], broken: string[] = []) {
    const hidden: string[] = [];
    const disposers: (() => void)[] = [];
    const listeners: (() => void)[] = [];
    const host = {
        subagentModels: () => allowed,
        resolveModel: (spec: string) => {
            if (broken.includes(spec)) {
                throw new Error(`${spec} is not signed in`);
            }

            return { provider: spec.split("/")[0], id: spec.split("/")[1] };
        },
        modelProblem: async () => undefined,
        hide: ({ value }: { value: string }) => {
            hidden.push(value);

            return () => {
                hidden.splice(hidden.indexOf(value), 1);
            };
        },
    } as unknown as Host;
    const web = {
        settings: () => undefined,
        setting: (name: string) => settings[name],
        onSettings: (listener: () => void) => {
            listeners.push(listener);

            return () => undefined;
        },
        onDispose: (dispose: () => void) => {
            disposers.push(dispose);
        },
    } as unknown as Web;

    createModelRouter(host, web);

    const api = (globalThis as unknown as Record<symbol, RouterApi | undefined>)[ROUTER]!;

    return {
        api,
        hidden,
        changed: () => listeners.forEach((listener) => listener()),
        dispose: () => disposers.forEach((dispose) => dispose()),
    };
}

/** Replace the global fetch for 1 test; the return value puts it back. */
function stubFetch(answer: (url: string, init: RequestInit) => Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const before = globalThis.fetch;

    globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });

        return answer(url, init);
    }) as unknown as typeof fetch;

    return { calls, restore: () => (globalThis.fetch = before) };
}

test("the module routes a masked brief in shadow mode, and hides its key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-module-"));
    const ssh = join(dir, "ssh-config");

    await writeFile(ssh, "Host frostbox\n  HostName 10.0.0.9\n");
    process.env.PI_POCKET_TEAM_SSH_CONFIG = ssh;
    process.env.PI_POCKET_TEAM_ROUTER_CONFIG = join(dir, "missing.json");

    const fetchStub = stubFetch(async () => new Response(JSON.stringify(ANSWER)));
    const router = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
        "github-copilot/claude-sonnet-5.5",
        "deepseek/deepseek-flash",
    ]);

    try {
        assert.deepEqual(router.hidden, [KEY], "the key is hidden from Pi");

        const route = await router.api.route({
            brief: "Fix frostbox at https://frostbox.lan:8080/x and 192.168.1.4; mail me@example.com",
            startAt: NOON,
            profileModel: "github-copilot/claude-opus-5.5",
        });

        assert.equal(fetchStub.calls.length, 1);
        assert.equal(fetchStub.calls[0].url, ENDPOINT);

        const sent = String(fetchStub.calls[0].init.body);

        assert.equal(sent.includes("frostbox"), false, "the SSH name is masked");
        assert.equal(sent.includes("192.168"), false);
        assert.equal(sent.includes("example.com"), false);
        assert.equal(sent.includes(KEY), false, "the key goes in the header only");
        assert.equal(route.status, "shadow");
        assert.equal(route.tier, "high");
        assert.equal(route.model, "github-copilot/claude-sonnet-5.5");
        assert.equal(route.profileModel, "github-copilot/claude-opus-5.5");
        assert.match(route.line, /shadow, not applied/);
        assert.equal(JSON.stringify(route).includes(KEY), false);
    } finally {
        fetchStub.restore();
        router.dispose();
        delete process.env.PI_POCKET_TEAM_SSH_CONFIG;
        delete process.env.PI_POCKET_TEAM_ROUTER_CONFIG;
        await rm(dir, { recursive: true, force: true });
    }

    assert.equal(router.hidden.length, 0, "dispose stops the hiding");
    assert.equal((globalThis as unknown as Record<symbol, unknown>)[ROUTER], undefined);
});

test("the module calls nothing when its mode is off or it has no key, and a failure is a record", async () => {
    const fetchStub = stubFetch(async () => new Response("{}", { status: 500 }));

    try {
        const off = loadRouter({ mode: "off", typesafeApiKey: KEY }, ["deepseek/deepseek-flash"]);

        assert.equal((await off.api.route({ brief: "x", startAt: NOON })).status, "off");
        off.dispose();

        const keyless = loadRouter({ mode: "shadow" }, ["deepseek/deepseek-flash"]);
        const none = await keyless.api.route({ brief: "x", startAt: NOON });

        assert.equal(none.status, "failed");
        assert.equal(none.reason, "no TypeSafe key set");
        keyless.dispose();
        assert.equal(fetchStub.calls.length, 0, "no call without a key or with the mode off");

        const failing = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
            "deepseek/deepseek-flash",
        ]);
        const failed = await failing.api.route({ brief: "x", startAt: NOON });

        assert.equal(failed.status, "failed");
        assert.match(failed.reason, /500/);
        assert.equal(failed.model, undefined);
        failing.dispose();
    } finally {
        fetchStub.restore();
    }
});

test("the key goes out of the brief, and out of the Jev model and id", async () => {
    const fetchStub = stubFetch(
        async () =>
            new Response(JSON.stringify({ ...ANSWER, id: `req-${KEY}`, model: `jev-${KEY}` }), {
                status: 200,
            }),
    );
    const router = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
        "github-copilot/claude-sonnet-5.5",
    ]);

    try {
        const route = await router.api.route({
            brief: `Deploy with ${KEY} to acme.example.info`,
            startAt: NOON,
        });
        const sent = String(fetchStub.calls[0]!.init.body);

        assert.equal(sent.includes(KEY), false, "the key never goes to Jev");
        assert.match(sent, /\[TYPESAFE_API_KEY\]/);
        assert.equal(route.status, "shadow");
        assert.equal(JSON.stringify(route).includes(KEY), false, "the record holds no key");
        assert.equal(route.jevModel, "jev-[TYPESAFE_API_KEY]");
        assert.equal(route.jevId, "req-[TYPESAFE_API_KEY]");
    } finally {
        fetchStub.restore();
        router.dispose();
    }
});

test("the module skips a model it cannot resolve, and a named worker needs no call", async () => {
    const fetchStub = stubFetch(async () => new Response(JSON.stringify(ANSWER)));
    const router = loadRouter(
        { mode: "shadow", typesafeApiKey: KEY },
        ["github-copilot/claude-sonnet-5.5", "github-copilot/gpt-6.1-sol"],
        ["github-copilot/claude-sonnet-5.5"],
    );

    try {
        const route = await router.api.route({ brief: "x", startAt: NOON });

        assert.equal(route.model, "github-copilot/gpt-6.1-sol");

        const named = router.api.explicit({ worker: "github-copilot/claude-sonnet-5.5" });

        assert.equal(named.status, "explicit");
        assert.equal(fetchStub.calls.length, 1, "explicit makes no call");
    } finally {
        fetchStub.restore();
        router.dispose();
    }
});

test("the module publishes version 4, and keeps `explicit` for an older team.ts", () => {
    const router = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, []);

    try {
        assert.equal(router.api.version, 4);
        assert.equal(typeof router.api.explicit, "function");
        assert.equal(typeof router.api.features, "function");
    } finally {
        router.dispose();
    }
});

test("a worker line is at most 120 characters with 2 models of 32 characters", () => {
    const model = "github-copilot/claude-sonnet-5.5"; // 32 characters
    const worker = "github-copilot/claude-haiku-5.5x"; // 32 characters
    const line = routeLine({
        mode: "shadow",
        status: "shadow",
        kind: "implement",
        tier: "standard",
        demand: 1.9,
        model,
        worker,
        reason: "shadow: recorded only",
        at: NOON,
    });

    assert.equal(model.length, 32);
    assert.equal(worker.length, 32);
    assert.equal(line, `Route: standard: ${model} (implement 1.9); named ${worker} runs; shadow`);
    assert.ok(line.length <= 120, `the line has ${String(line.length)} characters`);

    // A failure's reason can hold 200 characters: the worker comes first, so the desk's 120-character cut keeps it.
    const failed = routeLine({
        mode: "shadow",
        status: "failed",
        worker,
        reason: "x".repeat(200),
        at: NOON,
    });

    assert.ok(
        failed.slice(0, 120).startsWith(`Route: failed, named ${worker} runs (`),
        "the first 120 characters hold the named worker",
    );
});

test("a named worker is routed all the same: 1 Jev call, masking as before, and the record carries the worker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-worker-"));
    const ssh = join(dir, "ssh-config");

    await writeFile(ssh, "Host frostbox\n  HostName 10.0.0.9\n");
    process.env.PI_POCKET_TEAM_SSH_CONFIG = ssh;
    process.env.PI_POCKET_TEAM_ROUTER_CONFIG = join(dir, "missing.json");

    const fetchStub = stubFetch(async () => new Response(JSON.stringify(ANSWER)));
    const router = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
        "github-copilot/claude-sonnet-5.5",
        "deepseek/deepseek-flash",
    ]);

    try {
        const route = await router.api.route({
            brief: "Fix frostbox at 192.168.1.4; mail me@example.com",
            startAt: NOON,
            profileModel: "github-copilot/claude-opus-5.5",
            worker: "deepseek/deepseek-flash",
        });
        const sent = String(fetchStub.calls[0]!.init.body);

        assert.equal(fetchStub.calls.length, 1, "1 Jev call");
        assert.equal(sent.includes("frostbox"), false, "the SSH name is masked");
        assert.equal(sent.includes("192.168"), false);
        assert.equal(sent.includes("example.com"), false);
        assert.equal(
            sent.includes("deepseek/deepseek-flash"),
            false,
            "the worker never goes to Jev",
        );
        assert.equal(route.status, "shadow");
        assert.equal(route.worker, "deepseek/deepseek-flash");
        assert.equal(route.model, "github-copilot/claude-sonnet-5.5");
        assert.equal(route.profileModel, "github-copilot/claude-opus-5.5");
        assert.match(
            route.line,
            /^Route: high: github-copilot\/claude-sonnet-5\.5 \(implement 2\.0\); named deepseek\/deepseek-flash runs; shadow$/,
        );

        const plain = await router.api.route({ brief: "x", startAt: NOON });

        assert.equal(plain.worker, undefined, "no worker named, no worker field");
        assert.equal("worker" in plain, false);
    } finally {
        fetchStub.restore();
        router.dispose();
        delete process.env.PI_POCKET_TEAM_SSH_CONFIG;
        delete process.env.PI_POCKET_TEAM_ROUTER_CONFIG;
        await rm(dir, { recursive: true, force: true });
    }
});

test("a failed or off route beside a named worker carries the worker", async () => {
    const fetchStub = stubFetch(async () => new Response("{}", { status: 500 }));
    const worker = "deepseek/deepseek-flash";

    try {
        const failing = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [worker]);
        const failed = await failing.api.route({ brief: "x", startAt: NOON, worker });

        assert.equal(failed.status, "failed");
        assert.equal(failed.worker, worker);
        assert.match(
            failed.line,
            /^Route: failed, named deepseek\/deepseek-flash runs \(.*500.*\)/,
        );
        failing.dispose();

        const keyless = loadRouter({ mode: "shadow" }, [worker]);

        assert.equal(
            (await keyless.api.route({ brief: "x", startAt: NOON, worker })).worker,
            worker,
        );
        keyless.dispose();

        const off = loadRouter({ mode: "off", typesafeApiKey: KEY }, [worker]);
        const none = await off.api.route({ brief: "x", startAt: NOON, worker });

        assert.equal(none.status, "off");
        assert.equal(none.worker, worker);
        assert.equal(none.line, "Route: off (the router's mode is off); nothing changes");
        off.dispose();
    } finally {
        fetchStub.restore();
    }
});

// ─── Features ───────────────────────────────────────────────────────────────

/** A temporary folder with `files` (path → text) in it; the return value removes it. */
async function repoWith(
    files: Record<string, string>,
): Promise<{ dir: string; done: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "router-features-"));

    for (const [path, text] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), text);
    }

    return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

const RISK_LIST = JSON.stringify({
    schema_version: 1,
    paths: [
        { glob: "model-router.ts", why: "secrets" },
        { glob: ".github/workflows/**", why: "CI" },
        { glob: "scripts/{lib,bin}/*.mjs", why: "the gate" },
    ],
});

test("features: the Jev fields come from the analysis, at 2 decimals, and the demand is the route's", () => {
    const judged = features(
        "Fix it",
        [],
        analysis({ complexity: 1.8, capability: 1.5, deepReasoning: 0.4 }),
    );

    assert.equal(judged.v, 1);
    assert.equal(judged.kind, "implement");
    assert.equal(judged.complexity, 1.8);
    assert.equal(judged.capability, 1.5);
    assert.equal(judged.deepReasoning, 0.4);
    // 0.55 × 1.8 + 0.45 × 1.5 = 1.665: the demand `decide` gives the route.
    assert.equal(judged.demand, 1.67);
    assert.equal(
        judged.demand,
        decide(analysis({ complexity: 1.8, capability: 1.5, deepReasoning: 0.4 }), {
            allowed: ["github-copilot/claude-sonnet-5.5"],
            unusable: new Set(),
            at: NOON,
            tiers: DEFAULT_TIERS,
        }).demand,
    );

    // A plan floors at `high` (2), as the route's demand does.
    assert.equal(
        features("x", [], analysis({ kind: "plan", complexity: 0, capability: 0 })).demand,
        2,
    );
});

test("features: without an analysis, no Jev field is there at all", () => {
    const plain = features("Fix it", []);

    for (const field of ["kind", "complexity", "capability", "deepReasoning", "demand"]) {
        assert.equal(field in plain, false, `${field} is absent`);
    }

    assert.deepEqual(plain, {
        v: 1,
        briefChars: 6,
        pathsNamed: 0,
        reposNamed: 0,
        language: "unknown",
        riskPathNamed: null,
        testsBeside: null,
    });
});

test("features: briefChars counts the brief's characters before masking, by code point", () => {
    assert.equal(features("", []).briefChars, 0);
    assert.equal(features("héllo 🚀", []).briefChars, 7);
    assert.equal(
        features("see https://example.com/a/b", []).briefChars,
        "see https://example.com/a/b".length,
        "the URL counts as written, not as [url]",
    );
});

test("features: pathsNamed counts distinct tokens with a `/` or a file extension, and never a URL or a host", () => {
    const brief = [
        "Change `model-router.ts` and team.ts:120, then docs/modules/model-router.md.",
        "Read ./team.ts again (team.ts), and audit/checks.mjs:10:4.",
        "Not https://example.com/a/b, not //cdn.example.com/x, not 10.0.0.1/24, not acme.example.info.",
        "Not bketelsen/pi-pocket-team#82, nor the version 1.8/3, nor plain words.",
    ].join("\n");
    const counted = features(brief, [], undefined, { roster: ["bketelsen/pi-pocket-team"] });

    // model-router.ts, team.ts, docs/modules/model-router.md, audit/checks.mjs, bketelsen/pi-pocket-team (a roster
    // repository holds a `/`: it is a path too, and the 2 counts are separate) and 1.8/3.
    assert.equal(counted.pathsNamed, 6);
    assert.equal(counted.reposNamed, 1);

    assert.equal(features("bketelsen/pi-pocket-team", []).pathsNamed, 1);
    assert.equal(features("", []).pathsNamed, 0);
    assert.equal(features("2026/12 and 数据/2026", []).pathsNamed, 2, "no letter is needed");
    assert.equal(
        features("a / b, ./ and ..", []).pathsNamed,
        0,
        "only slashes and dots name nothing",
    );
    // An SSH host name is masked first: it is no path.
    assert.equal(
        features("frostbox.sh", [], undefined, { hostNames: ["frostbox.sh"] }).pathsNamed,
        0,
    );
});

test("features: reposNamed counts distinct roster repositories, in any case, with a PR number too", () => {
    const roster = ["bketelsen/pi-pocket-team", "frostyard/core"];

    assert.equal(
        features(
            "bketelsen/pi-pocket-team#82 and Bketelsen/Pi-Pocket-Team, `frostyard/core`'s ADR, frostyard/other",
            [],
            undefined,
            { roster },
        ).reposNamed,
        2,
    );
    assert.equal(features("bketelsen/pi-pocket-team", []).reposNamed, 0, "no roster: 0");
    assert.equal(features("nothing here", [], undefined, { roster }).reposNamed, 0);
});

test("features: the language comes from the first folder's marker files, in order", async () => {
    const cases: [Record<string, string>, string][] = [
        [{ "go.mod": "module x", "package.json": "{}" }, "go"],
        [{ "tsconfig.json": "{}", "package.json": "{}" }, "ts"],
        [{ "package.json": "{}" }, "js"],
        [{ "pyproject.toml": "" }, "python"],
        [{ "requirements.txt": "" }, "python"],
        [{ "README.md": "" }, "other"],
    ];

    for (const [files, language] of cases) {
        const repo = await repoWith(files);

        try {
            assert.equal(features("x", [repo.dir]).language, language, JSON.stringify(files));
        } finally {
            await repo.done();
        }
    }

    const go = await repoWith({ "go.mod": "module x" });
    const js = await repoWith({ "package.json": "{}" });

    try {
        assert.equal(features("x", [js.dir, go.dir]).language, "js", "the first folder decides");
    } finally {
        await go.done();
        await js.done();
    }

    assert.equal(features("x", []).language, "unknown", "no folder");
    assert.equal(features("x", [join(tmpdir(), "router-no-such-folder")]).language, "unknown");
});

test("features: riskPathNamed matches named paths against the folder's risk paths list", async () => {
    const repo = await repoWith({
        ".github/risk-paths.json": RISK_LIST,
        "model-router.ts": "",
        "team.ts": "",
    });
    const bare = await repoWith({ "team.ts": "" });
    const broken = await repoWith({ ".github/risk-paths.json": "{ not json" });

    try {
        assert.equal(features("Change model-router.ts", [repo.dir]).riskPathNamed, true);
        assert.equal(features("Edit .github/workflows/ci.yml", [repo.dir]).riskPathNamed, true);
        assert.equal(
            features("Edit scripts/bin/x.mjs", [repo.dir]).riskPathNamed,
            true,
            "a brace group",
        );
        assert.equal(
            features(`Edit ${join(repo.dir, "model-router.ts")}`, [repo.dir]).riskPathNamed,
            true,
            "an absolute path inside the folder",
        );
        assert.equal(features("Change team.ts", [repo.dir]).riskPathNamed, false);
        assert.equal(
            features("No path at all", [repo.dir]).riskPathNamed,
            false,
            "a list, and no path",
        );
        assert.equal(
            features("Change ../x/model-router.ts", [repo.dir]).riskPathNamed,
            false,
            "a path that leaves the folder never matches",
        );
        assert.equal(features("Change model-router.ts", [bare.dir]).riskPathNamed, null, "no list");
        assert.equal(
            features("Change model-router.ts", [broken.dir]).riskPathNamed,
            null,
            "no valid list",
        );
        assert.equal(features("Change model-router.ts", []).riskPathNamed, null, "no folder");
        assert.equal(
            features("Change model-router.ts", [bare.dir, repo.dir]).riskPathNamed,
            true,
            "any folder's list",
        );
    } finally {
        await repo.done();
        await bare.done();
        await broken.done();
    }
});

test("features: riskPathNamed reads only the L1 and L2 globs of a version 2 risk paths list", async () => {
    const v2 = (level: string) =>
        JSON.stringify({
            schema_version: 2,
            default_level: "L3",
            paths: [{ glob: "model-router.ts", level, why: "the router" }],
        });
    const loose = await repoWith({
        ".github/risk-paths.json": v2("L4"),
        "model-router.ts": "",
    });
    const strict = await repoWith({
        ".github/risk-paths.json": v2("L2"),
        "model-router.ts": "",
    });

    try {
        assert.equal(
            features("Change model-router.ts", [loose.dir]).riskPathNamed,
            false,
            "an L4 glob is not a risk path",
        );
        assert.equal(
            features("Change model-router.ts", [strict.dir]).riskPathNamed,
            true,
            "an L2 glob is a risk path",
        );
    } finally {
        await loose.done();
        await strict.done();
    }
});

test("features: testsBeside looks for a test file in each named path's folder", async () => {
    const repo = await repoWith({
        "team.ts": "",
        "team.test.ts": "",
        "audit/checks.mjs": "",
        "audit/checks.test.mjs": "",
        "pkg/store/store.go": "",
        "pkg/store/store_test.go": "",
        "py/app.py": "",
        "py/test_app.py": "",
        "docs/modules/model-router.md": "",
        "web/index.js": "",
        "web/index.test.js": "",
    });

    try {
        assert.equal(
            features("Change team.ts", [repo.dir]).testsBeside,
            true,
            "*.test.ts at the root",
        );
        assert.equal(
            features("Change audit/checks.mjs", [repo.dir]).testsBeside,
            true,
            "*.test.mjs",
        );
        assert.equal(
            features("Change pkg/store/store.go", [repo.dir]).testsBeside,
            true,
            "*_test.go",
        );
        assert.equal(features("Change py/app.py", [repo.dir]).testsBeside, true, "test_*.py");
        assert.equal(
            features("Look in pkg/store/", [repo.dir]).testsBeside,
            true,
            "a named folder",
        );
        assert.equal(
            features("Change docs/modules/model-router.md", [repo.dir]).testsBeside,
            false,
        );
        assert.equal(
            features("Change web/index.js", [repo.dir]).testsBeside,
            false,
            "*.test.js is not one of the 4 patterns",
        );
        assert.equal(
            features("Change docs/modules/model-router.md and team.ts", [repo.dir]).testsBeside,
            true,
            "any named path",
        );
        assert.equal(features("Change nothing", [repo.dir]).testsBeside, null, "no path named");
        assert.equal(features("Change team.ts", []).testsBeside, null, "no folder");
        assert.equal(
            features("Change /etc/passwd", [repo.dir]).testsBeside,
            false,
            "a path outside the folder is never read",
        );
    } finally {
        await repo.done();
    }
});

test("matchRiskGlob matches as the vendored risk-paths matcher does", () => {
    const globs = [
        "Makefile",
        "*.ts",
        "scripts/lib/**",
        ".github/workflows/**",
        "**/secrets/*.json",
        "docs/**/x.md",
        "src/{a,b}/*.go",
        "a?c.txt",
        "{broken",
        "broken}",
        "{a}",
        "dots.in.name",
    ];
    const paths = [
        "Makefile",
        "makefile",
        "team.ts",
        "dir/team.ts",
        "scripts/lib/risk-paths.mjs",
        "scripts/lib",
        "scripts/library/x",
        ".github/workflows/ci.yml",
        ".github/workflows/a/b.yml",
        "secrets/k.json",
        "x/y/secrets/k.json",
        "docs/x.md",
        "docs/a/b/x.md",
        "src/a/main.go",
        "src/c/main.go",
        "abc.txt",
        "ac.txt",
        "dotsXinXname",
        "dots.in.name",
        "",
    ];

    for (const glob of globs) {
        for (const path of paths) {
            assert.equal(
                matchRiskGlob(glob, path),
                matchGlob(glob, path),
                `${glob} against ${JSON.stringify(path)}`,
            );
        }
    }
});

test("briefHash is the SHA-256 hex of the brief as given", () => {
    assert.equal(
        briefHash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.notEqual(
        briefHash("Fix 10.0.0.1"),
        briefHash("Fix [ip]"),
        "the brief is not masked first",
    );
});

test("every route records features and the brief's hash: shadow, off, no key, and a Jev failure", async () => {
    const repo = await repoWith({ "go.mod": "module x", "store_test.go": "", "store.go": "" });
    const brief = "Fix store.go in frostyard/test at https://example.com/x";
    const request = {
        brief,
        startAt: NOON,
        repoDirs: [repo.dir],
        roster: ["frostyard/test"],
    };
    const base = {
        v: 1,
        briefChars: [...brief].length,
        // store.go, and frostyard/test (a roster repository holds a `/`).
        pathsNamed: 2,
        reposNamed: 1,
        language: "go",
        riskPathNamed: null,
        testsBeside: true,
    };
    const ok = stubFetch(async () => new Response(JSON.stringify(ANSWER)));

    try {
        const shadow = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
            "github-copilot/claude-sonnet-5.5",
        ]);
        const route = await shadow.api.route(request);

        assert.equal(route.status, "shadow");
        assert.deepEqual(route.features, {
            v: 1,
            kind: "implement",
            complexity: 2,
            capability: 2,
            deepReasoning: 0.3,
            demand: route.demand,
            ...base,
        });
        assert.equal(route.briefHash, briefHash(brief));
        assert.equal(route.line.includes("features"), false, "the line is as before");
        assert.equal(JSON.stringify(route).includes("example.com"), false, "no brief text is kept");
        shadow.dispose();

        const off = loadRouter({ mode: "off", typesafeApiKey: KEY }, []);
        const offRoute = await off.api.route(request);

        assert.equal(offRoute.status, "off");
        assert.deepEqual(offRoute.features, base, "off: the features without Jev");
        assert.equal(offRoute.briefHash, briefHash(brief));
        off.dispose();

        const keyless = loadRouter({ mode: "shadow" }, []);

        assert.deepEqual((await keyless.api.route(request)).features, base);
        keyless.dispose();
        assert.equal(ok.calls.length, 1, "off and keyless call nothing");
    } finally {
        ok.restore();
    }

    const failing = stubFetch(async () => new Response("{}", { status: 500 }));

    try {
        const router = loadRouter({ mode: "shadow", typesafeApiKey: KEY }, [
            "github-copilot/claude-sonnet-5.5",
        ]);
        const failed = await router.api.route(request);

        assert.equal(failed.status, "failed");
        assert.deepEqual(failed.features, base, "a Jev failure: the features without Jev");
        assert.equal(failed.briefHash, briefHash(brief));
        assert.deepEqual(router.api.features(brief, [repo.dir], ["frostyard/test"]), base);
        router.dispose();
    } finally {
        failing.restore();
        await repo.done();
    }
});

test("a route with no folders and no roster still records the brief's features", async () => {
    const off = loadRouter({ mode: "off" }, []);

    try {
        const route = await off.api.route({ brief: "Fix team.ts", startAt: NOON });

        assert.deepEqual(route.features, {
            v: 1,
            briefChars: 11,
            pathsNamed: 1,
            reposNamed: 0,
            language: "unknown",
            riskPathNamed: null,
            testsBeside: null,
        });
    } finally {
        off.dispose();
    }
});

test("features: every path counts for the risk and test flags, not only the first 50", async () => {
    const repo = await repoWith({
        ".github/risk-paths.json": RISK_LIST,
        "model-router.ts": "",
        "pkg/store_test.go": "",
    });
    const ordinary = Array.from({ length: 50 }, (_, index) => `docs/n${String(index)}.md`).join(
        " ",
    );

    try {
        const risk = features(`${ordinary} model-router.ts`, [repo.dir]);

        assert.equal(risk.pathsNamed, 51);
        assert.equal(risk.riskPathNamed, true, "the 51st path is a risk path");

        const tests = features(`${ordinary} pkg/store.go`, [repo.dir]);

        assert.equal(tests.testsBeside, true, "a test beside the 51st path");
    } finally {
        await repo.done();
    }
});

test("features: a symbolic link out of the folder is never followed", async () => {
    const outside = await repoWith({
        "x.test.ts": "",
        "risk-paths.json": RISK_LIST,
        ".github/risk-paths.json": RISK_LIST,
    });
    const repo = await repoWith({ "go.mod": "module x" });
    const linkedList = await repoWith({ "go.mod": "module x" });

    try {
        // A folder link: a named path through it would read the outside folder.
        await symlink(outside.dir, join(repo.dir, "linked"));
        assert.equal(features("Change linked/x.ts", [repo.dir]).testsBeside, false);
        assert.equal(features("Look in linked/", [repo.dir]).testsBeside, false);

        // A linked list, and a linked `.github` folder: neither is read.
        await mkdir(join(linkedList.dir, ".github"));
        await symlink(
            join(outside.dir, "risk-paths.json"),
            join(linkedList.dir, ".github", "risk-paths.json"),
        );
        assert.equal(features("Change model-router.ts", [linkedList.dir]).riskPathNamed, null);
        await symlink(join(outside.dir, ".github"), join(repo.dir, ".github"));
        assert.equal(features("Change model-router.ts", [repo.dir]).riskPathNamed, null);

        // A link that stays inside the folder is read as usual.
        await mkdir(join(linkedList.dir, "src"));
        await writeFile(join(linkedList.dir, "src", "a_test.go"), "");
        await symlink(join(linkedList.dir, "src"), join(linkedList.dir, "alias"));
        assert.equal(features("Change alias/a.go", [linkedList.dir]).testsBeside, true);
    } finally {
        await repo.done();
        await linkedList.done();
        await outside.done();
    }
});

test("features: a folder reached through a symbolic link has the features of its real path", async () => {
    const repo = await repoWith({
        "go.mod": "module x",
        ".github/risk-paths.json": RISK_LIST,
        "model-router.ts": "",
        "pkg/store_test.go": "",
    });
    const parent = await mkdtemp(join(tmpdir(), "router-link-parent-"));
    const linked = join(parent, "checkout");

    try {
        await symlink(repo.dir, linked);

        const brief = "Change model-router.ts and pkg/store.go";
        const real = features(brief, [repo.dir]);

        assert.equal(real.riskPathNamed, true);
        assert.equal(real.testsBeside, true);
        assert.deepEqual(features(brief, [linked]), real, "the root's link changes nothing");

        // A link in a parent folder: the same.
        const below = join(parent, "via");

        await symlink(join(repo.dir, ".."), below);
        assert.deepEqual(features(brief, [join(below, repo.dir.split("/").at(-1)!)]), real);
    } finally {
        await rm(parent, { recursive: true, force: true });
        await repo.done();
    }
});

// ─── Rule v1: the bands, the picks, assign mode and the arm (router v4) ─────

test("router-rule-v1.json is the bench's frozen rule, valid, and install.mjs copies it", async () => {
    const here = import.meta.dirname;
    const parsed = JSON.parse(readFileSync(join(here, "router-rule-v1.json"), "utf8"));

    // The same rule, value for value (Prettier formats the copy; the bench's file is skipped).
    assert.deepEqual(
        parsed,
        JSON.parse(readFileSync(join(here, "bench", "rule-v1.json"), "utf8")),
        "a copy of the frozen rule",
    );

    assert.doesNotThrow(() => validateRule(parsed), "the bench accepts it");
    assert.ok("rule" in checkRule(parsed), "the router accepts it");

    const target = await mkdtemp(join(tmpdir(), "router-install-"));

    try {
        const { changed } = await install({ source: here, target, check: true });

        assert.ok(changed.includes("new  router-rule-v1.json"), "the install writes it");
    } finally {
        await rm(target, { recursive: true, force: true });
    }
});

test("checkRule refuses a rule that is not whole, as the bench's validateRule does", () => {
    const rule = JSON.parse(
        readFileSync(join(import.meta.dirname, "bench", "rule-v1.json"), "utf8"),
    );
    const broken: [string, unknown][] = [
        ["not an object", null],
        ["version", { ...rule, version: 2 }],
        ["features", { ...rule, features: ["nope"] }],
        ["scale", { ...rule, scale: { ...rule.scale, briefChars: 0 } }],
        ["median", { ...rule, medians: {} }],
        ["weight", { ...rule, weights: { ...rule.weights, briefChars: "x" } }],
        ["thresholds", { ...rule, thresholds: [2, 1] }],
        ["levels", { ...rule, features: ["kind"], levels: { kind: ["implement"] } }],
    ];

    for (const [name, value] of broken) {
        const checked = checkRule(value);

        assert.ok("why" in checked, name);
        assert.throws(() => validateRule(value), undefined, `the bench refuses it too: ${name}`);
    }
});

test("predictBand gives the band that the bench's predictTier gives", () => {
    const rule = JSON.parse(readFileSync(join(import.meta.dirname, "router-rule-v1.json"), "utf8"));
    // A rule with a categorical feature too: the 1-hot columns and the `unknown` level.
    const kinded = {
        ...rule,
        features: [...rule.features, "kind", "language"],
        levels: { kind: ["implement", "unknown"], language: ["go", "ts", "unknown"] },
        weights: {
            ...rule.weights,
            "kind=implement": 0.7,
            "kind=unknown": -0.4,
            "language=go": 0.3,
            "language=ts": -0.2,
            "language=unknown": 0.1,
        },
    };
    let seed = 1064;

    const next = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;

        return seed / 2 ** 31;
    };

    const seen = new Set<string>();

    for (let i = 0; i < 400; i++) {
        const facts = {
            v: 1 as const,
            briefChars: Math.floor(next() * 4000),
            pathsNamed: Math.floor(next() * 12),
            reposNamed: Math.floor(next() * 3),
            language: (["go", "ts", "python", "unknown"] as const)[Math.floor(next() * 4)]!,
            riskPathNamed: next() < 0.3 ? null : next() < 0.5,
            testsBeside: null,
            ...(next() < 0.5 ? { kind: next() < 0.5 ? "implement" : "write" } : {}),
        };

        for (const each of [rule, kinded]) {
            const band = predictBand(each, facts);

            assert.equal(band, predictTier(each, facts), JSON.stringify(facts));
            seen.add(band);
        }
    }

    assert.deepEqual([...seen].sort(), [...BANDS].sort(), "the sample reaches every band");
});

test("readRule: an absent, a broken and an invalid rule file each say why; a valid one is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-rule-"));

    try {
        const absent = await readRule(join(dir, "none.json"));

        assert.ok("why" in absent && /absent/.test(absent.why));

        await writeFile(join(dir, "broken.json"), "{ not json");
        const broken = await readRule(join(dir, "broken.json"));

        assert.ok("why" in broken && /not a valid rule/.test(broken.why));

        await writeFile(join(dir, "invalid.json"), JSON.stringify({ version: 1, features: [] }));
        const invalid = await readRule(join(dir, "invalid.json"));

        assert.ok("why" in invalid && /not a valid rule/.test(invalid.why));

        const valid = await readRule(join(import.meta.dirname, "router-rule-v1.json"));

        assert.ok("rule" in valid);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("armOf is A when the first byte of SHA-256(thread id) is even, else B", () => {
    const parity = (id: string) =>
        createHash("sha256").update(id, "utf8").digest()[0]! % 2 === 0 ? "A" : "B";
    const arms = new Set<string>();

    for (let n = 1; n <= 40; n++) {
        const id = `T${String(n)}`;

        assert.equal(armOf(id), parity(id), id);
        assert.equal(armOf(id), armOf(id), "the same thread, the same arm");
        arms.add(armOf(id));
    }

    assert.deepEqual([...arms].sort(), ["A", "B"]);
});

test("ineligible: each condition of the bench's population", () => {
    const eligible = {
        shift: true,
        kind: "implement",
        repo: "bketelsen/pi-pocket-team",
        reposNamed: ["bketelsen/pi-pocket-team", "frostyard/core"],
        riskPathNamed: false,
    };

    assert.equal(ineligible(eligible), undefined);

    for (const kind of ["implement", "debug", "refactor", "write"]) {
        assert.equal(ineligible({ ...eligible, kind }), undefined, kind);
    }

    assert.equal(ineligible({ ...eligible, repo: "Frostyard/NSL" }), undefined, "any case");
    assert.equal(ineligible({ ...eligible, shift: false }), "not a shift");
    assert.equal(ineligible({ ...eligible, shift: undefined }), "not a shift");
    assert.equal(ineligible({ ...eligible, worker: "acme/named" }), "a named worker");
    assert.equal(ineligible({ ...eligible, kind: "review" }), "kind review");
    assert.equal(ineligible({ ...eligible, kind: undefined }), "kind unknown");
    assert.equal(ineligible({ ...eligible, repo: "frostyard/snosi" }), "not a bench repository");
    assert.equal(ineligible({ ...eligible, repo: undefined }), "not a bench repository");
    assert.equal(
        ineligible({ ...eligible, reposNamed: ["bketelsen/pi-pocket"] }),
        "the brief names a repository outside the bench",
    );
    assert.equal(ineligible({ ...eligible, riskPathNamed: true }), "the brief names a risk path");
    assert.equal(ineligible({ ...eligible, riskPathNamed: null }), "no risk paths list to read");
    assert.equal(
        ineligible({ ...eligible, riskPathNamed: undefined }),
        "no risk paths list to read",
    );
});

test("BENCH_REPOS is the audit's R2 list", () => {
    assert.deepEqual([...BENCH_REPOS].sort(), [...R2_BENCH_REPOS].sort());
});

test("briefNames gives the roster repositories that a brief names, lowercase", () => {
    const { repos, paths } = briefNames("Fix Frostyard/Core#12 and store.go, not acme/x", {
        roster: ["frostyard/core", "bketelsen/fleet"],
    });

    assert.deepEqual([...repos], ["frostyard/core"]);
    assert.ok(paths.has("store.go"));
});

test("readLiveTiers reads a comma list of bands, once each, and notes an unknown name", () => {
    assert.deepEqual(readLiveTiers(""), { bands: [], notes: [] });
    assert.deepEqual(readLiveTiers(undefined), { bands: [], notes: [] });
    assert.deepEqual(readLiveTiers(" Easy, hard ,easy"), { bands: ["easy", "hard"], notes: [] });
    assert.deepEqual(readLiveTiers("easy,premium"), {
        bands: ["easy"],
        notes: ["liveTiers: a name that is not a band is ignored"],
    });
});

const PICK = {
    model: "github-copilot/gpt-6-luna",
    thinking: "high",
    control: "deepseek/deepseek-flash",
};

test("RULE_PICKS ships empty: stage 2 decided no band (branch wait)", () => {
    assert.deepEqual(RULE_PICKS, {});
    assert.equal(RULE_EXPERIMENT, undefined);
});

test("readRulePicks: the code's picks, router.json's valid entries over them, and a note for each invalid one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-picks-"));
    const path = join(dir, "router.json");

    try {
        assert.deepEqual(await readRulePicks(join(dir, "none.json")), { picks: {}, notes: [] });

        await writeFile(path, "{ not json");
        assert.deepEqual(await readRulePicks(path), { picks: {}, notes: [] });

        await writeFile(path, JSON.stringify({ tiers: {} }));
        assert.deepEqual(await readRulePicks(path), { picks: {}, notes: [] }, "no ruleV1");

        await writeFile(
            path,
            JSON.stringify({
                ruleV1: {
                    experiment: "T1064-easy-1",
                    picks: {
                        easy: PICK,
                        medium: { ...PICK, thinking: "very" },
                        hard: { model: "acme/x", thinking: "high" },
                        premium: PICK,
                    },
                },
            }),
        );
        assert.deepEqual(await readRulePicks(path), {
            picks: { easy: PICK },
            experiment: "T1064-easy-1",
            notes: [
                "router.json: ruleV1.picks.medium is not valid, ignored",
                "router.json: ruleV1.picks.hard is not valid, ignored",
                "router.json: a ruleV1.picks entry that is not a band is ignored",
            ],
        });

        await writeFile(path, JSON.stringify({ ruleV1: { picks: [], experiment: "a b" } }));
        assert.deepEqual(await readRulePicks(path), {
            picks: {},
            notes: [
                "router.json: ruleV1.experiment is not valid, ignored",
                "router.json: ruleV1.picks is not an object, ignored",
            ],
        });

        await writeFile(path, JSON.stringify({ ruleV1: "on" }));
        assert.deepEqual(await readRulePicks(path), {
            picks: {},
            notes: ["router.json: ruleV1 is not an object, ignored"],
        });

        // A file with only ruleV1 keeps the default tiers, with no note.
        await writeFile(path, JSON.stringify({ ruleV1: { picks: { easy: PICK } } }));
        assert.deepEqual(await readTiers(path), { tiers: DEFAULT_TIERS, notes: [] });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("assignArm: arm A gets the pick and its thinking, arm B the control; an unusable model falls back", () => {
    const all = () => true;

    assert.deepEqual(assignArm(PICK, "A", all), {
        assigned: PICK.model,
        assignedThinking: "high",
        notes: [],
    });
    assert.deepEqual(assignArm(PICK, "B", all), { assigned: PICK.control, notes: [] });
    assert.deepEqual(
        assignArm(PICK, "A", (model) => model === PICK.control),
        {
            assigned: PICK.control,
            notes: [`${PICK.model} cannot be used now: the control instead`],
        },
        "an unusable pick: the control, with no thinking",
    );
    assert.deepEqual(
        assignArm(PICK, "A", () => false),
        {
            notes: [
                `${PICK.model} cannot be used now: the control instead`,
                `${PICK.control} cannot be used now: no assignment`,
            ],
        },
    );
    assert.deepEqual(
        assignArm(PICK, "B", () => false),
        {
            notes: [`${PICK.control} cannot be used now: no assignment`],
        },
    );
});

test("routeLine says the band, the pick, the arm and the assignment of a v1 route", () => {
    const base = {
        mode: "assign" as const,
        status: "shadow" as const,
        kind: "implement",
        demand: 2,
        tier: "easy" as const,
        tierRule: "v1" as const,
        reason: "",
        at: 0,
    };

    assert.equal(
        routeLine(base),
        "Route: v1 easy: no pick (implement 2.0); today's policy; shadow",
    );
    assert.equal(
        routeLine({ ...base, model: PICK.model, thinking: "high" }),
        "Route: v1 easy: github-copilot/gpt-6-luna, thinking high (implement 2.0); shadow, not applied",
    );
    assert.equal(
        routeLine({ ...base, arm: "B" }),
        "Route: v1 easy: arm B, no usable model (implement 2.0); today's policy",
    );

    const long = routeLine({
        ...base,
        status: "assigned",
        tier: "medium",
        arm: "A",
        assigned: "github-copilot/claude-sonnet-5.5-preview-xx",
        assignedThinking: "xhigh",
    });

    assert.equal(
        long,
        "Route: v1 medium: arm A assigned github-copilot/claude-sonnet-5.5-preview-xx, thinking xhigh (implement 2.0); assign",
    );
    assert.ok(long.length <= 120, "the desk event holds it whole");
    assert.equal(
        routeLine({ ...base, status: "assigned", arm: "B", assigned: PICK.control }),
        "Route: v1 easy: arm B assigned deepseek/deepseek-flash (implement 2.0); assign",
    );
});

/** The thread ids of each arm, by the arm rule itself. */
const ARM_A = Array.from({ length: 40 }, (_, n) => `T${String(n + 1)}`).find(
    (id) => armOf(id) === "A",
)!;
const ARM_B = Array.from({ length: 40 }, (_, n) => `T${String(n + 1)}`).find(
    (id) => armOf(id) === "B",
)!;

/**
 * An eligible shift of a bench repository (a risk paths list that the brief does not match), the router's files in a
 * temporary folder, and the router module in `settings`. `routerJson` is `router.json`; `rule` names another rule file.
 */
async function ruleRouter(
    settings: Record<string, unknown>,
    options: { routerJson?: unknown; rule?: string; allowed?: string[] } = {},
) {
    const dir = await mkdtemp(join(tmpdir(), "router-v1-"));
    const repo = await repoWith({
        "go.mod": "module x",
        ".github/risk-paths.json": RISK_LIST,
        "store.go": "",
    });

    process.env.PI_POCKET_TEAM_SSH_CONFIG = join(dir, "no-ssh-config");
    process.env.PI_POCKET_TEAM_ROUTER_CONFIG = join(dir, "router.json");

    if (options.rule !== undefined) {
        process.env.PI_POCKET_TEAM_ROUTER_RULE = options.rule;
    }

    if (options.routerJson !== undefined) {
        await writeFile(join(dir, "router.json"), JSON.stringify(options.routerJson));
    }

    const fetchStub = stubFetch(async () => new Response(JSON.stringify(ANSWER)));
    const router = loadRouter(
        { typesafeApiKey: KEY, ...settings },
        options.allowed ?? [PICK.model, PICK.control, "github-copilot/claude-sonnet-5.5"],
    );
    const request = {
        brief: "Change store.go in bketelsen/pi-pocket-team\n\nStop when: the tests pass",
        startAt: NOON,
        profileModel: "github-copilot/claude-opus-5.5",
        repoDirs: [repo.dir],
        roster: ["bketelsen/pi-pocket-team", "frostyard/test"],
        shift: true,
        repo: "bketelsen/pi-pocket-team",
        threadId: ARM_A,
    };

    return {
        dir,
        router,
        request,
        fetchStub,
        done: async () => {
            fetchStub.restore();
            router.dispose();
            delete process.env.PI_POCKET_TEAM_SSH_CONFIG;
            delete process.env.PI_POCKET_TEAM_ROUTER_CONFIG;
            delete process.env.PI_POCKET_TEAM_ROUTER_RULE;
            await repo.done();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

const RULE = JSON.parse(readFileSync(join(import.meta.dirname, "router-rule-v1.json"), "utf8"));
const ALL_PICKS = { ruleV1: { picks: { easy: PICK, medium: PICK, hard: PICK } } };

test("an eligible shift records tierRule v1 and its band; with no pick it assigns nothing and suggests nothing", async () => {
    const setup = await ruleRouter({ mode: "assign", liveTiers: "easy,medium,hard" });

    try {
        const route = await setup.router.api.route(setup.request);

        assert.equal(route.tierRule, "v1");
        assert.equal(route.tier, predictBand(RULE, route.features!));
        assert.ok((BANDS as readonly string[]).includes(route.tier!));
        assert.equal(route.features?.riskPathNamed, false);
        assert.equal(route.status, "shadow", "no pick: no assignment");
        assert.equal(route.model, undefined, "no pick: no suggestion");
        assert.equal(route.arm, undefined);
        assert.equal(route.assigned, undefined);
        assert.deepEqual(route.notes, [`no pick for ${route.tier}: no assignment`]);
        assert.equal(route.profileModel, "github-copilot/claude-opus-5.5");
        assert.match(route.line, /^Route: v1 (easy|medium|hard): no pick/);
        assert.equal(setup.fetchStub.calls.length, 1, "1 Jev call");
    } finally {
        await setup.done();
    }
});

test("a delegation outside the bench's population keeps today's route: no tierRule", async () => {
    const setup = await ruleRouter(
        { mode: "assign", liveTiers: "easy,medium,hard" },
        { routerJson: ALL_PICKS },
    );

    try {
        const cases: [string, Record<string, unknown>][] = [
            ["no shift", { shift: false }],
            ["a named worker", { worker: PICK.control }],
            ["not a bench repository", { repo: "frostyard/test" }],
            ["no repository", { repo: undefined }],
            [
                "a repository outside the bench in the brief",
                { brief: "Change store.go in frostyard/test\n\nStop when: done" },
            ],
            ["a risk path", { brief: "Change model-router.ts\n\nStop when: done" }],
            ["no risk paths list", { repoDirs: [] }],
        ];

        for (const [name, change] of cases) {
            const route = await setup.router.api.route({ ...setup.request, ...change });

            assert.equal(route.tierRule, undefined, name);
            assert.equal(route.arm, undefined, name);
            assert.equal(route.assigned, undefined, name);
            assert.equal(route.status, "shadow", name);
            assert.ok(
                (TIERS as readonly string[]).includes(route.tier!),
                `${name}: the 4 tiers as before`,
            );
        }

        // A kind outside the bench's: Jev says review.
        setup.fetchStub.restore();
        const review = stubFetch(
            async () =>
                new Response(
                    JSON.stringify({
                        answers: { ...ANSWER.answers, task_kind: { choice: "review" } },
                    }),
                ),
        );

        try {
            const route = await setup.router.api.route(setup.request);

            assert.equal(route.tierRule, undefined, "kind review");
            assert.equal(route.assigned, undefined);
        } finally {
            review.restore();
        }
    } finally {
        await setup.done();
    }
});

test("an absent or invalid rule file: no band, no assignment, and the route says why", async () => {
    for (const [name, contents, why] of [
        ["absent", undefined, /router-rule-v1\.json is absent: no band, no assignment/],
        ["invalid", "{}", /router-rule-v1\.json is not a valid rule: .*: no band, no assignment/],
    ] as const) {
        const folder = await mkdtemp(join(tmpdir(), "router-rule-file-"));
        const rule = join(folder, "router-rule-v1.json");

        if (contents !== undefined) {
            await writeFile(rule, contents);
        }

        const setup = await ruleRouter(
            { mode: "assign", liveTiers: "easy,medium,hard" },
            { routerJson: ALL_PICKS, rule },
        );

        try {
            const route = await setup.router.api.route(setup.request);

            assert.equal(route.tierRule, undefined, name);
            assert.equal(route.arm, undefined, name);
            assert.equal(route.assigned, undefined, name);
            assert.equal(route.status, "shadow", name);
            assert.ok(
                route.notes?.some((note) => why.test(note)),
                `${name}: ${JSON.stringify(route.notes)}`,
            );
        } finally {
            await setup.done();
            await rm(folder, { recursive: true, force: true });
        }
    }
});

test("assign: a router.json pick on a live band gives arm A the pick at its thinking, and arm B the control", async () => {
    const setup = await ruleRouter(
        { mode: "assign", liveTiers: "easy,medium,hard" },
        { routerJson: { ruleV1: { ...ALL_PICKS.ruleV1, experiment: "T1064-live-1" } } },
    );

    try {
        const a = await setup.router.api.route(setup.request);

        assert.equal(a.mode, "assign");
        assert.equal(a.status, "assigned");
        assert.equal(a.tierRule, "v1");
        assert.equal(a.arm, "A");
        assert.equal(a.assigned, PICK.model);
        assert.equal(a.assignedThinking, "high");
        assert.equal(a.model, PICK.model, "the band's pick");
        assert.equal(a.thinking, "high");
        assert.equal(a.experiment, "T1064-live-1");
        assert.equal(a.reason, "assign: arm A");
        assert.equal(a.profileModel, "github-copilot/claude-opus-5.5", "the profile model stays");
        assert.match(a.line, /arm A assigned github-copilot\/gpt-6-luna, thinking high/);

        const b = await setup.router.api.route({ ...setup.request, threadId: ARM_B });

        assert.equal(b.status, "assigned");
        assert.equal(b.arm, "B");
        assert.equal(b.assigned, PICK.control);
        assert.equal(b.assignedThinking, undefined, "the control runs with no thinking level");
        assert.equal("assignedThinking" in b, false);

        // A replay of the same thread asks the router again only without a memo: the arm is the same.
        const again = await setup.router.api.route(setup.request);

        assert.equal(again.arm, a.arm);
        assert.equal(again.assigned, a.assigned);
    } finally {
        await setup.done();
    }
});

test("assign: only a live band, only with a thread, and an unknown live tier is noted", async () => {
    const setup = await ruleRouter({ mode: "assign" }, { routerJson: ALL_PICKS });

    try {
        const first = await setup.router.api.route(setup.request);
        const band = first.tier!;

        assert.equal(first.arm, undefined, "liveTiers empty: no band is live");
        assert.equal(first.status, "shadow");
        assert.equal(first.model, PICK.model, "the pick is a suggestion");
        assert.match(first.line, /shadow, not applied$/);
        setup.router.dispose();

        const others = BANDS.filter((each) => each !== band).join(",");
        const notLive = loadRouter(
            { mode: "assign", typesafeApiKey: KEY, liveTiers: `${others},premium` },
            [PICK.model, PICK.control],
        );

        try {
            const route = await notLive.api.route(setup.request);

            assert.equal(route.arm, undefined, "another band is live, not this one");
            assert.ok(route.notes?.includes("liveTiers: a name that is not a band is ignored"));
        } finally {
            notLive.dispose();
        }

        const live = loadRouter({ mode: "assign", typesafeApiKey: KEY, liveTiers: band }, [
            PICK.model,
            PICK.control,
        ]);

        try {
            const { threadId: _drop, ...noThread } = setup.request;
            const route = await live.api.route(noThread);

            assert.equal(route.arm, undefined);
            assert.equal(route.assigned, undefined);
            assert.ok(route.notes?.includes("no desk thread: no arm, no assignment"));
        } finally {
            live.dispose();
        }

        const shadow = loadRouter({ mode: "shadow", typesafeApiKey: KEY, liveTiers: band }, [
            PICK.model,
            PICK.control,
        ]);

        try {
            const route = await shadow.api.route(setup.request);

            assert.equal(route.mode, "shadow");
            assert.equal(route.tierRule, "v1");
            assert.equal(route.arm, undefined, "shadow assigns nothing");
            assert.equal(route.assigned, undefined);
        } finally {
            shadow.dispose();
        }
    } finally {
        await setup.done();
    }
});

test("assign: an unusable pick falls back to the control, then to no assignment", async () => {
    const setup = await ruleRouter(
        { mode: "assign", liveTiers: "easy,medium,hard" },
        { routerJson: ALL_PICKS, allowed: [PICK.control] },
    );

    try {
        const route = await setup.router.api.route(setup.request);

        assert.equal(route.status, "assigned");
        assert.equal(route.arm, "A");
        assert.equal(route.assigned, PICK.control, "the pick is not allowed: the control");
        assert.equal(route.assignedThinking, undefined);
        assert.ok(route.notes?.includes(`${PICK.model} cannot be used now: the control instead`));

        // DeepSeek in its peak hours cannot be used either: nothing is left.
        const peak = await setup.router.api.route({ ...setup.request, startAt: PEAK });

        assert.equal(peak.status, "shadow");
        assert.equal(peak.arm, "A", "the arm stays on the record");
        assert.equal(peak.assigned, undefined);
        assert.equal(peak.reason, "assign: no usable model");
        assert.match(peak.line, /arm A, no usable model/);
    } finally {
        await setup.done();
    }
});

test("no field, note or line of a route holds the TypeSafe key, from the settings or router.json, in any case", async () => {
    // The key pasted by mistake: in liveTiers (lowercase too), as a pick's band, model and control, and as the experiment.
    const setup = await ruleRouter(
        { mode: "assign", liveTiers: `easy,medium,hard,${KEY.toUpperCase()},${KEY.toLowerCase()}` },
        {
            routerJson: {
                ruleV1: {
                    experiment: KEY,
                    picks: {
                        easy: { model: `acme/${KEY}`, thinking: "high", control: `acme/c-${KEY}` },
                        medium: {
                            model: `acme/${KEY}`,
                            thinking: "high",
                            control: `acme/c-${KEY}`,
                        },
                        hard: { model: `acme/${KEY}`, thinking: "high", control: `acme/c-${KEY}` },
                        [KEY]: PICK,
                    },
                },
            },
            allowed: [`acme/${KEY}`, `acme/c-${KEY}`],
        },
    );

    try {
        for (const threadId of [ARM_A, ARM_B]) {
            const route = await setup.router.api.route({ ...setup.request, threadId });
            const raw = JSON.stringify(route).toLowerCase();

            assert.equal(route.status, "assigned", "the assignment still happens");
            assert.equal(
                raw.includes(KEY.toLowerCase()),
                false,
                `the raw route of arm ${route.arm}`,
            );
            assert.match(route.assigned!, /^acme\/(c-)?\[TYPESAFE_API_KEY\]$/);
            assert.equal(route.experiment, "[TYPESAFE_API_KEY]");
        }
    } finally {
        await setup.done();
    }
});
