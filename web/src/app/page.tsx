import Link from "next/link";

import { DemoCta } from "@/components/DemoCta";
import { TapeDeck } from "@/components/TapeDeck";
import { TAPES } from "@/components/tapes";

const STEPS = [
  {
    n: "01",
    title: "RSVP with a refundable deposit",
    body: "Attendees scan one QR code with any Zcash wallet. The deposit is shielded: nobody can see who paid, including the organiser.",
  },
  {
    n: "02",
    title: "Show a ticket at the door",
    body: "The ticket is a random secret made on the attendee's phone. The door checks its hash against a list of hashes, and never learns a name.",
  },
  {
    n: "03",
    title: "Get the deposit back",
    body: "Everyone who came is refunded automatically, to an address only they know. No-show deposits go to the group's fund.",
  },
];

const SEIZED = [
  ["Names", "Every attendee", "None"],
  ["Emails / phone numbers", "Every attendee", "None"],
  ["Wallet or card details", "Every attendee", "None"],
  ["Who paid", "Yes", "Hidden by the shielded pool"],
  ["Who showed up", "Check-in list with timestamps", "Which anonymous tickets came, no times; only a count after the purge"],
  ["After the event", "Kept forever", "Deleted with one click"],
];

export default function Home() {
  return (
    <>
      <h1 className="sr-only">cashr: RSVPs without a guest list</h1>
      {/* The deck fills the screen from the very top, under the on-screen display. */}
      <div className="-mt-24 sm:-mt-32">
        <TapeDeck tapes={TAPES} />
      </div>

      <div className="mx-auto max-w-page space-y-24 px-4 pb-8 pt-10 sm:px-8">
        <section className="flex flex-wrap items-center gap-3">
          <Link href="/new" className="btn bg-gold text-gold-on hover:bg-gold/90">Create an event</Link>
          <DemoCta />
          <span className="text-sm text-ink-3">The demo runs the same app on a simulated chain, so you can try every step.</span>
        </section>

        <section>
          <p className="eyebrow">For groups that can&rsquo;t afford a leaked list</p>
          <h2 className="mt-3 max-w-3xl text-5xl leading-[1.02] sm:text-6xl">
            The guest list is the liability. <span className="text-ink-3">So we don&rsquo;t keep one.</span>
          </h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="card p-6">
                <div className="osd text-gold-ink">{s.n}</div>
                <h3 className="mt-3 text-lg font-medium">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-3">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-start">
          <div>
            <p className="eyebrow">If the organiser&rsquo;s laptop is seized</p>
            <h2 className="mt-3 text-5xl leading-[1.02]">There is nothing on it to find.</h2>
            <p className="mt-5 leading-relaxed text-ink-2">
              Every RSVP tool keeps a database of people. Breaches, subpoenas and stolen devices turn it into a target list.
              cashr stores no names, emails or phone numbers: only random ticket hashes, one-time refund addresses and
              payment records, and it deletes them when the organiser purges the event.
            </p>
            <p className="mt-4 leading-relaxed text-ink-2">
              That works because of Zcash&rsquo;s shielded pool: a deposit can come from someone unknown, and a refund can go
              back to them, with nothing on the public chain linking either to a person.
            </p>
            <Link href="/privacy" className="btn-secondary mt-6">Read the threat model</Link>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="osd text-ink-3">
                <tr>
                  <th className="px-5 py-3 font-medium">A seized server reveals</th>
                  <th className="px-5 py-3 font-medium">Typical RSVP tool</th>
                  <th className="px-5 py-3 font-medium">cashr</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/[0.08]">
                {SEIZED.map(([field, them, us]) => (
                  <tr key={field}>
                    <td className="px-5 py-3.5 font-medium">{field}</td>
                    <td className="px-5 py-3.5 text-bad">{them}</td>
                    <td className="px-5 py-3.5 text-ok">{us}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card flex flex-col items-start justify-between gap-6 p-8 sm:flex-row sm:items-center sm:p-10">
          <div>
            <h2 className="text-4xl leading-tight">Running something sensitive this week?</h2>
            <p className="mt-2 max-w-xl text-ink-2">
              Create an event in a minute. No account, no email, no name: not for you, and not for your attendees.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/new" className="btn bg-gold text-gold-on hover:bg-gold/90">Create an event</Link>
            <DemoCta />
            <Link href="/app" className="btn-secondary">Open the app</Link>
            <Link href="/docs" className="btn-ghost">Docs</Link>
          </div>
        </section>
      </div>
    </>
  );
}
