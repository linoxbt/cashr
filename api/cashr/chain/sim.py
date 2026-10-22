"""A simulated chain for tests and local development.

It is not a Zcash implementation, but it models the wallet behaviour cashr
depends on, including the awkward parts: sends stay in the mempool until a
block is mined, change is not spendable until it confirms, an unmined
transaction expires, shortfalls are reported when the operation runs, and a
send key is idempotent. It only runs when CASHR_CHAIN=sim is set
explicitly, and the web app shows a banner whenever it is active.
"""

from __future__ import annotations

import itertools
import secrets
import threading
import time
from dataclasses import dataclass, field

from ..codec import _CHARSET, _BECH32M_CONST, _hrp_expand, _polymod
from ..ua import f4jumble
from .base import Balance, ChainError, OpStatus, ReceivedNote, Recipient, TxStatus

MARGINAL_FEE = 5_000
EXPIRY_DELTA = 40
DUST_ZAT = 20_000  # matches the real wallet's delete limit


def zip317_fee(inputs: int, outputs: int) -> int:
    return MARGINAL_FEE * max(2, inputs, outputs)


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
    change: bool = False
    spent_by: str = ""  # txid of the transaction spending it


@dataclass
class _Tx:
    txid: str
    account: str
    recipients: list[Recipient]
    inputs: list[_Note]
    change: _Note | None
    expiry: int
    height: int = 0
    in_mempool: bool = True


@dataclass
class _Account:
    address: str
    notes: list[_Note] = field(default_factory=list)


@dataclass
class _Op:
    key: str
    account: str
    txid: str = ""
    state: str = "pending"
    error: str = ""
    amount_zat: int | None = None


