"use client";

import { useEffect, useState, type ReactNode } from "react";

import { api, type Meta } from "@/lib/api";

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "gold"; children: ReactNode }) {
  const tones = {
    neutral: "bg-paper-2 text-ink-2",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    gold: "bg-gold-soft text-gold-ink",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card p-5">
      <div className="eyebrow">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function Notice({ tone = "neutral", title, children }: { tone?: "neutral" | "ok" | "warn" | "bad"; title?: string; children: ReactNode }) {
  const tones = {
    neutral: "border-ink/10 bg-paper-2/60",
    ok: "border-ok/20 bg-ok-soft",
    warn: "border-warn/20 bg-warn-soft",
    bad: "border-bad/20 bg-bad-soft",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`} role={tone === "bad" ? "alert" : undefined}>
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
      <div className="mono-break mt-1.5 rounded-lg border border-ink/10 bg-paper/60 px-3 py-2 text-ink-2">{value}</div>
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
      <h1 className="text-xl font-semibold">{title}</h1>
      {children && <div className="mt-3 text-sm text-ink-3">{children}</div>}
    </div>
  );
}

let metaPromise: Promise<Meta> | null = null;

export function useMeta(): Meta | null {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    metaPromise ??= api.meta().catch((e) => {
      metaPromise = null;
      throw e;
    });
    metaPromise.then(setMeta, () => setMeta(null));
  }, []);
  return meta;
}

export function SimBanner() {
  const meta = useMeta();
  if (meta?.chain !== "sim") return null;
  return (
    <div className="bg-gold-soft text-gold-ink">
      <div className="mx-auto max-w-page px-4 py-2 text-center text-xs font-medium sm:px-6">
        Simulated chain: this server is running in development mode. No real ZEC moves.
      </div>
    </div>
  );
}

export function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[]) {
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await fn();
      } finally {
        if (alive) t = setTimeout(tick, ms);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function formatWhen(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
