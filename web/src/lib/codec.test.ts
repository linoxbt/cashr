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
import { decodeUnified } from "./ua.ts";

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
  assert.equal(m, `CSH1 abcde12345 ${"A".repeat(43)} u1x`);
});

test("ticket QR parsing", () => {
  const secret = b64url(new Uint8Array(32).fill(7));
  assert.deepEqual(parseTicketQr(`cashr:abcde12345:${secret}`), { eventId: "abcde12345", secret });
  assert.equal(parseTicketQr("https://example.com"), null);
});

// Real mainnet addresses produced by cashr-wallet (librustzcash); same as api/tests/test_ua.py.
const ORCHARD_ONLY = "u17j7e5kk4uzh698uajv4lah3mtt2x7jyewk3ya5tjvhjzp6yc5x260svm66uveezd93htyy3u0pyg80gpttfujfvj5pvlcqhngskrvpyd";
const SAPLING_ONLY = "u1r4epe0uuztny46hl3pkrdv4tqlxxu59jcvj3wtnrsljt4glvvzfrumu8d827h8vgxf7pzkjenye60k392eeegpzdx5y7r3vpaysausau";
const BOTH =
  "u13sza6jr067ydyrkr2s40qsyqaw59aazmjvjrnzn9sktk9tg6fpeng99rzy78pasda3wp0vf5sfhzhq2jfz6l96006r4lg4vn6jg4dckez75a5a0" +
  "gukew2mnhh7vcgpakz9hzraa9xvf490uryqqku6thqltl28kh32qgah0y4uzyqt8e";
const BOTH_ORCHARD = "u1qf62h58pwerw7q5d3ga20ld2rtkj9laq88vt70dp29pc26jglj5mz88lzqj5anqweyfrxq04y2rjfv5n8g8ge590pe0dm8zxp5rtmnve";

test("unified addresses decode to their receivers", () => {
  assert.deepEqual(Object.keys(decodeUnified(ORCHARD_ONLY, "main") ?? {}), ["orchard"]);
  assert.deepEqual(Object.keys(decodeUnified(SAPLING_ONLY, "main") ?? {}), ["sapling"]);
  const both = decodeUnified(BOTH, "main");
  assert.deepEqual(Object.keys(both ?? {}).sort(), ["orchard", "sapling"]);
  assert.deepEqual(both?.orchard, decodeUnified(BOTH_ORCHARD, "main")?.orchard);
  assert.equal(decodeUnified(ORCHARD_ONLY, "test"), null);
});

test("refund addresses must carry an Orchard receiver", () => {
  assert.equal(addressProblem(ORCHARD_ONLY, "main"), null);
  assert.equal(addressProblem(BOTH, "main"), null);
  assert.match(addressProblem(SAPLING_ONLY, "main") ?? "", /Orchard/);
});

// Generated once with the Python F4Jumble/bech32m helpers (same vector in api/tests/test_ua.py): an Orchard receiver (bytes 0..42)
// followed by an unknown receiver whose typecode and length need multi-byte
// CompactSizes. Both parsers must accept it, as ZIP 316 allows.
const MULTIBYTE_UA = "u1rexdud0f8y83nem3s7shlu2edrrwhjz79r5t8mmxgf582lhlg8ss89qera4wxq6pv7s60254sleueepr9eh6ggyjlrswy4tkufw3ewp3ahsmw907u3qapjtntp522ga06jddxkc9t6gs777z2s649dwn2yq5vz8phqxdgmjs5ad36snsdurw0zeumypemrnny99td58vj29ujr4p078mgjwypczx39kt430h9d6x7hvwjjkqssh7tlu2g2ura2xu4jls0lehhhmr3x4p2t9xthvvfsjrxj8dnyhhtr63eu7qafgptwzx726tggmvmd7sa23q20yhamj36zclch8nnnjacrqm34jkwvkfsgclundfn5cgu3y260hezpvrpk522cd8489crwfcs8sa52m89rnn586stng5dm46sfg4fjevjp267quptsukg2dvdhnlw2vw8m33qq567pwu5d7q0wr3aajcnhadur7gq9vjkxymt8wvlkthrap0yxvlqy33mnmx9cg3vrekku6hzd3lm2vyggp5lg7pljh4jpwk6wksx6f3rxl6cv5xjxpzs6lntm7qfrggujmk2ccp65g3f";

test("UA receivers with multi-byte CompactSizes parse like the Python side", () => {
  const r = decodeUnified(MULTIBYTE_UA, "main");
  assert.ok(r?.orchard);
  assert.deepEqual([...r.orchard], Array.from({ length: 43 }, (_, i) => i));
});

// A UA with transparent (bytes 0..19), Sapling (0..42) and Orchard (50..92)
// receivers, and its Orchard-only form: the same vector as api/tests/test_ua.py.
const UA_WITH_TRANSPARENT = "u1883eq6gafdkmysp0haxfzeqz3fgpjn5sxleva0rs56s04uyz5r6zth60s04lscad0a9pwafma6jm3pa4fqlxva279gcw5efkdsdkhru5jgza34vuknm9dlrhp6sfn9a5zluxawa4jwpk3jvxfkxrt5pnzrfjvxqvpughaljh8z9tqtkr9kqae7vuvghyu3lywfxvzxffv9ts2qzw85l";
const UA_ORCHARD_ONLY = "u1rdgxj9gscehn48q8qzsff2t8wszlasc0ldqgzkns6ctqhwd4ea6nsfjr000ggtr3c0em2pz9jankcrv9luusr0t69hgnctswxcplaffy";

test("only the Orchard receiver is kept, byte-identical to the Python side", async () => {
  const { orchardOnly } = await import("./ua.ts");
  assert.equal(orchardOnly(UA_WITH_TRANSPARENT, "main"), UA_ORCHARD_ONLY);
  assert.deepEqual(Object.keys(decodeUnified(UA_ORCHARD_ONLY, "main") ?? {}), ["orchard"]);
});
