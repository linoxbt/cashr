"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadQrPng, Qr } from "@/components/Qr";
import { CopyField, Notice, PageState, Pill, Spinner, formatWhen, listingWait, useIsTestnet, useMeta, usePoll } from "@/components/ui";
import { FAUCET_URL } from "@/lib/site";
import { api, ApiError, isEventId, type PublicEvent, type TicketList } from "@/lib/api";
import {
  REJECTION_TEXT,
  addressProblem,
  b64url,
  encodeMemo,
  fromB64url,
  newSecret,
  ticketHash,
  ticketQr,
  zatToZec,
  zip321,
} from "@/lib/codec";
import { TICKETS_KEY, forgetTicket, getTicket, saveTicket, type StoredTicket } from "@/lib/storage";
import { orchardOnly } from "@/lib/ua";

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  if (!isEventId(id)) return <PageState title="Event not found">Check the link you were given.</PageState>;
  return <EventFor id={id} />;
}

function EventFor({ id }: { id: string }) {
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [list, setList] = useState<TicketList | null>(null);
  const [ticket, setTicket] = useState<StoredTicket | null>(null);
  // Whether the ticket is actually in this browser's storage (it may be blocked or full).
  const [persisted, setPersisted] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [forgotten, setForgotten] = useState(false);
  // Bumped to fetch now rather than at the next tick (after a simulated payment).
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    setTicket(getTicket(id));
    // Another tab may RSVP or remove the ticket: follow it, never overwrite it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === TICKETS_KEY) setTicket(getTicket(id));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [id]);

  // Every visitor polls at the same, jittered pace whatever their ticket's state:
  // a pace that changed with the state would tell anyone watching the traffic
  // which state that is. Polling stops only once the event is purged, which is
  // the same for everyone.
  const eventRef = useRef<PublicEvent | null>(event);
  eventRef.current = event;
  const interval = () => (eventRef.current?.status === "purged" ? null : 15_000 + Math.floor(Math.random() * 10_000));

  // Fetch the event's *whole* ticket list and look for ours locally, so the
  // server never sees a request about one particular ticket.
  usePoll(
    async () => {
      try {
        const [ev, l] = await Promise.all([api.event(id), api.tickets(id)]);
        setEvent(ev);
        setList(l);
        setError(null);
        setLoadedAt(new Date());
        const held = getTicket(id);
        if (held && ev.status === "purged") {
          // Nothing is left on the server; nothing should be left here either.
          forgetTicket(id);
          setTicket(null);
          setForgotten(true);
        } else if (held?.refundAddress && [...l.tickets, ...l.rejected].some((t) => t.h === held.hash)) {
          // The payment is in (or returned): the refund address was only needed for its memo.
          const kept = { ...held, refundAddress: "" };
          saveTicket(kept);
          setTicket(kept);
        }
      } catch (e) {
        if (e instanceof ApiError) setError(e);
      }
    },
    interval,
    // Not the ticket: fetching off-schedule when one is created would time it.
    // `refreshes` only moves after a simulated payment on the demo.
    [id, refreshes],
    { whileHidden: true },
  );

  if (error?.status === 404) return <PageState title="Event not found">Check the link you were given.</PageState>;
  if (!event) {
    return error ? <PageState title="Can't load this event">{error.message}</PageState> : (
      <PageState title="Loading event…"><Spinner /></PageState>
    );
  }

  return (
    <div className="mx-auto grid max-w-page gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_26rem]">
      <EventDetails event={event} />
      <div className="space-y-4">
        {error && loadedAt && (
          <Notice tone="warn" title="Connection lost">
            Showing what was loaded at {loadedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Retrying…
          </Notice>
        )}
        {forgotten && (
          <Notice title="Ticket removed from this device">
            The organiser purged this event, so nothing about it is left on the server. Your ticket was removed from this
            browser too.
          </Notice>
        )}
        {ticket ? (
          <TicketCard event={event} ticket={ticket} list={list} persisted={persisted} onPaid={() => setRefreshes((n) => n + 1)}
            onForget={() => { forgetTicket(id); setTicket(null); }} />
        ) : (
          <RsvpCard event={event} onTicket={(t, ok) => { setTicket(t); setPersisted(ok); }} />
        )}
      </div>
    </div>
  );
}

function EventDetails({ event }: { event: PublicEvent }) {
  const statusPill = {
    open: event.accepting_rsvps ? <Pill tone="ok">RSVPs open</Pill> : <Pill tone="warn">RSVPs closed</Pill>,
    closed: <Pill tone="warn">RSVPs closed</Pill>,
    settling: <Pill>Refunds in progress</Pill>,
    settled: <Pill>Event over</Pill>,
    purged: <Pill>Event over · data deleted</Pill>,
  }[event.status];
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        {statusPill}
        <Pill tone="gold">No guest list</Pill>
      </div>
      <h1 className="mt-4 text-5xl sm:text-6xl ">{event.title}</h1>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="card p-4">
          <dt className="eyebrow">When</dt>
          <dd className="mt-1 font-medium">{formatWhen(event.starts_at)}</dd>
        </div>
        <div className="card p-4">
          <dt className="eyebrow">Where</dt>
          <dd className="mt-1 font-medium">{event.location || "Shared with attendees"}</dd>
        </div>
        <div className="card p-4">
          <dt className="eyebrow">Refundable deposit</dt>
          <dd className="mt-1 font-medium tabular-nums">{zatToZec(event.deposit_zat)} ZEC</dd>
        </div>
        {event.rsvp_closes_at && (
          <div className="card p-4">
            <dt className="eyebrow">RSVPs close</dt>
            <dd className="mt-1 font-medium">{formatWhen(event.rsvp_closes_at)}</dd>
          </div>
        )}
        <div className="card p-4">
          <dt className="eyebrow">Seats</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {event.seats_left} of {event.capacity} left
          </dd>
        </div>
      </dl>
      {event.details && <p className="mt-6 whitespace-pre-wrap leading-relaxed text-ink-2">{event.details}</p>}
      <div className="mt-8 rounded-2xl border border-ink/10 bg-paper-2/50 p-5 text-sm leading-relaxed text-ink-2">
        <div className="font-semibold text-ink">How your privacy is protected</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>You don&rsquo;t give a name, email or phone number.</li>
          <li>Your deposit is a shielded Zcash payment. Nobody can see who sent it, including the organiser.</li>
          <li>Your ticket is a secret made on this device. The organiser only ever sees its hash.</li>
          <li>Come, and your deposit is refunded to an address only you know. Skip it, and the deposit goes to the group.</li>
        </ul>
      </div>
    </section>
  );
}

