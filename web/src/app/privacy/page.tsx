import type { Metadata } from "next";

export const metadata: Metadata = { title: "Threat model" };

const STORED = [
  ["Event details", "Title, time, place, capacity, deposit. On purge, everything that names, places or dates the event is wiped, including when it was created, so an event id left in an attendee's wallet leads nowhere."],
  ["Ticket hash", "SHA-256 of a random secret. Reveals nothing about the person."],
  ["Refund address", "Only its Orchard (shielded) receiver, even if your wallet's address also carries a transparent one. Unlinkable to your other addresses. Deleted on purge."],
  ["Checked in", "A yes/no per ticket, never a time. Neither the ticket's state nor the check-in count is public while the event runs; every outcome appears at once when it settles."],
  ["Seat", "A random number, so it says nothing about the order people paid in."],
  ["Deposit notes", "Transaction id and amount, so no payment is counted twice. No block height, and an accepted deposit doesn't keep its ticket hash, so these records alone can't match a transaction to a ticket; a returned payment keeps its ticket hash, for the public list. Until the purge, though, the event's wallet (below) still holds each deposit's memo, which names its ticket. The sender is never visible, even to the wallet. Deleted on purge."],
  ["Payouts", "Each refund, return and sweep: its recipient's refund address, amount, memo and transaction id. Deleted on purge."],
  ["Link hashes", "SHA-256 hashes of the manage and door links, so the server can check them without storing them."],
  ["The event's wallet account", "Its own seed (encrypted at rest) and the deposits' memos. Purging deletes the account and the seed and rewrites the wallet file, so the memos can't be decrypted again, even from the chain. The wallet keeps the chain blocks it has scanned (heights and times, shared by all events), which name no event."],
  ["Backups", "An encrypted copy of the above, taken nightly and kept for seven days on the same server. Its key is on that server too, so whoever seizes the server within a week of a purge can still read that event's records."],
];

const LEAKS = [
  {
    risk: "Timing on the public ticket list",
    detail: "Anyone with the invite link can read the list of ticket hashes. If each ticket appeared the moment its payment confirmed, polling the list would time every payment.",
    fix: "The public list changes only at random moments one to three hours apart, scheduled from the event's creation and never triggered by a payment, plus when RSVPs close. New tickets and returned payments appear together at those moments; the public RSVP count, seats left and the full flag follow the list; and no check-in count is public until the event settles.",
  },
  {
    risk: "Who came together",
    detail: "One refund paying many attendees would be fetched by each of their wallets from a sync server, showing its operator a group of people who attended together.",
    fix: "Every refund is its own transaction, sent at a random time within about three hours of the event ending, and the public list shows everyone who came as \"refunding\" until all refunds are done, so it can't time any one of them.",
  },
  {
    risk: "The sync servers (lightwalletd)",
    detail: "Light wallets, including attendees' own and the server's, fetch transactions from a sync server, which sees the requesting IP address and which transactions it asks about.",
    fix: "The server's wallet talks to its sync server over Tor: each transaction it fetches (a random one to five minutes after first seeing it) and each one it broadcasts gets a fresh circuit, and nothing public changes in step with those requests. Your own wallet is outside cashr's control: for high-risk events, use a wallet that connects over Tor or to a server you trust, and pay from a shielded balance.",
  },
  {
    risk: "Reusing a refund address",
    detail: "The same address at two events would link one person's attendance across both.",
    fix: "Within an event, a reused address is refused and the deposit returned. Across events the server doesn't check: refusing would tell anyone who pays into their own event with someone else's address whether that address paid for an RSVP here. Use a fresh address for each RSVP (wallets show a new one on every Receive); the RSVP page asks you to confirm it.",
  },
  {
    risk: "Network metadata",
    detail: "Loading a page reveals an IP address to the web host and the API host, and their providers may log it.",
    fix: "The API and the HTTPS proxy in front of it keep no access logs. Confirmation downloads every ticket hash, so no request points at one ticket; every visitor of an event page polls at the same jittered pace whatever their ticket's state, even while the tab is in the background; and your ticket list never asks about all your events at once. For high-risk groups, open the pages over Tor.",
  },
  {
    risk: "What stays in your wallet",
    detail: "Memos stay in a wallet's history for good, and anyone who later sees the wallet can read them.",
    fix: "Refunds and returns carry a fixed memo that never names the event, and purging wipes everything that would name or date it, so the event id in your deposit memo leads nowhere.",
  },
  {
    risk: "Odd amounts",
    detail: "A unique deposit amount could stand out.",
    fix: "Every RSVP must pay exactly the same deposit, so inside the shielded pool they all look alike. Anything else is returned. Organisers should pick a round amount.",
  },
  {
    risk: "Transparent funds",
    detail: "Paying from a transparent (t-address) balance shows the payer's address and the exact deposit amount on the public chain, which can tie them to the event.",
    fix: "Event addresses are Orchard-only, refunds go Orchard-to-Orchard with the wallet's FullPrivacy policy, and only the Orchard part of a refund address is kept. Attendees should pay from a shielded balance.",
  },
  {
    risk: "Your phone",
    detail: "Whoever holds the ticket QR can use it once, and your browser keeps your tickets, with each event's name and date, so they can be listed without asking the server.",
    fix: "The refund address is dropped from your browser the next time the ticket is opened or checked after your payment is in, the saved ticket image doesn't print the event's name (its code carries the event id, which the door needs), and a ticket is removed the next time it is opened or checked after its event is purged. Remove tickets for past events from your ticket list, or all of them at once.",
  },
];

const TRUST = [
  "The server's wallet holds deposits until the event is settled. A dishonest operator could keep them, so deposits should stay small (the price of a coffee).",
  "The organiser's links are bearer secrets. Anyone with the manage link can settle or purge the event.",
  "The door device sees ticket hashes, seats and the live check-in count, and keeps the hashes to work offline until the event is settled. It never sees refund addresses. Whoever holds the door link can check in any listed ticket, and a checked-in ticket is refunded: give it only to people you'd trust with the deposits.",
  "The organiser's dashboard is live: it shows each ticket's hash and seat as soon as its payment confirms, check-ins as they happen, and refund transaction ids. It never shows refund addresses or deposit transaction ids. Treat the manage link like the guest list it replaces.",
  "After a purge, the event's id still answers with its counts (RSVPs, check-ins, deposit and capacity) and nothing else; its database row keeps its storage position among other events.",
  "This public instance runs on a shared server. A server is only as private as its operator and its host: high-risk groups should run their own (one command, see the docs).",
  "cashr can't hide that an event exists, or protect against someone photographing the room.",
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
