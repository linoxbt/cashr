"""Chain adapter for unlisted-wallet's JSON-RPC (wallet/).

The method names follow zcashd where one exists, but the semantics Unlisted
needs (idempotent sends, sweeps, transaction expiry, account deletion) are
unlisted-wallet extensions, so this adapter only supports that wallet. Each
event gets its own account, with its own keys, so funds never mix and an
event's keys can be destroyed when it is purged.
"""

from __future__ import annotations

import itertools
from decimal import Decimal

import httpx

from ..codec import ZAT_PER_ZEC, zat_to_zec_str
from .base import Balance, ChainError, OpStatus, ReceivedNote, Recipient, TxStatus


def _zat(entry: dict, key: str = "amount") -> int:
    if f"{key}Zat" in entry:
        return int(entry[f"{key}Zat"])
    return int((Decimal(str(entry[key])) * ZAT_PER_ZEC).to_integral_value())


# Creating and deleting accounts wait for the wallet's writer, which a sync can
# hold for a while; giving up early would leave an account the API never records.
SLOW_TIMEOUT_S = 180.0


class RpcChain:
    def __init__(self, url: str, user: str, password: str, privacy_policy: str = "FullPrivacy",
                 min_conf: int = 1, timeout: float = 30.0):
        auth = (user, password) if user or password else None
        self._client = httpx.Client(base_url=url, auth=auth, timeout=timeout)
        self._ids = itertools.count(1)
        self._policy = privacy_policy
        self._min_conf = min_conf

    def _call(self, method: str, *params, timeout: float | None = None):
        body = {"jsonrpc": "1.0", "id": next(self._ids), "method": method, "params": list(params)}
        try:
            r = self._client.post("/", json=body, **({"timeout": timeout} if timeout else {}))
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

    def height_at(self, unix_time: int) -> int | None:
        h = self._call("z_heightattime", int(unix_time))
        return None if h is None else int(h)

    def new_event_account(self) -> tuple[str, str]:
        account = str(self._call("z_getnewaccount", timeout=SLOW_TIMEOUT_S)["account"])
        # Orchard-only: payers and refunds stay inside one pool, so no
        # cross-pool transfer ever reveals an amount.
        try:
            addr = self._call("z_getaddressforaccount", account, ["orchard"], timeout=SLOW_TIMEOUT_S)["address"]
        except ChainError:
            # The account is new and empty: remove it rather than leave one the
            # API never records (it would be scanned forever and never purged).
            try:
                self.delete_account(account)
            except ChainError:
                pass
            raise
        return account, addr

    def received(self, account_ref: str, address: str, since_height: int = 0) -> list[ReceivedNote]:
        # Includes spent notes, so a deposit cannot vanish from view by being
        # spent in a refund before it is ingested.
        rows = self._call("z_listreceivedbyaddress", address, 0, since_height)
        notes = []
        for row in rows:
            if row.get("change"):
                continue
            notes.append(ReceivedNote(
                txid=row["txid"],
                pool=row["pool"],
                out_index=int(row.get("actionIndex", row.get("outindex", 0))),
                amount_zat=_zat(row),
                memo=bytes.fromhex(row.get("memo", "") or ""),
                confirmations=int(row.get("confirmations", 0)),
                height=int(row.get("blockheight") or 0),
            ))
        return notes

    def balance(self, account_ref: str) -> Balance:
        b = self._call("z_getbalanceforaccount", account_ref)
        return Balance(int(b["spendableZat"]), int(b["pendingZat"]))

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient], key: str) -> str:
        amounts = [
            {
                "address": r.address,
                # A decimal string, never a float: amounts must be exact.
                "amount": zat_to_zec_str(r.amount_zat),
                "memo": r.memo.hex(),
            }
            for r in recipients
        ]
        # minconf keeps zcashd's parameter order; unlisted-wallet applies librustzcash's
        # own confirmation policy (10 for received notes, 3 for change) instead.
        return self._call("z_sendmany", from_address, amounts, self._min_conf, None, self._policy, key)

    def sweep(self, account_ref: str, from_address: str, to_address: str, memo: bytes, key: str) -> str:
        return self._call("z_sweep", from_address, to_address, memo.hex(), key)

    def op_status(self, opid: str) -> OpStatus:
        rows = self._call("z_getoperationstatus", [opid])
        if not rows:
            return OpStatus("failed", error="operation unknown to wallet")
        row = rows[0]
        status = row.get("status")
        result = row.get("result") or {}
        if status == "success":
            amount = result.get("amountZat")
            return OpStatus("success", txid=result.get("txid", ""),
                            amount_zat=int(amount) if amount is not None else None)
        if status in ("failed", "cancelled"):
            return OpStatus("failed", error=(row.get("error") or {}).get("message", status))
        return OpStatus("pending")

    def tx_status(self, txid: str) -> TxStatus:
        r = self._call("gettransaction", txid)
        return TxStatus(r["status"], int(r.get("confirmations", 0)))

    def delete_account(self, account_ref: str) -> None:
        # Idempotent on the wallet's side, so a timed-out delete can be retried.
        self._call("z_deleteaccount", account_ref, timeout=SLOW_TIMEOUT_S)
