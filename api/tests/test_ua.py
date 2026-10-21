"""UA decoding against real mainnet addresses produced by librustzcash (unlisted-wallet)."""

import pytest

from unlisted.chain.sim import random_unified_address
from unlisted.codec import is_orchard_address
from unlisted.ua import UAError, decode_unified, f4jumble, f4jumble_inv

ORCHARD_ONLY = "u17j7e5kk4uzh698uajv4lah3mtt2x7jyewk3ya5tjvhjzp6yc5x260svm66uveezd93htyy3u0pyg80gpttfujfvj5pvlcqhngskrvpyd"
SAPLING_ONLY = "u1r4epe0uuztny46hl3pkrdv4tqlxxu59jcvj3wtnrsljt4glvvzfrumu8d827h8vgxf7pzkjenye60k392eeegpzdx5y7r3vpaysausau"
BOTH = ("u13sza6jr067ydyrkr2s40qsyqaw59aazmjvjrnzn9sktk9tg6fpeng99rzy78pasda3wp0vf5sfhzhq2jfz6l96006r4lg4vn6jg4dckez75a5a0"
        "gukew2mnhh7vcgpakz9hzraa9xvf490uryqqku6thqltl28kh32qgah0y4uzyqt8e")
# The Orchard receiver of BOTH, re-encoded alone by the wallet's z_listunifiedreceivers.
BOTH_ORCHARD = "u1qf62h58pwerw7q5d3ga20ld2rtkj9laq88vt70dp29pc26jglj5mz88lzqj5anqweyfrxq04y2rjfv5n8g8ge590pe0dm8zxp5rtmnve"


def test_real_addresses():
    assert set(decode_unified(ORCHARD_ONLY, "u")) == {"orchard"}
    assert set(decode_unified(SAPLING_ONLY, "u")) == {"sapling"}
    both = decode_unified(BOTH, "u")
    assert set(both) == {"sapling", "orchard"}
    assert both["orchard"] == decode_unified(BOTH_ORCHARD, "u")["orchard"]


def test_orchard_requirement():
    assert is_orchard_address(ORCHARD_ONLY, "main")
    assert is_orchard_address(BOTH, "main")
    assert not is_orchard_address(SAPLING_ONLY, "main")
    assert not is_orchard_address(ORCHARD_ONLY, "test")
    assert not is_orchard_address("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "main")


def test_corruption_detected():
    flipped = ORCHARD_ONLY[:20] + ("q" if ORCHARD_ONLY[20] != "q" else "p") + ORCHARD_ONLY[21:]
    with pytest.raises(UAError):
        decode_unified(flipped, "u")


def test_f4jumble_round_trip():
    for n in (48, 77, 128, 300):
        m = bytes(range(256))[:n] if n <= 256 else bytes(i % 251 for i in range(n))
        assert f4jumble_inv(f4jumble(m)) == m


def test_sim_addresses_are_real_uas():
    assert is_orchard_address(random_unified_address(), "main")
    assert not is_orchard_address(random_unified_address(orchard=False, sapling=True), "main")
