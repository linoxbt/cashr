// The six VHS sleeves: one per idea in cashr. Shown on the home page.
import type { Tape } from "@/components/TapeDeck";

// ---- cover art (SVG, inherits the tape colour) --------------------------------

function RedactedList() {
  const rows = [0.82, 0.64, 0.9, 0.55, 0.74, 0.6];
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      <text x="8" y="12" fontSize="6" fill="currentColor" fontFamily="monospace" opacity="0.8">GUEST LIST</text>
      {rows.map((w, i) => (
        <g key={i}>
          <text x="8" y={24 + i * 11} fontSize="5.5" fill="currentColor" fontFamily="monospace" opacity="0.6">{String(i + 1).padStart(2, "0")}</text>
          <rect x="18" y={19 + i * 11} width={74 * w} height="6" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

function Coin() {
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      {[34, 27, 20].map((r) => (
        <circle key={r} cx="50" cy="45" r={r} fill="none" stroke="currentColor" strokeWidth={r === 34 ? 2 : 1} opacity={r === 20 ? 0.6 : 1} />
      ))}
      <text x="50" y="49" fontSize="10" textAnchor="middle" fill="currentColor" fontFamily="monospace">ZEC</text>
    </svg>
  );
}

function TicketGrid() {
  // Deterministic "QR" pattern.
  const cells = Array.from({ length: 121 }, (_, i) => ((i * 7919) % 13) % 3 === 0);
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      <g transform="translate(23 18)">
        {cells.map((on, i) =>
          on ? <rect key={i} x={(i % 11) * 5} y={Math.floor(i / 11) * 5} width="4.4" height="4.4" fill="currentColor" /> : null,
        )}
        {[[0, 0], [40, 0], [0, 40]].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <rect x={x} y={y} width="15" height="15" fill="#070707" stroke="currentColor" strokeWidth="2.2" />
            <rect x={x + 5} y={y + 5} width="5" height="5" fill="currentColor" />
          </g>
        ))}
      </g>
    </svg>
  );
}

function RefundLoop() {
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      <path d="M28 45a22 22 0 0 1 38-15" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M72 45a22 22 0 0 1-38 15" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M60 24l8 6-9 4z" fill="currentColor" />
      <path d="M40 66l-8-6 9-4z" fill="currentColor" />
      <text x="50" y="49" fontSize="9" textAnchor="middle" fill="currentColor" fontFamily="monospace">ZEC</text>
    </svg>
  );
}

function SeizedLaptop() {
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      <rect x="22" y="18" width="56" height="38" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M14 64h72l-6 7H20z" fill="currentColor" />
      <text x="50" y="35" fontSize="6" textAnchor="middle" fill="currentColor" fontFamily="monospace">0 NAMES</text>
      <text x="50" y="45" fontSize="6" textAnchor="middle" fill="currentColor" fontFamily="monospace" opacity="0.6">0 EMAILS</text>
      <path d="M8 8l84 74" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  );
}

export const TAPES: Tape[] = [
  {
    id: "no-list",
    title: ["No", "Guest", "List"],
    color: "#E0262B",
    caption: "Host an event whose attendee list can never leak. Set a deposit and a capacity; no account needed.",
    tags: ["▶ Play: create an event"],
    href: "/new",
  },
  {
    id: "deposit",
    title: ["The", "Deposit"],
    color: "#F4B728",
    caption: "Got an invite? Pay a small refundable deposit in shielded ZEC. Nobody can see who paid.",
    tags: ["▶ Play: RSVP to an event"],
    href: "/join",
    art: <Coin />,
  },
  {
    id: "door",
    title: ["The", "Door"],
    color: "#7C5CFF",
    caption: "Scan tickets at the entrance. The door checks a hash, never a name, and works offline.",
    tags: ["▶ Play: open the scanner"],
    href: "/door",
    art: <TicketGrid />,
  },
  {
    id: "refund",
    title: ["The", "Refund"],
    color: "#3DD68C",
    caption: "Your tickets, on this device only: going, then refunded to an address only you know.",
    tags: ["▶ Play: your tickets"],
    href: "/tickets",
    art: <RefundLoop />,
  },
  {
    id: "seized",
    title: ["Seized"],
    color: "#3B6CFF",
    caption: "Open your event dashboard and see exactly what a seized server would reveal: nothing that names anyone.",
    tags: ["▶ Play: your events"],
    href: "/events",
    art: <SeizedLaptop />,
  },
  {
    id: "purge",
    title: ["Purge"],
    color: "#E8E1D0",
    caption: "After the event, refund everyone who came, then delete every ticket hash and address for good.",
    tags: ["▶ Play: settle & purge"],
    href: "/events",
    art: <RedactedList />,
  },
];