function RsvpCard({ event, onTicket }: { event: PublicEvent; onTicket: (t: StoredTicket, persisted: boolean) => void }) {
  const meta = useMeta();
  const [address, setAddress] = useState("");
  const [fresh, setFresh] = useState(false);
  const [touched, setTouched] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  // Addresses are checked against the server's network, so wait until it is known.
  const problem = meta ? addressProblem(address, meta.network) : null;

  if (!event.accepting_rsvps) {
    return (
      <div className="card p-6">
        <h2 className="text-2xl ">RSVPs are closed</h2>
        <p className="mt-2 text-sm text-ink-3">
          {event.status === "open" ? "The RSVP deadline has passed." : "This event isn\u2019t taking new RSVPs."} Don&rsquo;t
          send a deposit: it would be returned minus a fee.
        </p>
      </div>
    );
  }
  if (event.full) {
    return (
      <div className="card p-6">
        <h2 className="text-2xl ">This event is full</h2>
        <p className="mt-2 text-sm text-ink-3">Check back later. Seats can open up if RSVPs are returned.</p>
      </div>
    );
  }

  async function fillDemoAddress() {
    setDemoError(null);
    try {
      setAddress((await api.simAddress()).address);
      setFresh(true);
    } catch (e) {
      setDemoError(e instanceof Error ? e.message : "Couldn't get a demo address");
    }
  }

  async function create() {
    setTouched(true);
    if (!meta || problem || !fresh) return;
    // Another tab may have RSVP'd already: its ticket (perhaps paid) must not be replaced.
    const existing = getTicket(event.id);
    if (existing) return onTicket(existing, true);
    const secret = newSecret();
    const t: StoredTicket = {
      eventId: event.id,
      secret: b64url(secret),
      hash: await ticketHash(secret),
      // Only the Orchard receiver goes in the memo: a transparent one in the same
      // address could link the attendee to their transparent history.
      refundAddress: orchardOnly(address.trim(), meta.network) ?? address.trim(),
      createdAt: new Date().toISOString(),
      title: event.title,
      startsAt: event.starts_at,
    };
    // Saved before payment so the ticket survives a reload mid-way. Ask the
    // browser not to evict it (Safari clears script storage after 7 idle days).
    void navigator.storage?.persist?.().catch(() => false);
    onTicket(t, saveTicket(t) && getTicket(event.id)?.secret === t.secret);
  }

  return (
    <div className="card p-6">
      <div className="eyebrow">Step 1 of 2</div>
      <h2 className="mt-2 text-2xl ">Where should your refund go?</h2>
      <p className="mt-1.5 text-sm text-ink-3">
        Paste a shielded receive address from your own wallet. In ZODL, tap <em>Receive</em> and copy the shielded address.
      </p>
      <label htmlFor="refund" className="sr-only">Refund address</label>
      <textarea
        id="refund"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        className="input mt-4 font-mono text-[13px]"
        placeholder="u1…"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        onBlur={() => setTouched(true)}
      />
      {meta?.chain === "sim" && (
        <button type="button" className="btn-secondary mt-2 w-full" onClick={fillDemoAddress}>
          Use a demo address (simulated chain)
        </button>
      )}
      {demoError && <p className="mt-2 text-sm text-bad">{demoError}</p>}
      {touched && problem && <p className="mt-2 text-sm text-bad">{problem}</p>}
      <label className="mt-4 flex items-start gap-3 text-sm text-ink-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-ink" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
        <span>
          This address is fresh: I haven&rsquo;t used it for another cashr RSVP.{" "}
          <span className="text-ink-3">ZODL gives you a new one each time you open Receive.</span>
        </span>
      </label>
      {touched && !fresh && !problem && <p className="mt-2 text-sm text-bad">Please confirm the address is fresh.</p>}
      <button className="btn-primary mt-6 w-full" onClick={create} disabled={!meta}>
        {meta ? "Continue to deposit" : <><Spinner /> Connecting…</>}
      </button>
      <p className="mt-3 text-center text-xs text-ink-4">Nothing is sent to the server at this step.</p>
    </div>
  );
}

