import type { Metadata } from "next";

export const metadata: Metadata = { title: "Threat model" };

const STORED = [
  ["Event details", "Title, time, place, capacity, deposit. Place and description are wiped on purge."],
  ["Ticket hash", "SHA-256 of a random secret. Reveals nothing about the person."],
  ["Refund address", "A one-time shielded address the attendee chose. Unlinkable to their other addresses."],
  ["Checked in", "A yes/no per ticket. No time, so arrivals can't be matched against cameras."],
  ["Deposit notes", "Transaction id, amount, block height. The sender is never visible, even to the wallet."],
  ["Reused-address digests", "Keyed hashes of refund addresses, only to refuse reuse. Never the address itself."],
];

const LEAKS = [
  {
    risk: "Reusing a refund address",
    detail: "The same address at two events would link one person's attendance across both.",
    fix: "The server refuses any address it has seen before and returns the deposit.",
  },
  {
    risk: "Network metadata",
    detail: "Loading the event page reveals an IP address to the web host and the API.",
    fix: "The API keeps no access logs. Confirmation checks download every ticket hash, so no request points at one ticket. For high-risk groups, open the page over Tor.",
  },
  {
    risk: "Odd amounts",
    detail: "A unique deposit amount could stand out.",
    fix: "Every RSVP must pay exactly the same deposit. Anything else is returned.",
  },
  {
    risk: "Transparent funds",
    detail: "Paying from a transparent (t-address) balance exposes the payer's address.",
    fix: "Event addresses are Orchard-only and refunds are sent with the wallet's FullPrivacy policy. Attendees should pay from a shielded balance.",
  },
  {
    risk: "The ticket itself",
    detail: "Whoever holds the QR code can use it once.",
    fix: "Treat it like a physical ticket. It is stored only on the attendee's device.",
  },
];

const TRUST = [
  "The server's wallet holds deposits until the event is settled. A dishonest operator could keep them, so deposits should stay small (the price of a coffee).",
  "The organiser's links are bearer secrets. Anyone with the manage link can settle or purge the event.",
  "The door device sees ticket hashes and the event's check-in count. It never sees refund addresses.",
  "Unlisted can't hide that an event exists, or protect against someone photographing the room.",
];

export default function Privacy() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <p className="eyebrow">Threat model</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">What we store, what could leak, and what you trust us with.</h1>
      <p className="mt-5 text-lg leading-relaxed text-ink-2">
        Privacy that only looks right is worse than none, because people rely on it. Here is the whole picture.
      </p>

      <h2 className="mt-14 text-xl font-semibold">Everything the server ever stores</h2>
      <div className="card mt-4 divide-y divide-ink/5">
        {STORED.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-5 py-4 sm:grid-cols-[14rem_1fr]">
            <div className="font-medium">{k}</div>
            <div className="text-sm text-ink-3">{v}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm text-ink-3">
        After an organiser purges a settled event, only aggregate counts remain: how many RSVPed, came, were refunded
        and were forfeited.
      </p>

      <h2 className="mt-14 text-xl font-semibold">Known leaks and how each is closed</h2>
      <div className="mt-4 grid gap-4">
        {LEAKS.map((l) => (
          <div key={l.risk} className="card p-5">
            <div className="font-semibold">{l.risk}</div>
            <p className="mt-1 text-sm text-ink-3">{l.detail}</p>
            <p className="mt-3 text-sm"><span className="font-semibold text-ok">Mitigation · </span>{l.fix}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-14 text-xl font-semibold">What you are trusting</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-2">
        {TRUST.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </div>
  );
}
