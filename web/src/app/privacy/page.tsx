import type { Metadata } from "next";

export const metadata: Metadata = { title: "Threat model" };

const STORED = [
  ["Event details", "Title, time, place, capacity, deposit. All but capacity and deposit are wiped on purge, so an event id left in an attendee's wallet no longer leads anywhere."],
  ["Ticket hash", "SHA-256 of a random secret. Reveals nothing about the person."],
  ["Refund address", "A one-time shielded address the attendee chose. Unlinkable to their other addresses."],
  ["Checked in", "A yes/no per ticket. No time, so arrivals can't be matched against cameras. It's never published while the event runs; every ticket's outcome appears at once when the event is settled."],
  ["Seat", "A random number, so it says nothing about the order people paid in."],
  ["Deposit notes", "Transaction id, amount, block height. The sender is never visible, even to the wallet."],
  ["Reused-address digests", "Keyed hashes of refund addresses, only to refuse reuse. Never the address itself. Forgotten after one to two years."],
  ["The event's wallet account", "Its own seed (encrypted at rest) and the deposits' memos. Purging deletes the account and the seed, so the memos can't be decrypted again, even from the chain."],
];

const LEAKS = [
  {
    risk: "Reusing a refund address",
    detail: "The same address at two events would link one person's attendance across both.",
    fix: "The server refuses any address it has seen before and returns the deposit.",
  },
  {
    risk: "Network metadata",
    detail: "Loading a page reveals an IP address to the web host and the API host, and their providers may log it.",
    fix: "The API itself keeps no access logs. Confirmation checks download every ticket hash, so no request points at one ticket, and your ticket list never asks about all your events at once. For high-risk groups, open the pages over Tor.",
  },
  {
    risk: "The wallet's sync server",
    detail: "To read a deposit's memo, the server's wallet fetches that transaction from a lightwalletd server. Its operator would learn which transactions are RSVPs, and could match them to attendees' own wallets broadcasting through the same server.",
    fix: "The wallet reaches lightwalletd through Tor, with a fresh circuit for every transaction it fetches. Operators can also run their own lightwalletd.",
  },
  {
    risk: "What stays in your wallet",
    detail: "Memos stay in a wallet's history for good, and anyone who later sees the wallet can read them.",
    fix: "Refunds and returns carry a fixed memo that never names the event, and purging wipes the event's name, so the event id in your deposit memo leads nowhere.",
  },
  {
    risk: "Odd amounts",
    detail: "A unique deposit amount could stand out.",
    fix: "Every RSVP must pay exactly the same deposit, so inside the shielded pool they all look alike. Anything else is returned. Organisers should pick a round amount.",
  },
  {
    risk: "Transparent funds",
    detail: "Paying from a transparent (t-address) balance shows the payer's address and the exact deposit amount on the public chain, which can tie them to the event.",
    fix: "Event addresses are Orchard-only and refunds are sent with the wallet's FullPrivacy policy. Attendees should pay from a shielded balance.",
  },
  {
    risk: "The ticket itself",
    detail: "Whoever holds the QR code can use it once.",
    fix: "Treat it like a physical ticket. It is stored only on the attendee's device, and the saved image doesn't name the event. Remove tickets for past events from your ticket list.",
  },
];

const TRUST = [
  "The server's wallet holds deposits until the event is settled. A dishonest operator could keep them, so deposits should stay small (the price of a coffee).",
  "The organiser's links are bearer secrets. Anyone with the manage link can settle or purge the event.",
  "The door device sees ticket hashes, seats and the event's check-in count. It never sees refund addresses.",
  "The organiser's dashboard shows each ticket's hash and whether it was checked in, but only a shortened refund address.",
  "Unlisted can't hide that an event exists, or protect against someone photographing the room.",
];

export default function Privacy() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <p className="eyebrow">Threat model</p>
      <h1 className="mt-3 text-5xl sm:text-6xl ">What we store, what could leak, and what you trust us with.</h1>
      <p className="mt-5 text-lg leading-relaxed text-ink-2">
        Privacy that only looks right is worse than none, because people rely on it. Here is the whole picture.
      </p>

      <h2 className="mt-14 text-3xl ">Everything the server ever stores</h2>
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

      <h2 className="mt-14 text-3xl ">Known leaks and how each is closed</h2>
      <div className="mt-4 grid gap-4">
        {LEAKS.map((l) => (
          <div key={l.risk} className="card p-5">
            <div className="font-semibold">{l.risk}</div>
            <p className="mt-1 text-sm text-ink-3">{l.detail}</p>
            <p className="mt-3 text-sm"><span className="font-semibold text-ok">Mitigation · </span>{l.fix}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-14 text-3xl ">What you are trusting</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-2">
        {TRUST.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </div>
  );
}
