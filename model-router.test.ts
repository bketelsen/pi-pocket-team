// The model router's pure parts: the masking, the Jev body and answer, the decision, the tiers file, the record's line,
// and the one HTTP call (with a fake fetch: no network). Nothing here starts a server or reads a real file.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    classify,
    decide,
    inDeepseekPeak,
    jevBody,
    maskBrief,
    parseAnalysis,
    readTiers,
    routeLine,
    sshHostNames,
} from "./model-router.ts";
import createModelRouter from "./model-router.ts";
import type { Host, Web } from "./_pocket.d.ts";

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
