"""UA decoding against real mainnet addresses produced by librustzcash (cashr-wallet)."""

import pytest

from cashr.chain.sim import random_unified_address
from cashr.codec import is_orchard_address
from cashr.ua import UAError, decode_unified, f4jumble, f4jumble_inv

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


# The same vector web/src/lib/codec.test.ts checks: an Orchard receiver (bytes
# 0..42) and an unknown receiver whose typecode and length need multi-byte
# CompactSizes.
MULTIBYTE_UA = "u1rexdud0f8y83nem3s7shlu2edrrwhjz79r5t8mmxgf582lhlg8ss89qera4wxq6pv7s60254sleueepr9eh6ggyjlrswy4tkufw3ewp3ahsmw907u3qapjtntp522ga06jddxkc9t6gs777z2s649dwn2yq5vz8phqxdgmjs5ad36snsdurw0zeumypemrnny99td58vj29ujr4p078mgjwypczx39kt430h9d6x7hvwjjkqssh7tlu2g2ura2xu4jls0lehhhmr3x4p2t9xthvvfsjrxj8dnyhhtr63eu7qafgptwzx726tggmvmd7sa23q20yhamj36zclch8nnnjacrqm34jkwvkfsgclundfn5cgu3y260hezpvrpk522cd8489crwfcs8sa52m89rnn586stng5dm46sfg4fjevjp267quptsukg2dvdhnlw2vw8m33qq567pwu5d7q0wr3aajcnhadur7gq9vjkxymt8wvlkthrap0yxvlqy33mnmx9cg3vrekku6hzd3lm2vyggp5lg7pljh4jpwk6wksx6f3rxl6cv5xjxpzs6lntm7qfrggujmk2ccp65g3f"


def test_multibyte_compact_sizes():
    assert decode_unified(MULTIBYTE_UA, "u")["orchard"] == bytes(range(43))


# The same vector as web/src/lib/codec.test.ts: transparent (bytes 0..19), Sapling
# (0..42) and Orchard (50..92) receivers, and its Orchard-only form.
UA_WITH_TRANSPARENT = "u1883eq6gafdkmysp0haxfzeqz3fgpjn5sxleva0rs56s04uyz5r6zth60s04lscad0a9pwafma6jm3pa4fqlxva279gcw5efkdsdkhru5jgza34vuknm9dlrhp6sfn9a5zluxawa4jwpk3jvxfkxrt5pnzrfjvxqvpughaljh8z9tqtkr9kqae7vuvghyu3lywfxvzxffv9ts2qzw85l"
UA_ORCHARD_ONLY = "u1rdgxj9gscehn48q8qzsff2t8wszlasc0ldqgzkns6ctqhwd4ea6nsfjr000ggtr3c0em2pz9jankcrv9luusr0t69hgnctswxcplaffy"


def test_orchard_only_keeps_just_the_orchard_receiver():
    from cashr.ua import orchard_only

    assert orchard_only(UA_WITH_TRANSPARENT, "main") == UA_ORCHARD_ONLY
    assert decode_unified(UA_ORCHARD_ONLY, "u") == {"orchard": bytes(range(50, 93))}
