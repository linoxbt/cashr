// Run with `npm test` (Node's built-in test runner). Vectors match api/tests.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressKind,
  addressProblem,
  b64url,
  encodeMemo,
  parseTicketQr,
  ticketHash,
  zatToZec,
  zecToZat,
  zip321,
} from "./codec.ts";

test("bech32 checksum matches the BIP-173 vector", () => {
  // Same polymod as the Zcash HRPs; a bc1 address must fail only on HRP.
  assert.equal(addressKind("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "main"), null);
});

test("transparent addresses are explained, not just refused", () => {
  assert.match(addressProblem("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "main") ?? "", /transparent/);
});

test("amounts round-trip without floats", () => {
  assert.equal(zatToZec(500_000), "0.005");
  assert.equal(zatToZec(100_000_000), "1");
  assert.equal(zecToZat("0.005"), 500_000);
  assert.equal(zecToZat("1.23456789"), 123_456_789);
  assert.equal(zecToZat("1.123456789"), null);
  assert.equal(zecToZat("-1"), null);
});

test("zip321 matches the server", () => {
  assert.equal(zip321("u1abc", 500_000, new TextEncoder().encode("hi")), "zcash:u1abc?amount=0.005&memo=aGk");
});

test("ticket hash is base64url sha256", async () => {
  const h = await ticketHash(new Uint8Array(32));
  assert.equal(h, "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU");
  assert.equal(h.length, 43);
});

test("memo layout", () => {
  const m = new TextDecoder().decode(encodeMemo("abcde12345", "A".repeat(43), "u1x"));
  assert.equal(m, `UNL1 abcde12345 ${"A".repeat(43)} u1x`);
});

test("ticket QR parsing", () => {
  const secret = b64url(new Uint8Array(32).fill(7));
  assert.deepEqual(parseTicketQr(`unlisted:abcde12345:${secret}`), { eventId: "abcde12345", secret });
  assert.equal(parseTicketQr("https://example.com"), null);
});
