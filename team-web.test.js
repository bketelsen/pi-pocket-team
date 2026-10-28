import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import {
    expectedOf,
    identityStatus,
    newTaskKey,
    SUPERVISOR_ICON,
    SUPERVISOR_NAME,
    supervisorAction,
    supervisorRail,
    waitingCount,
} from "./team-web/index.js";

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

test("the status line shows the session's identity, and nothing without one", () => {
    assert.equal(identityStatus(null), null);
    assert.equal(identityStatus({ identity: null, linked: [] }), null);
    assert.deepEqual(identityStatus({ identity: { id: "murbella", name: "Murbella" } }), {
        id: "identity",
        text: "Murbella",
        title: "Team identity: Murbella. Tap to change it.",
        page: "team",
    });
});

test("the supervisor button: its name, its badge of open asks, and a tap that opens only a bound session", () => {
    const door = { found: true, conversationId: 42, title: "Desk", name: "Odrade", asks: 3 };

    assert.deepEqual(supervisorRail(door), { title: "Odrade", badge: 3 });
    assert.deepEqual(supervisorRail({ ...door, asks: 0 }), { title: "Odrade", badge: null });
    assert.deepEqual(supervisorRail({ found: false, reason: "none", text: "No." }), {
        title: SUPERVISOR_NAME,
        badge: null,
    });
    assert.deepEqual(supervisorRail(null), { title: SUPERVISOR_NAME, badge: null });

    assert.deepEqual(supervisorAction(door), { open: 42 });
    assert.deepEqual(supervisorAction({ ...door, archived: true }), {
        open: 42,
        notice: ["warning", 'Odrade\'s session "Desk" is archived.'],
    });
    // No bound session: a notice, and nothing opens.
    const none = supervisorAction({ found: false, reason: "none", text: "No session is bound." });

    assert.deepEqual(none, { notice: ["info", "No session is bound."] });
    assert.equal("open" in none, false);
});

test("the supervisor icon is 1 stroked path in the 24 by 24 box", () => {
    assert.match(SUPERVISOR_ICON, /^M[0-9 .,MLCHVZmlchvz-]+$/);

    for (const number of SUPERVISOR_ICON.match(/-?[0-9]*\.?[0-9]+/g)) {
        assert(Math.abs(Number(number)) <= 24, `${number} fits the box`);
    }
});
