"""HTTP API.

Privacy rules this module keeps:
* No access logs and no IP addresses stored anywhere.
* Attendees never send the server anything: the RSVP page builds the memo
  in the browser, and confirmation is checked by downloading the event's whole
  public ticket-hash list rather than asking about one ticket.
* Organiser and door links carry their token in the URL fragment, which
  browsers never send; the web app passes it as a bearer token instead.
"""

from __future__ import annotations

import base64
import logging
import threading
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select

from .chain import ChainError, make_chain
from .codec import is_ticket_hash
from .config import Settings, get_settings
from .db import Deposit, Event, Payout, Rsvp, init_db, make_engine, make_sessionmaker
from .engine import DOOR_OPEN, Engine, EngineError, _aware, accepting_rsvps
from .locks import acquire_writer_lock

log = logging.getLogger("cashr")

MAX_DEPOSIT_ZAT = 100 * 100_000_000
MIN_DEPOSIT_ZAT = 100_000  # 0.001 ZEC
# Events can be created at most this far ahead, so empty future events can't
# hold the server's live-event limit indefinitely (see Engine.retire_idle_events).
MAX_AHEAD = timedelta(days=366)
# Every request body here is small; anything bigger is refused before parsing.
MAX_BODY_BYTES = 64 * 1024
# /health fails once the wallet's last catch-up with the chain is older than this.
SYNC_STALE_S = 300


