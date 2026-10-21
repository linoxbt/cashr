import pytest

from unlisted.chain.sim import random_unified_address
from unlisted.codec import (
    _CHARSET,
    _hrp_expand,
    _polymod,
    MemoError,
    RsvpMemo,
    address_kind,
    decode_memo,
    encode_memo,
    zat_to_zec_str,
    zip321_uri,
)

TRANSPARENT = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"


def bech32_encode(hrp, data5):
    values = _hrp_expand(hrp) + data5
    pm = _polymod(values + [0] * 6) ^ 1
    return hrp + "1" + "".join(_CHARSET[d] for d in data5 + [(pm >> 5 * (5 - i)) & 31 for i in range(6)])


def test_checksum_matches_bip173_vector():
    hrp, _, data = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".rpartition("1")
    assert _polymod(_hrp_expand(hrp) + [_CHARSET.index(c) for c in data]) == 1


def test_memo_round_trip_and_padding():
    m = RsvpMemo("abcde12345", "A" * 43, random_unified_address())
    raw = encode_memo(m)
    assert len(raw) <= 512
    assert decode_memo(raw.ljust(512, b"\x00")) == m


@pytest.mark.parametrize("raw", [b"", b"hello", b"UNL1 short", b"UNL2 abcde12345 " + b"A" * 43 + b" u1x",
                                 b"UNL1 ABCDE12345 " + b"A" * 43 + b" u1x"])
def test_memo_rejects_garbage(raw):
    with pytest.raises(MemoError):
        decode_memo(raw)


def test_address_kinds():
    assert address_kind(random_unified_address("main"), "main") == "unified"
    assert address_kind(random_unified_address("test"), "main") is None
    assert address_kind(bech32_encode("zs", [7] * 69), "main") == "sapling"
    assert address_kind(TRANSPARENT, "main") is None
    ua = random_unified_address("main")
    flipped = ua[:-1] + ("q" if ua[-1] != "q" else "p")
    assert address_kind(flipped, "main") is None
    assert address_kind(ua.upper(), "main") is None


def test_zip321():
    assert zat_to_zec_str(500_000) == "0.005"
    assert zat_to_zec_str(100_000_000) == "1"
    uri = zip321_uri("u1abc", 500_000, b"hi")
    assert uri == "zcash:u1abc?amount=0.005&memo=aGk"
