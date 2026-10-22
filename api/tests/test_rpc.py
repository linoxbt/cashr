"""RpcChain against a fake unlisted-wallet JSON-RPC endpoint."""

import json

import httpx

from unlisted.chain.base import Recipient
from unlisted.chain.rpc import RpcChain


def make_chain(handler):
    c = RpcChain("http://wallet", "u", "p")
    c._client = httpx.Client(base_url="http://wallet", transport=httpx.MockTransport(handler))
    return c


def responder(results: dict, calls: list):
    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append((body["method"], body["params"]))
        res = results[body["method"]]
        if isinstance(res, Exception):
            return httpx.Response(200, json={"result": None, "error": {"code": -32601, "message": str(res)}})
        return httpx.Response(200, json={"result": res(body["params"]) if callable(res) else res, "error": None})
    return handler


def test_account_and_received_notes():
    calls = []
    memo = b"UNL1 abc".ljust(512, b"\x00")
    c = make_chain(responder({
        "z_getnewaccount": {"account": "0b6f-uuid"},
        "z_getaddressforaccount": {"account": "0b6f-uuid", "address": "u1event"},
        "z_listreceivedbyaddress": [
            {"pool": "orchard", "txid": "aa", "amount": 0.005, "amountZat": 500000,
             "memo": memo.hex(), "actionIndex": 1, "confirmations": 3, "blockheight": 3000008,
             "change": False},
            {"pool": "orchard", "txid": "bb", "amount": 0.1, "amountZat": 10000000,
             "memo": "f6", "actionIndex": 0, "confirmations": 1, "change": True},
            {"pool": "orchard", "txid": "cc", "amountZat": 7, "memo": "", "actionIndex": 0,
             "confirmations": 0, "blockheight": None, "change": False},
        ],
    }, calls))
    assert c.new_event_account() == ("0b6f-uuid", "u1event")
    assert calls[1] == ("z_getaddressforaccount", ["0b6f-uuid", ["orchard"]])
    note, unmined = c.received("0b6f-uuid", "u1event", 2_999_900)
    assert calls[2] == ("z_listreceivedbyaddress", ["u1event", 0, 2_999_900])
    assert (note.txid, note.out_index, note.amount_zat, note.height) == ("aa", 1, 500000, 3000008)
    assert note.memo == memo
    assert unmined.height == 0 and unmined.confirmations == 0


def test_send_sweep_and_status():
    calls = []
    c = make_chain(responder({
        "z_sendmany": "opid-1",
        "z_sweep": "opid-2",
        "z_getoperationstatus": lambda p: [{"id": p[0][0], "status": "success",
                                            "result": {"txid": "dd", "amountZat": 980000}}],
        "z_getbalanceforaccount": {"spendableZat": 42, "pendingZat": 8},
        "gettransaction": {"txid": "dd", "status": "mined", "confirmations": 4},
        "z_deleteaccount": True,
    }, calls))
    assert c.send("acct", "u1from", [Recipient("u1to", 500_000, b"hi")], "key-1") == "opid-1"
    method, params = calls[0]
    assert params[0] == "u1from" and params[1] == [{"address": "u1to", "amount": "0.005", "memo": "6869"}]
    assert params[4] == "FullPrivacy" and params[5] == "key-1"
    assert c.sweep("acct", "u1from", "u1fund", b"m", "key-2") == "opid-2"
    assert calls[1] == ("z_sweep", ["u1from", "u1fund", "6d", "key-2"])
    st = c.op_status("opid-2")
    assert (st.state, st.txid, st.amount_zat) == ("success", "dd", 980000)
    b = c.balance("acct")
    assert (b.spendable_zat, b.pending_zat, b.total_zat) == (42, 8, 50)
    tx = c.tx_status("dd")
    assert (tx.state, tx.confirmations) == ("mined", 4)
    c.delete_account("acct")
    assert calls[-1] == ("z_deleteaccount", ["acct"])


def test_failed_status_is_reported():
    c = make_chain(responder({
        "z_getoperationstatus": [{"id": "o", "status": "failed",
                                  "error": {"code": -6, "message": "Insufficient balance (have 0, need 510000 including fee)"}}],
    }, []))
    st = c.op_status("o")
    assert st.state == "failed" and "Insufficient" in st.error


def test_unreachable_wallet_is_a_chain_error():
    import pytest

    from unlisted.chain.base import ChainError

    def boom(request):
        raise httpx.ConnectTimeout("timed out")

    with pytest.raises(ChainError, match="unreachable"):
        make_chain(boom).tip_height()


def test_half_created_account_is_removed():
    calls = []
    c = make_chain(responder({
        "z_getnewaccount": {"account": "0b6f-uuid"},
        "z_getaddressforaccount": RuntimeError("timed out"),
        "z_deleteaccount": None,
    }, calls))
    try:
        c.new_event_account()
        raise AssertionError("expected a ChainError")
    except Exception as e:
        assert "timed out" in str(e)
    assert calls[-1] == ("z_deleteaccount", ["0b6f-uuid"])
