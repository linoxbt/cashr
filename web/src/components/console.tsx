"use client";

// Building blocks of the action pages: /app, /join, /tickets, /events, /door.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Pill, Spinner, formatWhen, usePoll } from "@/components/ui";
import { API_CONFIGURED, api, type Meta, type PublicEvent, type RsvpStatus } from "@/lib/api";
import { zatToZec } from "@/lib/codec";
import { linkTarget } from "@/lib/links";
import { forgetEvent, listSavedEvents, listTickets, type SavedEvent, type StoredTicket } from "@/lib/storage";

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
  usePoll(
    async () => {
      try {
        setMeta(await api.meta());
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
            ? "The Unlisted server can't be reached, so events can't be created or joined right now."
            : "This copy of Unlisted isn't connected to a server yet, so events can't be created or joined here."}{" "}
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

type TicketRow = {
  ticket: StoredTicket;
  event?: PublicEvent;
  status?: RsvpStatus | "pending" | "returned";
  checkedIn?: boolean;
  gone?: boolean;
};

function ticketPill(row: TicketRow) {
  if (row.gone) return <Pill>Event over</Pill>;
  switch (row.status) {
    case undefined: return <Pill>…</Pill>;
    case "pending": return <Pill tone="warn">Awaiting payment</Pill>;
    case "returned": return <Pill tone="bad">Payment returned</Pill>;
    case "refunded": return <Pill tone="ok">Refunded</Pill>;
    case "refunding": return <Pill tone="ok">Refund sending</Pill>;
    case "forfeited": return <Pill tone="warn">Forfeited</Pill>;
    default: return row.checkedIn ? <Pill tone="ok">Checked in</Pill> : <Pill tone="gold">Going</Pill>;
  }
}

export function MyTickets() {
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  useEffect(() => {
    const tickets = listTickets();
    setRows(tickets.map((ticket) => ({ ticket })));
    tickets.forEach(async (ticket, i) => {
      try {
        // Fetch the event's whole ticket list, never one ticket, so the server can't tell which is ours.
        const [event, list] = await Promise.all([api.event(ticket.eventId), api.tickets(ticket.eventId)]);
        const mine = list.tickets.find((t) => t.h === ticket.hash);
        const returned = list.rejected.some((r) => r.h === ticket.hash);
        const next: TicketRow = {
          ticket,
          event,
          status: mine ? mine.status : returned ? "returned" : "pending",
          checkedIn: mine?.checked_in,
          gone: event.status === "purged",
        };
        setRows((prev) => prev && prev.map((r, j) => (j === i ? next : r)));
      } catch {
        /* offline: keep the row without live status */
      }
    });
  }, []);

  if (rows === null) return <Spinner />;
  if (rows.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-3">
        No tickets on this device yet. When you RSVP, your ticket is kept here, and only here.
      </p>
    );
  }
  return (
    <ul className="-mx-2 divide-y divide-ink/[0.08]">
      {rows.map((row) => (
        <li key={row.ticket.eventId}>
          <Link href={`/e/${row.ticket.eventId}`} className="flex items-center justify-between gap-4 rounded px-2 py-3 hover:bg-white/[0.03]">
            <div className="min-w-0">
              <div className="truncate font-medium">{row.event?.title ?? row.ticket.eventId}</div>
              <div className="osd mt-0.5 text-[11px] text-ink-4">
                {row.event ? `${formatWhen(row.event.starts_at)} · ${zatToZec(row.event.deposit_zat)} ZEC` : "Loading…"}
              </div>
            </div>
            <div className="shrink-0">{ticketPill(row)}</div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function MyEvents({ mode = "both" }: { mode?: "both" | "door" } = {}) {
  const [events, setEvents] = useState<(SavedEvent & { live?: PublicEvent })[] | null>(null);
  useEffect(() => {
    const saved = listSavedEvents();
    setEvents(saved);
    saved.forEach(async (s, i) => {
      try {
        const live = await api.event(s.id);
        setEvents((prev) => prev && prev.map((e, j) => (j === i ? { ...e, live } : e)));
      } catch {
        /* keep the saved row */
      }
    });
  }, []);

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
            <div className="truncate font-medium">{e.live?.title ?? e.title}</div>
            <div className="osd mt-0.5 text-[11px] text-ink-4">
              {e.live ? `${e.live.status} · ${e.live.rsvp_count}/${e.live.capacity} RSVPs · ${e.live.checked_in_count} in` : "…"}
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
