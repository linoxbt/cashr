"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, type Meta } from "@/lib/api";
import { IS_DEMO_BUILD } from "@/lib/site";

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "gold"; children: ReactNode }) {
  const tones = {
    neutral: "bg-ink/[0.06] text-ink-2",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    gold: "bg-gold-soft text-gold-ink",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[3px] px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[-0.02em] ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card p-5">
      <div className="eyebrow">{label}</div>
      <div className="mt-2 font-display text-4xl tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function Notice({ tone = "neutral", title, children }: { tone?: "neutral" | "ok" | "warn" | "bad"; title?: string; children: ReactNode }) {
  const tones = {
    neutral: "border-ink/10 bg-ink/[0.03]",
    ok: "border-ok/20 bg-ok-soft",
    warn: "border-warn/20 bg-warn-soft",
    bad: "border-bad/20 bg-bad-soft",
  };
  return (
    <div className={`rounded-md border px-4 py-3 text-sm ${tones[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary px-3 py-1.5 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked; the value is visible to select by hand */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="label mb-0">{label}</span>
        <CopyButton value={value} />
      </div>
      <div className="mono-break mt-1.5 rounded-[4px] border border-ink/10 bg-well/40 px-3 py-2 text-ink-2">{value}</div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

export function PageState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="text-4xl">{title}</h1>
      {children && <div className="mt-3 text-sm text-ink-3">{children}</div>}
    </div>
  );
}

let metaPromise: Promise<Meta> | null = null;

/** The page's one /meta request, shared by everything that needs it. */
export function sharedMeta(): Promise<Meta> {
  metaPromise ??= api.meta().catch((e) => {
    metaPromise = null;
    throw e;
  });
  return metaPromise;
}

export function useMeta(): Meta | null {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    const load = () => {
      sharedMeta().then(
        (m) => alive && setMeta(m),
        () => {
          if (alive) retry = setTimeout(load, 10_000);
        },
      );
    };
    load();
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, []);
  return meta;
}

/** The demo site: known at build time there, and from the server everywhere else (local dev). */
export function useIsDemo(): boolean {
  const meta = useMeta();
  return IS_DEMO_BUILD || meta?.chain === "sim";
}

/**
 * Run `fn` now and then every `interval()` ms (null stops polling). Pauses while
 * the tab is hidden and catches up as soon as it is visible again, so a
 * background tab never keeps downloading.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  interval: number | (() => number | null),
  deps: unknown[],
  // Keep the schedule while the tab is hidden: for a page whose request timing must
  // say nothing (pausing and catching up on return would show when you switched apps).
  { whileHidden = false }: { whileHidden?: boolean } = {},
) {
  const latest = useRef({ fn, interval });
  latest.current = { fn, interval };
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const delay = () => {
      const i = latest.current.interval;
      return typeof i === "function" ? i() : i;
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await latest.current.fn();
      } finally {
        running = false;
        const d = delay();
        if (alive && d !== null && (whileHidden || !document.hidden)) timer = setTimeout(tick, d);
      }
    };
    const onVisibility = () => {
      if (whileHidden || document.hidden || !alive) return;
      clearTimeout(timer);
      tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function formatWhen(s: string): string {
  if (!s) return "—"; // purged events keep no date
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
