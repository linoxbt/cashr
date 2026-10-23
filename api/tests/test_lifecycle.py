from datetime import datetime, timedelta, timezone

import pytest
from conftest import auth

from cashr.chain.sim import EXPIRY_DELTA, random_unified_address
from cashr.engine import RSVP_GRACE_BLOCKS
from cashr.db import Deposit, Event, Payout, Rsvp, SeenAddress


def tickets(client, event_id):
    return client.get(f"/events/{event_id}/tickets").json()


def reasons(client, event_id):
    """Why each payment wasn't accepted, as the server records it (the public list says only returned/kept)."""
    with client.engine.sessions() as db:
        return [{"h": d.ticket_hash, "reason": d.reason} for d in db.query(Deposit)
                .filter(Deposit.event_id == event_id, (Deposit.kind == "rejected") | (Deposit.reason == "bad_refund_address"))
                .order_by(Deposit.id)]


def pay(client, ev, memo, amount=None):
    client.chain.pay(ev["address"], ev["deposit_zat"] if amount is None else amount, memo)
    client.engine.scan_once(full=True)


def advance(client, blocks=1):
    for _ in range(blocks):
        client.chain.mine()
        client.engine.scan_once(full=True)


def status(client, event_id):
    return client.get(f"/events/{event_id}").json()["status"]


def settle(client, ev, admin, max_blocks=20, post=True):
    if post:
        r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
        assert r.status_code == 200, r.text
    for _ in range(max_blocks):
        if status(client, ev["id"]) == "settled":
            return
        advance(client)
    raise AssertionError(f"event did not settle: {admin_view(client, ev, admin)['payouts']}")


def admin_view(client, ev, admin):
    return client.get(f"/events/{ev['id']}/admin", headers=auth(admin)).json()


def checkin(client, ev, door, a):
    r = client.post(f"/events/{ev['id']}/door/checkin", json={"ticket_hash": a.hash}, headers=auth(door))
    return r.json()["result"]


def refunds_to(client, address):
    return [r.amount_zat for _, rs, _ in client.chain.sent for r in rs if r.address == address]


def test_full_lifecycle(client, make_event, attendee):
    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])

    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    t = tickets(client, ev["id"])
    assert {x["h"] for x in t["tickets"]} == {a.hash, b.hash}
    assert client.get(f"/events/{ev['id']}").json()["seats_left"] == 1

    # The door only ever sees the hash of what the attendee shows.
    assert checkin(client, ev, door, a) == "ok"
    assert checkin(client, ev, door, a) == "already"

    r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    assert r.json()["status"] == "settling"
    # Broadcast is not paid: the refund counts once it is mined and confirmed.
    assert r.json()["refunded_zat"] == 0
    assert {x["h"]: x["status"] for x in tickets(client, ev["id"])["tickets"]}[a.hash] == "refunding"
    settle(client, ev, admin, post=False)

    after = admin_view(client, ev, admin)
    assert after["event"]["refunded_zat"] == ev["deposit_zat"]
    assert after["event"]["forfeited_zat"] == ev["deposit_zat"]
    assert refunds_to(client, a.refund_address) == [ev["deposit_zat"]]
    # Forfeits and the fee float leave the event wallet; nothing is stranded.
    assert after["balance_zat"] == 0 and after["event"]["swept_zat"] > 0
    assert refunds_to(client, fund) == [after["event"]["swept_zat"]]

    account = client.engine.sessions().get(Event, ev["id"]).account_ref
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged", r.text
    with client.engine.sessions() as db:
        for model in (Rsvp, Deposit, Payout):
            assert db.query(model).filter(model.event_id == ev["id"]).count() == 0
    # The wallet's keys and records for the event are gone too.
    assert account not in client.chain._accounts
    view = admin_view(client, ev, admin)
    assert view["wallet_error"] == "" and view["balance_zat"] == 0
    assert tickets(client, ev["id"])["tickets"] == []
    gone = client.get(f"/events/{ev['id']}").json()
    assert gone["rsvp_count"] == 2 and gone["checked_in_count"] == 1 and gone["location"] == ""