# ---- schemas -----------------------------------------------------------
class CreateEvent(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    # An ISO 8601 time with its UTC offset, so every viewer sees the right time.
    starts_at: str = Field(min_length=1, max_length=40)
    location: str = Field(default="", max_length=200)
    details: str = Field(default="", max_length=4000)
    capacity: int = Field(ge=1, le=5000)
    deposit_zat: int = Field(ge=MIN_DEPOSIT_ZAT, le=MAX_DEPOSIT_ZAT)
    rsvp_closes_at: datetime | None = None
    forfeit_address: str = Field(default="", max_length=600)

    @field_validator("title", "starts_at", "location", "details", "forfeit_address")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("starts_at")
    @classmethod
    def _aware_time(cls, v: str) -> str:
        try:
            t = datetime.fromisoformat(v)
        except ValueError as e:
            raise ValueError("starts_at must be an ISO 8601 date and time") from e
        if t.tzinfo is None:
            raise ValueError("starts_at needs a UTC offset, e.g. 2026-10-30T18:00:00Z")
        if t > datetime.now(timezone.utc) + MAX_AHEAD:
            raise ValueError("starts_at can be at most a year ahead")
        return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    @field_validator("rsvp_closes_at")
    @classmethod
    def _aware_close(cls, v: datetime | None) -> datetime | None:
        if v is not None and v.tzinfo is None:
            raise ValueError("rsvp_closes_at needs a UTC offset")
        # Stored as UTC: SQLite would otherwise drop the offset and shift the deadline.
        return v.astimezone(timezone.utc) if v is not None else None


    @model_validator(mode="after")
    def _closes_before_start(self) -> "CreateEvent":
        if self.rsvp_closes_at is not None:
            starts = datetime.fromisoformat(self.starts_at.replace("Z", "+00:00"))
            if self.rsvp_closes_at > starts:
                raise ValueError("RSVPs must close before the event starts")
        return self


class FundAddress(BaseModel):
    address: str = Field(min_length=1, max_length=600)


class CheckIn(BaseModel):
    ticket_hash: str


class SyncCheckIns(BaseModel):
    ticket_hashes: list[str] = Field(max_length=5000)


class SimPay(BaseModel):
    address: str
    amount_zat: int = Field(gt=0)
    memo_b64url: str


# ---- views ---------------------------------------------------------------
class _BodyTooLarge(Exception):
    pass


class BodyLimit:
    """Caps a body sent without Content-Length (chunked) as it streams in."""

    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        seen = 0

        async def limited():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _BodyTooLarge
            return message

        try:
            await self.app(scope, limited, send)
        except _BodyTooLarge:
            await JSONResponse({"error": "too_large", "message": "Request too large."}, status_code=413)(scope, receive, send)


def public_event(ev: Event) -> dict:
    return {
        "id": ev.id,
        "title": ev.title,
        "starts_at": ev.starts_at,
        "location": ev.location,
        "details": ev.details,
        "capacity": ev.capacity,
        "deposit_zat": ev.deposit_zat,
        # With its offset: SQLite hands the time back without one, and a browser
        # would read a bare time as its own local time.
        "rsvp_closes_at": _aware(ev.rsvp_closes_at).isoformat().replace("+00:00", "Z") if ev.rsvp_closes_at else None,
        "status": ev.status,
        "address": ev.address,
        # Public counts follow the public list, which fills in batches; a live count
        # would time each payment. Check-ins are counted only once the event settles,
        # or the count would time each arrival.
        "rsvp_count": ev.listed_count,
        "checked_in_count": None if ev.status in DOOR_OPEN else ev.checked_in_count,
        "seats_left": max(0, ev.capacity - ev.listed_count),
        # From the list too: a flag that flipped when the last seat was paid would time that payment.
        "full": ev.listed_count >= ev.capacity,
        # Open, and before the RSVP deadline. Payments sent when this is false are returned.
        "accepting_rsvps": accepting_rsvps(ev),
    }


def public_status(ev: Event, r: Rsvp) -> str:
    """A ticket's outcome as the public list shows it.

    Refunds go out one by one at random times; showing each as it confirmed would
    time that refund. Everyone who came reads "refunding" until all are done.
    """
    if ev.status == "settling" and r.status == "refunded":
        return "refunding"
    return r.status


def admin_event(ev: Event) -> dict:
    return public_event(ev) | {
        # The organiser (and door) see the true, live counts.
        "rsvp_count": ev.rsvp_count,
        "checked_in_count": ev.checked_in_count,
        "seats_left": max(0, ev.capacity - ev.rsvp_count),
        "forfeit_address": ev.forfeit_address,
        "rejected_count": ev.rejected_count,
        "refunded_zat": ev.refunded_zat,
        "forfeited_zat": ev.forfeited_zat,
        "float_zat": ev.float_zat,
        "swept_zat": ev.swept_zat,
        # Until then a settling event waits for offline door phones' check-ins.
        "sweep_after": _aware(ev.sweep_not_before).isoformat().replace("+00:00", "Z") if ev.sweep_not_before else None,
    }


def create_app(settings: Settings | None = None, chain=None) -> FastAPI:
    settings = settings or get_settings()
    chain = chain or make_chain(settings)
    # One process owns the database and the wallet's payouts: a second one
    # would race on them. Refuse to start rather than risk paying twice.
    writer_lock = acquire_writer_lock(settings.database_url)
    engine_db = make_engine(settings.database_url)
    init_db(engine_db)
    sessions = make_sessionmaker(engine_db)
    engine = Engine(settings, chain, sessions)
    stop = threading.Event()

    def scanner() -> None:
        while not stop.is_set():
            try:
                if settings.is_sim:
                    chain.mine()  # the simulated chain gets a block every cycle
                engine.scan_once()
            except Exception:  # keep scanning whatever one cycle hit
                log.exception("scan cycle failed")
            stop.wait(settings.scan_interval_s)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        t = None
        # A rewrite a purge owed when the server stopped is finished before serving.
        engine.compact_if_owed()
        if settings.run_scanner:
            t = threading.Thread(target=scanner, name="cashr-scanner", daemon=True)
            t.start()
        yield
        stop.set()
        if t:
            t.join(timeout=5)
        writer_lock.release()

    app = FastAPI(title="cashr API", version="0.1.0", lifespan=lifespan,
                  # The interactive API docs are for development only.
                  docs_url="/docs" if settings.is_sim else None, openapi_url="/openapi.json" if settings.is_sim else None,
                  redoc_url=None)
    app.state.engine = engine
    app.state.chain = chain
    app.state.writer_lock = writer_lock
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(EngineError)
    async def _engine_error(_: Request, e: EngineError):
        return JSONResponse({"error": e.code, "message": str(e)}, status_code=e.status)

    @app.exception_handler(ChainError)
    async def _chain_error(_: Request, e: ChainError):
        # The wallet's own words can name internal hosts or addresses: logged, not shown.
        log.warning("wallet error: %s", e)
        return JSONResponse({"error": "wallet", "message": "The wallet is unavailable right now. Try again shortly."},
                            status_code=502)

    @app.middleware("http")
    async def _limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
            return JSONResponse({"error": "too_large", "message": "Request too large."}, status_code=413)
        return await call_next(request)

    app.add_middleware(BodyLimit, max_bytes=MAX_BODY_BYTES)

    def db_session():
        with sessions() as db:
            yield db

    @contextmanager
    def wallet_errors_shown():
        """For the organiser's own actions: say why the wallet refused."""
        try:
            yield
        except ChainError as e:
            raise EngineError("wallet", f"The wallet couldn't do that: {e}", 502) from e

    def bearer(authorization: str = Header(default="")) -> str:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "Missing link token.")
        return token

    # ---- public -----------------------------------------------------------
    @app.get("/health")
    def health():
        """Healthy only while the wallet is keeping up with the chain: a stalled sync
        (Tor or lightwalletd down) would otherwise go unnoticed while payments wait."""
        try:
            age = chain.sync_age()
        except ChainError:
            age = None
        ok = age is not None and age <= SYNC_STALE_S
        return JSONResponse({"ok": ok, "sync_age_s": age}, status_code=200 if ok else 503)

    @app.get("/meta")
    def meta():
        try:
            tip = chain.tip_height()
        except ChainError:
            tip = None
        return {
            "chain": settings.chain_mode,
            "network": settings.network,
            "min_conf": settings.min_conf,
            "reject_fee_zat": settings.reject_fee_zat,
            # Minutes a settling event waits for offline door phones before sweeping.
            "door_sync_grace_min": settings.door_sync_grace_min,
            # The public list updates 0.5 to 1.5 times this many minutes apart.
            "list_delay_min": settings.list_delay_min,
            # None when the wallet is unreachable, so the UI can say so.
            "tip": tip,
        }

    @app.post("/events", status_code=201)
    def create_event(body: CreateEvent):
        created = engine.create_event(**body.model_dump())
        return {
            "event": public_event(created.event),
            "admin_token": created.admin_token,
            "door_token": created.door_token,
        }

    @app.get("/events/{event_id}")
    def get_event(event_id: str, db=Depends(db_session)):
        ev = db.get(Event, event_id)
        if ev is None:
            raise EngineError("not_found", "No such event.", 404)
        return public_event(ev)

    @app.get("/events/{event_id}/tickets")
    def tickets(event_id: str, db=Depends(db_session)):
        """Every ticket hash for the event. Attendees look for theirs locally."""
        ev = db.get(Event, event_id)
        if ev is None:
            raise EngineError("not_found", "No such event.", 404)
        # Sorted by hash, so the order says nothing about who paid first.
        rsvps = db.scalars(select(Rsvp).where(Rsvp.event_id == event_id, Rsvp.listed.is_(True))
                           .order_by(Rsvp.ticket_hash)).all()
        # Returned payments, and ones that can't be returned privately.
        rejected = db.scalars(select(Deposit).where(
            Deposit.event_id == event_id,
            (Deposit.kind == "rejected") | (Deposit.reason == "bad_refund_address"), Deposit.listed.is_(True))
            .order_by(Deposit.ticket_hash)).all()
        # Anyone can read this list. Showing check-ins as they happen would let
        # someone polling it note when each ticket came through the door, so a
        # ticket's status appears only once settlement has set them all at once.
        settled = ev.status not in DOOR_OPEN
        return {
            "status": ev.status,
            "tickets": [{"h": r.ticket_hash} | ({"status": public_status(ev, r)} if settled else {}) for r in rsvps],
            # Only whether the money comes back: a specific reason such as a reused
            # address would tell everyone something about that ticket's holder.
            "rejected": [{"h": d.ticket_hash, "reason": "kept" if d.reason == "bad_refund_address" else "returned"}
                         for d in rejected],
        }

    # ---- organiser ----------------------------------------------------------
    @app.get("/events/{event_id}/admin")
    def admin_view(event_id: str, token: str = Depends(bearer), db=Depends(db_session)):
        ev = engine.authorize(db, event_id, token, "admin")
        if ev.status == "purged":
            # The wallet account was deleted with the event: nothing to ask the wallet.
            balance, pending, wallet_error = 0, 0, ""
        else:
            try:
                bal = engine.balance(ev)
                balance, pending, wallet_error = bal.total_zat, bal.pending_zat, ""
            except ChainError as e:
                balance, pending, wallet_error = None, None, str(e)
        rsvps = db.scalars(select(Rsvp).where(Rsvp.event_id == event_id).order_by(Rsvp.seat)).all()
        deposits = db.scalars(select(Deposit).where(Deposit.event_id == event_id)
                              .order_by(Deposit.txid, Deposit.out_index)).all()
        payouts = db.scalars(select(Payout).where(Payout.event_id == event_id)
                             .order_by(Payout.id)).all()
        return {
            "event": admin_event(ev),
            "balance_zat": balance,
            "pending_zat": pending,
            "wallet_error": wallet_error,
            # The organiser never needs a refund address, and even a shortened one is a
            # fingerprint: the dashboard only learns that one is stored.
            "rsvps": [{"seat": r.seat, "ticket_hash": r.ticket_hash,
                       "refund_address": "stored until purge", "status": r.status,
                       "checked_in": r.checked_in} for r in rsvps],
            # No txids: matched with a ticket's arrival, one would date that ticket's payment.
            "deposits": [{"pool": d.pool, "index": d.out_index,
                          "amount_zat": d.amount_zat, "kind": d.kind,
                          "reason": d.reason} for d in deposits],
            "payouts": [{"id": p.id, "kind": p.kind, "status": p.status,
                         "recipients": len(p.recipients),
                         "amount_zat": sum(int(r["amount_zat"]) for r in p.recipients),
                         "txid": p.txid, "error": p.error} for p in payouts],
        }

    @app.post("/events/{event_id}/admin/fund")
    def admin_fund(event_id: str, body: FundAddress, token: str = Depends(bearer)):
        """Set (or change) where no-show deposits are swept; sweeps a settled event's leftovers."""
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "admin")
            engine.set_fund_address(db, ev, body.address)
            db.commit()
        with wallet_errors_shown():
            engine.scan_event(event_id)
        with sessions() as db:
            return admin_event(db.get(Event, event_id))

    @app.post("/events/{event_id}/admin/{action}")
    def admin_action(event_id: str, action: str, token: str = Depends(bearer)):
        actions = {"close": engine.close, "reopen": engine.reopen, "settle": engine.settle,
                   "retry": engine.retry_failed}
        if action not in actions and action not in ("scan", "purge"):
            raise EngineError("bad_action", "Unknown action.", 404)
        extra = {}
        if action == "close":
            # Asked before taking the lock: wallet calls can be slow.
            try:
                extra["tip"] = chain.tip_height()
            except ChainError:
                pass
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "admin")
            if action in actions:
                actions[action](db, ev, **extra)
                db.commit()
        with wallet_errors_shown():
            if action == "purge":
                engine.purge(event_id)
            elif action in ("scan", "settle", "retry"):
                engine.scan_event(event_id)
        with sessions() as db:
            return admin_event(db.get(Event, event_id))

    # ---- door -----------------------------------------------------------------
    @app.get("/events/{event_id}/door/manifest")
    def door_manifest(event_id: str, token: str = Depends(bearer), db=Depends(db_session)):
        ev = engine.authorize(db, event_id, token, "door")
        rsvps = db.scalars(select(Rsvp).where(Rsvp.event_id == event_id, Rsvp.status == "confirmed")
                           .order_by(Rsvp.ticket_hash)).all()
        return {
            "event": public_event(ev),
            "tickets": [{"h": r.ticket_hash, "seat": r.seat, "checked_in": r.checked_in}
                        for r in rsvps],
        }

    @app.post("/events/{event_id}/door/checkin")
    def door_checkin(event_id: str, body: CheckIn, token: str = Depends(bearer)):
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "door")
            if not is_ticket_hash(body.ticket_hash):
                return {"result": "unknown", "seat": None, "checked_in_count": ev.checked_in_count}
            # Like an offline device's sync: an arrival still counts until the sweep.
            result, seat = engine.late_check_in(db, ev, body.ticket_hash)
            db.commit()
            return {"result": result, "seat": seat, "checked_in_count": ev.checked_in_count}

    @app.post("/events/{event_id}/door/sync")
    def door_sync(event_id: str, body: SyncCheckIns, token: str = Depends(bearer)):
        """Upload check-ins a door device recorded while offline."""
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "door")
            # Settling may have started while the device was offline: those arrivals still count.
            results = [
                {"h": h, "result": engine.late_check_in(db, ev, h)[0] if is_ticket_hash(h) else "unknown"}
                for h in body.ticket_hashes
            ]
            db.commit()
            return {"results": results, "checked_in_count": ev.checked_in_count}

    # ---- simulator (CASHR_CHAIN=sim only) ----------------------------------
    if settings.is_sim:
        @app.post("/sim/pay")
        def sim_pay(body: SimPay):
            pad = "=" * (-len(body.memo_b64url) % 4)
            memo = base64.urlsafe_b64decode(body.memo_b64url + pad)
            txid = chain.pay(body.address, body.amount_zat, memo)
            engine.scan_once(full=True)
            return {"txid": txid}

        @app.get("/sim/address")
        def sim_address():
            """A fresh, valid Orchard Unified Address, for end-to-end tests."""
            from .chain.sim import random_unified_address

            return {"address": random_unified_address(settings.network)}

        @app.post("/sim/mine")
        def sim_mine(blocks: int = 1):
            chain.mine(min(max(blocks, 1), 100))
            engine.scan_once(full=True)
            return {"height": chain.tip_height()}

    return app


def _silence_access_log() -> None:
    logging.getLogger("uvicorn.access").disabled = True


_silence_access_log()
