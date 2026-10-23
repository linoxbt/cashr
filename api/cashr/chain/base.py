"""The interface between cashr and its Zcash wallet (cashr-wallet)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ReceivedNote:
    txid: str
    pool: str  # "orchard" | "sapling"
    out_index: int
    amount_zat: int
    memo: bytes
    confirmations: int
    height: int  # 0 while unmined


@dataclass(frozen=True)
class Recipient:
    address: str
    amount_zat: int
    memo: bytes


@dataclass(frozen=True)
class OpStatus:
    # "pending": still being built; "success": built and broadcast (txid set,
    # not necessarily mined); "failed": nothing was broadcast.
    state: str
    txid: str = ""
    error: str = ""
    amount_zat: int | None = None  # what a sweep actually sent, once known


@dataclass(frozen=True)
class TxStatus:
    # "mined" | "pending" (in mempool or not yet seen) | "expired" (can never be mined)
    state: str
    confirmations: int = 0


@dataclass(frozen=True)
class Balance:
    spendable_zat: int
    # Received or change value that is not spendable yet (waiting for confirmations).
    pending_zat: int

    @property
    def total_zat(self) -> int:
        return self.spendable_zat + self.pending_zat


class ChainError(RuntimeError):
    pass


class Chain(Protocol):
    def tip_height(self) -> int: ...

    def sync_age(self) -> int | None:
        """Seconds since the wallet last caught up with the chain (None: never yet)."""
        ...

    def height_at(self, unix_time: int) -> int | None:
        """The highest known block mined at or before `unix_time`, or None if unknown."""
        ...

    def new_event_account(self) -> tuple[str, str]:
        """Create a fresh wallet account (own keys) for one event; return (account_ref, address)."""
        ...

    def received(self, account_ref: str, address: str, since_height: int = 0) -> list[ReceivedNote]:
        """Shielded notes received at ``address``, spent or not, mined at or after
        ``since_height`` (plus every unmined one)."""
        ...

    def balance(self, account_ref: str) -> Balance: ...

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient], key: str) -> str:
        """Submit a shielded send and return an operation id.

        ``key`` makes the call idempotent: the wallet never builds a second
        transaction for a key whose transaction may still be mined. Calling it
        again with the same key rebroadcasts a pending transaction, rebuilds an
        expired one, and retries one that failed before broadcast.
        """
        ...

    def sweep(self, account_ref: str, from_address: str, to_address: str, memo: bytes, key: str) -> str:
        """Send the account's entire spendable balance, minus the fee, to one address."""
        ...

    def op_status(self, opid: str) -> OpStatus: ...

    def tx_status(self, txid: str) -> TxStatus: ...

    def delete_account(self, account_ref: str) -> None:
        """Destroy the account's keys and every record of its transactions and memos."""
        ...
