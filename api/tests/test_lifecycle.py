from conftest import auth

from unlisted.db import Deposit, Payout, Rsvp, SeenAddress


def tickets(client, event_id):
    return client.get(f"/events/{event_id}/tickets").json()


def pay(client, ev, memo, amount=None):
    client.chain.pay(ev["address"], ev["deposit_zat"] if amount is None else amount, memo)
    client.engine.scan_once()


def test_full_lifecycle(client, make_event, attendee):
    created = make_event(forfeit_address="")
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])

    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    t = tickets(client, ev["id"])
    assert {x["h"] for x in t["tickets"]} == {a.hash, b.hash}
    assert client.get(f"/events/{ev['id']}").json()["seats_left"] == 1

    # The door only ever sees the hash of what the attendee shows.
    r = client.post(f"/events/{ev['id']}/door/checkin", json={"ticket_hash": a.hash}, headers=auth(door))
    assert r.json()["result"] == "ok"
    r = client.post(f"/events/{ev['id']}/door/checkin", json={"ticket_hash": a.hash}, headers=auth(door))
    assert r.json()["result"] == "already"

    r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "settled"
    assert r.json()["refunded_zat"] == ev["deposit_zat"]
    assert r.json()["forfeited_zat"] == ev["deposit_zat"]

    # Exactly one refund, to the address only the attendee chose.
    refunds = [rcpt for _, rs, _ in client.chain.sent for rcpt in rs]
    assert [(x.address, x.amount_zat) for x in refunds] == [(a.refund_address, ev["deposit_zat"])]

    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged"
    with client.engine.sessions() as db:
        for model in (Rsvp, Deposit, Payout):
            assert db.query(model).filter(model.event_id == ev["id"]).count() == 0
    assert tickets(client, ev["id"])["tickets"] == []
    after = client.get(f"/events/{ev['id']}").json()
    assert after["rsvp_count"] == 2 and after["checked_in_count"] == 1 and after["location"] == ""


def test_forfeits_swept_to_group_fund(client, make_event, attendee):
    from unlisted.chain.sim import random_unified_address

    fund = random_unified_address()
    created = make_event(forfeit_address=fund)
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    assert r.json()["status"] == "settled"
    sweep = client.chain.sent[-1][1][0]
    assert sweep.address == fund and 0 < sweep.amount_zat < ev["deposit_zat"]


def test_rejections_are_returned(client, make_event, attendee):
    ev = make_event(capacity=1)["event"]
    first, second = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, first.memo())
    pay(client, ev, second.memo())                       # full
    pay(client, ev, attendee(ev["id"]).memo(), 123_456)   # wrong amount
    pay(client, ev, attendee(ev["id"]).memo("zzzzzzzzzz"))  # wrong event

    t = tickets(client, ev["id"])
    assert [x["h"] for x in t["tickets"]] == [first.hash]
    reasons = sorted(x["reason"] for x in t["rejected"])
    assert reasons == ["full", "wrong_amount", "wrong_event"]
    returned = {r.address: r.amount_zat for _, rs, _ in client.chain.sent for r in rs}
    assert returned[second.refund_address] == ev["deposit_zat"] - 10_000


def test_refund_address_reuse_refused_across_events(client, make_event, attendee):
    ev1, ev2 = make_event()["event"], make_event()["event"]
    a = attendee(ev1["id"])
    pay(client, ev1, a.memo())
    again = attendee(ev2["id"])
    again.refund_address = a.refund_address
    pay(client, ev2, again.memo())
    assert tickets(client, ev2["id"])["rejected"] == [{"h": again.hash, "reason": "address_reused"}]
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
    client.chain.mine()
    client.engine.scan_once()
    assert [x["h"] for x in tickets(client, ev["id"])["tickets"]] == [a.hash]


def test_closed_event_rejects_new_rsvps(client, make_event, attendee):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    client.post(f"/events/{ev['id']}/admin/close", headers=auth(admin))
    pay(client, ev, attendee(ev["id"]).memo())
    assert tickets(client, ev["id"])["rejected"][0]["reason"] == "rsvps_closed"


def test_memoless_payment_funds_the_float(client, make_event):
    created = make_event()
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, b"fee top-up", 200_000)
    view = client.get(f"/events/{ev['id']}/admin", headers=auth(admin)).json()
    assert view["event"]["float_zat"] == 200_000 and view["rsvps"] == []


def test_refunds_wait_for_fee_float(client, make_event, attendee):
    created = make_event()
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a = attendee(ev["id"])
    pay(client, ev, a.memo())
    client.post(f"/events/{ev['id']}/door/checkin", json={"ticket_hash": a.hash}, headers=auth(door))
    # 100% attendance and no float: the fee cannot be covered yet.
    r = client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    assert r.json()["status"] == "settling"
    view = client.get(f"/events/{ev['id']}/admin", headers=auth(admin)).json()
    assert view["payouts"][0]["status"] == "queued"
    assert "insufficient" in view["payouts"][0]["error"].lower()
    pay(client, ev, b"top-up", 100_000)
    assert client.get(f"/events/{ev['id']}").json()["status"] == "settled"


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
    bad = {"title": "x", "starts_at": "soon", "capacity": 0, "deposit_zat": 500_000}
    assert client.post("/events", json=bad).status_code == 422
    bad = {"title": "x", "starts_at": "soon", "capacity": 5, "deposit_zat": 500_000,
           "forfeit_address": "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"}
    assert client.post("/events", json=bad).json()["error"] == "bad_address"
