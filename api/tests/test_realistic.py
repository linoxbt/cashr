"""The money paths under the real wallet's timing.

The other tests use a sim with 1-confirmation spending and instant sends to stay
short. These run against SimChain's defaults, which match cashr-wallet:
received notes spendable after 10 confirmations, change after 3, payments
invisible until mined, and sends that report "executing" before they finish.
"""

import pytest
from conftest import auth
from fastapi.testclient import TestClient
from test_lifecycle import admin_view, checkin, refunds_to, status, tickets

from cashr.app import create_app
from cashr.chain.sim import EXPIRY_DELTA, SimChain, random_unified_address
from cashr.config import Settings


@pytest.fixture
def client(tmp_path):
    chain = SimChain("main", async_ops=True)
    settings = Settings(chain_mode="sim", database_url=f"sqlite:///{tmp_path}/t.db",
                        run_scanner=False, secret="test-secret",
                        # No batching or spreading in logic tests; test_privacy covers both.
                        list_delay_min=0, list_batch=1, refund_spread_min=0)
    with TestClient(create_app(settings, chain)) as c:
        c.chain = chain
        c.engine = c.app.state.engine
        yield c


def mine(client, blocks=1):
    for _ in range(blocks):
        client.chain.mine()
        client.engine.scan_once(full=True)


def pay(client, ev, memo, amount=None):
    client.chain.pay(ev["address"], ev["deposit_zat"] if amount is None else amount, memo)
    client.engine.scan_once(full=True)


def until(client, done, max_blocks=60):
    for n in range(max_blocks):
        if done():
            return n
        mine(client)
    raise AssertionError("did not happen within the block budget")


def test_lifecycle_at_real_speed(client, make_event, attendee):
    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    came, skipped = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, came.memo())
    pay(client, ev, skipped.memo())
    assert {t["h"] for t in tickets(client, ev["id"])["tickets"]} == {came.hash, skipped.hash}
    assert checkin(client, ev, door, came) == "ok"

    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    # Deposits need 10 confirmations before they can fund refunds: nothing yet.
    assert refunds_to(client, came.refund_address) == []
    until(client, lambda: status(client, ev["id"]) == "settled")
    assert refunds_to(client, came.refund_address) == [ev["deposit_zat"]]
    after = admin_view(client, ev, admin)
    assert after["balance_zat"] == 0 and refunds_to(client, fund) == [after["event"]["swept_zat"]]
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged", r.text


def test_rejected_payment_is_returned_once_spendable(client, make_event, attendee):
    ev = make_event(capacity=1)["event"]
    pay(client, ev, attendee(ev["id"]).memo())
    late = attendee(ev["id"])
    pay(client, ev, late.memo())  # full
    assert refunds_to(client, late.refund_address) == []
    until(client, lambda: refunds_to(client, late.refund_address))
    assert refunds_to(client, late.refund_address) == [ev["deposit_zat"] - 10_000]


def test_expired_refund_is_rebuilt_once(client, make_event, attendee):
    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b"top-up", 100_000)
    checkin(client, ev, door, a)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    until(client, lambda: client.chain.sent)
    (_, _, first), = client.chain.sent
    client.chain.drop_from_mempool(first)
    client.chain.height += EXPIRY_DELTA + 1  # blocks pass without it
    until(client, lambda: tickets(client, ev["id"])["tickets"][0]["status"] == "refunded")
    assert client.chain.tx_status(first).state == "expired"
    assert len(client.chain.sent) == 2
    assert refunds_to(client, a.refund_address) == [ev["deposit_zat"]] * 2  # built twice, paid once
    assert sum(tx.height > 0 for tx in client.chain._txs.values() if tx.recipients[0].address == a.refund_address) == 1
