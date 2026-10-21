import Link from "next/link";

const STEPS = [
  {
    n: "01",
    title: "RSVP with a refundable deposit",
    body: "Attendees scan one QR code with any Zcash wallet. The deposit is shielded: nobody can see who paid, including you.",
  },
  {
    n: "02",
    title: "Show a ticket at the door",
    body: "The ticket is a random secret generated on the attendee's phone. The door checks it against a list of hashes. It never learns a name.",
  },
  {
    n: "03",
    title: "Get your deposit back",
    body: "People who came are refunded automatically to an address only they know. No-show deposits go to your group's fund.",
  },
];

const SEIZED = [
  { field: "Names", them: "Every attendee", us: "None" },
  { field: "Emails / phone numbers", them: "Every attendee", us: "None" },
  { field: "Wallet or card details", them: "Every attendee", us: "None" },
  { field: "Who paid", them: "Yes", us: "Hidden by the shielded pool" },
  { field: "Who showed up", them: "Check-in list with timestamps", us: "A count" },
  { field: "After the event", them: "Kept forever", us: "Deleted with one click" },
];

export default function Home() {
  return (
    <>
      <section className="mx-auto max-w-page px-4 pb-16 pt-20 sm:px-6 sm:pt-28">
        <div className="max-w-3xl">
          <p className="eyebrow">For groups that can&rsquo;t afford a leaked list</p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
            The guest list is the liability.
            <span className="block text-ink-3">So we don&rsquo;t keep one.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
            Unlisted is RSVPs for support groups, organisers, journalists and anyone else whose attendee list would hurt
            people if it leaked. A small refundable deposit in shielded ZEC stops no-shows. Nobody, not even you, ever
            holds a list of who came.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/new" className="btn-primary px-5 py-3 text-base">Create an event</Link>
            <Link href="/how-it-works" className="btn-secondary px-5 py-3 text-base">How it works</Link>
          </div>
        </div>
      </section>

      <section className="border-y border-ink/10 bg-white">
        <div className="mx-auto grid max-w-page gap-px bg-ink/10 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-white px-6 py-10">
              <div className="font-mono text-sm text-gold-ink">{s.n}</div>
              <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-3">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-page px-4 py-20 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.3fr] lg:items-start">
          <div>
            <p className="eyebrow">If the organiser&rsquo;s laptop is seized</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">There is nothing on it to find.</h2>
            <p className="mt-4 leading-relaxed text-ink-2">
              Every RSVP tool keeps a database of people. Breaches, subpoenas and stolen devices turn that database
              into a target list. Unlisted only stores random ticket hashes and one-time refund addresses, and deletes
              those after the event.
            </p>
            <p className="mt-4 leading-relaxed text-ink-2">
              That works because of Zcash&rsquo;s shielded pool: a deposit can come from someone unknown, and a refund
              can go back to them, with nothing on the public chain linking either one to a person.
            </p>
            <Link href="/privacy" className="mt-6 inline-block text-sm font-semibold underline decoration-gold decoration-2 underline-offset-4">
              Read the full threat model
            </Link>
          </div>
          <div className="card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2/60 text-xs uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-5 py-3 font-semibold">What a seized server reveals</th>
                  <th className="px-5 py-3 font-semibold">Typical RSVP tool</th>
                  <th className="px-5 py-3 font-semibold">Unlisted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5">
                {SEIZED.map((r) => (
                  <tr key={r.field}>
                    <td className="px-5 py-3.5 font-medium">{r.field}</td>
                    <td className="px-5 py-3.5 text-bad">{r.them}</td>
                    <td className="px-5 py-3.5 text-ok">{r.us}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-page px-4 sm:px-6">
        <div className="card flex flex-col items-start justify-between gap-6 bg-ink p-8 text-paper sm:flex-row sm:items-center sm:p-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Running something sensitive this week?</h2>
            <p className="mt-2 max-w-xl text-paper/70">
              Create an event in a minute. No account, no email, no name required, for you or your attendees.
            </p>
          </div>
          <Link href="/new" className="btn bg-gold px-5 py-3 text-base text-ink hover:bg-gold/90">Create an event</Link>
        </div>
      </section>
    </>
  );
}