def test_lost_response_never_pays_twice(client, make_event, attendee):
    created = make_event(forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    checkin(client, ev, door, a)
    # The wallet builds and broadcasts, but the API never hears back (timeout).
    client.chain.lose_responses = 2
    settle(client, ev, admin)
    assert refunds_to(client, a.refund_address) == [ev["deposit_zat"]]


def test_restarted_api_resumes_without_paying_twice(client, make_event, attendee):
    from cashr.engine import Engine

    created = make_event(forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    checkin(client, ev, door, a)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    # Crash before the result was recorded: roll the payout back to queued.
    with client.engine.sessions() as db:
        p = db.query(Payout).filter(Payout.kind == "refund").one()
        p.status, p.opid, p.txid = "queued", "", ""
        db.commit()
    fresh = Engine(client.engine.settings, client.chain, client.engine.sessions)
    for _ in range(10):
        client.chain.mine()
        fresh.scan_once(full=True)
    assert refunds_to(client, a.refund_address) == [ev["deposit_zat"]]
    assert status(client, ev["id"]) == "settled"


def test_expired_refund_is_sent_again(client, make_event, attendee):
    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b"top-up", 100_000)
    checkin(client, ev, door, a)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    (_, _, first), = client.chain.sent
    client.chain.drop_from_mempool(first)
    for _ in range(EXPIRY_DELTA + 1):
        client.chain.height += 1  # blocks pass without the transaction
    client.engine.scan_once(full=True)
    assert tickets(client, ev["id"])["tickets"][0]["status"] == "refunding"
    advance(client, 5)
    assert [txid for _, _, txid in client.chain.sent][0] == first and len(client.chain.sent) == 2
    assert client.chain.tx_status(first).state == "expired"
    assert tickets(client, ev["id"])["tickets"][0]["status"] == "refunded"
    assert admin_view(client, ev, admin)["event"]["refunded_zat"] == ev["deposit_zat"]


def test_pending_refund_is_rebroadcast_not_resent(client, make_event, attendee):
    from cashr.engine import REBROADCAST_EVERY

    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b"top-up", 100_000)
    checkin(client, ev, door, a)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    (_, _, txid), = client.chain.sent
    client.chain.drop_from_mempool(txid)
    for _ in range(REBROADCAST_EVERY):
        client.engine.scan_once(full=True)
    assert client.chain._txs[txid].in_mempool  # rebroadcast
    advance(client, 4)
    assert len(client.chain.sent) == 1 and status(client, ev["id"]) == "settled"


def test_sweep_waits_for_change_to_confirm(client, make_event, attendee):
    client.chain.change_conf = 3  # like the real wallet's trusted-confirmations policy
    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    people = [attendee(ev["id"]) for _ in range(3)]
    for p in people:
        pay(client, ev, p.memo())
    checkin(client, ev, door, people[0])
    settle(client, ev, admin)
    swept = admin_view(client, ev, admin)["event"]["swept_zat"]
    # Two forfeits plus the refund's change, minus two fees: nothing left behind.
    assert swept == 3 * ev["deposit_zat"] - ev["deposit_zat"] - 2 * 10_000
    assert client.chain.balance(client.engine.sessions().get(Event, ev["id"]).account_ref).total_zat == 0


def test_without_fund_address_money_is_kept_and_purge_refused(client, make_event, attendee):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    settle(client, ev, admin)
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.status_code == 409 and r.json()["error"] == "funds_left"
    fund = random_unified_address()
    r = client.post(f"/events/{ev['id']}/admin/fund", json={"address": fund}, headers=auth(admin))
    assert r.status_code == 200, r.text
    settle_wait = 0
    while status(client, ev["id"]) != "settled" and settle_wait < 10:
        advance(client)
        settle_wait += 1
    assert refunds_to(client, fund) == [ev["deposit_zat"] - 10_000]
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged"


def test_unknown_operation_stops_for_a_person(client, make_event, attendee):
    from cashr.chain.base import OpStatus

    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b"top-up", 100_000)
    checkin(client, ev, door, a)
    client.chain.op_status = lambda opid: OpStatus("failed", error="operation unknown to wallet")
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    (p,) = admin_view(client, ev, admin)["payouts"]
    assert p["status"] == "failed" and "paid twice" in p["error"]


