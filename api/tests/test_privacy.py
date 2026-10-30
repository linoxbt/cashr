"""What each party can learn: the public list, memos, purge leftovers, digests."""

from conftest import auth
from test_lifecycle import admin_view, checkin, pay, reasons, refunds_to, settle, tickets

from cashr.chain.sim import random_unified_address
from cashr.db import Deposit, Event, Payout, Rsvp


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
    from datetime import datetime, timedelta, timezone
    closes = (datetime.now(timezone.utc) + timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    created = make_event(title="Tenants' union, flat 4B", forfeit_address=random_unified_address(),
                         rsvp_closes_at=closes)
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


def test_seats_are_random_and_refund_addresses_hidden(client, make_event, attendee):
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
    assert all(r["refund_address"] == "stored until purge" for r in rsvps)
    assert all("height" not in d for d in admin_view(client, ev, admin)["deposits"])


def test_stored_rows_dont_date_or_order_payments(client, make_event, attendee):
    # A seized database: an accepted deposit's txid must not lead to a ticket, no
    # deposit keeps a block height, and RSVP ids don't count up in payment order.
    ev = make_event(capacity=10)["event"]
    people = [attendee(ev["id"]) for _ in range(6)]
    for p in people:
        pay(client, ev, p.memo())
    with client.engine.sessions() as db:
        deps = db.query(Deposit).filter(Deposit.event_id == ev["id"]).all()
        assert deps and all(d.height == 0 and d.ticket_hash == "" for d in deps)
        ids = [r.id for r in db.query(Rsvp).filter(Rsvp.event_id == ev["id"]).order_by(Rsvp.ticket_hash)]
    by_payment = [ids[sorted(p.hash for p in people).index(p.hash)] for p in people]
    assert by_payment != sorted(by_payment)


def test_deadline_is_judged_by_when_a_payment_was_mined(client, make_event, attendee):
    from datetime import datetime, timedelta, timezone

    from test_lifecycle import advance

    from cashr.engine import RSVP_GRACE_BLOCKS

    just_passed = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    ev = make_event(rsvp_closes_at=just_passed)["event"]
    sent_in_time = attendee(ev["id"])
    pay(client, ev, sent_in_time.memo())  # mined in the next block
    assert [t["h"] for t in tickets(client, ev["id"])["tickets"]] == [sent_in_time.hash]
    advance(client, RSVP_GRACE_BLOCKS + 1)
    late = attendee(ev["id"])
    pay(client, ev, late.memo())
    assert reasons(client, ev["id"]) == [{"h": late.hash, "reason": "rsvps_closed"}]


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

    from cashr.app import create_app
    from cashr.chain.sim import SimChain
    from cashr.config import Settings

    app = create_app(Settings(chain_mode="rpc", database_url=f"sqlite:///{tmp_path}/d.db", run_scanner=False), SimChain("main"))
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


def test_purge_refuses_when_the_wallet_forgot_an_account_it_never_deleted(client, make_event, attendee):
    from test_lifecycle import settle

    created = make_event(forfeit_address=random_unified_address())
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    settle(client, ev, admin)
    with client.engine.sessions() as db:
        account = db.get(Event, ev["id"]).account_ref
    # A wallet database reset or restored from an old backup: the account is gone
    # but was never deleted, and its seed may still guard funds on chain.
    del client.chain._accounts[account]
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.status_code == 502 and "no account" in r.json()["message"]
    assert client.get(f"/events/{ev['id']}").json()["status"] == "settled"


def test_deadline_uses_block_times_when_known(client, make_event, attendee):
    from datetime import datetime, timezone

    ev = make_event()["event"]
    for _ in range(5):
        client.chain.mine()
    # Real blocks come about 75 s apart; give the sim's the same spacing.
    for i, h in enumerate(sorted(client.chain._block_times)):
        client.chain._block_times[h] = 1_700_000_000 + 75 * i
    deadline_block = client.chain.height - 4
    closes = datetime.fromtimestamp(client.chain._block_times[deadline_block], timezone.utc)
    with client.engine.sessions() as db:
        db.get(Event, ev["id"]).rsvp_closes_at = closes
        db.commit()
    # Seconds ago by the clock, but five blocks ago on chain: well past the grace.
    late = attendee(ev["id"])
    pay(client, ev, late.memo())
    assert reasons(client, ev["id"]) == [{"h": late.hash, "reason": "rsvps_closed"}]
    with client.engine.sessions() as db:
        assert db.get(Event, ev["id"]).close_height == deadline_block



def test_the_public_list_changes_only_on_its_own_schedule(tmp_path, attendee):
    from datetime import timedelta

    from fastapi.testclient import TestClient

    from cashr.app import create_app
    from cashr.chain.sim import SimChain
    from cashr.config import Settings

    from datetime import datetime, timezone
    starts_at = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    chain = SimChain("main", received_conf=1, change_conf=1)
    settings = Settings(chain_mode="sim", database_url=f"sqlite:///{tmp_path}/b.db", run_scanner=False, list_delay_min=120, refund_spread_min=0)
    with TestClient(create_app(settings, chain)) as c:
        c.chain, c.engine = chain, c.app.state.engine
        created = c.post("/events", json={"title": "x", "starts_at": starts_at, "capacity": 2,
                                          "deposit_zat": 500_000}).json()
        ev, admin, door = created["event"], created["admin_token"], created["door_token"]
        with c.engine.sessions() as db:
            first_update = db.get(Event, ev["id"]).list_publish_at
        # Scheduled from creation, not from any payment.
        assert timedelta(minutes=59) < (first_update.replace(tzinfo=None) - datetime_now()) < timedelta(minutes=181)
        before = (c.get(f"/events/{ev['id']}").json(), tickets(c, ev["id"]))
        a, b, late = attendee(ev["id"]), attendee(ev["id"]), attendee(ev["id"])
        pay(c, ev, a.memo())
        pay(c, ev, b.memo())          # fills the event
        pay(c, ev, late.memo())       # returned: full
        # Nothing public changed: not the list, the counts, the full flag, or the returned payments.
        assert (c.get(f"/events/{ev['id']}").json(), tickets(c, ev["id"])) == before
        assert admin_view(c, ev, admin)["event"]["rsvp_count"] == 2  # the organiser sees the truth
        assert checkin(c, ev, door, a) == "ok"                         # and the door can admit them
        # At the scheduled moment, everything waiting appears together, and the next update is scheduled.
        with c.engine.sessions() as db:
            e = db.get(Event, ev["id"])
            e.list_publish_at = e.list_publish_at - timedelta(hours=4)
            db.commit()
        c.engine.scan_once(full=True)
        after = c.get(f"/events/{ev['id']}").json()
        assert {t["h"] for t in tickets(c, ev["id"])["tickets"]} == {a.hash, b.hash}
        assert tickets(c, ev["id"])["rejected"] == [{"h": late.hash, "reason": "returned"}]
        assert after["rsvp_count"] == 2 and after["full"] is True and after["checked_in_count"] is None
        with c.engine.sessions() as db:
            assert db.get(Event, ev["id"]).list_publish_at.replace(tzinfo=None) > datetime_now()


def test_refund_progress_stays_hidden_until_settled(client, make_event, attendee):
    created = make_event(forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    people = [attendee(ev["id"]) for _ in range(2)]
    for p in people:
        pay(client, ev, p.memo())
        checkin(client, ev, door, p)
    pay(client, ev, b"", 100_000)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    seen = set()
    for _ in range(20):
        t = tickets(client, ev["id"])
        if t["status"] == "settled":
            break
        seen.add(tuple(sorted(x["status"] for x in t["tickets"])))
        client.chain.mine()
        client.engine.scan_once(full=True)
    # While settling, everyone who came reads "refunding"; outcomes appear together at the end.
    assert seen <= {("refunding", "refunding")}
    assert [x["status"] for x in tickets(client, ev["id"])["tickets"]] == ["refunded", "refunded"]


def datetime_now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(tzinfo=None)


def test_refunds_go_one_per_transaction_at_staggered_times(client, make_event, attendee):
    from datetime import timedelta

    created = make_event(forfeit_address=random_unified_address())
    ev, admin, door = created["event"], created["admin_token"], created["door_token"]
    people = [attendee(ev["id"]) for _ in range(3)]
    for p in people:
        pay(client, ev, p.memo())
        checkin(client, ev, door, p)
    # Everyone came, so the organiser tops up the fees: one per refund now.
    pay(client, ev, b"", 100_000)
    client.engine.settings = replace_setting(client.engine.settings, refund_spread_min=180)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    with client.engine.sessions() as db:
        refunds = db.query(Payout).filter(Payout.event_id == ev["id"], Payout.kind == "refund").all()
        assert len(refunds) == 3 and all(len(p.recipients) == 1 for p in refunds)
        assert all(p.not_before is not None for p in refunds)
    # Nothing is sent before its time.
    client.engine.scan_once(full=True)
    assert client.chain.sent == []
    with client.engine.sessions() as db:
        for p in db.query(Payout).filter(Payout.event_id == ev["id"]):
            p.not_before = p.not_before - timedelta(hours=4)
        db.commit()
    settle(client, ev, admin, post=False)
    refund_txs = [rs for _, rs, _ in client.chain.sent if rs[0].amount_zat == ev["deposit_zat"]]
    assert len(refund_txs) == 3 and all(len(rs) == 1 for rs in refund_txs)
    assert sorted(refunds_to(client, p.refund_address) for p in people) == [[ev["deposit_zat"]]] * 3


def replace_setting(settings, **changes):
    from dataclasses import replace

    return replace(settings, **changes)


def test_only_the_orchard_receiver_of_a_refund_address_is_kept(client, make_event, attendee):
    import secrets as _s

    from cashr.ua import decode_unified, unified_address

    ev = make_event()["event"]
    a = attendee(ev["id"])
    orchard = _s.token_bytes(43)
    # A wallet that puts a transparent receiver next to the Orchard one.
    a.refund_address = unified_address("main", {0x00: _s.token_bytes(20), 0x03: orchard})
    pay(client, ev, a.memo())
    with client.engine.sessions() as db:
        stored = db.query(Rsvp).filter(Rsvp.event_id == ev["id"]).one().refund_address
    assert decode_unified(stored, "u") == {"orchard": orchard}
    # Reuse is judged on the Orchard receiver, whatever else the address carried.
    again = attendee(ev["id"])
    again.refund_address = unified_address("main", {0x03: orchard})
    pay(client, ev, again.memo())
    assert reasons(client, ev["id"]) == [{"h": again.hash, "reason": "address_reused"}]


def test_purge_wipes_what_could_date_the_event(client, make_event, attendee):
    created = make_event(forfeit_address=random_unified_address())
    ev, admin = created["event"], created["admin_token"]
    pay(client, ev, attendee(ev["id"]).memo())
    client.post(f"/events/{ev['id']}/admin/close", headers=auth(admin))
    settle(client, ev, admin)
    assert client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin)).json()["status"] == "purged"
    with client.engine.sessions() as db:
        e = db.get(Event, ev["id"])
        assert e.created_at.year == 1970 and e.scan_height == 0 and e.close_height is None


