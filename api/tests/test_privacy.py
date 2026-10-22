"""What each party can learn: the public list, memos, purge leftovers, digests."""

from conftest import auth
from test_lifecycle import admin_view, checkin, pay, settle, tickets

from unlisted.chain.sim import random_unified_address
from unlisted.db import Event, SeenAddress


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
                         rsvp_closes_at="2026-10-26T18:00:00Z")
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


def test_deadline_is_judged_by_when_a_payment_was_mined(client, make_event, attendee):
    from datetime import datetime, timedelta, timezone

    from test_lifecycle import advance

    from unlisted.engine import RSVP_GRACE_BLOCKS

    just_passed = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    ev = make_event(rsvp_closes_at=just_passed)["event"]
    sent_in_time = attendee(ev["id"])
    pay(client, ev, sent_in_time.memo())  # mined in the next block
    assert [t["h"] for t in tickets(client, ev["id"])["tickets"]] == [sent_in_time.hash]
    advance(client, RSVP_GRACE_BLOCKS + 1)
    late = attendee(ev["id"])
    pay(client, ev, late.memo())
    assert tickets(client, ev["id"])["rejected"] == [{"h": late.hash, "reason": "rsvps_closed"}]


def test_idle_events_are_retired_a_day_after_they_start(client, make_event, attendee):
    from datetime import datetime, timedelta, timezone

    long_ago = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    idle = make_event(starts_at=long_ago)["event"]
    used = make_event(starts_at=long_ago)["event"]
    upcoming = make_event()["event"]
    pay(client, used, attendee(used["id"]).memo())
    client.engine.retire_idle_events()
    status = {e["id"]: client.get(f"/events/{e['id']}").json() for e in (idle, used, upcoming)}
    assert status[idle["id"]]["status"] == "purged" and status[idle["id"]]["title"] == "Purged event"
    assert status[used["id"]]["status"] == "open" and status[upcoming["id"]]["status"] == "open"
    with client.engine.sessions() as db:
        assert db.get(Event, idle["id"]).account_ref == ""


def test_api_docs_are_off_outside_sim(tmp_path):
    from fastapi.testclient import TestClient

    from unlisted.app import create_app
    from unlisted.chain.sim import SimChain
    from unlisted.config import Settings

    app = create_app(Settings(chain_mode="rpc", database_url=f"sqlite:///{tmp_path}/d.db", run_scanner=False,
                              secret="s"), SimChain("main"))
    with TestClient(app) as c:
        assert c.get("/docs").status_code == 404 and c.get("/openapi.json").status_code == 404


def test_purge_interrupted_after_the_wallet_delete_can_finish(client, make_event, attendee):
    from test_lifecycle import settle

    created = make_event(forfeit_address=random_unified_address())
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    settle(client, ev, admin)
    with client.engine.sessions() as db:
        account = db.get(Event, ev["id"]).account_ref
    # The wallet deleted the account, but the API never heard back (timeout).
    client.chain.delete_account(account)
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.json()["status"] == "purged", r.text
