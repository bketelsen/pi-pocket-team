// The attempt's settlement under faults: a paid try's usage reaches the settlement before any cleanup that can throw,
// and a failure while Pi's usage is unknown settles at the full cap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { prepare, runAttempt } from "./lib/runner.mjs";
import { acquireSlots } from "./lib/slots.mjs";
import {
    FAKE_BWRAP,
    PRICED,
    fixtureArgs,
    fixtureTask,
    makeFixture,
    setBudget,
    testEnv,
    writeManifest,
} from "./fixtures/helpers.mjs";

let fixture;
let manifest;

before(async () => {
    fixture = makeFixture();
    manifest = writeManifest(fixture, [
        fixtureTask(fixture, "release-throws", { name: "ok" }),
        fixtureTask(fixture, "usage-unknown", { name: "ok" }),
    ]);
    await setBudget(fixture, 100);
});

after(() => rm(fixture.root, { recursive: true, force: true }));

/** A runner context of the fixture, as `main` makes it, with fault hooks. */
async function context(task, hooks, extra = []) {
    const ctx = await prepare(
        [...fixtureArgs(fixture, manifest), "--task", task, "--model", PRICED, ...extra],
        testEnv(fixture),
    );

    ctx.bwrap = FAKE_BWRAP;
    ctx.hooks = hooks;

    return ctx;
}

/** The settled entries of 1 task. */
const entriesOf = (task) =>
    JSON.parse(readFileSync(join(fixture.data, "spend.json"), "utf8")).entries.filter(
        (entry) => entry.task === task,
    );

test("slot release throws after a paid try: the settled entry keeps its cost and tokens", async () => {
    const ctx = await context("release-throws", {
        acquireSlots: async (...args) => {
            const slots = await acquireSlots(...args);

            return {
                ...slots,
                release: async () => {
                    await slots.release();

                    throw new Error("injected slot release failure");
                },
            };
        },
    });

    await assert.rejects(
        runAttempt(ctx, () => {}),
        /injected slot release failure/,
    );
    assert.deepEqual(
        entriesOf("release-throws").map((e) => [e.cost, e.tokens, e.tries, e.usageUnknown]),
        [[0.01, 150, 1, undefined]],
    );
});

test("a failure while Pi's usage is unknown settles at the full cap", async () => {
    const ctx = await context(
        "usage-unknown",
        {
            runStreamed: async () => {
                throw new Error("injected failure during the Pi run");
            },
        },
        ["--cost-limit", "0.5"],
    );

    await assert.rejects(
        runAttempt(ctx, () => {}),
        /injected failure during the Pi run/,
    );
    assert.deepEqual(
        entriesOf("usage-unknown").map((e) => [e.cost, e.tries, e.usageUnknown]),
        [[0.5, 1, true]],
    );
});
