"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Qr } from "@/components/Qr";
import { CopyField, Notice, PageState, Pill, Spinner, Stat, formatWhen, useMeta, usePoll } from "@/components/ui";
import { api, ApiError, type AdminView, type PayoutStatus } from "@/lib/api";
import { REJECTION_TEXT, addressProblem, zatToZec, zip321 } from "@/lib/codec";
import { takeLinkToken } from "@/lib/storage";

type Tab = "overview" | "money" | "seized";

const ACTIONS: Record<string, { label: string; confirm: string; tone: "primary" | "secondary" | "danger" }> = {
  close: { label: "Close RSVPs", confirm: "Stop taking new RSVPs? Payments that arrive after this are returned.", tone: "secondary" },
  reopen: { label: "Reopen RSVPs", confirm: "Start taking RSVPs again?", tone: "secondary" },
  settle: {
    label: "End event & refund",
    confirm:
      "Refund everyone who checked in and forfeit the rest? The door stops working and this can't be undone.\n\nFirst make sure every door phone shows no check-ins waiting to sync: check-ins synced after this are refused.",
    tone: "primary",
  },
  retry: { label: "Retry failed payouts", confirm: "Try the failed payouts again?", tone: "secondary" },
  purge: {
    label: "Purge all data",
    confirm:
      "Permanently delete every ticket hash, refund address and payment record for this event, and destroy its wallet keys? Only totals remain. Payments sent to this event afterwards can't be returned.",
    tone: "danger",
  },
};

export default function Manage() {
  const { id } = useParams<{ id: string }>();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<AdminView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => setToken(takeLinkToken(`admin.${id}`)), [id]);

  usePoll(
    async () => {
      if (!token) return;
      try {
        setView(await api.admin(id, token));
        setError(null);
      } catch (e) {
        if (e instanceof ApiError) setError(e);
      }
    },
    10_000,
    [id, token, nonce],
  );

  if (token === undefined) return <PageState title="Loading…"><Spinner /></PageState>;
  if (!token || error?.status === 403 || error?.status === 401) {
    return (
      <PageState title="This manage link isn't valid">
        Open the full manage link you saved when you created the event. It ends in <code>#k=…</code>.
      </PageState>
    );
  }
  if (error?.status === 404) return <PageState title="Event not found" />;
  if (!view) return error ? <PageState title="Can't load the dashboard">{error.message}</PageState> : <PageState title="Loading…"><Spinner /></PageState>;

  const ev = view.event;
  const run = async (action: string) => {
    if (!window.confirm(ACTIONS[action].confirm)) return;
    setPending(action);
    setActionError(null);
    try {
      await api.adminAction(id, action, token);
      setNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Action failed.");
    } finally {
      setPending(null);
    }
  };
  const available = {
    open: ["close", "settle"],
    closed: ["reopen", "settle"],
    settling: view.payouts.some((p) => p.status === "failed") ? ["retry"] : [],
    settled: ["purge"],
    purged: [],
  }[ev.status];
  const shortfall = view.payouts.find((p) => p.status === "queued" && /insufficient/i.test(p.error));
  // A shortfall while deposits are still confirming is just waiting, not a missing fee.
  const confirming = (view.pending_zat ?? 0) > 0;
  const leftover = view.balance_zat ?? 0;

  return (
    <div className="mx-auto max-w-page px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Pill tone={ev.accepting_rsvps ? "ok" : ev.status === "purged" ? "neutral" : "warn"}>
              {ev.status === "open" && !ev.accepting_rsvps ? "deadline passed" : ev.status}
            </Pill>
            <span className="text-sm text-ink-3">{formatWhen(ev.starts_at)}</span>
          </div>
          <h1 className="mt-2 text-5xl ">{ev.title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/e/${ev.id}`} className="btn-secondary">RSVP page</Link>
          {available.map((a) => (
            <button
              key={a}
              className={ACTIONS[a].tone === "primary" ? "btn-primary" : ACTIONS[a].tone === "danger" ? "btn-danger" : "btn-secondary"}
              onClick={() => run(a)}
              disabled={pending !== null}
            >
              {pending === a && <Spinner />} {ACTIONS[a].label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {actionError && <Notice tone="bad">{actionError}</Notice>}
        {view.wallet_error && <Notice tone="bad" title="Wallet unreachable">{view.wallet_error}</Notice>}
        {shortfall && confirming && (
          <Notice title="Waiting for deposits to confirm">
            Refunds can only spend deposits once they have enough confirmations (about 12 minutes for the newest one).
            They go out automatically.
          </Notice>
        )}
        {shortfall && !confirming && (
          <Notice tone="warn" title="Refunds are waiting for network fees">
            There isn&rsquo;t enough in the event wallet to pay the network fee, usually because everyone came and no
            deposits were forfeited. Send about 0.001 ZEC to the event address under <strong>Money</strong> (no memo
            needed) and refunds go out automatically.
          </Notice>
        )}
        {ev.status === "settled" && leftover > 0 && !ev.forfeit_address && (
          <Notice tone="warn" title={`${zatToZec(leftover)} ZEC is still in the event wallet`}>
            Forfeited deposits and leftover fees stay here until you add a no-show fund address under{" "}
            <strong>Money</strong>. Purging is blocked until then, because it destroys the wallet keys.
          </Notice>
        )}
        {ev.status === "purged" && (
          <Notice tone="ok" title="Purged">Every ticket hash, refund address and payment record has been deleted, and the event&rsquo;s wallet keys were destroyed. Only the totals below remain.</Notice>
        )}
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="RSVPs" value={`${ev.rsvp_count} / ${ev.capacity}`} sub={`${ev.seats_left} seats left`} />
        <Stat label="Checked in" value={ev.checked_in_count} sub={ev.rsvp_count ? `${Math.round((ev.checked_in_count / ev.rsvp_count) * 100)}% of RSVPs` : "No RSVPs yet"} />
        <Stat label="Returned payments" value={ev.rejected_count} sub="Full, late, wrong amount or reused address" />
        <Stat
          label="Wallet balance"
          value={view.balance_zat === null ? "—" : `${zatToZec(view.balance_zat)} ZEC`}
          sub={confirming ? `${zatToZec(view.pending_zat ?? 0)} ZEC still confirming` : `Deposit ${zatToZec(ev.deposit_zat)} ZEC`}
        />
      </div>

      <div className="mt-10 border-b border-ink/10">
        <nav className="-mb-px flex gap-6 text-sm" aria-label="Dashboard sections">
          {([["overview", "Tickets"], ["money", "Money"], ["seized", "What a seizure reveals"]] as [Tab, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`border-b-2 pb-3 font-medium ${tab === k ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === "overview" && <TicketsTab view={view} />}
        {tab === "money" && <MoneyTab view={view} token={token} onChange={() => setNonce((n) => n + 1)} />}
        {tab === "seized" && <SeizedTab view={view} />}
      </div>
    </div>
  );
}