def test_payments_built_before_the_rename_still_count(client, make_event, attendee):
    from cashr.codec import try_decode_memo

    ev = make_event()["event"]
    a = attendee(ev["id"])
    old = a.memo().replace(b"CSH1 ", b"UNL1 ", 1)
    assert try_decode_memo(old) is not None
    pay(client, ev, old)
    assert [t["h"] for t in tickets(client, ev["id"])["tickets"]] == [a.hash]


def _purged_event_with_ticket(client, make_event, attendee, title):
    created = make_event(title=title, forfeit_address=random_unified_address())
    ev, admin = created["event"], created["admin_token"]
    a = attendee(ev["id"])
    client.chain.pay(ev["address"], ev["deposit_zat"], a.memo())
    client.engine.scan_once(full=True)
    client.post(f"/events/{ev['id']}/admin/settle", headers=auth(admin))
    for _ in range(10):
        client.chain.mine()
        client.engine.scan_once(full=True)
    return ev, admin, a


def _db_files_mention(path, *needles):
    found = []
    for f in path.iterdir():
        data = f.read_bytes()
        found += [(f.name, n) for n in needles if n.encode() in data]
    return found


def test_purge_leaves_nothing_in_the_wal_even_with_a_reader(client, make_event, attendee, tmp_path):
    # A read in progress during the purge is waited out, then the WAL is emptied.
    import sqlite3
    import threading
    ev, admin, a = _purged_event_with_ticket(client, make_event, attendee, "SecretTitleQQ")
    reader = sqlite3.connect(tmp_path / "t.db", check_same_thread=False)
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM events").fetchall()
    threading.Timer(1.0, reader.rollback).start()  # a slow read, finished mid-purge
    r = client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin))
    assert r.status_code == 200, r.text
    reader.close()
    assert _db_files_mention(tmp_path, "SecretTitleQQ", a.hash) == []


