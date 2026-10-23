// Everything an attendee holds lives only in their own browser.
// Storage can be unavailable (private windows, blocked site data), so every
// access is guarded and the UI keeps working from in-memory state.

export interface StoredTicket {
  eventId: string;
  secret: string; // base64url, 32 bytes
  hash: string;
  refundAddress: string;
  createdAt: string;
  // Kept so the ticket list can show what each ticket is for without asking the
  // server (asking about every event at once would link them together).
  title?: string;
  startsAt?: string;
}

export const TICKETS_KEY = "cashr.tickets.v1";
export const THEME_KEY = "cashr.theme";
export type Theme = "dark" | "light";
const TICKETS = TICKETS_KEY;

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

// Keys were "unlisted.*" before the app was renamed cashr. Move them once, so
// tickets and remembered links saved under the old name are kept.
const LEGACY_PREFIX = "unlisted.";
const migrated = new WeakSet<Storage>();
function migrate(store: Storage): Storage {
  if (migrated.has(store)) return store;
  migrated.add(store);
  try {
    for (const key of Object.keys(store)) {
      if (!key.startsWith(LEGACY_PREFIX)) continue;
      const renamed = "cashr." + key.slice(LEGACY_PREFIX.length);
      const value = store.getItem(key);
      if (store.getItem(renamed) === null && value !== null) store.setItem(renamed, value);
      store.removeItem(key);
    }
  } catch {
    /* storage blocked: nothing to move */
  }
  return store;
}

// Even reading window.localStorage throws when site data is blocked.
function storage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return migrate(window[kind]);
  } catch {
    return undefined;
  }
}
const local = () => storage("localStorage");
const session = () => storage("sessionStorage");

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

export function forgetKeys(keys: string[]): void {
  for (const k of keys) {
    try {
      local()?.removeItem(k);
    } catch {
      /* storage unavailable: nothing was kept */
    }
  }
}

/**
 * Organiser and door links look like /manage/<id>#k=<token>. The fragment is
 * never sent to any server. We keep the token for this tab in sessionStorage
 * and strip it from the address bar so it does not end up in screenshots.
 */
export function takeLinkToken(scope: string): string | null {
  const key = `cashr.token.${scope}`;
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (m) {
    write(session(), key, m[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return m[1];
  }
  return read<string | null>(session(), key, null);
}

// ---- organiser links remembered on this device (opt-in) ----------------------

export interface SavedEvent {
  id: string;
  title: string;
  adminToken: string;
  doorToken: string;
  savedAt: string;
}

const EVENTS = "cashr.events.v1";

export function listTickets(): StoredTicket[] {
  return Object.values(read<Record<string, StoredTicket>>(local(), TICKETS, {})).sort((a, b) =>
    String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")),
  );
}

export function listSavedEvents(): SavedEvent[] {
  return Object.values(read<Record<string, SavedEvent>>(local(), EVENTS, {})).sort((a, b) =>
    String(b?.savedAt ?? "").localeCompare(String(a?.savedAt ?? "")),
  );
}

export function saveEvent(e: SavedEvent): boolean {
  const all = read<Record<string, SavedEvent>>(local(), EVENTS, {});
  all[e.id] = e;
  return write(local(), EVENTS, all);
}

export function forgetEvent(id: string): void {
  const all = read<Record<string, SavedEvent>>(local(), EVENTS, {});
  delete all[id];
  write(local(), EVENTS, all);
}