function TicketsTab({ view }: { view: AdminView }) {
  if (view.rsvps.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-ink-3">
        {view.event.status === "purged" ? "Ticket records were deleted." : "No RSVPs yet. Share the RSVP page link."}
      </div>
    );
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="bg-paper-2/60 text-xs uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-5 py-3 font-semibold">Seat</th>
            <th className="px-5 py-3 font-semibold">Ticket</th>
            <th className="px-5 py-3 font-semibold">Door</th>
            <th className="px-5 py-3 font-semibold">Deposit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5">
          {view.rsvps.map((r) => (
            <tr key={r.ticket_hash}>
              <td className="px-5 py-3 tabular-nums">{r.seat}</td>
              <td className="px-5 py-3 font-mono text-xs text-ink-3">{r.ticket_hash.slice(0, 12)}…</td>
              <td className="px-5 py-3">{r.checked_in ? <Pill tone="ok">Checked in</Pill> : <Pill>Not yet</Pill>}</td>
              <td className="px-5 py-3">
                <Pill tone={r.status === "refunded" ? "ok" : r.status === "forfeited" ? "warn" : "neutral"}>{r.status}</Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-ink/5 px-5 py-3 text-xs text-ink-3">
        This is all there is to see. There are no names because there are none to show.
      </p>
    </div>
  );
}

const PAYOUT_LABEL: Record<PayoutStatus, { tone: "ok" | "bad" | "warn" | "neutral"; text: string }> = {
  queued: { tone: "warn", text: "queued" },
  submitted: { tone: "warn", text: "building" },
  broadcast: { tone: "neutral", text: "confirming" },
  done: { tone: "ok", text: "paid" },
  failed: { tone: "bad", text: "failed" },
};

function FundForm({ id, token, current, onChange }: { id: string; token: string; current: string; onChange: () => void }) {
  const meta = useMeta();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = meta ? addressProblem(address, meta.network) : "Connecting…";
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.setFund(id, address.trim(), token);
      setAddress("");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the address.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="fund" className="label">{current ? "Change no-show fund address" : "No-show fund address"}</label>
      <input id="fund" className="input font-mono text-[12px]" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="u1…" spellCheck={false} />
      {error && <p className="text-xs text-bad">{error}</p>}
      <button className="btn-secondary w-full" disabled={busy || !address.trim()}>{busy && <Spinner />} Save{current ? "" : " and sweep after settling"}</button>
    </form>
  );
}

function MoneyTab({ view, token, onChange }: { view: AdminView; token: string; onChange: () => void }) {
  const ev = view.event;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Refunded" value={`${zatToZec(ev.refunded_zat)} ZEC`} />
          <Stat
            label="Forfeited"
            value={`${zatToZec(ev.forfeited_zat)} ZEC`}
            sub={ev.swept_zat ? `${zatToZec(ev.swept_zat)} ZEC swept to your fund` : ev.forfeit_address ? "Swept to your fund after refunds" : "Kept in the event wallet"}
          />
          <Stat label="Fee top-ups" value={`${zatToZec(ev.float_zat)} ZEC`} />
        </div>
        <div className="card overflow-x-auto">
          <div className="border-b border-ink/5 px-5 py-3 text-sm font-semibold">Payouts</div>
          {view.payouts.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-3">No payouts yet. Refunds go out when you end the event.</p>
          ) : (
            <table className="w-full min-w-[36rem] text-left text-sm">
              <tbody className="divide-y divide-ink/5">
                {view.payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-3 capitalize">{p.kind === "reject" ? "Returned payment" : p.kind === "forfeit" ? "No-show sweep" : "Refund batch"}</td>
                    <td className="px-5 py-3 tabular-nums text-ink-3">{p.recipients} recipient{p.recipients === 1 ? "" : "s"}</td>
                    <td className="px-5 py-3 tabular-nums">{zatToZec(p.amount_zat)} ZEC</td>
                    <td className="px-5 py-3">
                      <Pill tone={PAYOUT_LABEL[p.status]?.tone ?? "neutral"}>{PAYOUT_LABEL[p.status]?.text ?? p.status}</Pill>
                      {p.error && <div className="mt-1 max-w-xs text-xs text-ink-3">{p.error}</div>}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-ink-3">{p.txid ? `${p.txid.slice(0, 10)}…` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card overflow-x-auto">
          <div className="border-b border-ink/5 px-5 py-3 text-sm font-semibold">Incoming payments</div>
          {view.deposits.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-3">Nothing received yet.</p>
          ) : (
            <table className="w-full min-w-[36rem] text-left text-sm">
              <tbody className="divide-y divide-ink/5">
                {view.deposits.map((d) => (
                  <tr key={`${d.txid}-${d.index}`}>
                    <td className="px-5 py-3 font-mono text-xs text-ink-3">{d.txid.slice(0, 10)}…</td>
                    <td className="px-5 py-3 tabular-nums">{zatToZec(d.amount_zat)} ZEC</td>
                    <td className="px-5 py-3">
                      {d.kind === "rsvp" ? (
                        <Pill tone="ok">RSVP</Pill>
                      ) : d.kind === "rejected" ? (
                        <Pill tone="bad">Returned</Pill>
                      ) : d.reason === "bad_refund_address" ? (
                        <Pill tone="warn">Can&rsquo;t refund</Pill>
                      ) : (
                        <Pill>Top-up / no memo</Pill>
                      )}
                      {d.reason && d.reason !== "no_memo" && <span className="ml-2 text-xs text-ink-3">{REJECTION_TEXT[d.reason] ?? d.reason}</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-3">Sender: hidden</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="card h-fit space-y-4 p-5">
        <div className="text-sm font-semibold">Event wallet</div>
        <div className="flex justify-center">
          <Qr value={zip321(ev.address, 100_000)} size={200} label="Fee top-up QR code" />
        </div>
        <p className="text-xs text-ink-3">
          Scan to send a 0.001 ZEC fee top-up. Payments without an RSVP memo are treated as top-ups.
        </p>
        <CopyField label="Address" value={ev.address} />
        {ev.status !== "purged" && (
          <div className="border-t border-ink/10 pt-4">
            {ev.forfeit_address && <CopyField label="No-show fund" value={ev.forfeit_address} />}
            <div className={ev.forfeit_address ? "mt-4" : ""}>
              <FundForm id={ev.id} token={token} current={ev.forfeit_address} onChange={onChange} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SeizedTab({ view }: { view: AdminView }) {
  const dump = {
    event: {
      id: view.event.id,
      title: view.event.title,
      starts_at: view.event.starts_at,
      location: view.event.location,
      capacity: view.event.capacity,
      deposit_zat: view.event.deposit_zat,
      counts: {
        rsvps: view.event.rsvp_count,
        checked_in: view.event.checked_in_count,
        returned: view.event.rejected_count,
      },
    },
    rsvps: view.rsvps.map((r) => ({ ticket_hash: r.ticket_hash, refund_address: r.refund_address, checked_in: r.checked_in, status: r.status })),
    deposits: view.deposits.map((d) => ({ txid: d.txid, amount_zat: d.amount_zat, kind: d.kind })),
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <div className="space-y-4 text-sm leading-relaxed text-ink-2">
        <h2 className="text-3xl text-ink">Imagine this server was seized tonight.</h2>
        <p>
          On the right is every record Unlisted holds for this event. Look for a name, an email, a phone number or the
          address someone paid from. None of them exist.
        </p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li><strong>Ticket hashes</strong> are SHA-256 of secrets that live only on attendees&rsquo; phones.</li>
          <li><strong>Refund addresses</strong> are one-time shielded addresses. The chain can&rsquo;t link them to their owners. They&rsquo;re shortened here because you never need them; the server keeps them in full until the purge.</li>
          <li><strong>Deposit transactions</strong> are shielded. Their sender is hidden from everyone, us included.</li>
        </ul>
        <p>
          Purging deletes these records, the event&rsquo;s title, date and place, <em>and</em> its wallet keys and seed,
          so not even the server can decrypt the event&rsquo;s memos from the chain again. Only the totals remain.
        </p>
      </div>
      <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-all panel bg-black/60 p-5 font-mono text-xs leading-relaxed text-ink-2">
        {JSON.stringify(dump, null, 2)}
      </pre>
    </div>
  );
}
