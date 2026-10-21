import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "How it works" };

const FLOW = [
  {
    who: "Organiser",
    title: "Creates an event",
    body: "Unlisted opens a fresh Orchard (shielded) account in its wallet just for this event. The organiser gets two private links: one to manage the event, one for the door.",
  },
  {
    who: "Attendee's phone",
    title: "Makes a ticket",
    body: "The browser generates a random 32-byte secret and keeps it. It puts only the SHA-256 hash of that secret, plus a refund address the attendee pastes from their own wallet, into a payment memo.",
  },
  {
    who: "Attendee's wallet",
    title: "Pays the deposit",
    body: "The page shows a standard ZIP 321 payment link. One scan in ZODL (or any Zcash wallet) pays the deposit, with the memo encrypted to the event's address.",
  },
  {
    who: "Unlisted server",
    title: "Confirms the RSVP",
    body: "The server's wallet decrypts the memo and records the ticket hash and refund address, nothing more. Seats go in block order. A wrong amount, a full event or a reused address is returned automatically.",
  },
  {
    who: "Door",
    title: "Checks the ticket",
    body: "The attendee shows a QR code of their secret. The door phone hashes it and looks for the hash in its list. It works offline and records a yes/no, not a time.",
  },
  {
    who: "Organiser",
    title: "Settles, then purges",
    body: "One click refunds everyone who came, in batched shielded sends. No-show deposits go to the group's fund. A second click deletes every ticket hash and refund address for good.",
  },
];

export default function HowItWorks() {
  return (
    <div className="mx-auto max-w-page px-4 py-16 sm:px-6">
      <p className="eyebrow">How it works</p>
      <h1 className="mt-3 max-w-3xl text-5xl sm:text-6xl ">
        A deposit, a secret and a refund, with nothing in between that names anyone.
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2">
        Unlisted uses features only Zcash has: shielded payments, encrypted memos, viewing-only wallet access and
        unlinkable addresses. With them, a server can take a deposit from someone and send it back without ever
        learning who they are.
      </p>

      <ol className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {FLOW.map((s, i) => (
          <li key={s.title} className="card p-6">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm text-gold-ink">{String(i + 1).padStart(2, "0")}</span>
              <span className="eyebrow">{s.who}</span>
            </div>
            <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">{s.body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-20 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="text-3xl ">The memo</h2>
          <p className="mt-3 leading-relaxed text-ink-2">
            Every RSVP payment carries one line of text, encrypted so only the event&rsquo;s wallet can read it:
          </p>
          <pre className="mono-break mt-4 whitespace-pre-wrap panel p-4 text-ink-2">
UNL1 &lt;event id&gt; &lt;base64url(sha256(secret))&gt; &lt;refund address&gt;
          </pre>
          <p className="mt-4 leading-relaxed text-ink-2">
            The secret itself never leaves the attendee&rsquo;s phone until they show it at the door, so the server
            can&rsquo;t mint tickets, and a stolen database can&rsquo;t be used to get in.
          </p>
        </div>
        <div>
          <h2 className="text-3xl ">Why only Zcash can do this</h2>
          <ul className="mt-4 space-y-3 text-ink-2">
            <li><strong className="text-ink">Cards and PayPal</strong> give the organiser a name with every payment.</li>
            <li><strong className="text-ink">Bitcoin and Ethereum</strong> put the payer&rsquo;s address and the refund on a public ledger anyone can trace.</li>
            <li><strong className="text-ink">Shielded Zcash</strong> hides sender, receiver and amount, and carries an encrypted memo with each payment, so the refund instructions travel with the deposit.</li>
          </ul>
          <Link href="/privacy" className="btn-secondary mt-6">Read the threat model</Link>
        </div>
      </section>
    </div>
  );
}
