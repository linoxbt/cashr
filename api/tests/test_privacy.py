"""What each party can learn: the public list, memos, purge leftovers, digests."""

from conftest import auth
from test_lifecycle import admin_view, checkin, pay, settle, tickets

from unlisted.chain.sim import random_unified_address
from unlisted.db import SeenAddress


def test_public_list_hides_check_ins_until_settlement(client, make_event, attendee):
    created = make_event(forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    before = tickets(client, ev["id"])
    assert checkin(client, ev, door, a) == "ok"
    # Polling the list during the event shows nothing about who came in, or when.
    assert tickets(client, ev["id"]) == before
    assert before["tickets"] == sorted(({"h": a.hash}, {"h": b.hash}), key=lambda t: t["h"])

    settle(client, ev, admin)
    after = {t["h"]: t["status"] for t in tickets(client, ev["id"])["tickets"]}
    assert after == {a.hash: "refunded", b.hash: "forfeited"}


def test_memos_never_name_the_event(client, make_event, attendee):
    created = make_event(title="Tenants' union, flat 4B", forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    a, b = attendee(ev["id"]), attendee(ev["id"])
    pay(client, ev, a.memo())
    pay(client, ev, b.memo())
    pay(client, ev, attendee(ev["id"]).memo(), amount=ev["deposit_zat"] + 1)  # returned: wrong amount
    checkin(client, ev, door, a)
    settle(client, ev, admin)
    memos = {r.memo.decode() for _, rs, _ in client.chain.sent for r in rs}
    assert memos and not any("Tenants" in m for m in memos), memos


def test_purge_leaves_nothing_that_names_the_event(client, make_event, attendee):
    created = make_event(title="Tenants' union, flat 4B", forfeit_address=random_unified_address(),
                         rsvp_closes_at="2026-10-29T18:00:00Z")
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    settle(client, ev, admin)
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged", r.text
    gone = client.get(f"/events/{ev['id']}").json()
    assert gone["title"] == "Purged event"
    assert gone["starts_at"] == "" and gone["rsvp_closes_at"] is None
    assert gone["address"] == "" and gone["location"] == "" and gone["details"] == ""
    assert gone["rsvp_count"] == 1


def test_seats_are_random_and_refund_addresses_shortened(client, make_event, attendee):
    created = make_event(capacity=50)
    ev, admin = created["event"], created["admin_token"]
    people = [attendee(ev["id"]) for _ in range(8)]
    for p in people:
        pay(client, ev, p.memo())
    rsvps = admin_view(client, ev, admin)["rsvps"]
    seats = [r["seat"] for r in rsvps]
    assert len(set(seats)) == 8 and all(1 <= s <= 50 for s in seats)
    # Counting up 1..8 for the first eight payers would reveal payment order.
    assert sorted(seats) != list(range(1, 9))
    full = {p.refund_address for p in people}
    assert all(r["refund_address"] not in full and "…" in r["refund_address"] for r in rsvps)
    assert all("height" not in d for d in admin_view(client, ev, admin)["deposits"])


def test_used_address_digests_are_forgotten_after_two_periods(client, make_event, attendee):
    ev = make_event()["event"]
    pay(client, ev, attendee(ev["id"]).memo())
    engine = client.engine
    now = engine._period()
    with engine.sessions() as db:
        db.add(SeenAddress(digest="legacy", period=None))
        db.add(SeenAddress(digest="old", period=now - 2))
        db.add(SeenAddress(digest="last", period=now - 1))
        db.commit()
    engine.forget_old_addresses()
    with engine.sessions() as db:
        kept = {s.digest: s.period for s in db.query(SeenAddress)}
    assert "old" not in kept
    assert kept["last"] == now - 1 and kept["legacy"] == now and len(kept) == 3
