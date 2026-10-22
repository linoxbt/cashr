"use client";

import jsQR from "jsqr";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Notice, PageState, Pill, Spinner } from "@/components/ui";
import { api, ApiError, isEventId, isUnreachable, type Manifest } from "@/lib/api";
import { fromB64url, parseTicketQr, ticketHash } from "@/lib/codec";
import { forgetKeys, readJson, takeLinkToken, writeJson } from "@/lib/storage";

type Verdict = {
  kind: "ok" | "already" | "unknown" | "unverified" | "other_event" | "closed" | "error";
  seat?: number | null;
  offline?: boolean;
  detail?: string;
};

const VERDICT_UI: Record<Verdict["kind"], { bg: string; title: string; sub: string }> = {
  ok: { bg: "bg-ok", title: "Welcome in", sub: "Ticket checked in." },
  already: { bg: "bg-warn", title: "Already checked in", sub: "This ticket was used before." },
  unknown: { bg: "bg-bad", title: "Not a valid ticket", sub: "No confirmed RSVP matches this code." },
  // Offline, a ticket missing from this phone's saved list may just be newer than it.
  unverified: { bg: "bg-screen-3", title: "Can't confirm offline", sub: "Not on this phone's saved list. If they paid in the last few minutes, check again once you're back online." },
  other_event: { bg: "bg-bad", title: "Wrong event", sub: "This ticket is for a different event." },
  closed: { bg: "bg-screen-3", title: "Door closed", sub: "This event has ended." },
  // Never shown as "not valid": a server problem says nothing about the ticket.
  error: { bg: "bg-warn", title: "Try again", sub: "The server had a problem checking this ticket." },
};

// QR decoding is costly on phones; this is plenty for people walking up.
const SCAN_INTERVAL_MS = 125;

export default function Door() {
  const { id } = useParams<{ id: string }>();
  if (!isEventId(id)) return <PageState title="This door link isn't valid">Open the full door link from the organiser.</PageState>;
  return <DoorFor id={id} />;
}

function DoorFor({ id }: { id: string }) {
  const cacheKey = `unlisted.door.${id}`;
  const queueKey = `unlisted.door.queue.${id}`;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [refused, setRefused] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState<"off" | "starting" | "on" | "denied">("off");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScan = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const busy = useRef(false);
  const refreshing = useRef(false);

  useEffect(() => {
    setToken(takeLinkToken(`door.${id}`));
    setManifest(readJson<Manifest | null>(cacheKey, null));
    setQueue(readJson<string[]>(queueKey, []));
  }, [id, cacheKey, queueKey]);

  const refresh = useCallback(async () => {
    // One at a time: overlapping syncs could send, or drop, the same check-ins twice.
    if (!token || refreshing.current) return;
    refreshing.current = true;
    try {
      const sent = readJson<string[]>(queueKey, []);
      if (sent.length) {
        const res = await api.syncCheckIns(id, sent, token);
        // Offline check-ins the server didn't accept (e.g. the event was already settled).
        const bad = res.results.filter((r) => r.result === "event_closed" || r.result === "unknown").length;
        if (bad) setRefused((n) => n + bad);
        // Remove only what was sent: a scan queued while the request was out stays.
        const remaining = [...readJson<string[]>(queueKey, [])];
        for (const h of sent) {
          const i = remaining.indexOf(h);
          if (i >= 0) remaining.splice(i, 1);
        }
        writeJson(queueKey, remaining);
        setQueue(remaining);
      }
      const m = await api.manifest(id, token);
      setManifest(m);
      if (m.event.status === "open" || m.event.status === "closed") {
        writeJson(cacheKey, m);
      } else {
        // The door is done: nothing about who came stays on this phone.
        forgetKeys([cacheKey, queueKey]);
      }
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setAuthError(true);
      else if (e instanceof ApiError && e.status === 404) {
        forgetKeys([cacheKey, queueKey]);
        setAuthError(true);
      } else setOnline(false);
    } finally {
      refreshing.current = false;
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
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setAuthError(true);
          return;
        }
        if (!isUnreachable(e)) {
          return setVerdict({ kind: "error", detail: e instanceof Error ? e.message : undefined });
        }
        // Offline, timed out, or the host can't reach the API: decide from the
        // saved list and queue the check-in.
        setOnline(false);
        if (!local) return setVerdict({ kind: "unverified", offline: true });
        if (local.checked_in) return setVerdict({ kind: "already", seat: local.seat, offline: true });
        markLocal(hash);
        const q = [...readJson<string[]>(queueKey, []), hash];
        writeJson(queueKey, q);
        setQueue(q);
        setVerdict({ kind: "ok", seat: local.seat, offline: true });
      }
    } catch (e) {
      setVerdict({ kind: "error", detail: e instanceof Error ? e.message : undefined });
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
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
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
    let last = 0;
    const tick = (t: number) => {
      if (t - last >= SCAN_INTERVAL_MS && video && ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        last = t;
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

  // The stream is kept in its own ref: by the time this runs on leaving the
  // page, the video element's ref is already detached.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

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
          <h1 className="mt-1 text-2xl ">{manifest?.event.title ?? "Loading event…"}</h1>
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
      {refused > 0 && (
        <div className="mt-3">
          <Notice tone="bad" title={`${refused} offline check-in${refused === 1 ? " was" : "s were"} refused`}>
            The server didn&rsquo;t accept them, usually because the event was settled before this phone synced. Tell
            the organiser.
          </Notice>
        </div>
      )}

      <div className="relative mt-6 aspect-square overflow-hidden rounded-md bg-black">
        <video ref={videoRef} playsInline muted className={`h-full w-full object-cover ${camera === "on" ? "" : "hidden"}`} />
        {camera !== "on" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-ink">
            {camera === "denied" ? (
              <>
                <p className="text-sm text-ink-2">Camera access was blocked. Allow it in your browser settings, or enter codes by hand below.</p>
                <button className="btn-secondary" onClick={startCamera}>Try the camera again</button>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-3">Point the camera at an attendee&rsquo;s ticket.</p>
                <button className="btn bg-gold text-screen hover:bg-gold/90" onClick={startCamera} disabled={camera === "starting"}>
                  {camera === "starting" && <Spinner />} Start scanning
                </button>
              </>
            )}
          </div>
        )}
        {camera === "on" && !ui && <div className="pointer-events-none absolute inset-10 rounded-2xl border-2 border-ink/50" />}
        {ui && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white ${ui.bg}`} role="alert">
            <div className="font-display text-5xl sm:text-6xl">{ui.title}</div>
            {verdict?.seat ? <div className="mt-2 text-lg">Seat {verdict.seat}</div> : null}
            <div className="mt-2 text-sm text-white/80">{ui.sub}</div>
            {verdict?.offline && <div className="mt-3 text-xs text-white/70">Checked offline. It will sync when the connection is back.</div>}
            {verdict?.detail && <div className="mt-3 max-w-xs text-xs text-white/70">{verdict.detail}</div>}
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
        <label htmlFor="ticket-code" className="sr-only">Ticket code</label>
        <input id="ticket-code" className="input font-mono text-xs" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a ticket code: unlisted:…" spellCheck={false} />
        <button className="btn-secondary" type="submit">Check</button>
      </form>

      <div className="mt-6">
        <Notice>
          This device sees only ticket hashes. It never learns names or refund addresses, and it records whether a ticket was used, not when.
          Offline, each phone checks against its own saved list, so two offline phones could both admit the same ticket:
          use one door phone while offline, and let every phone sync before the organiser ends the event.
        </Notice>
      </div>
    </div>
  );
}
