"""Unified Address decoding (ZIP 316): bech32m → F4Jumble⁻¹ → receivers.

Unlisted refunds are sent Orchard-to-Orchard so nothing about them is visible
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
