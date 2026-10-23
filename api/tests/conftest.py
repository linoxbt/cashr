import os
import secrets

import pytest
from fastapi.testclient import TestClient

from cashr.app import create_app
from cashr.chain.sim import SimChain, random_unified_address
from cashr.codec import RsvpMemo, encode_memo, ticket_hash
from cashr.config import Settings


@pytest.fixture
def chain():
    # Fast confirmations keep the logic tests short. test_realistic.py runs the
    # money paths under the real wallet's timing (10/3 confirmations, async sends).
    return SimChain("main", received_conf=1, change_conf=1)


@pytest.fixture
def client(tmp_path, chain):
    settings = Settings(chain_mode="sim", database_url=f"sqlite:///{tmp_path}/t.db",
                        run_scanner=False,
                        # No batching or spreading in logic tests; test_privacy covers both.
                        list_delay_min=0, refund_spread_min=0, door_sync_grace_min=0)
    app = create_app(settings, chain)
    with TestClient(app) as c:
        c.chain = chain
        c.engine = app.state.engine
        yield c


@pytest.fixture
def make_event(client):
    def _make(**overrides):
        body = {"title": "Tuesday circle", "starts_at": "2026-10-27T19:00:00Z",
                "location": "Shared on the ticket", "capacity": 3, "deposit_zat": 500_000}
        body.update(overrides)
        r = client.post("/events", json=body)
        assert r.status_code == 201, r.text
        return r.json()
    return _make


class Attendee:
    """What the browser does: a secret, its hash, and a fresh refund address."""

    def __init__(self, event_id: str):
        self.secret = secrets.token_bytes(32)
        self.hash = ticket_hash(self.secret)
        self.refund_address = random_unified_address()
        self.event_id = event_id

    def memo(self, event_id: str | None = None) -> bytes:
        return encode_memo(RsvpMemo(event_id or self.event_id, self.hash, self.refund_address))


@pytest.fixture
def attendee():
    return Attendee


def auth(token):
    return {"Authorization": f"Bearer {token}"}
