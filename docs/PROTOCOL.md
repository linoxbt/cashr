# cashr protocol

Implemented in `api/cashr/codec.py` and `web/src/lib/codec.ts`. Both sides must stay byte-identical; the test
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
CSH1 <event_id> <ticket_hash> <refund_address>
```

`refund_address` must be a **Unified Address containing an Orchard receiver** (`u1…` on mainnet). Refunds are
Orchard-to-Orchard, so nothing about them (amount, recipient) is revealed on chain. The browser and the API both
fully decode the address (bech32m → F4Jumble⁻¹ → receiver list, ZIP 316) to check it before any money moves.
Implementations: `web/src/lib/ua.ts`, `api/cashr/ua.py`. Both are tested against real addresses from librustzcash.

## Payment request (ZIP 321)

```
zcash:<event_address>?amount=<deposit in ZEC>&memo=<base64url(memo)>
```

Event addresses are Orchard-only Unified Addresses, one wallet account per event.

## Ticket QR

```
cashr:<event_id>:<secret>
```

The door hashes `secret` locally and only ever sends the hash.

## Server rules for an incoming note

A note is processed once it has `CASHR_MIN_CONF` confirmations, in `(height, txid, index)` order:

1. **No `CSH1` memo:** treated as an organiser fee top-up ("float", reason `no_memo`).
2. **Refund address without an Orchard receiver:** kept as float (reason `bad_refund_address`), since there is
   nowhere private to return it. It is listed with the returned payments so the attendee and organiser can see it.
   The RSVP page prevents this before payment.
3. **Otherwise rejected, and returned minus `CASHR_REJECT_FEE_ZAT`, if any of:** wrong event id, RSVPs closed
   (status not `open`, or past `rsvp_closes_at`; a payment mined within 2 blocks of the close height, recorded when
   the organiser closed or estimated back from the deadline, still counts), amount ≠ deposit, duplicate ticket hash, refund address used
   before (checked against an HMAC-SHA256 digest under `CASHR_SECRET`), or event full. A return that would be
   ≤ 0 is kept as float.
4. **Otherwise accepted:** a random free seat (counting up would reveal payment order), and a digest of the refund
   address recorded with its period. Digests are forgotten after one to two periods of
   `CASHR_ADDRESS_MEMORY_DAYS` (default 365), since they outlive purges.

Events expose `accepting_rsvps` (open and before the deadline); the RSVP page shows payment details only while it
is true.

## Payouts

Refunds, returns and sweeps are payouts: `queued → submitted → broadcast → done` (or `failed`, for a person).

* Each payout has a random idempotency key, sent with every wallet call. Retrying after a timeout, a lost response
  or a restart can never produce a second transaction while the first could still be mined.
* `broadcast` means a txid exists. It becomes `done` only when mined with `CASHR_PAYOUT_CONF` confirmations.
* In the wallet, every rebuild of an operation is a new attempt: only the current attempt may record a txid or an
  outcome, and a rebroadcast never changes an operation's state, so a stale step can't trigger a second build.
  A transaction counts as expired only 10 blocks past its expiry height, so a short reorg can't make a
  transaction that may still be mined look dead.
* `z_deleteaccount` refuses while the account holds value, a send is being built, or any transaction spending its
  notes could still be mined. It records each deletion first, so a retry after a timeout succeeds, while an
  account the wallet never deleted (a reset or restored database) is refused and its seed kept. The file rewrite
  that clears deleted pages is recorded as owed and finished at the next start if interrupted.
* The close height for a deadline comes from the wallet's scanned block times (`z_heightattime`), falling back to
  an estimate (75 s per block) only when the wallet has no block that old.
  A pending transaction is rebroadcast periodically; one that expires unmined is rebuilt under the same key.
* An insufficient-funds failure keeps the payout queued (deposits still confirming, or a fee top-up is needed).
  If the wallet has no record of an operation, the payout stops as `failed` rather than risk paying twice.

## Settlement

* Checked-in RSVPs are refunded the full deposit, one per transaction (`CASHR_REFUND_BATCH`, default 1), each at
  a random time within `CASHR_REFUND_SPREAD_MIN` minutes (default 180) of settling (`Payout.not_before`), with the
  `FullPrivacy` policy. A transaction paying several attendees would be fetched by each of their wallets from a
  sync server, showing its operator who came together. Each refund pays its own fee, so when nearly everyone comes
  the organiser tops up about 0.00015 ZEC per refund. Server-written memos never name the event, because they stay in the recipient's wallet
  for good: refunds say `cashr: deposit refunded.`, returns `cashr: payment returned (<reason>).`, sweeps
  `cashr: no-show deposits.` Fees come from forfeits and float. RSVPs that were not checked in are forfeited.
* When every payout is `done` and nothing in the event wallet is still confirming, the whole spendable balance minus
  the ZIP 317 fee is swept to the no-show fund address (`z_sweep`), repeating until less than `CASHR_DUST_ZAT`
  remains. Then the event is `settled`.
* Without a fund address the money stays in the event wallet. The organiser can add one at any time
  (`POST /events/{id}/admin/fund`); a settled event then goes back to `settling` and sweeps.
* **Purge** (only when `settled` and the wallet holds at most `CASHR_DUST_ZAT`) deletes the event's wallet
  account, its transactions and memos, and its seed, then all RSVP, deposit and payout rows. It also wipes the title
  (to `Purged event`), start and close times, location, details, event address and fund address: attendees' wallets
  keep the event id from their deposit memo, so nothing left may name or date the event. Aggregate counts stay.
  Payments sent to a purged event can't be returned.

## Privacy-relevant request patterns

* Attendees never POST anything. Confirmation polling fetches `GET /events/{id}/tickets` (every hash) and matches
  locally, at one jittered pace (15–25 s) whatever the ticket's state, so request timing says nothing about it.
* The public list is a snapshot, not a feed: new tickets join it in batches (`Rsvp.listed`), once
  `CASHR_LIST_BATCH` (3) are waiting, at a random time around `CASHR_LIST_DELAY_MIN` (120) minutes after the first,
  or when RSVPs close or the event settles. It is sorted by hash and holds hashes only (`{"h": …}`) while the event
  runs; at settlement every ticket's `status` appears at once. Rejections say only `returned` or `kept`.
* `GET /events/{id}` shows `rsvp_count` and `seats_left` from listed tickets, a `full` flag from the real count, and
  `checked_in_count` only once the event settles. The organiser's dashboard and the door see the real, live state.
* The ticket list page (`/tickets`) never fetches all held events together, which would link them; each is checked
  only when its holder asks.
* The door phone keeps the event's ticket hashes and check-in flags (to work offline) and its unsynced queue, and
  deletes both once the event is settled, purged or gone.
* Events that started over a day ago and never received anything are retired: their wallet account is deleted
  and their details wiped, as a purge does.
* The wallet reaches lightwalletd through Tor by default (`CASHR_WALLET_SOCKS_PROXY`), with a fresh circuit for every
  transaction it fetches, each fetched a random 1–5 minutes after the wallet first sees it. lightwalletd still sees
  which transactions are fetched, but not from where, and not in step with their broadcast. Attendees' own wallets
  are outside cashr's control; the threat model advises a wallet that connects over Tor. Txids are logged at debug only.
* Refund addresses are kept as their Orchard receiver only (`ua.orchard_only`); the browser builds the memo that way.
* Purge also wipes `created_at`, `scan_height` and `close_height`, which could date the event.
* Admin/door tokens live in the URL fragment, which browsers never send. The client moves them to `sessionStorage`,
  strips them from the address bar, and sends them as `Authorization: Bearer`.
* The API runs with `--no-access-log` and keeps no IP addresses. Hosting providers in front of it may still log them.
