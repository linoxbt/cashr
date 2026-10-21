"""One writer per database.

The engine's lock only works inside one process. Two API processes sharing a
database would both submit payouts and both apply wallet results, so the API
takes an exclusive lock at startup and refuses to run without it.
"""

from __future__ import annotations

import os
import zlib
from dataclasses import dataclass
from typing import Callable

from sqlalchemy.engine import make_url


@dataclass
class WriterLock:
    release: Callable[[], None]


def acquire_writer_lock(database_url: str) -> WriterLock:
    url = make_url(database_url)
    if url.drivername.startswith("sqlite"):
        if not url.database or url.database == ":memory:":
            return WriterLock(lambda: None)
        import fcntl

        fd = os.open(f"{url.database}.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise RuntimeError(
                "Another Unlisted API process is using this database. Run exactly one (one worker, one replica)."
            ) from None

        def release() -> None:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

        return WriterLock(release)

    # Postgres: a session-level advisory lock held for the process lifetime.
    from sqlalchemy import create_engine, text

    eng = create_engine(database_url, pool_size=1, max_overflow=0)
    conn = eng.connect()
    key = zlib.crc32(b"unlisted-writer")
    if not conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar():
        conn.close()
        raise RuntimeError(
            "Another Unlisted API process holds the database. Run exactly one (one worker, one replica)."
        )

    def release_pg() -> None:
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})
        conn.close()
        eng.dispose()

    return WriterLock(release_pg)
