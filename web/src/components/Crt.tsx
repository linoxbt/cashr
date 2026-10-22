"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useMeta } from "@/components/ui";
import { API_CONFIGURED } from "@/lib/api";
import { Wordmark } from "@/components/Logo";
import { DEMO_URL, SITE_URL } from "@/lib/site";
import { THEME_KEY, readJson, writeJson, type Theme } from "@/lib/storage";

const NAV = [
  { href: "/new", label: "Host" },
  { href: "/join", label: "Join" },
  { href: "/tickets", label: "Tickets" },
  { href: "/events", label: "Events" },
  { href: "/docs", label: "Docs" },
];

/** The logo in the header: the brand mark and the name, on every screen size. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex flex-col items-center text-ink" aria-label="cashr home">
      <Wordmark size={compact ? 28 : 36} />
      {!compact && (
        <span className="osd mt-1.5 flex w-full justify-between gap-6 border-t border-ink/25 pt-0.5 text-[10px] text-ink-3">
          <span>Shielded</span>
          <span>2026</span>
        </span>
      )}
    </Link>
  );
}

/**
 * Back: the previous page when you got here inside the app; the home page when
 * you arrived from a link (going "back" would leave the site). Hidden at home.
 */
function BackButton({ inApp, className = "" }: { inApp: boolean; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <button
      type="button"
      onClick={() => (inApp ? router.back() : router.push("/"))}
      className={`glitch flex items-center gap-1.5 text-ink-2 hover:text-ink sm:uppercase ${className}`}
      aria-label="Go back"
    >
      <span aria-hidden>←</span> Back
    </button>
  );
}

/** White or dark. Stored on this device; applied before paint by the root layout. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), []);
  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    writeJson(THEME_KEY, next);
    setTheme(next);
  };
  return [theme, toggle];
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
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 8000);
    return () => clearTimeout(t);
  }, []);
  if (!API_CONFIGURED) return <span className="text-bad">Chain: No server</span>;
  if (!meta) return waited ? <span className="text-bad">Chain: Offline</span> : <span>Chain: …</span>;
  if (meta.chain === "sim") {
    return (
      <span className="text-gold-ink" title="Development mode: no real ZEC moves">
        Chain: <span className="blink">Simulated</span>
      </span>
    );
  }
  return <span>Chain: {meta.network === "main" ? "Mainnet" : "Testnet"}</span>;
}

/** Main site: a link to the demo. Demo site: a banner back to the real app. */
function DemoLink({ className = "" }: { className?: string }) {
  const meta = useMeta();
  if (meta?.chain === "sim") return null;
  return (
    <a href={DEMO_URL} className={`glitch inline-block text-gold-ink hover:text-ink ${className}`}>
      Demo
    </a>
  );
}

function DemoBanner() {
  const meta = useMeta();
  if (meta?.chain !== "sim") return null;
  return (
    <div className="relative z-30 bg-gold px-4 py-1.5 text-center font-mono text-[12px] font-medium uppercase tracking-[-0.02em] text-gold-on">
      Demo · simulated chain, no real ZEC ·{" "}
      <a href={SITE_URL} className="underline underline-offset-2">Use the real app at {SITE_URL.replace(/^https?:\/\//, "")}</a>
    </div>
  );
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
  const [theme, toggleTheme] = useTheme();
  // Pages seen in this tab, so Back knows whether there's an in-app page to return to.
  const pagesSeen = useRef(0);
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    pagesSeen.current += 1;
    setInApp(pagesSeen.current > 1);
  }, [pathname]);

  useEffect(() => setBw(readJson<boolean>("cashr.bw", false)), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setMenu(false);
  }, [pathname]);

  const toggleBw = () => {
    setBw((v) => {
      writeJson("cashr.bw", !v);
      return !v;
    });
  };

  return (
    <div className="crt">
      <div className={`crt-screen crt-boot ${bw ? "bw" : ""}`}>
        <div ref={scroller} className="crt-scroll">
          <DemoBanner />
          <div className="min-h-full px-1 pb-24 pt-24 sm:pb-24 sm:pt-36">{children}</div>
        </div>

        {/* On-screen display: top */}
        <header className="osd absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-screen-2 via-screen-2/90 to-transparent px-5 pb-6 pt-5 sm:px-12 sm:pt-9">
          <div className="hidden grid-cols-[1fr_auto_1fr] items-start sm:grid">
            <div className="flex items-center gap-8 pt-1.5 lg:gap-16">
              <BackButton inApp={inApp} />
              <Link href="/" className="glitch flex items-center gap-1.5 text-ink-2 hover:text-ink">
                <span aria-hidden className="inline-block h-2.5 w-2.5 bg-current" />
                Home
              </Link>
              <Timecode />
            </div>
            <Logo />
            <nav className="flex justify-end gap-6 pt-1.5 lg:gap-10" aria-label="Main">
              {NAV.map((n) => <NavLink key={n.href} {...n} active={pathname === n.href} />)}
              <DemoLink />
            </nav>
          </div>
          <div className="flex items-center justify-between gap-3 sm:hidden">
            <Logo compact />
            <div className="flex items-center gap-5">
              <BackButton inApp={inApp} />
              <button className="text-ink-2" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="osd-menu">
                Menu [{menu ? "–" : "+"}]
              </button>
            </div>
          </div>
        </header>

        {menu && (
          <nav id="osd-menu" className="absolute inset-0 z-[25] flex flex-col justify-center gap-6 bg-screen/95 px-8 sm:hidden" aria-label="Main">
            {[{ href: "/", label: "Home" }, ...NAV].map((n) => (
              <Link key={n.href} href={n.href} className="font-display text-5xl text-ink">
                {n.label}
              </Link>
            ))}
            <DemoLink className="font-display text-5xl normal-case" />
            <button onClick={toggleTheme} className="self-start font-mono text-sm uppercase text-ink-2">
              Theme [{theme === "light" ? "White" : "Dark"}]
            </button>
          </nav>
        )}

        {/* On-screen display: bottom */}
        <footer className="osd absolute inset-x-0 bottom-0 z-20 flex items-end justify-between bg-gradient-to-t from-screen via-screen/85 to-transparent px-5 pb-5 pt-8 text-ink-3 sm:px-14 sm:pb-9">
          <div className="flex items-center gap-6 lg:gap-24">
            <Clock />
            <button onClick={toggleBw} className="glitch hidden text-ink-2 hover:text-ink sm:inline-block" aria-pressed={bw}>
              B&amp;W [{bw ? "On" : "Off"}]
            </button>
            <button onClick={toggleTheme} className="glitch hidden text-ink-2 hover:text-ink sm:inline-block" aria-pressed={theme === "light"}>
              Theme [{theme === "light" ? "White" : "Dark"}]
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
        {/* A door phone runs this page for hours: keep its grain still to save battery. */}
        <div className={`crt-fx crt-grain${pathname?.startsWith("/door/") ? " crt-still" : ""}`} />
        <div className="crt-fx crt-glare" />
        <div className="crt-fx crt-vignette" />
      </div>
    </div>
  );
}
