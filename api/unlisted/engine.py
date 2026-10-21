"""Event lifecycle: ingest deposits, check in, settle, purge.

All state changes go through here, under one lock, so the background scanner
and API requests never race on an event's counters.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import string
import threading
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .chain import Chain, ChainError, Recipient
from .codec import is_orchard_address, try_decode_memo
from .config import Settings
from .db import Deposit, Event, Payout, Rsvp, SeenAddress

log = logging.getLogger("unlisted.engine")

ACTIVE = ("open", "closed", "settling", "settled")
DOOR_OPEN = ("open", "closed")
MAX_ATTEMPTS = 5
ZIP317_MARGINAL_ZAT = 5_000

_ID_ALPHABET = string.ascii_lowercase + string.digits


def new_event_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


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


class Engine:
    def __init__(self, settings: Settings, chain: Chain, sessions: sessionmaker):
        self.settings = settings
        self.chain = chain
        self.sessions = sessions
        self.lock = threading.RLock()

    # ---- helpers --------------------------------------------------------
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

    # ---- creation -------------------------------------------------------
    def create_event(self, *, title: str, starts_at: str, location: str, details: str,
                     capacity: int, deposit_zat: int, rsvp_closes_at: datetime | None,
                     forfeit_address: str) -> CreatedEvent:
        if forfeit_address and not is_orchard_address(forfeit_address, self.settings.network):
            raise EngineError("bad_address", "The no-show fund address must be a Unified Address with an Orchard receiver.")
        account_ref, address = self.chain.new_event_account()
        admin, door = new_token(), new_token()
        with self.lock, self.sessions() as db:
            ev = Event(
                id=new_event_id(), title=title, starts_at=starts_at, location=location,
                details=details, capacity=capacity, deposit_zat=deposit_zat,
                rsvp_closes_at=rsvp_closes_at, forfeit_address=forfeit_address,
                account_ref=account_ref, address=address,
                admin_token_hash=token_hash(admin), door_token_hash=token_hash(door),
            )
            db.add(ev)
            db.commit()
            return CreatedEvent(ev, admin, door)

    # ---- ingestion ------------------------------------------------------
    def scan_once(self) -> None:
        with self.sessions() as db:
            ids = db.scalars(select(Event.id).where(Event.status.in_(ACTIVE))).all()
        for event_id in ids:
            try:
                self.scan_event(event_id)
            except ChainError as e:
                log.warning("scan %s: %s", event_id, e)

    def scan_event(self, event_id: str) -> None:
        with self.sessions() as db:
            ev = self._get_event(db, event_id)
            account_ref, address = ev.account_ref, ev.address
        notes = self.chain.received(account_ref, address)
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, event_id)
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
            db.commit()
        self.process_payouts(event_id)

    def _ingest(self, db: Session, ev: Event, note) -> None:
        dep = Deposit(event_id=ev.id, txid=note.txid, pool=note.pool, out_index=note.out_index,
                      amount_zat=note.amount_zat, height=note.height, kind="float")
        db.add(dep)
        memo = try_decode_memo(note.memo)
        if memo is None:
            # Organiser top-ups (and anything else without our memo) fund fees.
            ev.float_zat += note.amount_zat
            return
        dep.ticket_hash = memo.ticket_hash
        if not is_orchard_address(memo.refund_address, self.settings.network):
            # Nowhere to return it privately (no Orchard receiver).
            dep.reason = "bad_refund_address"
            ev.float_zat += note.amount_zat
            return

        reason = self._rejection(db, ev, memo, note.amount_zat)
        if reason:
            dep.kind, dep.reason = "rejected", reason
            ev.rejected_count += 1
            refund = note.amount_zat - self.settings.reject_fee_zat
            if refund > 0:
                db.add(Payout(event_id=ev.id, kind="reject", recipients=[{
                    "address": memo.refund_address, "amount_zat": refund,
                    "memo": f"Unlisted: your payment for '{ev.title}' was returned ({reason}).",
                    "rsvp_id": None,
                }]))
            else:
                ev.float_zat += note.amount_zat
            return

        dep.kind = "rsvp"
        ev.rsvp_count += 1
        db.add(Rsvp(event_id=ev.id, ticket_hash=memo.ticket_hash,
                    refund_address=memo.refund_address, seat=ev.rsvp_count))
        db.add(SeenAddress(digest=self._address_digest(memo.refund_address)))
        db.flush()

    def _rejection(self, db: Session, ev: Event, memo, amount_zat: int) -> str:
        if memo.event_id != ev.id:
            return "wrong_event"
        closes = ev.rsvp_closes_at
        if closes is not None and closes.tzinfo is None:
            closes = closes.replace(tzinfo=timezone.utc)
        if ev.status != "open" or (closes is not None and datetime.now(timezone.utc) > closes):
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
        # A settlement step can queue the forfeit sweep; run it in the same cycle.
        for _ in range(3):
            if not self._process_payouts_once(event_id):
                return

    def _process_payouts_once(self, event_id: str) -> bool:
        """Returns True if settlement queued new work."""
        with self.lock, self.sessions() as db:
            ev = self._get_event(db, event_id)
            payouts = db.scalars(
                select(Payout).where(Payout.event_id == event_id,
                                     Payout.status.in_(("queued", "submitted")))
                .order_by(Payout.id)
            ).all()
            for p in payouts:
                if p.status == "submitted":
                    self._poll(db, ev, p)
                if p.status == "queued":
                    self._submit(db, ev, p)
            db.commit()
            if ev.status == "settling":
                queued = self._advance_settlement(db, ev)
                db.commit()
                return queued
            return False

    def _submit(self, db: Session, ev: Event, p: Payout) -> None:
        recipients = [Recipient(r["address"], int(r["amount_zat"]), r["memo"].encode())
                      for r in p.recipients]
        try:
            p.opid = self.chain.send(ev.account_ref, ev.address, recipients)
            p.status, p.error = "submitted", ""
        except ChainError as e:
            p.attempts += 1
            p.error = str(e)
            # Shortfalls wait for a top-up rather than failing for good.
            if "insufficient" not in p.error.lower() and p.attempts >= MAX_ATTEMPTS:
                p.status = "failed"
            return
        self._poll(db, ev, p)

    def _poll(self, db: Session, ev: Event, p: Payout) -> None:
        st = self.chain.op_status(p.opid)
        if st.state == "pending":
            return
        if st.state == "failed":
            p.error = st.error
            if "insufficient" in st.error.lower():
                # Wallets report shortfalls when the send runs, not when it is
                # submitted. Wait for forfeits or a top-up instead of failing.
                p.status = "queued"
                return
            p.attempts += 1
            p.status = "failed" if p.attempts >= MAX_ATTEMPTS else "queued"
            return
        p.status, p.txid = "done", st.txid
        if p.kind == "refund":
            ids = [r["rsvp_id"] for r in p.recipients]
            for rsvp in db.scalars(select(Rsvp).where(Rsvp.id.in_(ids))):
                rsvp.status = "refunded"
            ev.refunded_zat += sum(int(r["amount_zat"]) for r in p.recipients)

    def _advance_settlement(self, db: Session, ev: Event) -> bool:
        """Move a settling event forward. Returns True if it queued the sweep."""
        # Wait for every refund, and for any failure to be retried by the organiser.
        unfinished = db.scalar(select(Payout.id).where(
            Payout.event_id == ev.id, Payout.status.in_(("queued", "submitted", "failed"))))
        if unfinished is not None:
            return False
        has_sweep = db.scalar(select(Payout.id).where(Payout.event_id == ev.id,
                                                      Payout.kind == "forfeit"))
        if ev.forfeit_address and has_sweep is None:
            n_notes = db.query(Deposit).filter(Deposit.event_id == ev.id).count()
            reserve = ZIP317_MARGINAL_ZAT * max(2, n_notes + 2)
            try:
                amount = self.chain.spendable_zat(ev.account_ref) - reserve
            except ChainError as e:
                log.warning("sweep %s: %s", ev.id, e)
                return False
            if amount > 0:
                db.add(Payout(event_id=ev.id, kind="forfeit", recipients=[{
                    "address": ev.forfeit_address, "amount_zat": amount,
                    "memo": f"Unlisted: no-show deposits from '{ev.title}'.", "rsvp_id": None,
                }]))
                return True
        ev.status = "settled"
        return False

    # ---- organiser actions ----------------------------------------------
    def close(self, db: Session, ev: Event) -> None:
        if ev.status != "open":
            raise EngineError("bad_state", "RSVPs are already closed.")
        ev.status = "closed"

    def reopen(self, db: Session, ev: Event) -> None:
        if ev.status != "closed":
            raise EngineError("bad_state", "Only a closed event can be reopened.")
        ev.status = "open"

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
                                "memo": f"Unlisted: thanks for coming to '{ev.title}'. Deposit refunded.",
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
            p.status, p.attempts = "queued", 0
        return len(failed)

    def purge(self, db: Session, ev: Event) -> None:
        if ev.status != "settled":
            raise EngineError("bad_state", "Settle the event before purging it.")
        for model in (Rsvp, Deposit, Payout):
            db.query(model).filter(model.event_id == ev.id).delete()
        ev.location = ""
        ev.details = ""
        ev.status = "purged"

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
