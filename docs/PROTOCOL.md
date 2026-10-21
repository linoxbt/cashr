# Unlisted protocol

Implemented in `api/unlisted/codec.py` and `web/src/lib/codec.ts`. Both sides must stay byte-identical; the test
suites share test values.

## Identifiers

| Thing | Format |
|---|---|
| Event id | 10 chars, `[a-z0-9]` |
| Ticket secret | 32 random bytes from `crypto.getRandomValues`, base64url without padding (43 chars) |
| Ticket hash | `base64url(SHA-256(secret))`, no padding (43 chars) |
| Organiser / door token | 32 random bytes, base64url. Server stores `SHA-256(token)` only |

## RSVP memo

ASCII, single spaces, ≤ 512 bytes (on chain it is zero-padded to 512):

```
UNL1 <event_id> <ticket_hash> <refund_address>
```

`refund_address` must be a shielded address for the server's network: a Unified Address (`u1…`, bech32m) or Sapling
(`zs1…`, bech32). Both client and server check the HRP and checksum. The wallet does the final check when it refunds.

## Payment request (ZIP 321)

```
zcash:<event_address>?amount=<deposit in ZEC>&memo=<base64url(memo)>
```

Event addresses are Orchard-only Unified Addresses, one wallet account per event.

## Ticket QR

```
unlisted:<event_id>:<secret>
```

The door hashes `secret` locally and only ever sends the hash.

## Server rules for an incoming note

A note is processed once it has `UNLISTED_MIN_CONF` confirmations, in `(height, txid, index)` order:

1. **No `UNL1` memo:** treated as an organiser fee top-up ("float").
2. **Refund address not shielded / malformed:** kept as float, since there is nowhere private to return it.
3. **Otherwise rejected, and returned minus `UNLISTED_REJECT_FEE_ZAT`, if any of:** wrong event id, RSVPs closed,
   amount ≠ deposit, duplicate ticket hash, refund address used before (checked against an HMAC-SHA256 digest under
   `UNLISTED_SECRET`), or event full. A return that would be ≤ 0 is kept as float.
4. **Otherwise accepted:** seat = next number, digest of the refund address recorded.

## Settlement

* Checked-in RSVPs are refunded the full deposit in batched `z_sendmany` calls (`UNLISTED_REFUND_BATCH` recipients
  each) with the `FullPrivacy` policy. Fees come from forfeits and float. If the balance is short, payouts wait,
  queued, until the organiser tops up.
* RSVPs that were not checked in are forfeited.
* If a no-show fund address is set, once every refund is done the remaining balance minus a ZIP 317 fee reserve is
  swept there.
* Event becomes `settled`. **Purge** then deletes all RSVP, deposit and payout rows, plus location and details.
  Aggregate counts stay.

## Privacy-relevant request patterns

* Attendees never POST anything. Confirmation polling fetches `GET /events/{id}/tickets` (every hash) and matches
  locally.
* Admin/door tokens live in the URL fragment, which browsers never send. The client moves them to `sessionStorage`,
  strips them from the address bar, and sends them as `Authorization: Bearer`.
* The API runs with `--no-access-log` and keeps no IP addresses.