function TicketCard({ event, ticket, list, persisted, onPaid, onForget }: {
  event: PublicEvent; ticket: StoredTicket; list: TicketList | null; persisted: boolean; onPaid: () => void; onForget: () => void;
}) {
  if (event.status === "purged") return <Purged onForget={onForget} />;
  const mine = list?.tickets.find((t) => t.h === ticket.hash) ?? null;
  const rejected = list?.rejected.find((r) => r.h === ticket.hash) ?? null;
  // An accepted ticket wins: paying twice with the same memo gets the second
  // payment rejected as a duplicate, but the first one still holds the seat.
  if (!mine && rejected) return <Rejected event={event} reason={rejected.reason} onForget={onForget} />;
  if (!mine) return <PayCard event={event} ticket={ticket} loaded={list !== null} persisted={persisted} onPaid={onPaid} onForget={onForget} />;

  const qr = ticketQr(event.id, ticket.secret);
  // Check-ins aren't published while the event runs (anyone could time them),
  // so the ticket says "going" until settlement reveals every outcome at once.
  const state = mine.status === "refunded"
    ? { tone: "ok" as const, label: "Deposit refunded", text: "Thanks for coming. Your deposit is back in your wallet." }
    : mine.status === "refunding"
      ? { tone: "ok" as const, label: "Refund on its way", text: "Your refund is being sent to the address you gave." }
      : mine.status === "forfeited"
        ? { tone: "warn" as const, label: "Deposit forfeited", text: "This ticket wasn't checked in, so the deposit went to the group's fund." }
        : { tone: "gold" as const, label: "You're going", text: "Show this code at the door; the door confirms when you're in. Screenshot it or save the image in case you're offline. Your deposit comes back after the event." };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <Pill tone={state.tone === "gold" ? "gold" : state.tone}>{state.label}</Pill>
      </div>
      <div className="mt-5 flex justify-center">
        <Qr value={qr} size={260} label="Your ticket QR code" />
      </div>
      <p className="mt-5 text-center text-sm text-ink-2">{state.text}</p>
      <div className="mt-5 grid gap-2">
        <button className="btn-secondary" onClick={() => downloadQrPng(qr, "cashr-ticket.png")}>
          Save ticket image
        </button>
        <ForgetButton onForget={onForget} warn={mine.status === undefined || mine.status === "confirmed"} />
      </div>
    </div>
  );
}

