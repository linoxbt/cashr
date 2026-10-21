"""The interface between Unlisted and a Zcash wallet."""

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
    state: str  # "pending" | "success" | "failed"
    txid: str = ""
    error: str = ""


class ChainError(RuntimeError):
    pass


class Chain(Protocol):
    def tip_height(self) -> int: ...

    def new_event_account(self) -> tuple[str, str]:
        """Create a fresh wallet account for one event; return (account_ref, address)."""
        ...

    def received(self, account_ref: str, address: str) -> list[ReceivedNote]:
        """Every shielded note ever received at ``address``, spent or not."""
        ...

    def spendable_zat(self, account_ref: str) -> int: ...

    def send(self, account_ref: str, from_address: str, recipients: list[Recipient]) -> str:
        """Submit a shielded send and return an operation id."""
        ...

    def op_status(self, opid: str) -> OpStatus: ...
