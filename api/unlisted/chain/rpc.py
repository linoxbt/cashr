"""Chain adapter for a real wallet speaking the zcashd JSON-RPC dialect.

Works against Zallet (the zcashd wallet successor) or a zcashd wallet. Each
event gets its own account so its funds, refunds and forfeits never mix with
another event's.
"""

from __future__ import annotations

import itertools
from decimal import Decimal

import httpx

from ..codec import ZAT_PER_ZEC, zat_to_zec_str
from .base import ChainError, OpStatus, ReceivedNote, Recipient


def _zat(entry: dict, key: str = "amount") -> int:
    if f"{key}Zat" in entry:
        return int(entry[f"{key}Zat"])
    return int((Decimal(str(entry[key])) * ZAT_PER_ZEC).to_integral_value())


class RpcChain:
    def __init__(self, url: str, user: str, password: str, privacy_policy: str = "FullPrivacy",
                 min_conf: int = 1, timeout: float = 30.0):
        auth = (user, password) if user or password else None
        self._client = httpx.Client(base_url=url, auth=auth, timeout=timeout)
        self._ids = itertools.count(1)
        self._policy = privacy_policy
        self._min_conf = min_conf
        self._has_listreceived: bool | None = None

    def _call(self, method: str, *params):
        body = {"jsonrpc": "1.0", "id": next(self._ids), "method": method, "params": list(params)}
        try:
            r = self._client.post("/", json=body)
        except httpx.HTTPError as e:
            raise ChainError(f"wallet unreachable: {e}") from e
        try:
            data = r.json()
        except ValueError as e:
            raise ChainError(f"wallet returned HTTP {r.status_code}") from e
        if data.get("error"):
            err = data["error"]
            raise ChainError(f"{method}: {err.get('message', err)}")
        return data["result"]

    def tip_height(self) -> int:
        return int(self._call("getblockcount"))

    def new_event_account(self) -> tuple[str, str]:
        account = self._call("z_getnewaccount")["account"]
        # Orchard-only: payers and refunds stay inside one pool, so no
        # cross-pool transfer ever reveals an amount.
        addr = self._call("z_getaddressforaccount", account, ["orchard"])["address"]
        return str(account), addr

    def received(self, account_ref: str, address: str) -> list[ReceivedNote]:
        tip = self.tip_height()
        # z_listreceivedbyaddress includes spent notes, so a deposit cannot
        # vanish from view by being spent in a refund before it is ingested.
        if self._has_listreceived is not False:
            try:
                rows = self._call("z_listreceivedbyaddress", address, 0)
                self._has_listreceived = True
            except ChainError as e:
                if self._has_listreceived is None and "not found" in str(e).lower():
                    self._has_listreceived = False
                else:
                    raise
        if self._has_listreceived is False:
            rows = self._call("z_listunspent", 0, 9_999_999, False, [address])

        notes = []
        for row in rows:
            if row.get("change"):
                continue
            conf = int(row.get("confirmations", 0))
            height = int(row.get("blockheight") or (tip - conf + 1 if conf > 0 else 0))
            index = row.get("actionIndex", row.get("outindex", row.get("jsoutindex", 0)))
            notes.append(ReceivedNote(
                txid=row["txid"],
                pool=row.get("pool", "orchard" if "actionIndex" in row else "sapling"),
                out_index=int(index),
                amount_zat=_zat(row),
                memo=bytes.fromhex(row.get("memo", "") or ""),
                confirmations=conf,
                height=height,
            ))
        return notes

    def spendable_zat(self, account_ref: str) -> int:
        bal = self._call("z_getbalanceforaccount", int(account_ref), self._min_conf)
        return sum(int(p.get("valueZat", 0)) for p in bal.get("pools", {}).values())

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient]) -> str:
        amounts = [
            {
                "address": r.address,
                # A decimal string, never a float: amounts must be exact.
                "amount": zat_to_zec_str(r.amount_zat),
                "memo": r.memo.hex(),
            }
            for r in recipients
        ]
        return self._call("z_sendmany", from_address, amounts, self._min_conf, None, self._policy)

    def op_status(self, opid: str) -> OpStatus:
        rows = self._call("z_getoperationstatus", [opid])
        if not rows:
            return OpStatus("failed", error="operation unknown to wallet")
        row = rows[0]
        status = row.get("status")
        if status == "success":
            return OpStatus("success", txid=row.get("result", {}).get("txid", ""))
        if status in ("failed", "cancelled"):
            return OpStatus("failed", error=row.get("error", {}).get("message", status))
        return OpStatus("pending")
