import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { expectedOf, newTaskKey, waitingCount } from "./team-web/index.js";

test("task keys work with the crypto API available on plain-HTTP LAN pages", () => {
    const lanCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
    const first = newTaskKey(lanCrypto);
    const second = newTaskKey(lanCrypto);

    assert.equal(lanCrypto.randomUUID, undefined);
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.match(second, /^[a-f0-9]{32}$/);
    assert.notEqual(first, second);
});

test("the owner's approval carries what they saw, and waiting lessons count", () => {
    const pending = { id: "a", text: "New.", pending: true };
    const change = { id: "b", text: "Old.", proposal: { text: "New." } };
    const forget = { id: "c", text: "Old.", proposal: { forget: true } };
    const inForce = { id: "d", text: "Kept." };

    assert.deepEqual(expectedOf(pending), { text: "New." });
    assert.deepEqual(expectedOf(change), { text: "New." });
    assert.deepEqual(expectedOf(forget), { forget: true });
    assert.deepEqual(expectedOf(inForce), { text: "Kept." });
    assert.equal(waitingCount([pending, change, forget, inForce]), 3);
    assert.equal(waitingCount(undefined), 0);
});
