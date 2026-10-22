// The cashr marks. Both are drawn in the current text colour plus gold, so
// they follow the theme. `BrandMark` is the one the app uses; /brand shows both.

const GOLD = "#F4B728";

type MarkProps = { size?: number; className?: string; title?: string };

/** Concept 1: a ticket whose name line is redacted, with a gold punch-hole. */
export function TicketMark({ size = 32, className, title }: MarkProps) {
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 48 32" className={className} role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true} aria-label={title}>
      {/* Ticket outline with a notch on each side. */}
      <path
        d="M6 3H42a4 4 0 0 1 4 4V12a4 4 0 0 0 0 8V25a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V20a4 4 0 0 0 0-8V7a4 4 0 0 1 4-4Z"
        fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round"
      />
      {/* Perforation between the ticket and its stub. */}
      <line x1="33.5" y1="7.5" x2="33.5" y2="24.5" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 2.4" opacity="0.5" />
      {/* The event line stays; the name line is a solid bar: nobody's name is on it. */}
      <rect x="8.5" y="9" width="13" height="2.6" rx="1.3" fill="currentColor" opacity="0.45" />
      <rect x="8.5" y="15" width="19.5" height="7.5" rx="1.2" fill="currentColor" />
      <circle cx="40" cy="16" r="3.4" fill={GOLD} />
    </svg>
  );
}

/** Concept 2: a gold coin with a "c" whose opening is closed by a shield line. */
export function CoinMark({ size = 32, className, title }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true} aria-label={title}>
      <circle cx="16" cy="16" r="15" fill={GOLD} />
      <circle cx="16" cy="16" r="12.2" fill="none" stroke="#111111" strokeOpacity="0.28" strokeWidth="1.2" />
      {/* The "c": an open arc... */}
      <path d="M20.9 11.1A6.9 6.9 0 1 0 20.9 20.9" fill="none" stroke="#111111" strokeWidth="3.2" strokeLinecap="round" />
      {/* ...closed by a thin shield line: the money is enclosed, the opening is guarded. */}
      <path d="M20.9 11.1V20.9" stroke="#111111" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="1.6 1.6" />
    </svg>
  );
}

/** The mark the app uses: concept 2, the shielded coin (chosen over the ticket). */
export const BrandMark = CoinMark;

/** The mark with the name, for the header. */
export function Wordmark({ size = 24, mark: Mark = BrandMark }: { size?: number; mark?: typeof TicketMark }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark size={size} />
      <span className="font-display normal-case leading-none tracking-[-0.02em]" style={{ fontSize: size * 1.25 }}>
        cashr
      </span>
    </span>
  );
}