function PayCard({ event, ticket, loaded, persisted, onPaid, onForget }: {
  event: PublicEvent; ticket: StoredTicket; loaded: boolean; persisted: boolean; onPaid: () => void; onForget: () => void;
}) {
  const meta = useMeta();
  const memo = useMemo(() => {
    try {
      return encodeMemo(event.id, ticket.hash, ticket.refundAddress);
    } catch {
      return null; // a stored refund address too long for a memo (checked before saving now)
    }
  }, [event.id, ticket]);
  if (!memo) {
    return (
      <div className="card p-6">
        <Notice tone="bad">This ticket&rsquo;s refund address is too long to fit in a payment memo. Start over with your wallet&rsquo;s shielded address.</Notice>
        <div className="mt-5"><ForgetButton onForget={onForget} warn={false} label="Start over" /></div>
      </div>
    );
  }
  return <PayCardFor event={event} ticket={ticket} loaded={loaded} persisted={persisted} memo={memo} meta={meta} onPaid={onPaid} onForget={onForget} />;
}

function PayCardFor({ event, ticket, loaded, persisted, memo, meta, onPaid, onForget }: {
  event: PublicEvent; ticket: StoredTicket; loaded: boolean; persisted: boolean; memo: Uint8Array; meta: ReturnType<typeof useMeta>;
  onPaid: () => void; onForget: () => void;
}) {
  const sim = meta?.chain === "sim";
  const testnet = useIsTestnet();
  const uri = zip321(event.address, event.deposit_zat, memo);
  const memoText = new TextDecoder().decode(memo);
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  const simulate = useCallback(async () => {
    setSimBusy(true);
    setSimError(null);
    try {
      await api.simPay(event.address, event.deposit_zat, b64url(memo));
      onPaid();
    } catch (e) {
      setSimError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setSimBusy(false);
    }
  }, [event, memo, onPaid]);

  // Sanity check: the stored secret must still hash to the stored hash.
  const [intact, setIntact] = useState(true);
  useEffect(() => {
    // A stored secret that isn't even base64 is as damaged as one with the wrong hash.
    let secret: Uint8Array;
    try {
      secret = fromB64url(ticket.secret);
    } catch {
      setIntact(false);
      return;
    }
    ticketHash(secret).then((h) => setIntact(h === ticket.hash), () => setIntact(false));
  }, [ticket]);

  if (!event.accepting_rsvps || event.full) {
    // Never show payment details a deposit would bounce off.
    return (
      <div className="card p-6">
        <Pill tone="warn">Don&rsquo;t pay now</Pill>
        <h2 className="mt-3 text-2xl ">{event.full && event.accepting_rsvps ? "The event filled up" : "RSVPs closed"}</h2>
        <p className="mt-2 text-sm text-ink-2">
          A deposit sent now would be returned to your refund address, minus a small network fee. If you already sent
          one, it will show here once it confirms.
        </p>
        <div className="mt-5">
          <ForgetButton onForget={onForget} warn label="Start over" />
        </div>
      </div>
    );
  }

  const qr = ticketQr(event.id, ticket.secret);
  const saveImage = (
    <button className="btn-secondary w-full" onClick={() => downloadQrPng(qr, "cashr-ticket.png")}>
      Save ticket image
    </button>
  );
  return (
    <div className="card p-6">
      <div className="eyebrow">Step 2 of 2</div>
      <h2 className="mt-2 text-2xl ">Pay the {zatToZec(event.deposit_zat)} ZEC deposit</h2>
      {!intact && <div className="mt-4"><Notice tone="bad">This ticket on your device looks damaged. Start over below.</Notice></div>}
      {!persisted && (
        <div className="mt-4">
          <Notice tone="bad" title="This browser isn't keeping your ticket">
            Its storage is blocked or full, so the ticket disappears if this page closes. Save the ticket image below
            before you pay: it is the only way in, and the only way to get your deposit back.
          </Notice>
        </div>
      )}
      <div className="mt-4">{saveImage}</div>
      <p className="mt-2 text-xs text-ink-3">
        Your ticket is ready now. Save it before paying, so a closed tab or a cleared browser can&rsquo;t lose it.
      </p>

      {!meta ? (
        // Until the server says which chain it runs, show no way to pay: on the demo
        // server a real wallet would be paying a made-up address.
        <p className="mt-5 flex items-center gap-2 text-sm text-ink-3"><Spinner /> Connecting to the server…</p>
      ) : sim ? (
        // The demo server's event addresses are made up: real ZEC sent to one is lost.
        <div className="mt-5">
          <Notice tone="warn" title="Demo server: simulated chain">
            Nothing here moves real ZEC. Don&rsquo;t pay from a wallet; use the button below.
          </Notice>
          <button className="btn-primary mt-4 w-full" onClick={simulate} disabled={simBusy}>
            {simBusy && <Spinner />} Simulate this payment
          </button>
          {simError && <p className="mt-2 text-sm text-bad">{simError}</p>}
        </div>
      ) : (
        <>
          <p className="mt-5 text-sm text-ink-3">
            {testnet ? (
              <>Scan with a wallet set to <strong className="text-ink-2">testnet</strong> (Zingo or YWallet, for example), paying test ZEC from the <a href={FAUCET_URL} className="underline underline-offset-2">faucet</a>. The amount and memo are filled in for you. Don&rsquo;t change them.</>
            ) : (
              <>Scan with ZODL or any Zcash wallet. The amount and memo are filled in for you. Don&rsquo;t change them.</>
            )}
          </p>
          <div className="mt-5 flex justify-center">
            <Qr value={uri} size={248} label="Payment QR code" />
          </div>
          <a href={uri} className="btn-primary mt-5 w-full">Open in wallet app</a>
          <p className="mt-3 text-xs leading-relaxed text-ink-3">
            Pay from your <strong className="text-ink-2">shielded</strong> balance. A payment from a transparent (t-address)
            balance shows your address and this exact amount on the public chain.
          </p>
        </>
      )}

      <div className="mt-5 flex items-center gap-2 rounded-lg bg-paper-2/60 px-3 py-2.5 text-sm text-ink-2">
        <Spinner className="text-ink-4" />
        {!loaded
          ? "Connecting…"
          : sim
            ? "On the real app, tickets join the public list at random moments up to about three hours apart, so nobody watching can tell when yours was paid. This demo lists them at once."
            : `After you pay, your ticket shows here within ${listingWait(meta)}, often sooner. The public list updates at random moments, so nobody watching can tell when yours was paid.`}
      </div>

      {meta && !sim && (
        <details className="mt-5 text-sm">
          <summary className="cursor-pointer font-medium text-ink-2">Enter the payment by hand</summary>
          <div className="mt-4 space-y-4">
            <CopyField label="Send to" value={event.address} />
            <CopyField label="Amount (ZEC)" value={zatToZec(event.deposit_zat)} />
            <CopyField label="Memo" value={memoText} hint="Paste it exactly. Without it, we can't refund you." />
          </div>
        </details>
      )}
      <div className="mt-5">
        <ForgetButton onForget={onForget} warn label="Start over" />
      </div>
    </div>
  );
}

