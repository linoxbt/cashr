// Unified Address decoding (ZIP 316). Mirrors api/unlisted/ua.py.
// Lets the RSVP page refuse a refund address without an Orchard receiver
// before the attendee pays, without sending the address anywhere.
import { blake2b } from "@noble/hashes/blake2.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc830a3;
const enc = new TextEncoder();

export type Receivers = Partial<Record<"p2pkh" | "p2sh" | "sapling" | "orchard", Uint8Array>>;
const NAMES: Record<number, keyof Receivers> = { 0: "p2pkh", 1: "p2sh", 2: "sapling", 3: "orchard" };

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ gen[i]) >>> 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}

function from5to8(data: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((x, i) => x ^ b[i]);
}

function personal(tag: string, extra: number[]): Uint8Array {
  return Uint8Array.from([...enc.encode(tag), ...extra]);
}

function H(i: number, u: Uint8Array, len: number): Uint8Array {
  return blake2b(u, { dkLen: len, personalization: personal("UA_F4Jumble_H", [i, 0, 0]) });
}

function G(i: number, u: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let j = 0, off = 0; off < len; j++, off += 64) {
    const block = blake2b(u, { dkLen: 64, personalization: personal("UA_F4Jumble_G", [i, j & 0xff, j >> 8]) });
    out.set(block.subarray(0, Math.min(64, len - off)), off);
  }
  return out;
}

export function f4jumbleInv(m: Uint8Array): Uint8Array {
  const lL = Math.min(64, Math.floor(m.length / 2));
  const lR = m.length - lL;
  const c = m.subarray(0, lL);
  const d = m.subarray(lL);
  const y = xor(c, H(1, d, lL));
  const x = xor(d, G(1, y, lR));
  const a = xor(y, H(0, x, lL));
  const b = xor(x, G(0, a, lR));
  const out = new Uint8Array(m.length);
  out.set(a);
  out.set(b, lL);
  return out;
}

export function decodeUnified(address: string, network: string): Receivers | null {
  const a = address.trim();
  const expectedHrp = network === "main" ? "u" : "utest";
  if (a !== a.toLowerCase()) return null;
  const sep = a.lastIndexOf("1");
  if (a.slice(0, sep) !== expectedHrp) return null;
  const values: number[] = [];
  for (const ch of a.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    values.push(v);
  }
  if (values.length < 6 || polymod([...hrpExpand(expectedHrp), ...values]) !== BECH32M) return null;
  const jumbled = from5to8(values.slice(0, -6));
  if (!jumbled || jumbled.length < 48) return null;
  const raw = f4jumbleInv(jumbled);
  const pad = new Uint8Array(16);
  pad.set(enc.encode(expectedHrp));
  if (!raw.subarray(raw.length - 16).every((b, i) => b === pad[i])) return null;
  const body = raw.subarray(0, raw.length - 16);
  const receivers: Receivers = {};
  let pos = 0;
  let last = -1;
  while (pos < body.length) {
    const type = body[pos++];
    const len = body[pos++];
    // Receivers Unlisted cares about have single-byte typecodes and lengths.
    if (type === undefined || len === undefined || type >= 0xfd || len >= 0xfd || type <= last || pos + len > body.length) {
      return null;
    }
    last = type;
    const name = NAMES[type];
    if (name) receivers[name] = body.slice(pos, pos + len);
    pos += len;
  }
  return receivers.orchard || receivers.sapling ? receivers : null;
}

export function hasOrchardReceiver(address: string, network: string): boolean {
  return Boolean(decodeUnified(address, network)?.orchard);
}
