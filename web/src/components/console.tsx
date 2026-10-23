"use client";

// Building blocks of the action pages: /app, /join, /tickets, /events, /door.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Pill, Spinner, formatWhen, sharedMeta, usePoll } from "@/components/ui";
import { API_CONFIGURED, api, type Meta, type PublicEvent, type RsvpStatus } from "@/lib/api";
import { linkTarget } from "@/lib/links";
import { forgetEvent, forgetTicket, listSavedEvents, listTickets, saveTicket, type SavedEvent, type StoredTicket } from "@/lib/storage";

export function Channel({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="card flex flex-col p-6 sm:p-7">
      <div className="osd flex items-center justify-between text-ink-3">
        <span>CH {n}</span>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-4" />
      </div>
      <h2 className="mt-3 text-4xl leading-none">{title}</h2>
      <div className="mt-5 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

export function ServerStatus() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  const first = useRef(true);
  usePoll(
    async () => {
      try {
        // The first look shares the page's request; later ones check the server again.
        setMeta(await (first.current ? sharedMeta() : api.meta()));
        first.current = false;
      } catch {
        setMeta(null);
      }
    },
    15_000,
    [],
  );
  if (meta === undefined) {
    return <div className="osd flex items-center gap-2 text-ink-3"><Spinner className="h-3 w-3" /> Tuning in…</div>;
  }
  if (meta === null) {
    return (
      <div className="osd max-w-sm space-y-1 sm:text-right">
        <div className="flex items-center gap-2 text-bad sm:justify-end">
          <span className="blink inline-block h-2 w-2 rounded-full bg-bad" /> No signal
        </div>
        <div className="text-ink-3">
          {API_CONFIGURED
            ? "The cashr server can't be reached, so events can't be created or joined right now."
            : "This copy of cashr isn't connected to a server yet, so events can't be created or joined here."}{" "}
          <Link href="/docs#self-hosting" className="text-ink-2 underline decoration-ink-4 underline-offset-4 hover:text-ink">Run your own</Link>
        </div>
      </div>
    );
  }
  const network = meta.chain === "sim" ? "Simulated chain" : meta.network === "main" ? "Zcash mainnet" : "Zcash testnet";
  return (
    <div className="osd flex flex-wrap items-center gap-x-5 gap-y-1">
      <span className="flex items-center gap-2 text-ok"><span className="inline-block h-2 w-2 rounded-full bg-ok" /> On air</span>
      <span className={meta.chain === "sim" ? "text-gold-ink" : "text-ink-2"}>{network}</span>
      {meta.tip !== null ? (
        <span className="tabular-nums text-ink-3">Block {meta.tip.toLocaleString("en-US")}</span>
      ) : (
        <span className="text-warn">Wallet syncing</span>
      )}
    </div>
  );
}

export function OpenLink({
  prompt = "Paste an invite to RSVP. Organiser and door links work here too.",
  placeholder = "https://…/e/abc123defg  or  abc123defg",
  button = "Open",
  only,
}: {
  prompt?: string;
  placeholder?: string;
  button?: string;
  /** Restrict to one kind of link, with a matching error message. */
  only?: "e" | "manage" | "door";
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target = linkTarget(value);
    const kind = target?.split("/")[1];
    if (!target || (only && kind !== only)) {
      return setError(
        only === "door"
          ? "Paste the full door link from the organiser. It looks like …/door/abc123defg#k=…"
          : only === "manage"
            ? "Paste the full manage link you saved. It looks like …/manage/abc123defg#k=…"
            : "Paste the whole link you were sent, or a 10-character event code.",
      );
    }
    router.push(target);
  };
  return (
    <form onSubmit={submit} className="flex flex-1 flex-col">
      <p className="text-sm leading-relaxed text-ink-2">{prompt}</p>
      <label htmlFor={`open-link-${only ?? "any"}`} className="sr-only">Link</label>
      <input
        id={`open-link-${only ?? "any"}`}
        className="input mt-4 font-mono text-[13px]"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        spellCheck={false}
        autoComplete="off"
      />
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <button type="submit" className="btn-primary mt-5 self-start">{button}</button>
    </form>
  );
}

type TicketStatus = RsvpStatus | "going" | "pending" | "returned" | "gone";

function ticketPill(status: TicketStatus | undefined) {
  switch (status) {
    case undefined: return null;
    case "gone": return <Pill>Event over · ticket removed</Pill>;
    case "pending": return <Pill tone="warn">Not listed yet</Pill>;
    case "returned": return <Pill tone="bad">Payment returned</Pill>;
    case "refunded": return <Pill tone="ok">Refunded</Pill>;
    case "refunding": return <Pill tone="ok">Refund sending</Pill>;
    case "forfeited": return <Pill tone="warn">Forfeited</Pill>;
    default: return <Pill tone="gold">Going</Pill>;
  }
}

/** One event's status for a held ticket, from that event's whole ticket list. */
async function checkTicket(ticket: StoredTicket): Promise<TicketStatus> {
  const [event, list] = await Promise.all([api.event(ticket.eventId), api.tickets(ticket.eventId)]);
  if (event.status === "purged") return "gone";
  const mine = list.tickets.find((t) => t.h === ticket.hash);
  if (mine) return mine.status ?? "going";
  return list.rejected.some((r) => r.h === ticket.hash) ? "returned" : "pending";
}

// Tickets are listed from this device alone. Fetching every event's list at
// once would tell the server (and anyone watching the connection) that one
// browser holds tickets to all of them, so each is checked only when asked.
export function MyTickets() {
  const [tickets, setTickets] = useState<StoredTicket[] | null>(null);
  const [status, setStatus] = useState<Record<string, TicketStatus | "checking" | "offline">>({});
  useEffect(() => setTickets(listTickets()), []);

  async function check(ticket: StoredTicket) {
    setStatus((s) => ({ ...s, [ticket.eventId]: "checking" }));
    try {
      const st = await checkTicket(ticket);
      // The event was purged: nothing is left on the server, so nothing stays here.
      if (st === "gone") forgetTicket(ticket.eventId);
      // Listed or returned: the refund address was only needed for the payment's memo.
      else if (st !== "pending" && ticket.refundAddress) saveTicket({ ...ticket, refundAddress: "" });
      setStatus((s) => ({ ...s, [ticket.eventId]: st }));
    } catch {
      setStatus((s) => ({ ...s, [ticket.eventId]: "offline" }));
    }
  }

  function remove(ids: string[]) {
    ids.forEach(forgetTicket);
    setTickets(listTickets());
  }

  if (tickets === null) return <Spinner />;
  if (tickets.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-3">
        No tickets on this device yet. When you RSVP, your ticket is kept here, and only here.
      </p>
    );
  }
  const over = tickets.filter((t) => status[t.eventId] === "gone").map((t) => t.eventId);
  return (
    <div>
      <ul className="-mx-2 divide-y divide-ink/[0.08]">
        {tickets.map((t) => {
          const st = status[t.eventId];
          return (
            <li key={t.eventId} className="flex items-center justify-between gap-3 px-2 py-3">
              <Link href={`/e/${t.eventId}`} prefetch={false} className="min-w-0 hover:underline">
                <div className="truncate font-medium">{t.title ?? t.eventId}</div>
                <div className="osd mt-0.5 text-[11px] text-ink-4">{t.startsAt ? formatWhen(t.startsAt) : "Open to see details"}</div>
              </Link>
              <div className="shrink-0">
                {st === "checking" ? (
                  <Spinner />
                ) : st === undefined || st === "offline" ? (
                  <button className="btn-ghost px-2 py-1.5 text-[11px]" onClick={() => check(t)}>
                    {st === "offline" ? "Offline · retry" : "Check status"}
                  </button>
                ) : (
                  ticketPill(st)
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        {over.length > 0 && (
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => remove(over)}>
            Remove {over.length} ticket{over.length === 1 ? "" : "s"} for past events
          </button>
        )}
        <button
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={() => {
            if (!window.confirm("Remove every ticket from this device? A ticket for an upcoming event is the only way in, and the only way to get its deposit back.")) return;
            remove(tickets.map((t) => t.eventId));
          }}
        >
          Remove all tickets from this device
        </button>
      </div>
    </div>
  );
}

export function MyEvents({ mode = "both" }: { mode?: "both" | "door" } = {}) {
  const [events, setEvents] = useState<(SavedEvent & { live?: PublicEvent | null })[] | null>(null);
  useEffect(() => setEvents(listSavedEvents()), []);

  // One event at a time, when asked: fetching them all together would link them.
  async function check(id: string) {
    let live: PublicEvent | null = null;
    try {
      live = await api.event(id);
    } catch {
      /* keep the saved row */
    }
    setEvents((prev) => prev && prev.map((e) => (e.id === id ? { ...e, live } : e)));
  }

  if (events === null) return <Spinner />;
  if (events.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-sm leading-relaxed text-ink-3">
          Events you run appear here if you choose to remember their links on this device when you create them.
          Otherwise, open the manage link you saved.
        </p>
        <Link href="/new" className="btn-secondary mt-5 self-start">Create an event</Link>
      </div>
    );
  }
  return (
    <ul className="-mx-2 divide-y divide-ink/[0.08]">
      {events.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 px-2 py-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{e.title}</div>
            <div className="osd mt-0.5 text-[11px] text-ink-4">
              {e.live ? (
                `${e.live.status} · ${e.live.rsvp_count}/${e.live.capacity} listed${e.live.checked_in_count === null ? "" : ` · ${e.live.checked_in_count} came`}`
              ) : (
                <button className="underline decoration-ink-4 underline-offset-2 hover:text-ink-2" onClick={() => check(e.id)}>
                  {e.live === null ? "Offline · retry" : "Check status"}
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {mode === "both" && (
              <a href={`/manage/${e.id}#k=${e.adminToken}`} className="btn-secondary px-2.5 py-1.5 text-[11px]">Manage</a>
            )}
            <a href={`/door/${e.id}#k=${e.doorToken}`} className={`${mode === "door" ? "btn-primary" : "btn-secondary"} px-2.5 py-1.5 text-[11px]`}>
              {mode === "door" ? "Start scanning" : "Door"}
            </a>
            <button
              className="btn-ghost px-2 py-1.5 text-[11px]"
              aria-label={`Forget ${e.title} on this device`}
              onClick={() => {
                if (!window.confirm("Forget this event's links on this device? Make sure you saved them somewhere else.")) return;
                forgetEvent(e.id);
                setEvents((prev) => prev && prev.filter((x) => x.id !== e.id));
              }}
            >
              ✕
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Top of every action page: what this screen does, and whether the server is on air. */
export function ActionHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-5 border-b border-ink/10 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-5xl leading-[0.95] sm:text-6xl">{title}</h1>
        {children && <div className="mt-3 max-w-xl text-ink-2">{children}</div>}
      </div>
      <ServerStatus />
    </div>
  );
}
