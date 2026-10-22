"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { CopyField, Notice, Spinner, useMeta } from "@/components/ui";
import { api, ApiError, type PublicEvent } from "@/lib/api";
import { addressProblem, zatToZec, zecToZat } from "@/lib/codec";
import { forgetEvent, saveEvent } from "@/lib/storage";

interface Created {
  event: PublicEvent;
  admin_token: string;
  door_token: string;
}

// Matches the API's limit (api/unlisted/app.py MAX_DEPOSIT_ZAT).
const MAX_DEPOSIT_ZAT = 100 * 100_000_000;

export default function NewEvent() {
  const meta = useMeta();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [form, setForm] = useState({
    title: "",
    starts_at: "",
    location: "",
    details: "",
    capacity: "30",
    deposit: "0.01",
    rsvp_closes_at: "",
    forfeit_address: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const depositZat = zecToZat(form.deposit);
  const forfeitProblem = form.forfeit_address.trim() && meta ? addressProblem(form.forfeit_address, meta.network) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (depositZat === null || depositZat < 50_000) return setError("Deposit must be at least 0.0005 ZEC.");
    if (depositZat > MAX_DEPOSIT_ZAT) return setError("Deposit can be at most 100 ZEC.");
    const capacity = Number(form.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000) return setError("Capacity must be a whole number from 1 to 5000.");
    if (forfeitProblem) return setError(forfeitProblem);
    const starts = new Date(form.starts_at);
    if (Number.isNaN(starts.getTime())) return setError("Pick a start date and time.");
    if (starts.getTime() < Date.now()) return setError("The start time is in the past.");
    const closes = form.rsvp_closes_at ? new Date(form.rsvp_closes_at) : null;
    if (closes && Number.isNaN(closes.getTime())) return setError("Pick a valid RSVP close time, or leave it empty.");
    if (closes && closes.getTime() > starts.getTime()) return setError("RSVPs must close before the event starts.");
    setBusy(true);
    try {
      const res = await api.createEvent({
        title: form.title,
        // The browser's local time, sent with its offset so every attendee sees the right time.
        starts_at: starts.toISOString(),
        location: form.location,
        details: form.details,
        capacity,
        deposit_zat: depositZat,
        rsvp_closes_at: closes ? closes.toISOString() : null,
        forfeit_address: form.forfeit_address.trim(),
      });
      setCreated(res);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (created) return <CreatedPanel created={created} />;

  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <p className="eyebrow">New event</p>
      <h1 className="mt-3 text-5xl ">Create an event</h1>
      <p className="mt-3 text-ink-2">
        No account, no email. You&rsquo;ll get two private links: keep them safe, they are the only way in.
      </p>

      <form onSubmit={submit} className="card mt-8 space-y-6 p-6 sm:p-8">
        <div>
          <label className="label" htmlFor="title">Event name</label>
          <input id="title" required maxLength={120} className="input" value={form.title} onChange={set("title")} placeholder="Tuesday evening circle" />
          <p className="hint">Shown on the public RSVP page. Keep it as vague as you need it to be.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="starts">Starts</label>
            <input id="starts" required type="datetime-local" className="input" value={form.starts_at} onChange={set("starts_at")} />
          </div>
          <div>
            <label className="label" htmlFor="closes">RSVPs close <span className="font-normal text-ink-4">(optional)</span></label>
            <input id="closes" type="datetime-local" className="input" value={form.rsvp_closes_at} onChange={set("rsvp_closes_at")} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="location">Where <span className="font-normal text-ink-4">(optional)</span></label>
          <input id="location" maxLength={200} className="input" value={form.location} onChange={set("location")} placeholder="Shared privately with confirmed attendees" />
          <p className="hint">This is public. For sensitive venues, write something like &ldquo;sent on Signal after you RSVP&rdquo;.</p>
        </div>
        <div>
          <label className="label" htmlFor="details">Details <span className="font-normal text-ink-4">(optional)</span></label>
          <textarea id="details" rows={4} maxLength={4000} className="input" value={form.details} onChange={set("details")} />
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="capacity">Capacity</label>
            <input id="capacity" required type="number" min={1} max={5000} className="input" value={form.capacity} onChange={set("capacity")} />
          </div>
          <div>
            <label className="label" htmlFor="deposit">Deposit (ZEC)</label>
            <input id="deposit" required inputMode="decimal" className="input" value={form.deposit} onChange={set("deposit")} />
            <p className="hint">
              {depositZat !== null
                ? `${zatToZec(depositZat)} ZEC, refunded to everyone who comes. A round amount is less distinctive on chain.`
                : "Enter an amount like 0.01."}
            </p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="forfeit">No-show fund address <span className="font-normal text-ink-4">(optional)</span></label>
          <input id="forfeit" className="input font-mono text-[13px]" value={form.forfeit_address} onChange={set("forfeit_address")} placeholder="u1…" spellCheck={false} />
          <p className="hint">
            {forfeitProblem ??
              "Shielded address for your group's fund. After settling, no-show deposits and leftover fee money are swept here. You can also add it later from the dashboard; the event can't be purged until it's swept."}
          </p>
        </div>

        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex items-center justify-end gap-3 border-t border-ink/10 pt-6">
          <Link href="/" className="btn-ghost">Cancel</Link>
          <button type="submit" className="btn-primary" disabled={busy || !meta}>
            {busy && <Spinner />} Create event
          </button>
        </div>
      </form>
    </div>
  );
}

function CreatedPanel({ created }: { created: Created }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const { event } = created;
  const publicLink = `${origin}/e/${event.id}`;
  const manageLink = `${origin}/manage/${event.id}#k=${created.admin_token}`;
  const doorLink = `${origin}/door/${event.id}#k=${created.door_token}`;
  const [remember, setRemember] = useState(false);
  const toggleRemember = (on: boolean) => {
    setRemember(on);
    if (on) {
      saveEvent({ id: event.id, title: event.title, adminToken: created.admin_token, doorToken: created.door_token, savedAt: new Date().toISOString() });
    } else {
      forgetEvent(event.id);
    }
  };
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <p className="eyebrow">Event created</p>
      <h1 className="mt-3 text-5xl ">{event.title} is ready.</h1>
      <div className="mt-6">
        <Notice tone="warn" title="Save these links now">
          The manage and door links are shown only once. We store a hash of them, not the links, so we can&rsquo;t
          recover them for you. Save them in a password manager.
        </Notice>
      </div>
      <div className="card mt-6 space-y-6 p-6 sm:p-8">
        <CopyField label="Public RSVP link" value={publicLink} hint="Share this with the people you're inviting." />
        <CopyField label="Manage link (private)" value={manageLink} hint="Settle refunds, close RSVPs and purge data. Anyone with it controls the event." />
        <CopyField label="Door link (private)" value={doorLink} hint="Open on the phone that checks people in. It can only check tickets." />
      </div>
      <label className="card mt-4 flex items-start gap-3 p-4 text-sm text-ink-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#F4B728]" checked={remember} onChange={(e) => toggleRemember(e.target.checked)} />
        <span>
          <span className="font-medium text-ink">Remember these links on this device</span>
          <span className="block text-ink-3">
            Lists the event under <Link href="/events" className="underline">Your events</Link>. Anyone using this browser could then manage
            the event, so leave it off on shared or at-risk devices.
          </span>
        </span>
      </label>
      <div className="mt-6 flex flex-wrap gap-3">
        <a href={manageLink} className="btn-primary">Open dashboard</a>
        <a href={publicLink} className="btn-secondary">View RSVP page</a>
      </div>
    </div>
  );
}
