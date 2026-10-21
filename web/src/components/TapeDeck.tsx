"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface Tape {
  id: string;
  title: string[];
  color: string;
  caption: string;
  tags: string[];
  href: string;
  art?: ReactNode;
  year?: string;
}

/** A VHS sleeve, drawn in CSS: rules, a label, optional art, a tall serif title. */
export function TapeCover({ tape }: { tape: Tape }) {
  const c = tape.color;
  return (
    <article
      className="relative flex h-full w-full select-none flex-col overflow-hidden bg-[#070707] px-[5%] pb-[4%] pt-[3%]"
      style={{ boxShadow: "0 30px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.04)" }}
    >
      <header className="text-center" style={{ color: c }}>
        <div className="h-px w-full opacity-80" style={{ background: c }} />
        <div className="mt-[3%] font-mono text-[0.48em] font-medium uppercase tracking-[0.1em] opacity-70">Unlisted</div>
        <div className="font-display text-[0.95em] italic leading-tight">Shielded Tape</div>
        <div className="mt-[2%] h-px w-full opacity-80" style={{ background: c }} />
      </header>

      {tape.art && (
        <div className="relative mx-[4%] mt-[5%] aspect-[1.55] border" style={{ borderColor: c, color: c }}>
          {tape.art}
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <h3
          className="text-center font-display uppercase"
          style={{
            color: c,
            fontSize: tape.art ? (tape.title.length > 1 ? "2em" : "2.6em") : tape.title.length > 2 ? "2.75em" : "3.4em",
            textShadow: `0 0 18px ${c}33`,
          }}
        >
          {/* Each line is stretched tall; its box is sized to match so lines never overlap. */}
          {tape.title.map((line) => (
            <span key={line} className="block" style={{ height: "1.12em", lineHeight: "1.12em", transform: "scaleY(1.5)" }}>
              {line}
            </span>
          ))}
        </h3>
      </div>

      <footer className="flex items-center justify-between" style={{ color: c }}>
        <span className="border px-1 font-display text-[0.8em] leading-none" style={{ borderColor: c }}>
          ZEC
        </span>
        <span className="font-display text-[0.6em] opacity-80">{tape.year ?? "2026"}</span>
        <svg viewBox="0 0 40 20" className="h-[1.1em] w-[2.2em]" aria-hidden>
          <ellipse cx="20" cy="10" rx="18" ry="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <ellipse cx="20" cy="10" rx="11" ry="8" fill="none" stroke="currentColor" strokeWidth="1" />
          <ellipse cx="20" cy="10" rx="4" ry="8" fill="none" stroke="currentColor" strokeWidth="1" />
          <line x1="2" y1="10" x2="38" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </footer>
    </article>
  );
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Tapes laid out on an arc. Arrow keys or a swipe change tape; clicking a side
 * tape brings it forward; clicking (or Enter on) the centre one plays it.
 */
export function TapeDeck({ tapes }: { tapes: Tape[] }) {
  const router = useRouter();
  const [active, setActive] = useState(0);
  const [jolt, setJolt] = useState(0);
  const drag = useRef<number | null>(null);
  const dragged = useRef(false);
  const n = tapes.length;

  const go = useCallback((delta: number) => {
    setActive((a) => mod(a + delta, n));
    setJolt((j) => j + 1);
  }, [n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Enter" && (!t || t === document.body)) router.push(tapes[active].href);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, router, tapes, active]);

  const current = tapes[active];

  return (
    <div className="flex w-full flex-col items-center">
      <p className="osd mb-6 hidden max-w-md text-center text-ink-3 sm:block">
        Use the left and right arrow keys to change tapes, and enter to play the one in the centre.
      </p>

      <div
        className="relative w-full touch-pan-y [--tape-w:clamp(168px,min(19vw,calc((100dvh_-_22rem)/1.6)),272px)] [overflow-x:clip]"
        style={{ height: "calc(var(--tape-w) * 1.5 + 40px)" }}
        onPointerDown={(e) => (drag.current = e.clientX)}
        onPointerUp={(e) => {
          if (drag.current === null) return;
          const dx = e.clientX - drag.current;
          drag.current = null;
          dragged.current = Math.abs(dx) > 40;
          if (dragged.current) go(dx < 0 ? 1 : -1);
        }}
        role="region"
        aria-roledescription="carousel"
        aria-label="What Unlisted does"
      >
        {tapes.map((tape, i) => {
          // Signed distance from the centre, wrapped so the deck loops.
          let d = mod(i - active, n);
          if (d > n / 2) d -= n;
          const abs = Math.abs(d);
          const visible = abs <= 2;
          const style: React.CSSProperties = {
            width: "var(--tape-w)",
            height: "calc(var(--tape-w) * 1.5)",
            left: "50%",
            top: 0,
            fontSize: "calc(var(--tape-w) / 13)",
            transform: `translateX(calc(-50% + ${d} * var(--tape-w) * 1.28)) translateY(calc(${d * d} * var(--tape-w) * 0.13)) rotate(${d * 15}deg) scale(${1 - abs * 0.04})`,
            filter: d === 0 ? "none" : `brightness(${abs === 1 ? 0.42 : 0.25}) saturate(0.8)`,
            opacity: visible ? 1 : 0,
            zIndex: 10 - abs,
            transition: "transform 700ms cubic-bezier(0.2,0.8,0.2,1), filter 700ms ease, opacity 500ms ease",
            pointerEvents: visible ? "auto" : "none",
          };
          return (
            <button
              key={tape.id}
              type="button"
              className="absolute origin-[50%_120%] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
              style={style}
              tabIndex={d === 0 ? 0 : -1}
              aria-label={d === 0 ? `Play: ${tape.title.join(" ")}` : `Show ${tape.title.join(" ")}`}
              onClick={() => {
                if (dragged.current) return void (dragged.current = false);
                if (d === 0) router.push(tape.href);
                else go(d);
              }}
            >
              <div key={d === 0 ? jolt : undefined} className={`h-full w-full ${d === 0 && jolt ? "jolt" : ""}`}>
                <TapeCover tape={tape} />
              </div>
            </button>
          );
        })}
      </div>

      <div className="osd mt-6 min-h-[92px] max-w-md px-4 text-center" aria-live="polite">
        <div className="text-ink-3">{current.title.join(" ")}</div>
        <p className="mt-1.5 text-[13px] leading-snug text-ink">{current.caption}</p>
        <div className="mt-1.5 text-ink-3">{current.tags.join(" · ")}</div>
      </div>

      <div className="mt-2 flex items-center gap-3 sm:hidden">
        <button className="btn-secondary px-3 py-1.5" onClick={() => go(-1)} aria-label="Previous tape">←</button>
        <button className="btn-primary px-3 py-1.5" onClick={() => router.push(current.href)}>Play</button>
        <button className="btn-secondary px-3 py-1.5" onClick={() => go(1)} aria-label="Next tape">→</button>
      </div>
    </div>
  );
}
