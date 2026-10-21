"use client";

import Link from "next/link";
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How a tape at signed distance `d` from the centre sits on the arc. */
function placement(d: number): React.CSSProperties {
  const abs = Math.abs(d);
  const brightness = abs <= 1 ? 1 - 0.58 * abs : Math.max(0.22, 0.42 - 0.2 * (abs - 1));
  return {
    transform: `translateX(calc(-50% + ${d} * var(--tape-w) * 1.28)) translateY(calc(${d * d} * var(--tape-w) * 0.11)) rotate(${d * 15}deg) scale(${1 - Math.min(abs, 3) * 0.04})`,
    filter: abs < 0.02 ? "none" : `brightness(${brightness}) saturate(${1 - Math.min(abs, 1) * 0.2})`,
    opacity: clamp(3 - abs, 0, 1),
    zIndex: 100 - Math.round(abs * 10),
  };
}

/**
 * Tapes on an arc, driven by scrolling: the deck pins to the screen and the
 * scroll position slides the tapes along, so the whole row moves left or right
 * as you scroll on a phone or a desktop. Arrow keys, clicks on side tapes and
 * the counter all scroll to a tape; the centre tape (or Enter) plays it.
 */
export function TapeDeck({ tapes }: { tapes: Tape[] }) {
  const router = useRouter();
  const n = tapes.length;
  const section = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const target = useRef(0);
  const current = useRef(0);
  const raf = useRef(0);
  const [pos, setPos] = useState(0);
  const [jolt, setJolt] = useState(0);
  const active = clamp(Math.round(pos), 0, n - 1);
  const lastActive = useRef(0);

  useEffect(() => {
    if (active !== lastActive.current) {
      lastActive.current = active;
      setJolt((j) => j + 1);
    }
  }, [active]);

  const range = useCallback(() => {
    const el = section.current;
    const sc = scroller.current;
    if (!el || !sc) return { top: 0, span: 1 };
    return { top: el.offsetTop, span: Math.max(1, el.offsetHeight - sc.clientHeight) };
  }, []);

  useEffect(() => {
    const el = section.current;
    const sc = el?.closest(".crt-scroll") as HTMLElement | null;
    if (!el || !sc) return;
    scroller.current = sc;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const animate = () => {
      const delta = target.current - current.current;
      current.current = still || Math.abs(delta) < 0.001 ? target.current : current.current + delta * 0.16;
      setPos(current.current);
      raf.current = current.current === target.current ? 0 : requestAnimationFrame(animate);
    };
    const onScroll = () => {
      const { top, span } = range();
      target.current = clamp((sc.scrollTop - top) / span, 0, 1) * (n - 1);
      if (!raf.current) raf.current = requestAnimationFrame(animate);
    };
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [n, range]);

  const goTo = useCallback((i: number) => {
    const sc = scroller.current;
    if (!sc) return;
    const { top, span } = range();
    sc.scrollTo({ top: top + (clamp(i, 0, n - 1) / (n - 1)) * span, behavior: "smooth" });
  }, [n, range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(t.tagName))) return;
      const sc = scroller.current;
      const el = section.current;
      // Only while the deck is on screen.
      if (!sc || !el || sc.scrollTop > el.offsetTop + el.offsetHeight - sc.clientHeight + 40) return;
      if (e.key === "ArrowRight") goTo(active + 1);
      else if (e.key === "ArrowLeft") goTo(active - 1);
      else if (e.key === "Enter") router.push(tapes[active].href);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, goTo, router, tapes]);

  const current_ = tapes[active];

  return (
    <div ref={section} className="relative w-full" style={{ height: `calc(var(--stage-h) + ${(n - 1) * 55}dvh)` }}>
      <div className="sticky top-0 flex w-full flex-col items-center justify-center overflow-hidden pb-20 pt-24 sm:pt-32" style={{ height: "var(--stage-h)" }}>
        <p className="osd mb-5 hidden max-w-md text-center text-ink-3 sm:block [@media(max-height:860px)]:!hidden">
          Scroll to fast-forward. Click the centre tape, or press enter, to play it.
        </p>

        {/* The box is tall enough for the whole arc (side tapes sit lower and tilt
            outwards), so the caption below never ends up under a tape. */}
        <div
          className="relative w-full [--tape-w:clamp(140px,min(19vw,calc((100dvh_-_26rem)/2)),272px)]"
          style={{ height: "calc(var(--tape-w) * 2.1)" }}
          role="region"
          aria-roledescription="carousel"
          aria-label="What Unlisted does"
        >
          {tapes.map((tape, i) => {
            const d = i - pos;
            const isActive = i === active;
            return (
              <button
                key={tape.id}
                type="button"
                className="absolute left-1/2 top-0 origin-[50%_120%] will-change-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
                style={{
                  width: "var(--tape-w)",
                  height: "calc(var(--tape-w) * 1.5)",
                  fontSize: "calc(var(--tape-w) / 13)",
                  pointerEvents: Math.abs(d) < 2.5 ? "auto" : "none",
                  ...placement(d),
                }}
                tabIndex={isActive ? 0 : -1}
                aria-label={isActive ? `Play: ${tape.title.join(" ")}` : `Show ${tape.title.join(" ")}`}
                onClick={() => (isActive ? router.push(tape.href) : goTo(i))}
              >
                <div key={isActive ? jolt : undefined} className={`h-full w-full ${isActive && jolt ? "jolt" : ""}`}>
                  <TapeCover tape={tape} />
                </div>
              </button>
            );
          })}
        </div>

        <div className="osd relative z-[200] min-h-[112px] max-w-md px-4 text-center" aria-live="polite">
          <div className="text-ink-3">{current_.title.join(" ")}</div>
          <p className="mt-1.5 text-[13px] leading-snug text-ink">{current_.caption}</p>
          <Link href={current_.href} className="btn bg-gold mt-3 px-3 py-1.5 text-[12px] text-screen hover:bg-gold/90">
            {current_.tags[0]}
          </Link>
        </div>

        {/* Tape counter: where you are in the reel. */}
        <div className="osd relative z-[200] mt-3 flex items-center gap-3 text-ink-3">
          <button className="btn-ghost px-2 py-1" onClick={() => goTo(active - 1)} disabled={active === 0} aria-label="Previous tape">←</button>
          <span className="tabular-nums">Tape {String(active + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}</span>
          <div className="relative h-px w-24 bg-ink/20 sm:w-40" aria-hidden>
            <div className="absolute inset-y-0 left-0 bg-gold" style={{ width: `${(pos / (n - 1)) * 100}%`, height: "2px", top: "-0.5px" }} />
          </div>
          <button className="btn-ghost px-2 py-1" onClick={() => goTo(active + 1)} disabled={active === n - 1} aria-label="Next tape">→</button>
        </div>
      </div>
    </div>
  );
}
