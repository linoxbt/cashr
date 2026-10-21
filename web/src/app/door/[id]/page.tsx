"use client";

import jsQR from "jsqr";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Notice, PageState, Pill, Spinner } from "@/components/ui";
import { api, ApiError, type Manifest } from "@/lib/api";
import { fromB64url, parseTicketQr, ticketHash } from "@/lib/codec";
import { readJson, takeLinkToken, writeJson } from "@/lib/storage";

type Verdict = { kind: "ok" | "already" | "unknown" | "other_event" | "closed"; seat?: number | null; offline?: boolean };

const VERDICT_UI: Record<Verdict["kind"], { bg: string; title: string; sub: string }> = {
  ok: { bg: "bg-ok", title: "Welcome in", sub: "Ticket checked in." },
  already: { bg: "bg-warn", title: "Already checked in", sub: "This ticket was used before." },
  unknown: { bg: "bg-bad", title: "Not a valid ticket", sub: "No confirmed RSVP matches this code." },
  other_event: { bg: "bg-bad", title: "Wrong event", sub: "This ticket is for a different event." },
  closed: { bg: "bg-ink-2", title: "Door closed", sub: "This event has ended." },
};

export default function Door() {
  const { id } = useParams<{ id: string }>();
  const cacheKey = `unlisted.door.${id}`;
  const queueKey = `unlisted.door.queue.${id}`;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState<"off" | "starting" | "on" | "denied">("off");
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastScan = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const busy = useRef(false);

  useEffect(() => {
    setToken(takeLinkToken(`door.${id}`));
    setManifest(readJson<Manifest | null>(cacheKey, null));
    setQueue(readJson<string[]>(queueKey, []));
  }, [id, cacheKey, queueKey]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      let pendingQueue = readJson<string[]>(queueKey, []);
      if (pendingQueue.length) {
        await api.syncCheckIns(id, pendingQueue, token);
        pendingQueue = [];
        writeJson(queueKey, pendingQueue);
        setQueue(pendingQueue);
      }
      const m = await api.manifest(id, token);
      setManifest(m);
      writeJson(cacheKey, m);
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setAuthError(true);
      else setOnline(false);
    }
  }, [id, token, cacheKey, queueKey]);

  useEffect(() => {
    if (!token) return;
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [token, refresh]);

  const markLocal = useCallback((hash: string) => {
    setManifest((m) => {
      if (!m) return m;
      const next = { ...m, tickets: m.tickets.map((t) => (t.h === hash ? { ...t, checked_in: true } : t)) };
      writeJson(cacheKey, next);
      return next;
    });
  }, [cacheKey]);

  const check = useCallback(async (text: string) => {
    if (busy.current || !token) return;
    const parsed = parseTicketQr(text);
    if (!parsed) return setVerdict({ kind: "unknown" });
    if (parsed.eventId !== id) return setVerdict({ kind: "other_event" });
    busy.current = true;
    try {
      // The door only ever handles the hash; the secret is discarded here.
      const hash = await ticketHash(fromB64url(parsed.secret));
      const local = manifest?.tickets.find((t) => t.h === hash);
      try {
        const res = await api.checkIn(id, hash, token);
        setOnline(true);
        if (res.result === "ok" || res.result === "already") markLocal(hash);
        setVerdict({ kind: res.result === "event_closed" ? "closed" : res.result, seat: res.seat });
      } catch (e) {
        if (e instanceof ApiError && e.status !== 0) throw e;
        // Offline: decide from the cached manifest and queue the check-in.
        setOnline(false);
        if (!local) return setVerdict({ kind: "unknown", offline: true });
        if (local.checked_in) return setVerdict({ kind: "already", seat: local.seat, offline: true });
        markLocal(hash);
        const q = [...readJson<string[]>(queueKey, []), hash];
        writeJson(queueKey, q);
        setQueue(q);
        setVerdict({ kind: "ok", seat: local.seat, offline: true });
      }
    } catch {
      setVerdict({ kind: "unknown" });
    } finally {
      busy.current = false;
    }
  }, [id, token, manifest, markLocal, queueKey]);

  // Clear the verdict after a few seconds so the next person can scan.
  useEffect(() => {
    if (!verdict) return;
    const t = setTimeout(() => setVerdict(null), 3500);
    return () => clearTimeout(t);
  }, [verdict]);

  const startCamera = useCallback(async () => {
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      setCamera("on");
    } catch {
      setCamera("denied");
    }
  }, []);

  useEffect(() => {
    if (camera !== "on") return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let raf = 0;
    const tick = () => {
      if (video && ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = 480;
        const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
        const now = Date.now();
        if (code?.data && (code.data !== lastScan.current.text || now - lastScan.current.at > 4000)) {
          lastScan.current = { text: code.data, at: now };
          check(code.data);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [camera, check]);

  useEffect(() => () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
  }, []);

  if (token === undefined) return <PageState title="Loading…"><Spinner /></PageState>;
  if (!token || authError) {
    return <PageState title="This door link isn't valid">Open the full door link from the organiser. It ends in <code>#k=…</code>.</PageState>;
  }

  const checkedIn = manifest?.tickets.filter((t) => t.checked_in).length ?? 0;
  const total = manifest?.tickets.length ?? 0;
  const ui = verdict ? VERDICT_UI[verdict.kind] : null;

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Door</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{manifest?.event.title ?? "Loading event…"}</h1>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{checkedIn}<span className="text-ink-4">/{total}</span></div>
          <div className="text-xs text-ink-3">checked in</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {online ? <Pill tone="ok">Online</Pill> : <Pill tone="warn">Offline · using saved list</Pill>}
        {queue.length > 0 && <Pill tone="warn">{queue.length} check-in{queue.length === 1 ? "" : "s"} to sync</Pill>}
      </div>

      <div className="relative mt-6 aspect-square overflow-hidden rounded-2xl bg-ink">
        <video ref={videoRef} playsInline muted className={`h-full w-full object-cover ${camera === "on" ? "" : "hidden"}`} />
        {camera !== "on" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-paper">
            {camera === "denied" ? (
              <p className="text-sm text-paper/80">Camera access was blocked. Allow it in your browser settings, or enter codes by hand below.</p>
            ) : (
              <>
                <p className="text-sm text-paper/70">Point the camera at an attendee&rsquo;s ticket.</p>
                <button className="btn bg-gold text-ink hover:bg-gold/90" onClick={startCamera} disabled={camera === "starting"}>
                  {camera === "starting" && <Spinner />} Start scanning
                </button>
              </>
            )}
          </div>
        )}
        {camera === "on" && !ui && <div className="pointer-events-none absolute inset-10 rounded-2xl border-2 border-paper/60" />}
        {ui && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white ${ui.bg}`} role="status" aria-live="assertive">
            <div className="text-3xl font-semibold">{ui.title}</div>
            {verdict?.seat ? <div className="mt-2 text-lg">Seat {verdict.seat}</div> : null}
            <div className="mt-2 text-sm text-white/80">{ui.sub}</div>
            {verdict?.offline && <div className="mt-3 text-xs text-white/70">Checked offline. It will sync when the connection is back.</div>}
          </div>
        )}
      </div>

      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          check(manual);
          setManual("");
        }}
      >
        <input className="input font-mono text-xs" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a ticket code: unlisted:…" spellCheck={false} />
        <button className="btn-secondary" type="submit">Check</button>
      </form>

      <div className="mt-6">
        <Notice>
          This device sees only ticket hashes. It never learns names or refund addresses, and it records whether a ticket was used, not when.
        </Notice>
      </div>
    </div>
  );
}
