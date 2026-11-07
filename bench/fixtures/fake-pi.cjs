#!/usr/bin/env node
// A fake `pi` for the bench tests: it prints JSON events like Pi's `--mode json` stream. The scenario is a line
// `SCENARIO {json}` in the prompt (the last argument, or the file of an `@file` argument and the message after it, as
// a judge gets them); `BENCH_TRY` is the try number. It never calls a model.
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");

const fileArg = process.argv.slice(2).find((arg) => arg.startsWith("@"));
const lastArg = process.argv.at(-1) ?? "";
const prompt = fileArg
    ? `${readFileSync(fileArg.slice(1), "utf8")}\n${lastArg.startsWith("@") ? "" : lastArg}`
    : lastArg;
const line = prompt.split("\n").find((l) => l.startsWith("SCENARIO "));
const scenario = line ? JSON.parse(line.slice("SCENARIO ".length)) : { name: "ok" };
const tryNo = Number(process.env.BENCH_TRY);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = (input, output, cost) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistantStart = () =>
    emit({
        type: "message_start",
        message: { role: "assistant", content: [], stopReason: "pending" },
    });
const update = (u) =>
    emit({
        type: "message_update",
        usage: u,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
    });
const assistantEnd = (u, stopReason) =>
    emit({
        type: "message_end",
        message: { role: "assistant", content: [], usage: u, stopReason },
    });

const finish = () => {
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
};

const whole = (u, stopReason = "stop") => {
    assistantStart();
    update(u);
    assistantEnd(u, stopReason);
    finish();
};

// A child in the same process group, with a unique argument the test looks for.
const background = () => {
    const child = spawn("sleep", [scenario.marker], { stdio: "ignore" });

    writeFileSync("bg.pid", String(child.pid));
};

const hang = () => setInterval(() => {}, 60_000);

emit({
    type: "session",
    version: 3,
    id: "fake",
    timestamp: new Date(0).toISOString(),
    cwd: process.cwd(),
});
emit({ type: "agent_start" });
emit({ type: "message_start", message: { role: "user", content: "brief" } });
emit({ type: "message_end", message: { role: "user", content: "brief" } });

switch (scenario.name) {
    case "ok":
        writeFileSync("pi-ran.txt", `try ${tryNo}\n`);
        whole(usage(100, 50, 0.01));
        break;

    case "slow-ok": {
        // Real gaps between the events, so the stream timing has a rate.
        const u = usage(100, 50, 0);

        assistantStart();
        setTimeout(() => {
            update(u);
            setTimeout(() => {
                assistantEnd(u, "stop");
                finish();
            }, 50);
        }, 20);
        break;
    }

    case "compaction":
        // Automatic compaction: a model call whose usage comes only in compaction_end.
        emit({ type: "compaction_start", reason: "threshold" });
        emit({
            type: "compaction_end",
            reason: "threshold",
            result: {
                summary: "s",
                firstKeptEntryId: "e",
                tokensBefore: 1,
                usage: usage(1000, 200, 0.05),
            },
            aborted: false,
            willRetry: false,
        });
        whole(usage(100, 50, 0.01));
        break;

    case "gate": {
        // Tell the test that Pi runs (a host path: only behind the fake bwrap), then wait for its gate file.
        writeFileSync(scenario.started, String(process.pid));
        assistantStart();
        const timer = setInterval(() => {
            if (existsSync(scenario.gate)) {
                clearInterval(timer);
                const u = usage(100, 50, 0.01);

                assistantEnd(u, "stop");
                finish();
            }
        }, 20);

        break;
    }

    case "cost":
        background();
        assistantStart();

        for (const cost of [0.1, 0.3, 0.9, 1.5]) {
            update(usage(1000, 100, cost));
        }

        hang();
        break;
    case "hang":
        background();
        assistantStart();
        update(usage(10, 1, 0.001));
        hang();
        break;
    case "error-then-ok":
        if (tryNo === 1) {
            writeFileSync("try1.txt", "written on try 1\n");
            whole(usage(100, 50, 0.01), "error");
        } else {
            writeFileSync("fresh.json", JSON.stringify({ try1Present: existsSync("try1.txt") }));
            whole(usage(100, 50, 0.01));
        }

        break;
    case "always-error":
        whole(usage(100, 50, 0.01), "error");
        break;
    case "no-final":
        assistantStart();
        update(usage(10, 5, 0.002));
        break;

    case "probe": {
        const run = (cmd, args) => {
            const r = spawnSync(cmd, args, { encoding: "utf8" });

            return {
                status: r.status,
                error: r.error?.code ?? null,
                stdout: (r.stdout ?? "").slice(0, 300),
                stderr: (r.stderr ?? "").slice(0, 300),
            };
        };

        writeFileSync(
            "probe.json",
            JSON.stringify({
                cat: run("cat", [scenario.hostFile]),
                curl: run("curl", ["-sS", "-m", "5", "https://github.com"]),
                varHome: existsSync("/var/home"),
                hostHome: existsSync(scenario.hostHome),
                envKeys: Object.keys(process.env),
                pid1: existsSync("/proc/1/cmdline"),
                user: run("node", ["-e", "console.log(require('os').userInfo().username)"]),
            }),
        );
        whole(usage(100, 50, 0.01));
        break;
    }

    case "judge": {
        // A judge: the answer of try `BENCH_TRY` for this `--model` (the last answer repeats), as assistant text.
        const model = process.argv[process.argv.indexOf("--model") + 1].replace(/:high$/, "");
        const answers = scenario.answers[model] ?? scenario.answers.default ?? [];
        const text = answers[Math.min(tryNo, answers.length) - 1] ?? "";
        const u = usage(1000, 100, scenario.cost ?? 0.02);

        if (scenario.log) {
            appendFileSync(scenario.log, `${model} ${tryNo}\n`);
        }

        assistantStart();
        update(u);
        emit({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text }],
                usage: u,
                stopReason: "stop",
            },
        });
        finish();
        break;
    }

    default:
        process.stderr.write(`unknown scenario ${scenario.name}\n`);
        process.exit(9);
}
