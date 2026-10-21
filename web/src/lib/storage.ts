// Everything an attendee holds lives only in their own browser.
// Storage can be unavailable (private windows, blocked site data), so every
// access is guarded and the UI keeps working from in-memory state.

export interface StoredTicket {
  eventId: string;
  secret: string; // base64url, 32 bytes
  hash: string;
  refundAddress: string;
  createdAt: string;
}

const TICKETS = "unlisted.tickets.v1";

function read<T>(store: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(store: Storage | undefined, key: string, value: unknown): boolean {
  try {
    store?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const local = () => (typeof window === "undefined" ? undefined : window.localStorage);
const session = () => (typeof window === "undefined" ? undefined : window.sessionStorage);

export function getTicket(eventId: string): StoredTicket | null {
  return read<Record<string, StoredTicket>>(local(), TICKETS, {})[eventId] ?? null;
}

export function saveTicket(t: StoredTicket): boolean {
  const all = read<Record<string, StoredTicket>>(local(), TICKETS, {});
  all[t.eventId] = t;
  return write(local(), TICKETS, all);
}

export function forgetTicket(eventId: string): void {
  const all = read<Record<string, StoredTicket>>(local(), TICKETS, {});
  delete all[eventId];
  write(local(), TICKETS, all);
}

export function readJson<T>(key: string, fallback: T): T {
  return read(local(), key, fallback);
}

export function writeJson(key: string, value: unknown): boolean {
  return write(local(), key, value);
}

/**
 * Organiser and door links look like /manage/<id>#k=<token>. The fragment is
 * never sent to any server. We keep the token for this tab in sessionStorage
 * and strip it from the address bar so it does not end up in screenshots.
 */
export function takeLinkToken(scope: string): string | null {
  const key = `unlisted.token.${scope}`;
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (m) {
    write(session(), key, m[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return m[1];
  }
  return read<string | null>(session(), key, null);
}
