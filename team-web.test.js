import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { newTaskKey } from "./team-web/index.js";

test("task keys work with the crypto API available on plain-HTTP LAN pages", () => {
    const lanCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
    const first = newTaskKey(lanCrypto);
    const second = newTaskKey(lanCrypto);

    assert.equal(lanCrypto.randomUUID, undefined);
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.match(second, /^[a-f0-9]{32}$/);
    assert.notEqual(first, second);
});
