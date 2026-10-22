"""Wire formats shared with the web client.

RSVP memo (ASCII, single spaces, at most 512 bytes):

    CSH1 <event_id> <ticket_hash> <refund_address>

* ``ticket_hash`` is base64url(SHA-256(secret)) without padding (43 chars).
  The 32-byte secret is generated in the attendee's browser and never leaves
  it until it is shown as a QR code at the door.
* ``refund_address`` is a shielded address of the attendee's choosing
  (a Unified Address with an Orchard receiver). Anything else is refused.

Payment request (ZIP 321): ``zcash:<addr>?amount=<ZEC>&memo=<base64url(memo)>``.
"""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass
from decimal import Decimal

MEMO_TAG = "CSH1"
LEGACY_MEMO_TAG = "UNL1"
MEMO_MAX = 512
ZAT_PER_ZEC = 100_000_000

_HASH_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_EVENT_RE = re.compile(r"^[a-z0-9]{10}$")


@dataclass(frozen=True)
class RsvpMemo:
    event_id: str
    ticket_hash: str
    refund_address: str


class MemoError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def ticket_hash(secret: bytes) -> str:
    return b64url(hashlib.sha256(secret).digest())


def is_ticket_hash(value: str) -> bool:
    return bool(_HASH_RE.match(value))


def encode_memo(m: RsvpMemo) -> bytes:
    raw = f"{MEMO_TAG} {m.event_id} {m.ticket_hash} {m.refund_address}".encode()
    if len(raw) > MEMO_MAX:
        raise MemoError("memo too long")
    return raw


def decode_memo(raw: bytes) -> RsvpMemo:
    # Memos are zero-padded to 512 bytes on chain.
    text = raw.rstrip(b"\x00").decode("ascii", errors="strict").strip()
    parts = text.split(" ")
    # UNL1 is the tag from before the rename to cashr: a payment built from an old
    # page must still count, not be kept as a fee top-up.
    if len(parts) != 4 or parts[0] not in (MEMO_TAG, LEGACY_MEMO_TAG):
        raise MemoError("not a cashr memo")
    _, event_id, th, addr = parts
    if not _EVENT_RE.match(event_id):
        raise MemoError("bad event id")
    if not is_ticket_hash(th):
        raise MemoError("bad ticket hash")
    return RsvpMemo(event_id, th, addr)


def try_decode_memo(raw: bytes) -> RsvpMemo | None:
    try:
        return decode_memo(raw)
    except (MemoError, UnicodeDecodeError):
        return None


def zat_to_zec_str(zat: int) -> str:
    d = (Decimal(zat) / ZAT_PER_ZEC).quantize(Decimal("0.00000001"))
    s = format(d, "f").rstrip("0").rstrip(".")
    return s or "0"


def zip321_uri(address: str, amount_zat: int, memo: bytes) -> str:
    return f"zcash:{address}?amount={zat_to_zec_str(amount_zat)}&memo={b64url(memo)}"


# ---- address checks -------------------------------------------------------
# Only a syntactic check (HRP + bech32/bech32m checksum). The wallet does the
# authoritative check when it sends a refund.

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32_CONST = 1
_BECH32M_CONST = 0x2BC830A3

SHIELDED_HRPS = {
    "main": {"u": _BECH32M_CONST, "zs": _BECH32_CONST},
    "test": {"utest": _BECH32M_CONST, "ztestsapling": _BECH32_CONST},
}


def _polymod(values: list[int]) -> int:
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def is_orchard_address(address: str, network: str) -> bool:
    """A Unified Address with an Orchard receiver: the only kind cashr pays.

    Refunds go Orchard-to-Orchard so that no amount or recipient is revealed
    on chain; an address without an Orchard receiver can't be refunded privately.
    """
    from .ua import has_orchard_receiver

    return has_orchard_receiver(address, network)


def address_kind(address: str, network: str) -> str | None:
    """Return "unified"/"sapling" for a well-formed shielded address, else None."""
    if address != address.lower() or "1" not in address:
        return None
    hrp, _, data = address.rpartition("1")
    expected = SHIELDED_HRPS.get(network, {}).get(hrp)
    if expected is None or len(data) < 6:
        return None
    try:
        values = [_CHARSET.index(c) for c in data]
    except ValueError:
        return None
    if _polymod(_hrp_expand(hrp) + values) != expected:
        return None
    return "unified" if expected == _BECH32M_CONST else "sapling"
