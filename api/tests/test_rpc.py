"""RpcChain against a fake zcashd JSON-RPC endpoint (response shapes from zcashd 5.x)."""

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
        "getblockcount": 3_000_010,
        "z_getnewaccount": {"account": 7},
        "z_getaddressforaccount": {"account": 7, "address": "u1event"},
        "z_listreceivedbyaddress": [
            {"pool": "orchard", "txid": "aa", "amount": 0.005, "amountZat": 500000,
             "memo": memo.hex(), "actionIndex": 1, "confirmations": 3, "blockheight": 3000008,
             "change": False},
            {"pool": "orchard", "txid": "bb", "amount": 0.1, "amountZat": 10000000,
             "memo": "f6", "actionIndex": 0, "confirmations": 1, "change": True},
        ],
    }, calls))
    assert c.new_event_account() == ("7", "u1event")
    assert calls[1] == ("z_getaddressforaccount", [7, ["orchard"]])
    (note,) = c.received("7", "u1event")
    assert (note.txid, note.out_index, note.amount_zat, note.height) == ("aa", 1, 500000, 3000008)
    assert note.memo == memo


def test_falls_back_to_listunspent():
    calls = []
    c = make_chain(responder({
        "getblockcount": 100,
        "z_listreceivedbyaddress": RuntimeError("Method not found"),
        "z_listunspent": [{"pool": "orchard", "txid": "cc", "amount": 0.01, "memo": "00",
                           "outindex": 0, "confirmations": 2}],
    }, calls))
    (note,) = c.received("1", "u1x")
    assert note.amount_zat == 1_000_000 and note.height == 99
    c.received("1", "u1x")
    assert [m for m, _ in calls].count("z_listreceivedbyaddress") == 1


def test_send_and_status():
    calls = []
    c = make_chain(responder({
        "z_sendmany": "opid-1",
        "z_getoperationstatus": [{"id": "opid-1", "status": "success", "result": {"txid": "dd"}}],
        "z_getbalanceforaccount": {"pools": {"orchard": {"valueZat": 42}}},
    }, calls))
    assert c.send("3", "u1from", [Recipient("u1to", 500_000, b"hi")]) == "opid-1"
    method, params = calls[0]
    assert params[0] == "u1from" and params[1] == [{"address": "u1to", "amount": 0.005, "memo": "6869"}]
    assert params[4] == "FullPrivacy"
    st = c.op_status("opid-1")
    assert (st.state, st.txid) == ("success", "dd")
    assert c.spendable_zat("3") == 42