class SimChain:
    # Confirmation needs default to the real wallet's (librustzcash's default
    # policy: 10 for received notes, 3 for its own change), so tests can't pass
    # on timing the real wallet would never allow.
    def __init__(self, network: str = "main", auto_mine: bool = True,
                 received_conf: int = 10, change_conf: int = 3, async_ops: bool = False):
        self.network = network
        self.auto_mine = auto_mine
        self.received_conf = received_conf
        self.change_conf = change_conf
        # Like the real wallet, report a send as executing until polled once.
        self.async_ops = async_ops
        self._unpolled: set[str] = set()
        self._block_times: dict[int, float] = {}
        # Accounts deleted here, so a repeated delete succeeds while an unknown
        # account (a reset wallet) is refused, as the real wallet does.
        self._deleted: set[str] = set()
        self.height = 3_100_000
        self._lock = threading.RLock()
        self._accounts: dict[str, _Account] = {}
        self._txs: dict[str, _Tx] = {}
        self._ops: dict[str, _Op] = {}
        self._by_key: dict[str, str] = {}
        self._ids = itertools.count(1)
        self.sent: list[tuple[str, list[Recipient], str]] = []  # every transaction built
        self.fail_sends = False
        # Simulate a lost response: the wallet acts, the caller sees an error.
        self.lose_responses = 0

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
        """Mine blocks: payments and broadcast transactions in the mempool confirm."""
        with self._lock:
            for _ in range(blocks):
                self.height += 1
                self._block_times[self.height] = time.time()
                for acct in self._accounts.values():
                    for n in acct.notes:
                        if n.height == 0 and not n.change:
                            n.height = self.height
                for tx in self._txs.values():
                    if tx.height == 0 and tx.in_mempool and self.height <= tx.expiry:
                        tx.height = self.height
                        if tx.change:
                            tx.change.height = self.height

    def drop_from_mempool(self, txid: str) -> None:
        """Simulate a transaction that fell out of the mempool unmined."""
        with self._lock:
            self._txs[txid].in_mempool = False

    def _by_address(self, address: str) -> _Account:
        for acct in self._accounts.values():
            if acct.address == address:
                return acct
        raise ChainError("address not in this wallet")

    def _account(self, ref: str) -> _Account:
        acct = self._accounts.get(ref)
        if acct is None:
            raise ChainError(f"account {ref} was deleted" if ref in self._deleted else f"no account {ref}")
        return acct

    def _confs(self, height: int) -> int:
        return self.height - height + 1 if height else 0

    def _expired(self, tx: _Tx) -> bool:
        return tx.height == 0 and self.height > tx.expiry

    def _spent(self, n: _Note) -> bool:
        tx = self._txs.get(n.spent_by)
        return tx is not None and not self._expired(tx)

    def _split(self, acct: _Account) -> tuple[list[_Note], list[_Note]]:
        spendable, pending = [], []
        for n in acct.notes:
            if self._spent(n):
                continue
            if not n.change and n.height == 0:
                continue  # the real wallet only learns of a payment once it is mined
            if n.change and self._expired(self._txs[n.txid]):
                continue  # change of a transaction that can never be mined
            need = self.change_conf if n.change else self.received_conf
            (spendable if self._confs(n.height) >= need else pending).append(n)
        return spendable, pending

    # ---- Chain protocol -----------------------------------------------
    def tip_height(self) -> int:
        return self.height

    def height_at(self, unix_time: int) -> int | None:
        with self._lock:
            known = [h for h, t in self._block_times.items() if t <= unix_time]
            return max(known) if known else None

    def new_event_account(self) -> tuple[str, str]:
        with self._lock:
            ref = f"acct-{next(self._ids)}"
            addr = random_unified_address(self.network)
            self._accounts[ref] = _Account(addr)
            return ref, addr

    def received(self, account_ref: str, address: str, since_height: int = 0) -> list[ReceivedNote]:
        with self._lock:
            acct = self._account(account_ref)
            return [
                ReceivedNote(
                    txid=n.txid, pool="orchard", out_index=n.index, amount_zat=n.amount_zat,
                    memo=n.memo, confirmations=self._confs(n.height), height=n.height,
                )
                for n in acct.notes
                # Mined only: the real wallet scans blocks, not the mempool.
                if n.address == address and not n.change and n.height and n.height >= since_height
            ]

    def balance(self, account_ref: str) -> Balance:
        with self._lock:
            spendable, pending = self._split(self._account(account_ref))
            return Balance(sum(n.amount_zat for n in spendable), sum(n.amount_zat for n in pending))

    def _respond(self, opid: str) -> str:
        if self.lose_responses:
            self.lose_responses -= 1
            raise ChainError("wallet unreachable: timed out")
        return opid

    def _submit(self, account_ref: str, key: str, build) -> str:
        with self._lock:
            if self.fail_sends:
                raise ChainError("simulated wallet failure")
            self._account(account_ref)
            opid = self._by_key.get(key)
            if opid is None:
                opid = f"opid-sim-{secrets.token_hex(8)}"
                self._by_key[key] = opid
                self._ops[opid] = _Op(key, account_ref)
            op = self._ops[opid]
            tx = self._txs.get(op.txid)
            if op.txid and tx is None:
                # Like the real wallet: never build again for a txid it can't account for.
                raise ChainError("the transaction for this key is unknown to the wallet; refusing to send again")
            if tx is not None and not self._expired(tx):
                tx.in_mempool = True  # rebroadcast; never a second transaction
                return self._respond(opid)
            op.state, op.error, op.txid = "pending", "", ""
            try:
                op.txid, op.amount_zat = build(self._account(account_ref))
                op.state = "success"
            except ChainError as e:
                op.state, op.error = "failed", str(e)
            if self.async_ops:
                self._unpolled.add(opid)
            return self._respond(opid)

    def _build(self, account_ref: str, acct: _Account, recipients: list[Recipient], everything: bool):
        spendable, pending = self._split(acct)
        if everything:
            if pending:
                raise ChainError("Cannot send everything while funds are still unconfirmed")
            inputs = sorted(spendable, key=lambda n: -n.amount_zat)
            fee = zip317_fee(len(inputs), 1)
            amount = sum(n.amount_zat for n in inputs) - fee
            if amount <= 0:
                raise ChainError("Insufficient balance to cover the fee")
            recipients = [Recipient(recipients[0].address, amount, recipients[0].memo)]
        else:
            want = sum(r.amount_zat for r in recipients)
            inputs, total = [], 0
            for n in sorted(spendable, key=lambda n: -n.amount_zat):
                if total >= want + zip317_fee(len(inputs), len(recipients) + 1):
                    break
                inputs.append(n)
                total += n.amount_zat
            fee = zip317_fee(len(inputs), len(recipients) + 1)
            if total < want + fee:
                raise ChainError(f"Insufficient balance (have {sum(n.amount_zat for n in spendable)}, need {want + fee} including fee)")
        txid = secrets.token_hex(32)
        left = sum(n.amount_zat for n in inputs) - sum(r.amount_zat for r in recipients) - fee
        change = _Note(acct.address, txid, len(recipients), left, b"", change=True) if left > 0 else None
        if change:
            acct.notes.append(change)
        for n in inputs:
            n.spent_by = txid
        self._txs[txid] = _Tx(txid, account_ref, list(recipients), inputs, change, self.height + EXPIRY_DELTA)
        # Like the real chain, the transaction waits in the mempool for a block.
        self.sent.append((account_ref, list(recipients), txid))
        return txid, sum(r.amount_zat for r in recipients)

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient], key: str) -> str:
        return self._submit(account_ref, key, lambda acct: self._build(account_ref, acct, recipients, False))

    def sweep(self, account_ref: str, from_address: str, to_address: str, memo: bytes, key: str) -> str:
        return self._submit(account_ref, key,
                            lambda acct: self._build(account_ref, acct, [Recipient(to_address, 0, memo)], True))

    def op_status(self, opid: str) -> OpStatus:
        with self._lock:
            op = self._ops.get(opid)
            if op is None:
                return OpStatus("failed", error="operation unknown to wallet")
            if opid in self._unpolled:
                self._unpolled.discard(opid)
                return OpStatus("pending")
            return OpStatus(op.state, txid=op.txid, error=op.error, amount_zat=op.amount_zat)

    def tx_status(self, txid: str) -> TxStatus:
        with self._lock:
            tx = self._txs.get(txid)
            if tx is None:
                raise ChainError(f"transaction {txid} unknown to wallet")
            if tx.height:
                return TxStatus("mined", self._confs(tx.height))
            return TxStatus("expired" if self._expired(tx) else "pending")

    def delete_account(self, account_ref: str) -> None:
        with self._lock:
            if account_ref not in self._accounts:
                if account_ref in self._deleted:
                    return  # like the real wallet: deleting a deleted account succeeds
                raise ChainError(f"no account {account_ref}, and no record of deleting it; refusing to delete its seed")
            bal = self.balance(account_ref)
            if bal.total_zat > DUST_ZAT:
                raise ChainError("account still holds funds")
            del self._accounts[account_ref]
            self._deleted.add(account_ref)
            for txid in [t for t, tx in self._txs.items() if tx.account == account_ref]:
                del self._txs[txid]