def test_rejections_are_returned(client, make_event, attendee):
    ev = make_event(capacity=1)["event"]
    first, second = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, first.memo())
    pay(client, ev, second.memo())                       # full
    pay(client, ev, attendee(ev["id"]).memo(), 123_456)   # wrong amount
    pay(client, ev, attendee(ev["id"]).memo("zzzzzzzzzz"))  # wrong event

    t = tickets(client, ev["id"])
    assert [x["h"] for x in t["tickets"]] == [first.hash]
    assert sorted(x["reason"] for x in t["rejected"]) == ["returned"] * 3
    reasons_ = sorted(x["reason"] for x in reasons(client, ev["id"]))
    assert reasons_ == ["full", "wrong_amount", "wrong_event"]
    assert refunds_to(client, second.refund_address) == [ev["deposit_zat"] - 10_000]


def test_refund_address_reuse_refused_across_events(client, make_event, attendee):
    ev1, ev2 = make_event()["event"], make_event()["event"]
    a = attendee(ev1["id"])
    pay(client, ev1, a.memo())
    again = attendee(ev2["id"])
    again.refund_address = a.refund_address
    pay(client, ev2, again.memo())
    assert tickets(client, ev2["id"])["rejected"] == [{"h": again.hash, "reason": "returned"}]
    assert reasons(client, ev2["id"]) == [{"h": again.hash, "reason": "address_reused"}]
    with client.engine.sessions() as db:
        # Only a keyed digest is stored, never the address itself.
        digests = [s.digest for s in db.query(SeenAddress)]
        assert a.refund_address not in digests and len(digests) == 1


def test_unconfirmed_notes_wait(client, make_event, attendee):
    ev = make_event()["event"]
    client.chain.auto_mine = False
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    assert tickets(client, ev["id"])["tickets"] == []
    advance(client)
    assert [x["h"] for x in tickets(client, ev["id"])["tickets"]] == [a.hash]


def test_closed_event_rejects_new_rsvps(client, make_event, attendee):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    client.post(f"/events/{ev['id']}/admin/close", headers=auth(admin))
    # A payment mined just after closing was sent while RSVPs were open: it counts.
    on_time = attendee(ev["id"])
    pay(client, ev, on_time.memo())
    assert [t["h"] for t in tickets(client, ev["id"])["tickets"]] == [on_time.hash]
    advance(client, RSVP_GRACE_BLOCKS + 1)
    pay(client, ev, attendee(ev["id"]).memo())
    assert reasons(client, ev["id"])[0]["reason"] == "rsvps_closed"


def test_rsvp_deadline_closes_rsvps(client, make_event, attendee):
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    ev = make_event(rsvp_closes_at=past)["event"]
    assert ev["status"] == "open" and ev["accepting_rsvps"] is False
    pay(client, ev, attendee(ev["id"]).memo())
    assert reasons(client, ev["id"])[0]["reason"] == "rsvps_closed"
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert make_event(rsvp_closes_at=future)["event"]["accepting_rsvps"] is True


def test_start_time_needs_a_timezone(client, make_event):
    r = client.post("/events", json={"title": "x", "starts_at": "2026-10-30T18:00", "capacity": 5,
                                     "deposit_zat": 500_000})
    assert r.status_code == 422
    ev = make_event(starts_at="2026-10-30T18:00:00+02:00")["event"]
    assert ev["starts_at"] == "2026-10-30T16:00:00Z"


def test_memoless_payment_funds_the_float(client, make_event):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, b"fee top-up", 200_000)
    view = admin_view(client, ev, admin)
    assert view["event"]["float_zat"] == 200_000 and view["rsvps"] == []
    assert view["deposits"][0]["reason"] == "no_memo"


def test_refunds_wait_for_fee_float(client, make_event, attendee):
    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    checkin(client, ev, door, a)
    # 100% attendance and no float: the fee cannot be covered yet.
    r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    assert r.json()["status"] == "settling"
    (p,) = admin_view(client, ev, admin)["payouts"]
    assert p["status"] == "queued" and "insufficient" in p["error"].lower()
    pay(client, ev, b"top-up", 100_000)
    advance(client, 5)
    assert status(client, ev["id"]) == "settled"
    assert refunds_to(client, a.refund_address) == [ev["deposit_zat"]]


