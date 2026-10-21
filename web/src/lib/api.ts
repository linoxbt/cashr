export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export type EventStatus = "open" | "closed" | "settling" | "settled" | "purged";

export interface PublicEvent {
  id: string;
  title: string;
  starts_at: string;
  location: string;
  details: string;
  capacity: number;
  deposit_zat: number;
  rsvp_closes_at: string | null;
  status: EventStatus;
  address: string;
  rsvp_count: number;
  checked_in_count: number;
  seats_left: number;
}

export interface AdminEvent extends PublicEvent {
  forfeit_address: string;
  rejected_count: number;
  refunded_zat: number;
  forfeited_zat: number;
  float_zat: number;
}

export type RsvpStatus = "confirmed" | "refunding" | "refunded" | "forfeited";

export interface TicketList {
  status: EventStatus;
  tickets: { h: string; seat: number; status: RsvpStatus; checked_in: boolean }[];
  rejected: { h: string; reason: string }[];
}

export interface AdminView {
  event: AdminEvent;
  balance_zat: number | null;
  wallet_error: string;
  rsvps: { seat: number; ticket_hash: string; refund_address: string; status: RsvpStatus; checked_in: boolean }[];
  deposits: { txid: string; pool: string; index: number; amount_zat: number; height: number; kind: string; reason: string }[];
  payouts: { id: number; kind: string; status: string; recipients: number; amount_zat: number; txid: string; error: string }[];
}

export interface Meta {
  chain: "sim" | "rpc";
  network: "main" | "test";
  min_conf: number;
  reject_fee_zat: number;
  tip: number | null;
}

export interface Manifest {
  event: PublicEvent;
  tickets: { h: string; seat: number; checked_in: boolean }[];
}

export type CheckInResult = "ok" | "already" | "unknown" | "event_closed";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    throw new ApiError(0, "network", "Can't reach the Unlisted server. Check your connection.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(body.detail) ? "Please check the highlighted fields." : body.detail;
    throw new ApiError(res.status, body.error ?? "http", body.message ?? detail ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export const api = {
  meta: () => request<Meta>("/meta"),
  event: (id: string) => request<PublicEvent>(`/events/${id}`),
  tickets: (id: string) => request<TicketList>(`/events/${id}/tickets`),
  createEvent: (body: Record<string, unknown>) =>
    request<{ event: PublicEvent; admin_token: string; door_token: string }>("/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  admin: (id: string, token: string) => request<AdminView>(`/events/${id}/admin`, { token }),
  adminAction: (id: string, action: string, token: string) =>
    request<AdminEvent>(`/events/${id}/admin/${action}`, { method: "POST", token }),
  manifest: (id: string, token: string) => request<Manifest>(`/events/${id}/door/manifest`, { token }),
  checkIn: (id: string, ticket_hash: string, token: string) =>
    request<{ result: CheckInResult; seat: number | null; checked_in_count: number }>(`/events/${id}/door/checkin`, {
      method: "POST",
      token,
      body: JSON.stringify({ ticket_hash }),
    }),
  syncCheckIns: (id: string, ticket_hashes: string[], token: string) =>
    request<{ results: { h: string; result: CheckInResult }[]; checked_in_count: number }>(`/events/${id}/door/sync`, {
      method: "POST",
      token,
      body: JSON.stringify({ ticket_hashes }),
    }),
  simPay: (address: string, amount_zat: number, memo_b64url: string) =>
    request<{ txid: string }>("/sim/pay", { method: "POST", body: JSON.stringify({ address, amount_zat, memo_b64url }) }),
};
