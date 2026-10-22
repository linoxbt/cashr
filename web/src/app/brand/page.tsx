import type { Metadata } from "next";

import { CoinMark, TicketMark, Wordmark } from "@/components/Logo";

export const metadata: Metadata = { title: "Logo concepts", robots: { index: false } };

const CONCEPTS = [
  {
    id: "1",
    name: "Ticket, name redacted",
    mark: TicketMark,
    note: "A ticket stub whose name line is a solid bar, with a gold punch-hole: a ticket with nobody's name on it.",
  },
  {
    id: "2",
    name: "Shielded coin",
    mark: CoinMark,
    note: "A gold coin with a “c” whose opening is closed by a shield line: money that stays private.",
  },
];

const SIZES = [16, 24, 32, 64, 128];

function Surface({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-end gap-6 rounded-md p-6"
      style={{ background: dark ? "#111111" : "#FFFFFF", color: dark ? "#ECE9E1" : "#16140F", boxShadow: "0 0 0 1px rgba(127,127,127,0.25)" }}
    >
      {children}
    </div>
  );
}

export default function Brand() {
  return (
    <div className="mx-auto max-w-page px-4 py-14 sm:px-6">
      <p className="eyebrow">Brand</p>
      <h1 className="mt-3 text-5xl">Two logo concepts</h1>
      <p className="mt-3 max-w-2xl text-ink-2">
        Each is shown at real sizes, from a 16-pixel browser tab up, on dark and on white, and next to the name. The app
        uses concept 1 until one is chosen.
      </p>

      <div className="mt-12 space-y-16">
        {CONCEPTS.map(({ id, name, mark: Mark, note }) => (
          <section key={id}>
            <div className="flex items-baseline gap-3">
              <span className="osd text-gold-ink">Concept {id}</span>
              <h2 className="text-3xl">{name}</h2>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-ink-3">{note}</p>
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {[true, false].map((dark) => (
                <div key={String(dark)} className="space-y-4">
                  <Surface dark={dark}>
                    {SIZES.map((s) => (
                      <div key={s} className="flex flex-col items-center gap-2">
                        <Mark size={s} title={`${name}, ${s} px`} />
                        <span className="font-mono text-[11px] opacity-60">{s}px</span>
                      </div>
                    ))}
                  </Surface>
                  <Surface dark={dark}>
                    <span style={{ color: dark ? "#ECE9E1" : "#16140F" }}>
                      <Wordmark size={30} mark={Mark} />
                    </span>
                    <span className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-xs"
                      style={{ background: dark ? "#2a2a2a" : "#ececec" }}>
                      <Mark size={14} /> cashr · RSVPs without a guest list
                    </span>
                  </Surface>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
