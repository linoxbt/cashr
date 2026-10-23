"""Persistence. Deliberately small: this is everything the server ever knows.

There is no table of people. An RSVP row is a ticket hash plus a one-time
shielded refund address, and it is deleted when the event is purged.
"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    title: Mapped[str] = mapped_column(String(120))
    starts_at: Mapped[str] = mapped_column(String(40))  # organiser-supplied ISO string
    location: Mapped[str] = mapped_column(String(200), default="")
    details: Mapped[str] = mapped_column(Text, default="")
    capacity: Mapped[int] = mapped_column(Integer)
    deposit_zat: Mapped[int] = mapped_column(BigInteger)
    rsvp_closes_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    forfeit_address: Mapped[str] = mapped_column(String(600), default="")

    # open → closed → settling → settled → purged
    status: Mapped[str] = mapped_column(String(12), default="open")
    # The chain height when the event was created; scans start a little below it.
    scan_height: Mapped[int] = mapped_column(Integer, default=0)
    # Chain height when RSVPs closed (deadline or organiser), so a payment sent
    # just before is judged by when it was mined, not when it was processed.
    close_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Settling waits until then for offline door devices (see Engine.late_check_in).
    sweep_not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The next moment the public list is updated (see Engine._publish).
    list_publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Tickets on the public list: the public counts come from this, not from rsvp_count.
    listed_count: Mapped[int] = mapped_column(Integer, default=0)
    account_ref: Mapped[str] = mapped_column(String(64))
    address: Mapped[str] = mapped_column(String(600))
    admin_token_hash: Mapped[str] = mapped_column(String(64))
    door_token_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # Aggregates survive purge; nothing else does.
    rsvp_count: Mapped[int] = mapped_column(Integer, default=0)
    checked_in_count: Mapped[int] = mapped_column(Integer, default=0)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0)
    refunded_zat: Mapped[int] = mapped_column(BigInteger, default=0)
    forfeited_zat: Mapped[int] = mapped_column(BigInteger, default=0)
    float_zat: Mapped[int] = mapped_column(BigInteger, default=0)
    swept_zat: Mapped[int] = mapped_column(BigInteger, default=0)


class Deposit(Base):
    """A shielded note received at an event address."""

    __tablename__ = "deposits"
    __table_args__ = (UniqueConstraint("event_id", "txid", "pool", "out_index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    txid: Mapped[str] = mapped_column(String(64))
    pool: Mapped[str] = mapped_column(String(10))
    out_index: Mapped[int] = mapped_column(Integer)
    amount_zat: Mapped[int] = mapped_column(BigInteger)
    # Always 0: a stored block height would date the payment. Kept for old databases.
    height: Mapped[int] = mapped_column(Integer, default=0)
    # rsvp | rejected | float (top-ups, payments without our memo, unrefundable)
    kind: Mapped[str] = mapped_column(String(10))
    reason: Mapped[str] = mapped_column(String(40), default="")
    # A returned payment appears on the public list only at its next update.
    listed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Returned and unrefundable payments only (the public list shows them); an
    # accepted deposit's ticket is on its RSVP row, so its txid matches no ticket.
    ticket_hash: Mapped[str] = mapped_column(String(43), default="")


class Rsvp(Base):
    __tablename__ = "rsvps"
    __table_args__ = (UniqueConstraint("event_id", "ticket_hash"),)

    # Random (set by the engine), so ids don't record the order people paid in.
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    ticket_hash: Mapped[str] = mapped_column(String(43))
    refund_address: Mapped[str] = mapped_column(String(600))
    seat: Mapped[int] = mapped_column(Integer)
    # confirmed | refunding | refunded | forfeited
    status: Mapped[str] = mapped_column(String(12), default="confirmed")
    # A boolean, not a timestamp: arrival times can be matched against cameras.
    checked_in: Mapped[bool] = mapped_column(Boolean, default=False)
    # On the public ticket list yet (they join in batches).
    listed: Mapped[bool] = mapped_column(Boolean, default=False)


class Payout(Base):
    """An outgoing shielded send: refunds, rejected-payment returns, forfeit sweep."""

    __tablename__ = "payouts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    # refund | reject | forfeit
    kind: Mapped[str] = mapped_column(String(10))
    # [{"address": str, "amount_zat": int, "memo": str, "rsvp_id": int | None}]
    recipients: Mapped[list] = mapped_column(JSON)
    # queued → submitted (wallet building) → broadcast (txid known, not yet
    # confirmed) → done (mined and confirmed); failed needs the organiser.
    status: Mapped[str] = mapped_column(String(10), default="queued")
    # Idempotency key: the wallet never builds a second transaction for it
    # while the first could still be mined. Random, so a reset database can
    # never collide with keys the wallet already knows.
    key: Mapped[str] = mapped_column(String(32), default=lambda: secrets.token_hex(16))
    opid: Mapped[str] = mapped_column(String(80), default="")
    polls: Mapped[int] = mapped_column(Integer, default=0)
    txid: Mapped[str] = mapped_column(String(64), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # A refund isn't sent before this (random per refund, so refunds spread out).
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Flag(Base):
    """Server housekeeping that must survive a restart (see Engine.compact_if_owed)."""

    __tablename__ = "flags"

    name: Mapped[str] = mapped_column(String(40), primary_key=True)


def make_engine(url: str):
    # A purge's promise rests on rewriting the database file (compact_sqlite);
    # other databases keep deleted rows in their own logs and dead tuples.
    if not url.startswith("sqlite"):
        raise ValueError("cashr stores its data in SQLite only (CASHR_DATABASE_URL=sqlite:///...)")
    # hide_parameters: an error's text (which can reach logs) never carries the
    # values of a query, such as ticket hashes or refund addresses.
    engine = create_engine(url, connect_args={"check_same_thread": False}, hide_parameters=True)

    # Overwrite deleted rows with zeros, so purged refund addresses and memos
    # don't linger in free pages of the database file.
    @event.listens_for(engine, "connect")
    def _secure_delete(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA secure_delete = ON")
        # WAL, so purged pages never sit in a rollback journal that is unlinked
        # without being overwritten; purges then truncate the log (compact_sqlite).
        dbapi_conn.execute("PRAGMA journal_mode = WAL")

    return engine


# How long a rewrite waits for other connections' reads to finish, per attempt.
COMPACT_BUSY_MS = 10_000
COMPACT_ATTEMPTS = 3

log = logging.getLogger("cashr.db")


def compact_sqlite(engine) -> bool:
    """Rewrite the file and empty the WAL, so a purge leaves nothing on disk.

    A checkpoint can't empty the WAL while another connection is reading from
    it, so this waits for reads to finish, checks the result rather than
    assuming it, and says whether it got there.
    """
    for attempt in range(COMPACT_ATTEMPTS):
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                conn.exec_driver_sql(f"PRAGMA busy_timeout = {COMPACT_BUSY_MS}")
                conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
                conn.exec_driver_sql("VACUUM")
                busy, wal_frames, _ = conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)").one()
                if not busy and wal_frames == 0:
                    return True
        except Exception as e:  # "database is locked": a reader outlasted the wait
            log.warning("database rewrite attempt failed: %s", e)
        time.sleep(0.2 * (attempt + 1))
    return False


def make_sessionmaker(engine):
    return sessionmaker(bind=engine, expire_on_commit=False)


def init_db(engine) -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    with engine.begin() as conn:
        # Data older servers kept and this one doesn't: reuse digests (the reuse
        # check is per event now), payment heights, and accepted deposits' tickets.
        conn.execute(text("DROP TABLE IF EXISTS seen_addresses"))
        conn.execute(text("UPDATE deposits SET height = 0 WHERE height != 0"))
        conn.execute(text("UPDATE deposits SET ticket_hash = '' WHERE kind = 'rsvp' AND ticket_hash != ''"))


def _add_missing_columns(engine) -> None:
    """Additive migrations: create columns added since a database was made."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                default = col.default.arg if col.default is not None and not callable(col.default.arg) else None
                ddl = col.type.compile(engine.dialect)
                clause = f" DEFAULT {default!r}" if isinstance(default, (int, str)) else ""
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {col.name} {ddl}{clause}'))
