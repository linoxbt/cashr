// Wire formats. Must match api/unlisted/codec.py exactly; see docs/PROTOCOL.md.
import { hasOrchardReceiver } from "./ua.ts";

export const MEMO_TAG = "UNL1";
export const ZAT_PER_ZEC = 100_000_000;
export const TICKET_QR_PREFIX = "unlisted";

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function newSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function ticketHash(secret: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", secret as BufferSource);
  return b64url(new Uint8Array(digest));
}

export function encodeMemo(eventId: string, hash: string, refundAddress: string): Uint8Array {
  const raw = enc.encode(`${MEMO_TAG} ${eventId} ${hash} ${refundAddress}`);
  if (raw.length > 512) throw new Error("Memo too long");
  return raw;
}

export function zatToZec(zat: number): string {
  const whole = Math.floor(zat / ZAT_PER_ZEC);
  const frac = String(zat % ZAT_PER_ZEC).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a ZEC amount string to zatoshis without floating point. */
export function zecToZat(input: string): number | null {
  const m = input.trim().match(/^(\d{1,4})(?:\.(\d{1,8}))?$/);
  if (!m) return null;
  return Number(m[1]) * ZAT_PER_ZEC + Number((m[2] ?? "").padEnd(8, "0"));
}

export function zip321(address: string, amountZat: number, memo?: Uint8Array): string {
  const q = [`amount=${zatToZec(amountZat)}`];
  if (memo) q.push(`memo=${b64url(memo)}`);
  return `zcash:${address}?${q.join("&")}`;
}

// ---- tickets as QR ----------------------------------------------------------
export function ticketQr(eventId: string, secret: string): string {
  return `${TICKET_QR_PREFIX}:${eventId}:${secret}`;
}

export function parseTicketQr(text: string): { eventId: string; secret: string } | null {
  const m = text.trim().match(/^unlisted:([a-z0-9]{10}):([A-Za-z0-9_-]{43})$/);
  return m ? { eventId: m[1], secret: m[2] } : null;
}

// ---- address checks (HRP + bech32/bech32m checksum only) -----------------------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32 = 1;
const BECH32M = 0x2bc830a3;
const HRPS: Record<string, Record<string, number>> = {
  main: { u: BECH32M, zs: BECH32 },
  test: { utest: BECH32M, ztestsapling: BECH32 },
};

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
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export type AddressKind = "unified" | "sapling";

export function addressKind(address: string, network: string): AddressKind | null {
  const a = address.trim();
  if (a !== a.toLowerCase()) return null;
  const sep = a.lastIndexOf("1");
  if (sep < 1) return null;
  const hrp = a.slice(0, sep);
  const data = a.slice(sep + 1);
  const expected = HRPS[network]?.[hrp];
  if (expected === undefined || data.length < 6) return null;
  const values: number[] = [];
  for (const c of data) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    values.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== expected) return null;
  return expected === BECH32M ? "unified" : "sapling";
}

export function addressProblem(address: string, network: string): string | null {
  const a = address.trim();
  if (!a) return "Paste an address from your wallet.";
  if (/^t[13m]/.test(a) || /^tex1/.test(a)) {
    return "That is a transparent address. Use your wallet's shielded address (it starts with “u1”).";
  }
  if (addressKind(a, network) === "sapling") {
    return "That is an older Sapling address. Use your wallet's Unified Address (it starts with “u1”).";
  }
  if (!addressKind(a, network)) return "That does not look like a valid Zcash address.";
  if (!hasOrchardReceiver(a, network)) {
    return "This address can't receive a private (Orchard) refund. Copy the shielded address from ZODL's Receive screen.";
  }
  return null;
}

export const REJECTION_TEXT: Record<string, string> = {
  full: "The event was already full.",
  wrong_amount: "The amount did not match the deposit.",
  wrong_event: "The payment was for a different event.",
  rsvps_closed: "RSVPs had already closed.",
  duplicate_ticket: "That ticket was already used.",
  address_reused: "That refund address was already used for an Unlisted RSVP.",
};