def test_a_rewrite_blocked_for_good_is_finished_later(client, make_event, attendee, tmp_path, monkeypatch):
    # A reader that outlasts the wait used to make the rewrite fail quietly, leaving
    # the purged title and ticket hash in the WAL until some later purge.
    import sqlite3
    from cashr import db as dbmod
    monkeypatch.setattr(dbmod, "COMPACT_BUSY_MS", 50)
    monkeypatch.setattr(dbmod, "COMPACT_ATTEMPTS", 1)
    ev, admin, a = _purged_event_with_ticket(client, make_event, attendee, "SecretTitleRR")
    reader = sqlite3.connect(tmp_path / "t.db")
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM events").fetchall()
    assert client.post(f"/events/{ev['id']}/admin/purge", headers=auth(admin)).status_code == 200
    reader.rollback()
    reader.close()
    assert _db_files_mention(tmp_path, "SecretTitleRR"), "the reader really did block the rewrite"
    # Still owed, and finished on the scanner's next slow turn.
    client.engine.scan_once(full=True)
    assert _db_files_mention(tmp_path, "SecretTitleRR", a.hash) == []


def test_scrubbing_old_rows_schedules_a_rewrite(tmp_path):
    # A database from before heights and accepted tickets were dropped: the scrub
    # rewrites the rows, and the old values must then leave the file too.
    from sqlalchemy import text

    from cashr.db import Flag, init_db, make_engine, make_sessionmaker

    eng = make_engine(f"sqlite:///{tmp_path}/old.db")
    init_db(eng)
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO deposits (event_id, txid, pool, out_index, amount_zat, height, kind, reason, listed, ticket_hash) "
                          "VALUES ('e', 't', 'orchard', 0, 1, 3100000, 'rsvp', '', 0, 'h')"))
    init_db(eng)
    with make_sessionmaker(eng)() as db:
        assert db.get(Flag, "compact_owed") is not None
        d = db.get(Deposit, 1)
        assert d.height == 0 and d.ticket_hash == ""
