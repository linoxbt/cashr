"""Event lifecycle: ingest deposits, check in, settle, purge.

All database changes go through here, under one lock, so the background
scanner and API requests never race on an event's counters. Wallet calls are
made *outside* the lock (they can be slow), and their results are applied
only if the payout has not moved on meanwhile. Sends carry an idempotency key,
so two processes submitting the same payout produce one transaction.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import string
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .chain import Balance, Chain, ChainError, Recipient
from .codec import is_orchard_address, try_decode_memo
from .config import Settings
from .db import Deposit, Event, Payout, Rsvp, SeenAddress

log = logging.getLogger("unlisted.engine")

ACTIVE = ("open", "closed", "settling", "settled")
DOOR_OPEN = ("open", "closed")
IN_FLIGHT = ("queued", "submitted", "broadcast")
MAX_ATTEMPTS = 5
# Notes this far below the last ingested block are re-read on every scan, so a
# small reorg cannot hide a deposit.
REORG_MARGIN = 100
# A pending transaction is rebroadcast every this many polls (~5 min at 15 s).
REBROADCAST_EVERY = 20
# Settled events are scanned (for late payments to return) every Nth cycle.
SLOW_SCAN_EVERY = 8
BALANCE_TTL_S = 10.0
# Memos stay in the recipient's wallet for good, so they never name the event:
# a refund memo with a title would prove attendance long after the purge.
REFUND_MEMO = "Unlisted: deposit refunded."
NO_SHOW_MEMO = "Unlisted: no-show deposits."
PURGED_TITLE = "Purged event"
# A payment sent just before RSVPs closed can be mined a block or two later;
# it still counts. Measured from the chain height when RSVPs closed.
RSVP_GRACE_BLOCKS = 2
BLOCK_SECONDS = 75
# An event that never received anything is retired this long after it started,
# so abandoned events don't keep wallet accounts (and capacity) forever.
IDLE_RETIRE_AFTER = timedelta(days=1)

_ID_ALPHABET = string.ascii_lowercase + string.digits


def _starts_before(starts_at: str, cutoff: datetime) -> bool:
    try:
        start = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (start if start.tzinfo else start.replace(tzinfo=timezone.utc)) < cutoff


def new_event_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def accepting_rsvps(ev: Event, now: datetime | None = None) -> bool:
    if ev.status != "open":
        return False
    closes = ev.rsvp_closes_at
    if closes is None:
        return True
    if closes.tzinfo is None:
        closes = closes.replace(tzinfo=timezone.utc)
    return (now or datetime.now(timezone.utc)) <= closes


class EngineError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass
class CreatedEvent:
    event: Event
    admin_token: str
    door_token: str


@dataclass
class _Snapshot:
    """What a payout looked like when the wallet call for it was planned."""

    id: int
    kind: str
    status: str
    key: str
    opid: str
    txid: str
    polls: int
    recipients: list = field(default_factory=list)


class Engine:
    def __init__(self, settings: Settings, chain: Chain, sessions: sessionmaker):
        self.settings = settings
        self.chain = chain
        self.sessions = sessions
        self.lock = threading.RLock()
        self._created: deque[float] = deque()
        self._balances: dict[str, tuple[float, Balance]] = {}
        self._cycle = 0

    # ---- helpers --------------------------------------------------------
    def _period(self) -> int:
        return int(time.time() // (max(1, self.settings.address_memory_days) * 86400))

    def forget_old_addresses(self) -> None:
        """Drop reuse digests older than the previous period.

        They outlive purges, so with the server's secret they could confirm that a
        known address once paid for an RSVP here. Keeping them for one to two
        periods still refuses reuse across events held close together.
        """
        with self.lock, self.sessions() as db:
            db.query(SeenAddress).filter(SeenAddress.period.is_(None)).update({"period": self._period()})
            db.query(SeenAddress).filter(SeenAddress.period < self._period() - 1).delete()
            db.commit()

    def _address_digest(self, address: str) -> str:
        return hmac.new(self.settings.secret.encode(), address.encode(), hashlib.sha256).hexdigest()

    def _get_event(self, db: Session, event_id: str) -> Event:
        ev = db.get(Event, event_id)
        if ev is None:
            raise EngineError("not_found", "No such event.", 404)
        return ev

    def authorize(self, db: Session, event_id: str, token: str, role: str) -> Event:
        ev = self._get_event(db, event_id)
        expected = ev.admin_token_hash if role == "admin" else ev.door_token_hash
        if not token or not hmac.compare_digest(token_hash(token), expected):
            raise EngineError("forbidden", "That link is not valid for this event.", 403)
        return ev

    def balance(self, ev: Event, fresh: bool = False) -> Balance:
        """The event wallet's balance, cached briefly so dashboards don't hammer the wallet."""
        hit = self._balances.get(ev.id)
        if hit and not fresh and time.monotonic() - hit[0] < BALANCE_TTL_S:
            return hit[1]
        bal = self.chain.balance(ev.account_ref)
        self._balances[ev.id] = (time.monotonic(), bal)
        return bal

    # ---- creation -------------------------------------------------------
    def _check_capacity(self) -> None:
        now = time.monotonic()
        while self._created and now - self._created[0] > 3600:
            self._created.popleft()
        if len(self._created) >= self.settings.create_per_hour:
            raise EngineError("busy", "This server is creating too many events right now. Try again in a while.", 429)
        with self.sessions() as db:
            live = db.scalar(select(func.count()).select_from(Event).where(Event.status != "purged"))
        if live >= self.settings.max_live_events:
            raise EngineError("busy", "This server is at its limit of live events. Try again after some are purged.", 429)

    def create_event(self, *, title: str, starts_at: str, location: str, details: str,
                     capacity: int, deposit_zat: int, rsvp_closes_at: datetime | None,
                     forfeit_address: str) -> CreatedEvent:
        if forfeit_address and not is_orchard_address(forfeit_address, self.settings.network):
            raise EngineError("bad_address", "The no-show fund address must be a Unified Address with an Orchard receiver.")
        with self.lock:
            self._check_capacity()
            self._created.append(time.monotonic())
        account_ref, address = self.chain.new_event_account()
        admin, door = new_token(), new_token()
        with self.lock, self.sessions() as db:
            ev = Event(
                id=new_event_id(), title=title, starts_at=starts_at, location=location,
                details=details, capacity=capacity, deposit_zat=deposit_zat,
                rsvp_closes_at=rsvp_closes_at, forfeit_address=forfeit_address,
                account_ref=account_ref, address=address,
                admin_token_hash=token_hash(admin), door_token_hash=token_hash(door),
                scan_height=self.chain.tip_height(),
            )
            db.add(ev)
            db.commit()
            return CreatedEvent(ev, admin, door)

    # ---- ingestion ------------------------------------------------------
    def scan_once(self, full: bool = False) -> None:
        self._cycle += 1
        slow_turn = full or self._cycle % SLOW_SCAN_EVERY == 0
        if slow_turn:
            self.forget_old_addresses()
            self.retire_idle_events()
        with self.sessions() as db:
            busy = set(db.scalars(select(Payout.event_id).where(Payout.status.in_(IN_FLIGHT))))
            rows = db.execute(select(Event.id, Event.status).where(Event.status.in_(ACTIVE))).all()
        for event_id, status in rows:
            if status == "settled" and event_id not in busy and not slow_turn:
                continue
            # One event failing (wallet hiccup, missing account) must not stop the others.
            try:
                self.scan_event(event_id)
            except ChainError as e:
                log.warning("scan %s: %s", event_id, e)
            except Exception:
                log.exception("scan %s failed", event_id)

    def scan_event(self, event_id: str) -> None:
        with self.sessions() as db:
            ev = self._get_event(db, event_id)
            account_ref, address = ev.account_ref, ev.address
            since = max(0, ev.scan_height - REORG_MARGIN)
            deadline_passed = ev.status == "open" and ev.close_height is None and not accepting_rsvps(ev)
        notes = self.chain.received(account_ref, address, since)
        tip = self.chain.tip_height() if deadline_passed else None
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, event_id)
            if ev.status not in ACTIVE:
                return
            if tip is not None and ev.status == "open" and ev.close_height is None:
                # The chain height at the deadline, estimated back from now, so
                # a scanner that was down doesn't stretch the grace.
                closes = ev.rsvp_closes_at.replace(tzinfo=ev.rsvp_closes_at.tzinfo or timezone.utc)
                late_s = max(0.0, (datetime.now(timezone.utc) - closes).total_seconds())
                ev.close_height = max(0, tip - int(late_s // BLOCK_SECONDS))
            known = {
                (d.txid, d.pool, d.out_index)
                for d in db.scalars(select(Deposit).where(Deposit.event_id == event_id))
            }
            fresh = sorted(
                (n for n in notes
                 if n.confirmations >= self.settings.min_conf
                 and (n.txid, n.pool, n.out_index) not in known),
                key=lambda n: (n.height, n.txid, n.out_index),
            )
            for note in fresh:
                self._ingest(db, ev, note)
                ev.scan_height = max(ev.scan_height, note.height)
            db.commit()
        if fresh:
            self._balances.pop(event_id, None)
        self.process_payouts(event_id)

    def _ingest(self, db: Session, ev: Event, note) -> None:
        dep = Deposit(event_id=ev.id, txid=note.txid, pool=note.pool, out_index=note.out_index,
                      amount_zat=note.amount_zat, height=note.height, kind="float")
        db.add(dep)
        memo = try_decode_memo(note.memo)
        if memo is None:
            # Organiser top-ups, and payments whose memo was lost: they fund fees.
            dep.reason = "no_memo"
            ev.float_zat += note.amount_zat
            return
        dep.ticket_hash = memo.ticket_hash
        if not is_orchard_address(memo.refund_address, self.settings.network):
            # Nowhere to return it privately (no Orchard receiver). The
            # attendee sees this on their ticket; the organiser sees it too.
            dep.reason = "bad_refund_address"
            ev.float_zat += note.amount_zat
            return

        reason = self._rejection(db, ev, memo, note.amount_zat, note.height)
        if reason:
            dep.kind, dep.reason = "rejected", reason
            ev.rejected_count += 1
            refund = note.amount_zat - self.settings.reject_fee_zat
            if refund > 0:
                db.add(Payout(event_id=ev.id, kind="reject", recipients=[{
                    "address": memo.refund_address, "amount_zat": refund,
                    "memo": f"Unlisted: payment returned ({reason}).",
                    "rsvp_id": None,
                }]))
            else:
                ev.float_zat += note.amount_zat
            return

        dep.kind = "rsvp"
        ev.rsvp_count += 1
        db.add(Rsvp(event_id=ev.id, ticket_hash=memo.ticket_hash,
                    refund_address=memo.refund_address, seat=self._free_seat(db, ev)))
        db.add(SeenAddress(digest=self._address_digest(memo.refund_address), period=self._period()))
        db.flush()

    @staticmethod
    def _within_grace(ev: Event, height: int) -> bool:
        """Mined so soon after RSVPs closed that it was sent while they were open."""
        return (ev.status in DOOR_OPEN and ev.close_height is not None and height > 0
                and height <= ev.close_height + RSVP_GRACE_BLOCKS)

    @staticmethod
    def _free_seat(db: Session, ev: Event) -> int:
        """A random free seat. Counting up would reveal the order people paid in."""
        taken = set(db.scalars(select(Rsvp.seat).where(Rsvp.event_id == ev.id)))
        return secrets.choice([n for n in range(1, ev.capacity + 1) if n not in taken])

    def _rejection(self, db: Session, ev: Event, memo, amount_zat: int, height: int = 0) -> str:
        if memo.event_id != ev.id:
            return "wrong_event"
        if not accepting_rsvps(ev) and not self._within_grace(ev, height):
            return "rsvps_closed"
        if amount_zat != ev.deposit_zat:
            return "wrong_amount"
        dup = db.scalar(select(Rsvp.id).where(Rsvp.event_id == ev.id,
                                              Rsvp.ticket_hash == memo.ticket_hash))
        if dup is not None:
            return "duplicate_ticket"
        if db.get(SeenAddress, self._address_digest(memo.refund_address)) is not None:
            return "address_reused"
        if ev.rsvp_count >= ev.capacity:
            return "full"
        return ""

    # ---- payouts --------------------------------------------------------
    def process_payouts(self, event_id: str) -> None:
        # Settlement can queue a sweep; give it a turn in the same cycle.
        for _ in range(3):
            self._run_payouts(event_id)
            if not self._advance_settlement(event_id):
                return

    def _run_payouts(self, event_id: str) -> None:
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, event_id)
            account_ref, address = ev.account_ref, ev.address
            for p in db.scalars(select(Payout).where(Payout.event_id == event_id, Payout.key.is_(None))):
                p.key = secrets.token_hex(16)  # rows from before keys existed
            db.commit()
            snaps = [
                _Snapshot(p.id, p.kind, p.status, p.key, p.opid, p.txid, p.polls, list(p.recipients))
                for p in db.scalars(select(Payout).where(Payout.event_id == event_id,
                                                         Payout.status.in_(IN_FLIGHT))
                                    .order_by(Payout.id))
            ]
        for snap in snaps:
            # Wallet I/O happens without the lock; door check-ins never wait on it.
            changes = self._step(account_ref, address, snap)
            if changes:
                self._apply(event_id, snap, changes)

    def _submit(self, account_ref: str, address: str, snap: _Snapshot) -> str:
        if snap.kind == "forfeit":
            r = snap.recipients[0]
            return self.chain.sweep(account_ref, address, r["address"], r["memo"].encode(), snap.key)
        recipients = [Recipient(r["address"], int(r["amount_zat"]), r["memo"].encode()) for r in snap.recipients]
        return self.chain.send(account_ref, address, recipients, snap.key)

    def _step(self, account_ref: str, address: str, snap: _Snapshot) -> dict:
        """Advance one payout by talking to the wallet. Returns the column changes to apply."""
        try:
            if snap.status == "queued":
                opid = self._submit(account_ref, address, snap)
                return self._after_op(snap, opid) | {"opid": opid}
            if snap.status == "submitted":
                return self._after_op(snap, snap.opid)
            return self._after_broadcast(account_ref, address, snap)
        except ChainError as e:
            # Unreachable, timed out, or refused. Retrying is safe: the key
            # stops the wallet from building a second transaction.
            msg = str(e)
            if "insufficient" in msg.lower():
                return {"error": msg}
            attempts = self._attempts(snap) + 1
            return {"error": msg, "attempts": attempts,
                    "status": "failed" if attempts >= MAX_ATTEMPTS and snap.status == "queued" else snap.status}

    def _attempts(self, snap: _Snapshot) -> int:
        with self.sessions() as db:
            return db.get(Payout, snap.id).attempts

    def _after_op(self, snap: _Snapshot, opid: str) -> dict:
        st = self.chain.op_status(opid)
        if st.state == "pending":
            return {"status": "submitted"}
        if st.state == "failed":
            if "insufficient" in st.error.lower():
                # Wallets report shortfalls when the send runs. Wait for
                # forfeits or a top-up instead of failing.
                return {"status": "queued", "error": st.error}
            if "unknown" in st.error.lower():
                # The wallet keeps operations on disk, so this means its data
                # was lost or replaced. It may already have paid: stop and let
                # a person check before anything is sent again.
                return {"status": "failed", "error": "The wallet has no record of this payout. Check the event "
                        "wallet's history before retrying, or it could be paid twice."}
            attempts = self._attempts(snap) + 1
            return {"status": "failed" if attempts >= MAX_ATTEMPTS else "queued",
                    "error": st.error, "attempts": attempts}
        changes = {"status": "broadcast", "txid": st.txid, "error": "", "polls": 0}
        if st.amount_zat is not None and snap.kind == "forfeit":
            changes["sweep_amount"] = st.amount_zat
        return changes

    def _after_broadcast(self, account_ref: str, address: str, snap: _Snapshot) -> dict:
        tx = self.chain.tx_status(snap.txid)
        if tx.state == "mined" and tx.confirmations >= self.settings.payout_conf:
            return {"status": "done", "error": ""}
        if tx.state == "expired":
            # It can never be mined now, and its notes are spendable again.
            # Resubmitting the same key makes the wallet build a fresh one.
            return {"status": "queued", "error": f"Transaction {snap.txid[:10]}… expired unmined; sending again."}
        polls = snap.polls + 1
        if tx.state == "pending" and polls % REBROADCAST_EVERY == 0:
            self._submit(account_ref, address, snap)  # same key: a rebroadcast, never a new send
        return {"polls": polls}

    def _apply(self, event_id: str, snap: _Snapshot, changes: dict) -> None:
        with self.lock, self.sessions() as db:
            p = db.get(Payout, snap.id)
            # Another worker got there first; its result stands.
            if p is None or p.status != snap.status or p.opid != snap.opid:
                return
            ev = self._get_event(db, event_id)
            sweep_amount = changes.pop("sweep_amount", None)
            if sweep_amount is not None:
                rec = dict(p.recipients[0], amount_zat=sweep_amount)
                p.recipients = [rec]
            for k, v in changes.items():
                setattr(p, k, v)
            if changes.get("status") == "done":
                total = sum(int(r["amount_zat"]) for r in p.recipients)
                if p.kind == "refund":
                    ids = [r["rsvp_id"] for r in p.recipients]
                    for rsvp in db.scalars(select(Rsvp).where(Rsvp.id.in_(ids))):
                        rsvp.status = "refunded"
                    ev.refunded_zat += total
                elif p.kind == "forfeit":
                    ev.swept_zat += total
                self._balances.pop(event_id, None)
            db.commit()

    def _advance_settlement(self, event_id: str) -> bool:
        """Move a settling event forward. Returns True if it queued a sweep."""
        with self.sessions() as db:
            ev = self._get_event(db, event_id)
            if ev.status != "settling":
                return False
            # Wait for every payout to be confirmed, and for failures to be retried by the organiser.
            unfinished = db.scalar(select(Payout.id).where(
                Payout.event_id == ev.id, Payout.status.in_(IN_FLIGHT + ("failed",))))
            if unfinished is not None:
                return False
            fund = ev.forfeit_address
            try:
                bal = self.balance(ev, fresh=True) if fund else None
            except ChainError as e:
                log.warning("settle %s: %s", ev.id, e)
                return False
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, event_id)
            if ev.status != "settling" or ev.forfeit_address != fund:
                return False
            if db.scalar(select(Payout.id).where(Payout.event_id == ev.id,
                                                 Payout.status.in_(IN_FLIGHT + ("failed",)))) is not None:
                return False
            if fund and bal is not None:
                if bal.pending_zat > 0:
                    # Change from refunds (or a late payment) is still confirming.
                    return False
                if bal.spendable_zat > self.settings.dust_zat:
                    db.add(Payout(event_id=ev.id, kind="forfeit", recipients=[{
                        "address": fund, "amount_zat": bal.spendable_zat,
                        "memo": NO_SHOW_MEMO, "rsvp_id": None,
                    }]))
                    db.commit()
                    return True
            ev.status = "settled"
            db.commit()
            return False

    # ---- organiser actions ----------------------------------------------
    def close(self, db: Session, ev: Event) -> None:
        if ev.status != "open":
            raise EngineError("bad_state", "RSVPs are already closed.")
        ev.status = "closed"
        if ev.close_height is None:
            try:
                ev.close_height = self.chain.tip_height()
            except ChainError:
                pass  # payments are then judged without the grace

    def reopen(self, db: Session, ev: Event) -> None:
        if ev.status != "closed":
            raise EngineError("bad_state", "Only a closed event can be reopened.")
        ev.status = "open"
        ev.close_height = None

    def settle(self, db: Session, ev: Event) -> None:
        if ev.status not in DOOR_OPEN:
            raise EngineError("bad_state", "This event is already settling or settled.")
        ev.status = "settling"
        refunds = []
        for r in db.scalars(select(Rsvp).where(Rsvp.event_id == ev.id,
                                               Rsvp.status == "confirmed").order_by(Rsvp.seat)):
            if r.checked_in:
                r.status = "refunding"
                refunds.append({"address": r.refund_address, "amount_zat": ev.deposit_zat,
                                "memo": REFUND_MEMO,
                                "rsvp_id": r.id})
            else:
                r.status = "forfeited"
                ev.forfeited_zat += ev.deposit_zat
        size = max(1, self.settings.refund_batch_size)
        for i in range(0, len(refunds), size):
            db.add(Payout(event_id=ev.id, kind="refund", recipients=refunds[i:i + size]))

    def retry_failed(self, db: Session, ev: Event) -> int:
        failed = db.scalars(select(Payout).where(Payout.event_id == ev.id,
                                                 Payout.status == "failed")).all()
        for p in failed:
            # Same key: if a transaction for it could still be mined, the
            # wallet rebroadcasts it instead of paying again.
            p.status, p.attempts = "queued", 0
        return len(failed)

    def set_fund_address(self, db: Session, ev: Event, address: str) -> None:
        address = address.strip()
        if ev.status == "purged":
            raise EngineError("bad_state", "This event has been purged.")
        if not is_orchard_address(address, self.settings.network):
            raise EngineError("bad_address", "The no-show fund address must be a Unified Address with an Orchard receiver.")
        sweeping = db.scalar(select(Payout.id).where(Payout.event_id == ev.id, Payout.kind == "forfeit",
                                                     Payout.status.in_(IN_FLIGHT)))
        if sweeping is not None:
            raise EngineError("bad_state", "A sweep to the current fund address is in progress.")
        ev.forfeit_address = address
        if ev.status == "settled":
            # Sweep what was kept in the event wallet.
            ev.status = "settling"

    def purge(self, ev_id: str) -> None:
        """Delete everything about the event, including its wallet keys.

        Refuses while money is still in the event wallet: deleting the keys
        would destroy it.
        """
        # Checked once without the lock for a quick answer, then again under it:
        # a late payment can land in between, and deleting the keys would destroy it.
        with self.sessions() as db:
            self._check_purgeable(db, self._get_event(db, ev_id))
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, ev_id)
            self._check_purgeable(db, ev)
            account_ref = ev.account_ref
            # Keys first: if the wallet refuses, nothing is deleted here either.
            self.chain.delete_account(account_ref)
            self._wipe(db, ev)
            db.commit()
        self._balances.pop(ev_id, None)

    @staticmethod
    def _wipe(db: Session, ev: Event) -> None:
        for model in (Rsvp, Deposit, Payout):
            db.query(model).filter(model.event_id == ev.id).delete()
        # Attendees' wallets keep the event id from their deposit memo, so
        # nothing left here may name, date or locate the event.
        ev.title = PURGED_TITLE
        ev.starts_at = ""
        ev.rsvp_closes_at = None
        ev.location = ""
        ev.details = ""
        ev.address = ""
        ev.account_ref = ""
        ev.forfeit_address = ""
        ev.status = "purged"

    def retire_idle_events(self) -> None:
        """Purge events that started over a day ago and never received anything.

        Nobody can lose money (nothing was paid in) and nobody RSVP'd, but each
        keeps a wallet account the wallet scans and a slot against the server's
        limit of live events. The wallet refuses the delete if anything arrived
        after all.
        """
        cutoff = datetime.now(timezone.utc) - IDLE_RETIRE_AFTER
        with self.sessions() as db:
            candidates = [
                ev.id for ev in db.scalars(select(Event).where(Event.status.in_(DOOR_OPEN), Event.rsvp_count == 0))
                if _starts_before(ev.starts_at, cutoff)
                and db.scalar(select(Deposit.id).where(Deposit.event_id == ev.id)) is None
            ]
        for event_id in candidates:
            with self.lock, self.sessions() as db:
                ev = self._get_event(db, event_id)
                if ev.status not in DOOR_OPEN or ev.rsvp_count or db.scalar(
                        select(Deposit.id).where(Deposit.event_id == ev.id)) is not None:
                    continue
                try:
                    self.chain.delete_account(ev.account_ref)
                except ChainError as e:
                    log.warning("retire %s: %s", event_id, e)
                    continue
                self._wipe(db, ev)
                db.commit()
            self._balances.pop(event_id, None)

    def _check_purgeable(self, db: Session, ev: Event) -> None:
        if ev.status != "settled":
            raise EngineError("bad_state", "Settle the event before purging it.")
        if db.scalar(select(Payout.id).where(Payout.event_id == ev.id, Payout.status.in_(IN_FLIGHT))) is not None:
            raise EngineError("payouts_pending", "A payout (such as a returned late payment) is still in progress. "
                              "Purge once it has confirmed.", 409)
        bal = self.balance(ev, fresh=True)
        if bal.total_zat > self.settings.dust_zat:
            raise EngineError(
                "funds_left",
                f"{bal.total_zat / 1e8:.8f} ZEC is still in the event wallet. Set a no-show fund address so it "
                "can be swept there before purging; purging destroys the wallet keys.",
                409,
            )

    # ---- door -----------------------------------------------------------
    def check_in(self, db: Session, ev: Event, ticket_hash: str) -> tuple[str, int | None]:
        if ev.status not in DOOR_OPEN:
            return "event_closed", None
        r = db.scalar(select(Rsvp).where(Rsvp.event_id == ev.id, Rsvp.ticket_hash == ticket_hash))
        if r is None or r.status != "confirmed":
            return "unknown", None
        if r.checked_in:
            return "already", r.seat
        r.checked_in = True
        ev.checked_in_count += 1
        return "ok", r.seat
