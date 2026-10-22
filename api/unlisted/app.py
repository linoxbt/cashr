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
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select

from .chain import ChainError, make_chain
from .codec import is_ticket_hash
from .config import Settings, get_settings
from .db import Deposit, Event, Payout, Rsvp, init_db, make_engine, make_sessionmaker
from .engine import DOOR_OPEN, Engine, EngineError, accepting_rsvps
from .locks import acquire_writer_lock

log = logging.getLogger("unlisted")

MAX_DEPOSIT_ZAT = 100 * 100_000_000


# ---- schemas -----------------------------------------------------------
class CreateEvent(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    # An ISO 8601 time with its UTC offset, so every viewer sees the right time.
    starts_at: str = Field(min_length=1, max_length=40)
    location: str = Field(default="", max_length=200)
    details: str = Field(default="", max_length=4000)
    capacity: int = Field(ge=1, le=5000)
    deposit_zat: int = Field(ge=50_000, le=MAX_DEPOSIT_ZAT)
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
        return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    @field_validator("rsvp_closes_at")
    @classmethod
    def _aware_close(cls, v: datetime | None) -> datetime | None:
        if v is not None and v.tzinfo is None:
            raise ValueError("rsvp_closes_at needs a UTC offset")
        return v


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
def public_event(ev: Event) -> dict:
    return {
        "id": ev.id,
        "title": ev.title,
        "starts_at": ev.starts_at,
        "location": ev.location,
        "details": ev.details,
        "capacity": ev.capacity,
        "deposit_zat": ev.deposit_zat,
        "rsvp_closes_at": ev.rsvp_closes_at.isoformat() if ev.rsvp_closes_at else None,
        "status": ev.status,
        "address": ev.address,
        "rsvp_count": ev.rsvp_count,
        "checked_in_count": ev.checked_in_count,
        "seats_left": max(0, ev.capacity - ev.rsvp_count),
        # Open, and before the RSVP deadline. Payments sent when this is false are returned.
        "accepting_rsvps": accepting_rsvps(ev),
    }


def shorten(address: str) -> str:
    return f"{address[:8]}…{address[-6:]}" if len(address) > 20 else address


def admin_event(ev: Event) -> dict:
    return public_event(ev) | {
        "forfeit_address": ev.forfeit_address,
        "rejected_count": ev.rejected_count,
        "refunded_zat": ev.refunded_zat,
        "forfeited_zat": ev.forfeited_zat,
        "float_zat": ev.float_zat,
        "swept_zat": ev.swept_zat,
    }


def create_app(settings: Settings | None = None, chain=None) -> FastAPI:
    settings = settings or get_settings()
    if not settings.is_sim and settings.secret == "dev-only-secret":
        raise RuntimeError("Set UNLISTED_SECRET before running against a real wallet.")
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
        if settings.run_scanner:
            t = threading.Thread(target=scanner, name="unlisted-scanner", daemon=True)
            t.start()
        yield
        stop.set()
        if t:
            t.join(timeout=5)
        writer_lock.release()

    app = FastAPI(title="Unlisted API", version="0.1.0", lifespan=lifespan,
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
        return JSONResponse({"error": "wallet", "message": str(e)}, status_code=502)

    def db_session():
        with sessions() as db:
            yield db

    def bearer(authorization: str = Header(default="")) -> str:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "Missing link token.")
        return token

    # ---- public -----------------------------------------------------------
    @app.get("/health")
    def health():
        return {"ok": True}

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
        rsvps = db.scalars(select(Rsvp).where(Rsvp.event_id == event_id).order_by(Rsvp.ticket_hash)).all()
        # Returned payments, and ones that can't be returned privately.
        rejected = db.scalars(select(Deposit).where(
            Deposit.event_id == event_id,
            (Deposit.kind == "rejected") | (Deposit.reason == "bad_refund_address"))
            .order_by(Deposit.ticket_hash)).all()
        # Anyone can read this list. Showing check-ins as they happen would let
        # someone polling it note when each ticket came through the door, so a
        # ticket's status appears only once settlement has set them all at once.
        settled = ev.status not in DOOR_OPEN
        return {
            "status": ev.status,
            "tickets": [{"h": r.ticket_hash} | ({"status": r.status} if settled else {}) for r in rsvps],
            "rejected": [{"h": d.ticket_hash, "reason": d.reason} for d in rejected],
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
            # The organiser never needs a refund address; shortened, it still
            # shows what the server holds without handing it out.
            "rsvps": [{"seat": r.seat, "ticket_hash": r.ticket_hash,
                       "refund_address": shorten(r.refund_address), "status": r.status,
                       "checked_in": r.checked_in} for r in rsvps],
            "deposits": [{"txid": d.txid, "pool": d.pool, "index": d.out_index,
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
        engine.scan_event(event_id)
        with sessions() as db:
            return admin_event(db.get(Event, event_id))

    @app.post("/events/{event_id}/admin/{action}")
    def admin_action(event_id: str, action: str, token: str = Depends(bearer)):
        actions = {"close": engine.close, "reopen": engine.reopen, "settle": engine.settle,
                   "retry": engine.retry_failed}
        if action not in actions and action not in ("scan", "purge"):
            raise EngineError("bad_action", "Unknown action.", 404)
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "admin")
            if action in actions:
                actions[action](db, ev)
                db.commit()
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
        if not is_ticket_hash(body.ticket_hash):
            return {"result": "unknown", "seat": None}
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "door")
            result, seat = engine.check_in(db, ev, body.ticket_hash)
            db.commit()
            return {"result": result, "seat": seat, "checked_in_count": ev.checked_in_count}

    @app.post("/events/{event_id}/door/sync")
    def door_sync(event_id: str, body: SyncCheckIns, token: str = Depends(bearer)):
        """Upload check-ins a door device recorded while offline."""
        with engine.lock, sessions() as db:
            ev = engine.authorize(db, event_id, token, "door")
            results = [
                {"h": h, "result": engine.check_in(db, ev, h)[0] if is_ticket_hash(h) else "unknown"}
                for h in body.ticket_hashes
            ]
            db.commit()
            return {"results": results, "checked_in_count": ev.checked_in_count}

    # ---- simulator (UNLISTED_CHAIN=sim only) ----------------------------------
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
