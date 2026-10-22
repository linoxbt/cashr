"""Unified Address decoding (ZIP 316): bech32m → F4Jumble⁻¹ → receivers.

cashr refunds are sent Orchard-to-Orchard so nothing about them is visible
on chain. A refund address is therefore only usable if it contains an Orchard
receiver, and this module is how the server checks that without asking a
wallet.
"""

from __future__ import annotations

import hashlib

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32M_CONST = 0x2BC830A3

RECEIVER_NAMES = {0x00: "p2pkh", 0x01: "p2sh", 0x02: "sapling", 0x03: "orchard"}


class UAError(ValueError):
    pass


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


def _convert_5_to_8(data: list[int]) -> bytes:
    acc = bits = 0
    out = bytearray()
    for v in data:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if bits >= 5 or (acc & ((1 << bits) - 1)):
        raise UAError("non-zero padding")
    return bytes(out)


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def _h(i: int, u: bytes, length: int) -> bytes:
    return hashlib.blake2b(u, digest_size=length, person=b"UA_F4Jumble_H" + bytes([i, 0, 0])).digest()


def _g(i: int, u: bytes, length: int) -> bytes:
    out = b""
    j = 0
    while len(out) < length:
        out += hashlib.blake2b(u, digest_size=64, person=b"UA_F4Jumble_G" + bytes([i]) + j.to_bytes(2, "little")).digest()
        j += 1
    return out[:length]


def f4jumble_inv(m: bytes) -> bytes:
    if not 48 <= len(m) <= 4194368:
        raise UAError("bad length")
    l_l = min(64, len(m) // 2)
    l_r = len(m) - l_l
    c, d = m[:l_l], m[l_l:]
    y = _xor(c, _h(1, d, l_l))
    x = _xor(d, _g(1, y, l_r))
    a = _xor(y, _h(0, x, l_l))
    b = _xor(x, _g(0, a, l_r))
    return a + b


def f4jumble(m: bytes) -> bytes:
    l_l = min(64, len(m) // 2)
    l_r = len(m) - l_l
    a, b = m[:l_l], m[l_l:]
    x = _xor(b, _g(0, a, l_r))
    y = _xor(a, _h(0, x, l_l))
    d = _xor(x, _g(1, y, l_r))
    c = _xor(y, _h(1, d, l_l))
    return c + d


def _compact_size(buf: bytes, pos: int) -> tuple[int, int]:
    if pos >= len(buf):
        raise UAError("truncated")
    first = buf[pos]
    if first < 0xFD:
        return first, pos + 1
    width = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    if pos + 1 + width > len(buf):
        raise UAError("truncated")
    return int.from_bytes(buf[pos + 1:pos + 1 + width], "little"), pos + 1 + width


def decode_unified(address: str, expected_hrp: str) -> dict[str, bytes]:
    """Return {receiver name: raw bytes} for a valid UA, or raise UAError."""
    if address != address.lower():
        raise UAError("mixed case")
    hrp, sep, data = address.rpartition("1")
    if not sep or hrp != expected_hrp:
        raise UAError("wrong network")
    try:
        values = [_CHARSET.index(c) for c in data]
    except ValueError as e:
        raise UAError("bad character") from e
    if len(values) < 6 or _polymod(_hrp_expand(hrp) + values) != _BECH32M_CONST:
        raise UAError("bad checksum")
    raw = f4jumble_inv(_convert_5_to_8(values[:-6]))
    padding = hrp.encode().ljust(16, b"\x00")
    if raw[-16:] != padding:
        raise UAError("bad padding")
    body, pos = raw[:-16], 0
    receivers: dict[str, bytes] = {}
    last = -1
    while pos < len(body):
        typecode, pos = _compact_size(body, pos)
        length, pos = _compact_size(body, pos)
        if typecode <= last:
            raise UAError("receivers out of order")
        last = typecode
        if pos + length > len(body):
            raise UAError("truncated receiver")
        receivers[RECEIVER_NAMES.get(typecode, f"type{typecode}")] = body[pos:pos + length]
        pos += length
    if not any(k in receivers for k in ("sapling", "orchard")):
        raise UAError("no shielded receiver")
    return receivers


def has_orchard_receiver(address: str, network: str) -> bool:
    try:
        return "orchard" in decode_unified(address, "u" if network == "main" else "utest")
    except UAError:
        return False


def _bech32m_encode(hrp: str, data5: list[int]) -> str:
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
    return _bech32m_encode(hrp, _to_5bit(f4jumble(body + hrp.encode().ljust(16, b"\x00"))))


def orchard_only(address: str, network: str) -> str:
    """The same address with only its Orchard receiver.

    Some wallets put a transparent receiver in their Unified Address. Refunds only
    ever use the Orchard one, so nothing else is kept: a stored t-address could
    link an attendee to their transparent history. Raises UAError without one.
    """
    receivers = decode_unified(address.strip(), "u" if network == "main" else "utest")
    if "orchard" not in receivers:
        raise UAError("no Orchard receiver")
    return unified_address(network, {0x03: receivers["orchard"]})
