"""Persistence. Deliberately small: this is everything the server ever knows.

There is no table of people. An RSVP row is a ticket hash plus a one-time
shielded refund address, and it is deleted when the event is purged.
"""

from __future__ import annotations

import secrets
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
    # Highest block whose deposits are ingested; scans start a little below it.
    scan_height: Mapped[int] = mapped_column(Integer, default=0)
    # Chain height when RSVPs closed (deadline or organiser), so a payment sent
    # just before is judged by when it was mined, not when it was processed.
    close_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    height: Mapped[int] = mapped_column(Integer)
    # rsvp | rejected | float (top-ups, payments without our memo, unrefundable)
    kind: Mapped[str] = mapped_column(String(10))
    reason: Mapped[str] = mapped_column(String(40), default="")
    ticket_hash: Mapped[str] = mapped_column(String(43), default="")


class Rsvp(Base):
    __tablename__ = "rsvps"
    __table_args__ = (UniqueConstraint("event_id", "ticket_hash"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    ticket_hash: Mapped[str] = mapped_column(String(43))
    refund_address: Mapped[str] = mapped_column(String(600))
    seat: Mapped[int] = mapped_column(Integer)
    # confirmed | refunding | refunded | forfeited
    status: Mapped[str] = mapped_column(String(12), default="confirmed")
    # A boolean, not a timestamp: arrival times can be matched against cameras.
    checked_in: Mapped[bool] = mapped_column(Boolean, default=False)


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


class SeenAddress(Base):
    """Keyed hashes of refund addresses already used, to refuse reuse.

    Reusing a refund address across events would let anyone holding two
    events' data link the same attendee, so a reused address is refused.
    """

    __tablename__ = "seen_addresses"

    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Which address-memory period it was used in (see Engine.forget_old_addresses).
    period: Mapped[int | None] = mapped_column(Integer, nullable=True)


def make_engine(url: str):
    kwargs = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        # Overwrite deleted rows with zeros, so purged refund addresses and memos
        # don't linger in free pages of the database file.
        @event.listens_for(engine, "connect")
        def _secure_delete(dbapi_conn, _record):
            dbapi_conn.execute("PRAGMA secure_delete = ON")
    return engine


def make_sessionmaker(engine):
    return sessionmaker(bind=engine, expire_on_commit=False)


def init_db(engine) -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)


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
