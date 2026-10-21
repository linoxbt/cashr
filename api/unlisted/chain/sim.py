"""A simulated chain for tests and local development.

It is not a Zcash implementation. It models what Unlisted relies on: notes
arrive at an address with a memo, gain confirmations, and outgoing sends spend
from an account balance. The API refuses to run in this mode unless asked to,
and the web app shows a banner whenever it is active.
"""

from __future__ import annotations

import itertools
import secrets
import threading
from dataclasses import dataclass, field

from ..codec import _CHARSET, _BECH32M_CONST, _hrp_expand, _polymod
from ..ua import f4jumble
from .base import ChainError, OpStatus, ReceivedNote, Recipient

FEE_ZAT = 10_000


def bech32m_encode(hrp: str, data5: list[int]) -> str:
    values = _hrp_expand(hrp) + data5
    pm = _polymod(values + [0] * 6) ^ _BECH32M_CONST
    checksum = [(pm >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CHARSET[d] for d in data5 + checksum)


def _to_5bit(data: bytes) -> list[int]:
    acc = bits = 0
    out = []
    for b in data:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if bits:
        out.append((acc << (5 - bits)) & 31)
    return out


def unified_address(network: str, receivers: dict[int, bytes]) -> str:
    """Encode a ZIP 316 Unified Address from {typecode: raw receiver}."""
    hrp = "u" if network == "main" else "utest"
    body = b"".join(bytes([t, len(r)]) + r for t, r in sorted(receivers.items()))
    return bech32m_encode(hrp, _to_5bit(f4jumble(body + hrp.encode().ljust(16, b"\x00"))))


def random_unified_address(network: str = "main", orchard: bool = True, sapling: bool = False) -> str:
    receivers = {}
    if sapling:
        receivers[0x02] = secrets.token_bytes(43)
    if orchard:
        receivers[0x03] = secrets.token_bytes(43)
    return unified_address(network, receivers)


@dataclass
class _Note:
    address: str
    txid: str
    index: int
    amount_zat: int
    memo: bytes
    height: int = 0  # 0 = in mempool


@dataclass
class _Account:
    address: str
    notes: list[_Note] = field(default_factory=list)
    spent_zat: int = 0


class SimChain:
    def __init__(self, network: str = "main", auto_mine: bool = True):
        self.network = network
        self.auto_mine = auto_mine
        self.height = 3_100_000
        self._lock = threading.RLock()
        self._accounts: dict[str, _Account] = {}
        self._ops: dict[str, OpStatus] = {}
        self._ids = itertools.count(1)
        self.sent: list[tuple[str, list[Recipient], str]] = []  # (account, recipients, txid)
        self.fail_sends = False

    # ---- test / dev controls ------------------------------------------
    def pay(self, address: str, amount_zat: int, memo: bytes) -> str:
        """Simulate an attendee's wallet paying ``address``."""
        with self._lock:
            acct = self._by_address(address)
            txid = secrets.token_hex(32)
            acct.notes.append(_Note(address, txid, 0, amount_zat, memo.ljust(512, b"\x00")))
            if self.auto_mine:
                self.mine()
            return txid

    def mine(self, blocks: int = 1) -> None:
        with self._lock:
            for _ in range(blocks):
                self.height += 1
                for acct in self._accounts.values():
                    for n in acct.notes:
                        if n.height == 0:
                            n.height = self.height

    def _by_address(self, address: str) -> _Account:
        for acct in self._accounts.values():
            if acct.address == address:
                return acct
        raise ChainError("address not in this wallet")

    # ---- Chain protocol -----------------------------------------------
    def tip_height(self) -> int:
        return self.height

    def new_event_account(self) -> tuple[str, str]:
        with self._lock:
            ref = str(next(self._ids))
            addr = random_unified_address(self.network)
            self._accounts[ref] = _Account(addr)
            return ref, addr

    def received(self, account_ref: str, address: str) -> list[ReceivedNote]:
        with self._lock:
            acct = self._accounts[account_ref]
            return [
                ReceivedNote(
                    txid=n.txid, pool="orchard", out_index=n.index, amount_zat=n.amount_zat,
                    memo=n.memo, confirmations=(self.height - n.height + 1) if n.height else 0,
                    height=n.height,
                )
                for n in acct.notes
                if n.address == address
            ]

    def spendable_zat(self, account_ref: str) -> int:
        with self._lock:
            acct = self._accounts[account_ref]
            return sum(n.amount_zat for n in acct.notes if n.height) - acct.spent_zat

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient]) -> str:
        with self._lock:
            if self.fail_sends:
                raise ChainError("simulated wallet failure")
            total = sum(r.amount_zat for r in recipients) + FEE_ZAT
            if total > self.spendable_zat(account_ref):
                raise ChainError("Insufficient funds")
            self._accounts[account_ref].spent_zat += total
            txid = secrets.token_hex(32)
            opid = f"opid-sim-{secrets.token_hex(8)}"
            self._ops[opid] = OpStatus("success", txid=txid)
            self.sent.append((account_ref, list(recipients), txid))
            return opid

    def op_status(self, opid: str) -> OpStatus:
        return self._ops.get(opid, OpStatus("failed", error="unknown op"))
