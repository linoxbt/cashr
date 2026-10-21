"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useMeta } from "@/components/ui";
import { readJson, writeJson } from "@/lib/storage";

const NAV = [
  { href: "/app", label: "App" },
  { href: "/docs", label: "Docs" },
  { href: "/privacy", label: "Threat model" },
  { href: "/new", label: "Create event" },
];

/** The wordmark: a striped "redaction" glyph and a serif name. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex flex-col items-center" aria-label="Unlisted home">
      <span className="flex items-center gap-2">
        {/* A guest list with one line redacted: the list nobody keeps. */}
        <svg width={compact ? 26 : 30} height={compact ? 20 : 24} viewBox="0 0 30 24" aria-hidden className="shrink-0">
          <rect x="0" y="1" width="22" height="2.5" fill="#ECE9E1" opacity="0.55" />
          <rect x="0" y="8" width="30" height="7" fill="#F4B728" />
          <rect x="0" y="20" width="16" height="2.5" fill="#ECE9E1" opacity="0.55" />
        </svg>
        {!compact && (
          <span className="font-display text-[30px] leading-none tracking-[-0.02em] text-ink group-hover:[animation:channel_380ms_steps(6)_1]">
            Unlisted
          </span>
        )}
      </span>
      {!compact && (
        <span className="osd mt-1 flex w-full justify-between gap-6 border-t border-ink/25 pt-0.5 text-[10px] text-ink-3">
          <span>Shielded</span>
          <span>2026</span>
        </span>
      )}
    </Link>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Tape counter: time since this page was opened, like a VCR's. */
function Timecode() {
  const [start] = useState(() => Date.now());
  const now = useNow(1000);
  const s = now ? Math.max(0, Math.floor((now.getTime() - start) / 1000)) : 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="tabular-nums" aria-hidden>
      {pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:{pad(s % 60)}
    </span>
  );
}

function Clock() {
  const now = useNow(15_000);
  if (!now) return <span className="tabular-nums">--:--</span>;
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const zone = new Intl.DateTimeFormat([], { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
  return <span className="tabular-nums">{time} {zone ?? "LOCAL"}</span>;
}

function ChainStatus() {
  const meta = useMeta();
  if (!meta) return <span>Chain: …</span>;
  if (meta.chain === "sim") {
    return (
      <span className="text-gold-ink" title="Development mode: no real ZEC moves">
        Chain: <span className="blink">Simulated</span>
      </span>
    );
  }
  return <span>Chain: {meta.network === "main" ? "Mainnet" : "Testnet"}</span>;
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} className={`glitch inline-block ${active ? "text-ink" : "text-ink-2 hover:text-ink"}`} aria-current={active ? "page" : undefined}>
      {active && <span aria-hidden>▸ </span>}
      {label}
    </Link>
  );
}

export function Crt({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const scroller = useRef<HTMLDivElement>(null);
  const [bw, setBw] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => setBw(readJson<boolean>("unlisted.bw", false)), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setMenu(false);
  }, [pathname]);

  const toggleBw = () => {
    setBw((v) => {
      writeJson("unlisted.bw", !v);
      return !v;
    });
  };

  return (
    <div className="crt">
      <div className={`crt-screen crt-boot ${bw ? "bw" : ""}`}>
        <div ref={scroller} className="crt-scroll">
          <div className="min-h-full px-1 pb-24 pt-24 sm:pb-24 sm:pt-32">{children}</div>
        </div>

        {/* On-screen display: top */}
        <header className="osd absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-[#141414] via-[#141414]/90 to-transparent px-5 pb-6 pt-5 sm:px-12 sm:pt-9">
          <div className="hidden grid-cols-[1fr_auto_1fr] items-start sm:grid">
            <div className="flex items-center gap-8 pt-1.5 lg:gap-28">
              <Link href="/" className="glitch flex items-center gap-1.5 text-ink-2 hover:text-ink">
                <span aria-hidden className="inline-block h-2.5 w-2.5 bg-current" />
                Home
              </Link>
              <Timecode />
            </div>
            <Logo />
            <nav className="flex justify-end gap-6 pt-1.5 lg:gap-10" aria-label="Main">
              {NAV.map((n) => <NavLink key={n.href} {...n} active={pathname === n.href} />)}
            </nav>
          </div>
          <div className="flex items-center justify-between sm:hidden">
            <Logo compact />
            <Link href="/" className="flex items-center gap-1.5 text-ink-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 bg-current" />
              Home
            </Link>
            <button className="text-ink-2" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="osd-menu">
              Menu [{menu ? "–" : "+"}]
            </button>
          </div>
        </header>

        {menu && (
          <nav id="osd-menu" className="absolute inset-0 z-[25] flex flex-col justify-center gap-6 bg-[#111]/95 px-8 sm:hidden" aria-label="Main">
            {[{ href: "/", label: "Home" }, ...NAV].map((n) => (
              <Link key={n.href} href={n.href} className="font-display text-5xl text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
        )}

        {/* On-screen display: bottom */}
        <footer className="osd absolute inset-x-0 bottom-0 z-20 flex items-end justify-between bg-gradient-to-t from-[#121212] via-[#121212]/85 to-transparent px-5 pb-5 pt-8 text-ink-3 sm:px-14 sm:pb-9">
          <div className="flex items-center gap-6 lg:gap-24">
            <Clock />
            <button onClick={toggleBw} className="glitch hidden text-ink-2 hover:text-ink sm:inline-block" aria-pressed={bw}>
              B&amp;W [{bw ? "On" : "Off"}]
            </button>
          </div>
          <div className="flex items-center gap-6 lg:gap-24">
            <ChainStatus />
            <a href="https://github.com/linoxbt/cashr" className="glitch hidden text-ink-2 hover:text-ink sm:inline-block">
              Source
            </a>
          </div>
        </footer>

        <div className="crt-fx crt-scanlines" />
        <div className="crt-fx crt-grain" />
        <div className="crt-fx crt-glare" />
        <div className="crt-fx crt-vignette" />
      </div>
    </div>
  );
}
