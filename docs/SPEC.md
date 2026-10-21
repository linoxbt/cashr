# Unlisted: product spec (as built)

## 1. Problem
Groups whose attendee list endangers people (support groups, organisers, journalists, activists) still need RSVPs
to manage capacity and no-shows. Every existing tool produces a list of identities.

## 2. Promise
A refundable deposit in shielded ZEC replaces identity as the commitment device. The server never learns, stores or
can reconstruct who RSVPed or who came.

## 3. Users and pages
| Who | Page | Does |
|---|---|---|
| Anyone | `/`, `/how-it-works`, `/privacy` | Understand the product and its threat model |
| Organiser | `/new` | Create an event; receive public, manage and door links once |
| Attendee | `/e/[id]` | Paste a fresh refund address → pay via ZIP 321 QR → hold a ticket QR → see check-in / refund status |
| Door volunteer | `/door/[id]#k=` | Scan tickets (camera or paste), works offline with a cached hash list and sync queue |
| Organiser | `/manage/[id]#k=` | Live counts, tickets, money, payouts; close/reopen, end & refund, retry, purge; "What a seizure reveals" |

## 4. Event lifecycle
`open` → (`closed`) → `settling` → `settled` → `purged`. The door works in `open` and `closed`.

## 5. Rules
See [PROTOCOL.md](PROTOCOL.md): memo format, ticket hashing, rejection reasons, settlement and purge.

## 6. Non-goals
Accounts, emails, notifications, ticket transfer, paid (non-refundable) tickets, and fiat on-ramps.

## 7. Known limits
* Custodial during the event: the server wallet holds deposits until settlement.
* Attendees need shielded ZEC and a wallet that pays ZIP 321 links with memos (e.g. ZODL).
* Page loads reveal IPs to the web host. The API keeps no logs; Tor is recommended for high-risk use.