def test_tokens_are_scoped(client, make_event):
    created = make_event()
    ev, door = created["event"], created["door_token"]
    assert client.get(f"/events/{ev['id']}/admin", headers=auth(door)).status_code == 403
    assert client.get(f"/events/{ev['id']}/admin").status_code == 401
    other = make_event()
    r = client.get(f"/events/{ev['id']}/door/manifest", headers=auth(other["door_token"]))
    assert r.status_code == 403


def test_offline_door_sync(client, make_event, attendee):
    created = make_event()
    ev, door = created["event"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    r = client.post(f"/events/{ev['id']}/door/sync",
                    json={"ticket_hashes": [a.hash, a.hash, "nope"]}, headers=auth(door))
    assert [x["result"] for x in r.json()["results"]] == ["ok", "already", "unknown"]


def test_create_validation(client):
    bad = {"title": "x", "starts_at": "2026-10-30T18:00:00Z", "capacity": 0, "deposit_zat": 500_000}
    assert client.post("/events", json=bad).status_code == 422
    bad = {"title": "x", "starts_at": "2026-10-30T18:00:00Z", "capacity": 5, "deposit_zat": 500_000,
           "forfeit_address": "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"}
    assert client.post("/events", json=bad).json()["error"] == "bad_address"


def test_event_creation_is_rate_limited(tmp_path, chain):
    from fastapi.testclient import TestClient

    from cashr.app import create_app
    from cashr.config import Settings

    settings = Settings(chain_mode="sim", database_url=f"sqlite:///{tmp_path}/r.db", run_scanner=False,
                        secret="s", create_per_hour=2)
    with TestClient(create_app(settings, chain)) as c:
        body = {"title": "x", "starts_at": "2026-10-30T18:00:00Z", "capacity": 5, "deposit_zat": 500_000}
        assert [c.post("/events", json=body).status_code for _ in range(3)] == [201, 201, 429]


def test_chain_mode_must_be_explicit():
    from cashr.chain import make_chain
    from cashr.config import Settings

    with pytest.raises(ValueError):
        make_chain(Settings(chain_mode=""))


def test_one_process_per_database(tmp_path, chain):
    from cashr.app import create_app
    from cashr.config import Settings

    settings = Settings(chain_mode="sim", database_url=f"sqlite:///{tmp_path}/w.db", run_scanner=False, secret="s")
    first = create_app(settings, chain)
    with pytest.raises(RuntimeError, match="Another cashr API process"):
        create_app(settings, chain)
    first.state.writer_lock.release()
    create_app(settings, chain).state.writer_lock.release()


def test_refund_address_without_orchard_is_reported(client, make_event, attendee):
    ev = make_event()["event"]
    a = attendee(ev["id"])
    a.refund_address = random_unified_address(orchard=False, sapling=True)
    pay(client, ev, a.memo())
    t = tickets(client, ev["id"])
    assert t["tickets"] == []
    # The attendee can see why nothing happened.
    assert t["rejected"] == [{"h": a.hash, "reason": "kept"}]
    assert reasons(client, ev["id"]) == [{"h": a.hash, "reason": "bad_refund_address"}]


def test_async_shortfall_waits_for_top_up(client, make_event, attendee):
    """The wallet reports insufficient funds only when the operation runs."""
    from cashr.chain.base import OpStatus

    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    checkin(client, ev, door, a)
    real_status = client.chain.op_status
    client.chain.op_status = lambda opid: OpStatus("failed", error="Insufficient balance (have 0, need 510000)")
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    for _ in range(8):
        client.post(f"/events/{ev['id']}/admin/scan", headers=auth(admin))
    assert admin_view(client, ev, admin)["payouts"][0]["status"] == "queued"
    client.chain.op_status = real_status
    pay(client, ev, b"top-up", 100_000)
    advance(client, 5)
    assert status(client, ev["id"]) == "settled"


def test_settled_events_are_scanned_less_often(client, make_event, attendee):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    settle(client, ev, admin)
    late = attendee(ev["id"])
    client.chain.pay(ev["address"], ev["deposit_zat"], late.memo())
    client.engine._cycle = 0
    client.engine.scan_once()
    assert tickets(client, ev["id"])["rejected"] == []
    for _ in range(8):
        client.engine.scan_once()
    # A late payment to a settled event is still returned.
    assert reasons(client, ev["id"])[0]["reason"] == "rsvps_closed"


def test_meta_reports_wallet_tip(client):
    m = client.get("/meta").json()
    assert m["chain"] == "sim" and m["tip"] == client.chain.tip_height()


def test_one_broken_event_does_not_stop_scanning(client, make_event, attendee):
    broken = make_event()["event"]
    ok = make_event()["event"]
    # Simulate an event whose wallet account has gone missing.
    del client.chain._accounts[client.engine.sessions().get(Event, broken["id"]).account_ref]
    a = attendee(ok["id"])
    client.chain.pay(ok["address"], ok["deposit_zat"], a.memo())
    client.engine.scan_once(full=True)
    assert [t["h"] for t in tickets(client, ok["id"])["tickets"]] == [a.hash]


def test_old_database_gains_new_columns(tmp_path):
    import sqlite3

    from cashr.db import init_db, make_engine

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE payouts (id INTEGER PRIMARY KEY, event_id VARCHAR(10), kind VARCHAR(10), "
                "recipients JSON, status VARCHAR(10), opid VARCHAR(80), txid VARCHAR(64), error TEXT, attempts INTEGER)")
    con.commit()
    con.close()
    init_db(make_engine(f"sqlite:///{path}"))
    cols = {r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(payouts)")}
    assert {"key", "polls"} <= cols


def test_purge_waits_for_in_flight_returns(client, make_event, attendee):
    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin = created["event"], created["admin_token"]
    settle(client, ev, admin)
    # A late payment arrives and its return is still confirming.
    client.chain.pay(ev["address"], ev["deposit_zat"], attendee(ev["id"]).memo())
    client.engine.scan_once(full=True)
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.status_code == 409 and r.json()["error"] == "payouts_pending"
    advance(client, 4)
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged", r.text


def test_purge_rechecks_funds_under_the_lock(client, make_event, attendee):
    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin = created["event"], created["admin_token"]
    settle(client, ev, admin)

    # A late payment lands right after purge first reads the balance.
    real_balance = client.engine.balance
    calls = []

    def balance_then_late_payment(*a, **kw):
        bal = real_balance(*a, **kw)
        if not calls:
            client.chain.pay(ev["address"], ev["deposit_zat"], attendee(ev["id"]).memo())
        calls.append(bal)
        return bal

    client.engine.balance = balance_then_late_payment
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.status_code == 409 and r.json()["error"] == "funds_left", r.text
    with client.engine.sessions() as db:
        assert db.get(Event, ev["id"]).status == "settled"


def test_sqlite_overwrites_deleted_rows(tmp_path):
    from sqlalchemy import text

    from cashr.db import make_engine

    with make_engine(f"sqlite:///{tmp_path}/s.db").connect() as conn:
        assert conn.execute(text("PRAGMA secure_delete")).scalar() == 1
        assert conn.execute(text("PRAGMA journal_mode")).scalar() == "wal"


def test_rsvps_must_close_before_the_start(client):
    body = {"title": "x", "starts_at": "2026-11-30T18:00:00Z", "capacity": 5, "deposit_zat": 500_000}
    r = client.post("/events", json=body | {"rsvp_closes_at": "2026-12-01T18:00:00Z"})
    assert r.status_code == 422 and "close before" in r.text
    assert client.post("/events", json=body | {"rsvp_closes_at": "2026-11-29T18:00:00Z"}).status_code == 201


def test_minimum_deposit_is_0_001_zec(client):
    body = {"title": "x", "starts_at": "2026-12-01T18:00:00Z", "capacity": 5}
    assert client.post("/events", json=body | {"deposit_zat": 99_999}).status_code == 422
    assert client.post("/events", json=body | {"deposit_zat": 100_000}).status_code == 201