function Rejected({ event, reason, onForget }: { event: PublicEvent; reason: string; onForget: () => void }) {
  return (
    <div className="card p-6">
      <Pill tone="bad">{reason === "kept" ? "Payment not accepted" : "Payment returned"}</Pill>
      <h2 className="mt-3 text-2xl ">This RSVP didn&rsquo;t go through</h2>
      <p className="mt-2 text-sm text-ink-2">{REJECTION_TEXT[reason] ?? "The payment couldn't be accepted."}</p>
      {reason !== "kept" && (
        <p className="mt-2 text-sm text-ink-3">
          Your payment is being returned to your refund address, minus a small network fee.
        </p>
      )}
      {event.accepting_rsvps && !event.full && (
        <div className="mt-5">
          <ForgetButton onForget={onForget} warn={false} label="Try again with a new ticket" />
        </div>
      )}
    </div>
  );
}

function Purged({ onForget }: { onForget: () => void }) {
  return (
    <div className="card p-6">
      <Pill>Event over · data deleted</Pill>
      <h2 className="mt-3 text-2xl ">Nothing is left to show</h2>
      <p className="mt-2 text-sm text-ink-2">
        The organiser purged this event: its tickets, payments and wallet keys are gone from the server. Your ticket is
        now the only record that you RSVP&rsquo;d, so you may want to remove it from this device.
      </p>
      <button className="btn-primary mt-5 w-full" onClick={onForget}>Remove ticket from this device</button>
    </div>
  );
}

function ForgetButton({ onForget, warn, label = "Remove ticket from this device" }: { onForget: () => void; warn: boolean; label?: string }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button className="btn-ghost w-full text-xs" onClick={() => setConfirm(true)}>{label}</button>;
  return (
    <div className="rounded-lg border border-bad/20 bg-bad-soft p-3 text-sm">
      <p className="text-ink-2">
        {warn
          ? "If you've already paid, this ticket is the only way in and the only way to get your deposit back. Save the image first."
          : "This removes the ticket from this browser."}
      </p>
      <div className="mt-3 flex gap-2">
        <button className="btn-danger flex-1 py-1.5" onClick={onForget}>Remove</button>
        <button className="btn-secondary flex-1 py-1.5" onClick={() => setConfirm(false)}>Keep it</button>
      </div>
    </div>
  );
}
