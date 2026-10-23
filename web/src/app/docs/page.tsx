import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { DEMO_URL, FAUCET_URL, TESTNET_URL } from "@/lib/site";


export const metadata: Metadata = { title: "Docs" };

const SECTIONS = [
  ["overview", "Overview"],
  ["organisers", "Hosting an event"],
  ["attendees", "RSVPing"],
  ["door", "At the door"],
  ["how-it-works", "How it works"],
  ["money", "Deposits & fees"],
  ["privacy", "Privacy"],
  ["self-hosting", "Self-hosting"],
  ["api", "API reference"],
  ["faq", "FAQ"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-32 border-t border-ink/10 pt-10">
      <h2 className="text-4xl sm:text-5xl">{title}</h2>
      <div className="docs-prose mt-5 space-y-4 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function Steps({ items }: { items: [string, ReactNode][] }) {
  return (
    <ol className="mt-2 space-y-3">
      {items.map(([title, body], i) => (
        <li key={title} className="card flex gap-4 p-4">
          <span className="osd shrink-0 pt-0.5 text-gold-ink">{String(i + 1).padStart(2, "0")}</span>
          <div>
            <div className="font-medium text-ink">{title}</div>
            <div className="mt-1 text-sm text-ink-3">{body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="osd text-ink-3">
          <tr>{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink/[0.08]">
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-3 align-top text-ink-2">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[3px] bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[12.5px] text-ink">{children}</code>
);

export default function Docs() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <div className="max-w-3xl">
        <p className="eyebrow">Documentation</p>
        <h1 className="mt-3 text-5xl sm:text-6xl">cashr, end to end.</h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-2">
          Everything an organiser, attendee, door volunteer or self-hoster needs: how to use cashr, what it protects,
          what it costs, and how it works underneath.
        </p>
        <p className="mt-3 text-ink-2">
          To try every step without ZEC, use the demo at{" "}
          <a href={DEMO_URL} className="underline decoration-ink-4 underline-offset-4 hover:text-ink">{DEMO_URL.replace(/^https?:\/\//, "")}</a>:
          the same app on a simulated chain. To try it on a real chain with free test coins, use{" "}
          <a href={TESTNET_URL} className="underline decoration-ink-4 underline-offset-4 hover:text-ink">{TESTNET_URL.replace(/^https?:\/\//, "")}</a>{" "}
          with a testnet wallet and ZEC from the{" "}
          <a href={FAUCET_URL} className="underline decoration-ink-4 underline-offset-4 hover:text-ink">faucet</a>.
        </p>
      </div>

      <div className="mt-10 grid gap-12 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="Docs contents" className="hidden lg:block">
          <ul className="osd sticky top-32 space-y-2.5 text-ink-3">
            {SECTIONS.map(([id, label]) => (
              <li key={id}><a href={`#${id}`} className="glitch inline-block hover:text-ink">{label}</a></li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-14">
          <section id="overview" className="scroll-mt-32">
            <div className="docs-prose max-w-3xl space-y-4 text-[15px] leading-relaxed text-ink-2">
              <p>
                cashr is RSVPs for groups whose attendee list would hurt people if it leaked: support groups, union
                organisers, journalists and their sources, activists. A small refundable deposit in shielded ZEC stops
                no-shows. The deposit hides who paid, the ticket is a secret that lives only on the attendee&rsquo;s
                phone, and the refund goes back to an address only the attendee knows.
              </p>
              <p>
                The result: the server never has a list of people to leak. For an event it holds the event&rsquo;s details,
                random ticket hashes, one-time refund addresses and payment records (the full list is on the threat model
                page), and it deletes them when the organiser purges the event.
              </p>
            </div>
          </section>

          <Section id="organisers" title="Hosting an event">
            <Steps
              items={[
                ["Create the event", <>On <Link href="/new" className="text-ink underline underline-offset-4">Create event</Link>, set a name, time, capacity and refundable deposit (minimum 0.001 ZEC). The place is public: for sensitive venues, write something like &ldquo;sent on Signal after you RSVP&rdquo;.</>],
                ["Save your two private links", "You get a manage link and a door link, shown once. cashr stores only a hash of them, so it can't recover them. Keep them in a password manager. You can also choose to remember them on this device."],
                ["Share the public RSVP link", "Send it however your group already talks. Anyone with it can RSVP until the event is full or you close RSVPs."],
                ["Check people in", "Open the door link on the phone at the entrance and scan tickets. It works offline and syncs when the connection returns."],
                ["End the event & refund", "On the dashboard, End event & refund sends everyone who checked in their deposit back. Deposits of people who didn't come are forfeited, and swept to your group's fund address if you set one."],
                ["Purge", "Once refunds are done, Purge deletes every ticket hash, refund address and payment record. Only totals remain."],
              ]}
            />
            <p>
              <strong className="text-ink">If everyone comes</strong>, there are no forfeited deposits to pay network
              fees. The dashboard will ask you to send a small top-up (about 0.001 ZEC, no memo) to the event address,
              and refunds then go out automatically.
            </p>
          </Section>

          <Section id="attendees" title="RSVPing">
            <p>You need a Zcash wallet that holds shielded ZEC and can pay a payment link with a memo, such as ZODL.</p>
            <Steps
              items={[
                ["Open the invite", "Open the link, or paste it on the Join page."],
                ["Give a refund address", <>In your wallet, open <em>Receive</em> and copy the shielded address (it starts with <C>u1</C>). Use a fresh one: an address used for another RSVP would link the two. The page checks it can receive a private (Orchard) refund before you pay.</>],
                ["Pay the deposit", "Scan the QR code or tap Open in wallet app. The amount and memo are filled in; don't change them. Your ticket shows as confirmed within about three hours (often sooner): the public list updates at random moments, so nobody can time yours."],
                ["Keep your ticket", "Your ticket appears as a QR code. Save the image: it is stored only in this browser, and it is the only way in and the only way to get your deposit back."],
                ["Show it at the door, get refunded", "After the event, the deposit returns to your refund address."],
              ]}
            />
            <p>Your tickets are listed on the <em>Tickets</em> page, on this device only.</p>
            <Table
              head={["If your payment is returned", "Why"]}
              rows={[
                ["The event was full", "Seats go in block order. Returned minus 0.0001 ZEC."],
                ["The amount didn't match", "Every RSVP must pay exactly the deposit, so payments look identical on chain."],
                ["RSVPs had closed", "The organiser closed RSVPs or the deadline passed."],
                ["The refund address was already used for this event", "Each ticket needs its own refund address."],
                ["The memo was changed", "Without the memo there is no ticket. A payment with no readable refund address can't be returned."],
              ]}
            />
          </Section>

          <Section id="door" title="At the door">
            <p>
              Open the door link on a phone and tap <em>Start scanning</em>. Each ticket shows <em>Welcome in</em>,{" "}
              <em>Already checked in</em>, <em>Not a valid ticket</em> or <em>Wrong event</em>. You can also paste a ticket
              code by hand.
            </p>
            <p>
              The door keeps a copy of the event&rsquo;s ticket hashes, so it keeps working if the connection drops. It
              queues check-ins and syncs them when it&rsquo;s back online. It never sees names or refund addresses, and it
              records whether a ticket was used, not when.
            </p>
          </Section>

          <Section id="how-it-works" title="How it works">
            <Steps
              items={[
                ["One wallet account per event", "Each event gets its own account from its own random seed (encrypted at rest), with an Orchard-only (shielded) address and a birthday at the current block. Purging the event deletes the seed."],
                ["A secret on the attendee's phone", "The browser makes 32 random bytes and keeps them. Only SHA-256 of that secret leaves the device."],
                ["The memo", <>The payment carries one encrypted line: <C>CSH1 &lt;event&gt; &lt;ticket hash&gt; &lt;refund address&gt;</C>. Only the event&rsquo;s wallet can read it.</>],
                ["The wallet reads it", "A light-client wallet syncs from lightwalletd, fetches the full transaction over Tor (after a random delay) to decrypt the memo, and the API records the hash and the refund address's Orchard receiver."],
                ["The door checks a hash", "The ticket QR holds the secret; the door hashes it and looks the hash up."],
                ["Refunds stay in Orchard", "Each refund is its own Orchard-to-Orchard send with the FullPrivacy policy, at a random time within about three hours, so no amount, recipient or group of attendees is revealed."],
              ]}
            />
            <p>
              Why only Zcash can do this: cards and PayPal give the organiser a name; Bitcoin and Ethereum put payer and
              refund on a public ledger. Shielded Zcash hides sender, receiver and amount, and carries the refund
              instructions inside the payment.
            </p>
          </Section>

          <Section id="money" title="Deposits & fees">
            <Table
              head={["", ""]}
              rows={[
                ["Deposit", "Set by the organiser, minimum 0.001 ZEC. Refunded in full to everyone who checks in."],
                ["Returned payments", "Refunded minus 0.0001 ZEC, so junk payments can't drain the event's fees."],
                ["Network fees for refunds", "Paid from forfeited deposits and organiser top-ups, never from refunds."],
                ["When a refund counts as paid", "Once its transaction is mined with 3 confirmations. One that expires unmined is sent again automatically; it is never paid twice."],
                ["No-show money", "Swept, minus the network fee, to the organiser's no-show fund address once refunds have confirmed. Without an address it waits in the event wallet, and the event can't be purged until it is swept."],
                ["When refunds can go out", "A deposit becomes spendable after 10 confirmations (about 12 minutes). Refunds queued earlier simply wait."],
                ["Who holds the money", "cashr's wallet holds deposits until the event is settled. Keep deposits small: the price of a coffee."],
              ]}
            />
          </Section>

          <Section id="privacy" title="Privacy">
            <p>
              The server never stores names, emails, phone numbers, check-in times or ticket secrets, and the API keeps no
              access logs. (Your hosting provider&rsquo;s edge may still log IP addresses; use Tor for high-risk events.) Organiser
              and door links keep their secret after the <C>#</C>, which browsers never send to any server. Attendees never
              send the server anything that points at their ticket.
            </p>
            <p>
              Read the full <Link href="/privacy" className="text-ink underline underline-offset-4">threat model</Link> for
              what is stored, every known leak and how it is closed, and what you are trusting.
            </p>
          </Section>

          <Section id="self-hosting" title="Self-hosting">
            <p>
              cashr is three pieces: this web app, a FastAPI service, and <C>cashr-wallet</C>, a light-client Zcash
              wallet built on librustzcash that syncs from a public lightwalletd server over Tor, so no full node is needed.
            </p>
            <pre className="panel overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-ink">{`# On a fresh Ubuntu server, as root: wallet + API + HTTPS, secrets generated for you
curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- api.example.com
# Back up the wallet volume and, separately, CASHR_WALLET_SEED_KEY. Both are needed to move funds.`}</pre>
            <p>
              Put HTTPS in front of the API, then deploy <C>web/</C> to Netlify or Vercel with{" "}
              <C>NEXT_PUBLIC_API_URL</C> set to the API&rsquo;s URL. Run exactly one API process: it refuses to start if
              another holds its database. Full settings are in{" "}
              <a href="https://github.com/linoxbt/cashr/blob/main/docs/DEPLOY.md" className="text-ink underline underline-offset-4">docs/DEPLOY.md</a>.
            </p>
          </Section>

          <Section id="api" title="API reference">
            <p>JSON over HTTPS. Organiser and door routes take <C>Authorization: Bearer &lt;token&gt;</C>.</p>
            <Table
              head={["Method & path", "Auth", "Does"]}
              rows={[
                [<C key="a">GET /meta</C>, "—", "Chain mode, network, current block, reject fee."],
                [<C key="a">POST /events</C>, "—", "Create an event. Returns the event, the admin token and the door token (once)."],
                [<C key="a">GET /events/:id</C>, "—", "Public event details and counts."],
                [<C key="a">GET /events/:id/tickets</C>, "—", "Every ticket hash, plus returned payments. Statuses appear only once the event settles."],
                [<C key="a">GET /events/:id/admin</C>, "Admin", "Everything stored for the event, the wallet balance and payouts."],
                [<C key="a">POST /events/:id/admin/:action</C>, "Admin", <>Actions: <C>close</C>, <C>reopen</C>, <C>settle</C>, <C>retry</C>, <C>purge</C>, <C>scan</C>. Purge refuses while money is left in the event wallet.</>],
                [<C key="a">POST /events/:id/admin/fund</C>, "Admin", <>Body <C>{`{"address"}`}</C>. Set the no-show fund address; a settled event&rsquo;s leftovers are swept to it.</>],
                [<C key="a">GET /events/:id/door/manifest</C>, "Door", "Confirmed ticket hashes for offline checking."],
                [<C key="a">POST /events/:id/door/checkin</C>, "Door", <>Body <C>{`{"ticket_hash"}`}</C>. Result: ok, already, unknown or event_closed.</>],
                [<C key="a">POST /events/:id/door/sync</C>, "Door", "Upload check-ins recorded offline."],
              ]}
            />
          </Section>

          <Section id="faq" title="FAQ">
            {[
              ["Can the organiser see who came?", "No. They see how many tickets were checked in, never whose. The deposit's sender is hidden even from the event's own wallet."],
              ["What if I lose my ticket?", "It can't be recovered: no one else has the secret. Save the ticket image when you RSVP."],
              ["What if the organiser loses their links?", "The event keeps working for attendees, but no one can settle it. Funds stay in the event's wallet account, which only the server operator can move."],
              ["Can I use a transparent (t-address) balance?", "Paying from a transparent balance exposes your address. Pay from your shielded balance; refunds always go to a shielded address."],
              ["Why does my ticket say Not listed yet?", "The public list updates at random moments, up to about three hours apart, so nobody can tell when your payment arrived. If it still isn't listed after that, check the amount and memo were unchanged."],
              ["Can a seized server be used to get in?", "No. It holds only hashes of tickets, and the door needs the secret behind the hash."],
            ].map(([q, a]) => (
              <div key={q} className="card p-5">
                <div className="font-medium text-ink">{q}</div>
                <p className="mt-1.5 text-sm text-ink-3">{a}</p>
              </div>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
