"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useIsDemo, useIsTestnet, useMeta } from "@/components/ui";
import { API_CONFIGURED } from "@/lib/api";
import { Wordmark } from "@/components/Logo";
import { DEMO_URL, FAUCET_URL, SITE_URL } from "@/lib/site";
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

// The pages visited in this tab, so Back knows whether there is a page of this
// site to return to (going back past the first one would leave the site).
const TRAIL_KEY = "cashr.trail";
function readTrail(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function writeTrail(trail: string[]) {
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-50)));
  } catch {
    /* storage blocked: Back falls back to the home page */
  }
}
// Set just before a full page load through one of this site's own links (the
// dashboard and door links are plain <a>), so that load still continues the trail.
const INSIDE_KEY = "cashr.inside";
let trailChecked = false;
/** Record a page: returning to the previous one shortens the trail, anything else extends it. */
function stepTrail(path: string): string[] {
  if (!trailChecked) {
    trailChecked = true;
    // Arriving fresh (a link from elsewhere or a typed address, not Back/Forward, a
    // reload or one of our own links): the page before this one isn't ours.
    const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    let inside = false;
    try {
      inside = sessionStorage.getItem(INSIDE_KEY) === "1";
      sessionStorage.removeItem(INSIDE_KEY);
    } catch {
      /* storage blocked: treat as arriving fresh */
    }
    if (nav?.type === "navigate" && !inside) writeTrail([]);
  }
  const trail = readTrail();
  if (trail[trail.length - 1] === path) return trail;
  const next = trail[trail.length - 2] === path ? trail.slice(0, -1) : [...trail, path];
  writeTrail(next);
  return next;
}

/** Back: the previous page of this site, or the home page when there is none. Hidden at home. */
function BackButton({ canGoBack, className = "" }: { canGoBack: boolean; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <button
      type="button"
      onClick={() => (canGoBack ? router.back() : router.push("/"))}
      className={`glitch flex items-center gap-1.5 text-ink-2 hover:text-ink sm:uppercase ${className}`}
      aria-label="Go back"
    >
      <span aria-hidden>←</span> Back
    </button>
  );
}

/** Phones colour their browser bar from <meta name="theme-color">: match the theme. */
function paintBrowserBar(theme: Theme) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#D9D5CB" : "#050505");
}

/** White or dark. Stored on this device; applied before paint by the root layout. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const t = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(t);
    paintBrowserBar(t);
  }, []);
  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    writeJson(THEME_KEY, next);
    setTheme(next);
    paintBrowserBar(next);
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
  if (useIsDemo()) return null;
  return (
    <a href={DEMO_URL} className={`glitch inline-block text-gold-ink hover:text-ink ${className}`}>
      Demo
    </a>
  );
}

function DemoBanner({ className = "" }: { className?: string }) {
  if (!useIsDemo()) return null;
  return (
    <div className={`bg-gold px-4 py-1.5 text-center font-mono text-[12px] font-medium uppercase tracking-[-0.02em] text-gold-on ${className}`}>
      Demo · simulated chain, no real ZEC ·{" "}
      <a href={SITE_URL} className="underline underline-offset-2">Use the real app at {SITE_URL.replace(/^https?:\/\//, "")}</a>
    </div>
  );
}

function TestnetBanner({ className = "" }: { className?: string }) {
  if (!useIsTestnet()) return null;
  return (
    <div className={`bg-gold px-4 py-1.5 text-center font-mono text-[12px] font-medium uppercase tracking-[-0.02em] text-gold-on ${className}`}>
      Testnet · real Zcash test network, test coins with no value ·{" "}
      <a href={FAUCET_URL} className="underline underline-offset-2">Get test ZEC</a> ·{" "}
      <a href={SITE_URL} className="underline underline-offset-2">Real app at {SITE_URL.replace(/^https?:\/\//, "")}</a>
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
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => setCanGoBack(stepTrail(pathname ?? "/").length > 1), [pathname]);
  const demo = useIsDemo();
  const testnet = useIsTestnet();
  const banner = demo || testnet;
  const firstMenuLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!menu) return;
    firstMenuLink.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  useEffect(() => setBw(readJson<boolean>("cashr.bw", false)), []);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && a.origin === window.location.origin) {
        try {
          sessionStorage.setItem(INSIDE_KEY, "1");
        } catch {
          /* storage blocked */
        }
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  useEffect(() => {
    setMenu(false);
    // A link to a section (/docs#faq) lands on it; any other new page starts at the top.
    const target = window.location.hash && document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target) target.scrollIntoView();
    else scroller.current?.scrollTo({ top: 0 });
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
          <main className={`min-h-full px-1 pb-24 ${banner ? "pt-32 sm:pt-44" : "pt-24 sm:pt-36"}`}>{children}</main>
        </div>

        {/* On-screen display: top */}
        <header className="osd absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-screen-2 via-screen-2/90 to-transparent px-5 pb-6 pt-5 sm:px-12 sm:pt-9">
          {/* Part of the header, not over it: it must never cover the logo, Back or Menu. */}
          <DemoBanner className="-mx-5 -mt-5 mb-4 sm:-mx-12 sm:-mt-9 sm:mb-5" />
          <TestnetBanner className="-mx-5 -mt-5 mb-4 sm:-mx-12 sm:-mt-9 sm:mb-5" />
          <div className="hidden grid-cols-[1fr_auto_1fr] items-start sm:grid">
            <div className="flex items-center gap-8 pt-1.5 lg:gap-16">
              <BackButton canGoBack={canGoBack} />
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
              <BackButton canGoBack={canGoBack} />
              <button className="text-ink-2" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="osd-menu">
                Menu [{menu ? "–" : "+"}]
              </button>
            </div>
          </div>
        </header>

        {menu && (
          <nav id="osd-menu" className="absolute inset-0 z-[25] flex flex-col justify-center gap-6 bg-screen/95 px-8 sm:hidden" aria-label="Main">
            <button onClick={() => setMenu(false)} className="absolute right-5 top-5 font-mono text-sm uppercase text-ink-2" aria-label="Close menu">
              Close [–]
            </button>
            {[{ href: "/", label: "Home" }, ...NAV].map((n, i) => (
              <Link key={n.href} href={n.href} ref={i === 0 ? firstMenuLink : undefined} onClick={() => setMenu(false)}
                className="font-display text-5xl text-ink">
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
