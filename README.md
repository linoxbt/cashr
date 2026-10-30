<div align="center">

# cashr

### RSVPs without a guest list

**A refundable deposit in shielded ZEC stops no-shows — and nobody, not even the organiser, ever holds a list of who came.**

[![License: MIT](https://img.shields.io/badge/License-MIT-F4B728.svg)](LICENSE)
[![CI](https://github.com/linoxbt/cashr/actions/workflows/ci.yml/badge.svg)](https://github.com/linoxbt/cashr/actions/workflows/ci.yml)
[![Zcash](https://img.shields.io/badge/Zcash-mainnet%20%7C%20testnet-F4B728.svg)](https://z.cash)
[![Built for Zecathon](https://img.shields.io/badge/Zecathon-Shielded%20Payments-635BFF.svg)](https://thezecathon.com/)

[**Live app**](https://cashr.site) · [**Try the demo**](https://demo.cashr.site) · [**How it works**](https://cashr.site/docs) · [**Threat model**](https://cashr.site/privacy)

</div>

---

## The problem

Support groups, union organisers, journalists and activists all need RSVPs — no-shows wreck capacity and planning.
But every RSVP tool produces the same by-product: **a list of names, emails or wallet addresses.** A breach, a
subpoena, or a single seized laptop turns that list into a target list for the exact people it was meant to protect.

cashr removes the list entirely. The commitment that normally comes from putting your name down comes instead from a
small, **refundable deposit in shielded ZEC**. You get it back when you show up. The server never learns, stores, or
can reconstruct who RSVPed or who attended.

## How it works

```
                 ┌─────────────────────────────────────────────────────────────┐
                 │  Attendee's phone makes a random ticket secret.               │
   RSVP          │  Only SHA-256(secret) + a one-time refund address are sent,   │
                 │  inside the encrypted memo of a shielded deposit.             │
                 └─────────────────────────────────────────────────────────────┘
                                            │
   Door          Scan the ticket QR  →  hash it locally  →  look up the hash.
                 Records yes / no. Never a name, never a time. Works offline.
                                            │
   Settle        Everyone who checked in is refunded to their own address, one
                 private transaction at a time. No-show deposits go to the group's fund.
                                            │
   Purge         One click deletes every ticket hash, refund address and payment
                 row, wipes the event's title/date/place, and destroys its wallet
                 keys — so its memos can never be decrypted again. Only totals remain.
```

1. **A secret made on the attendee's phone.** Only its SHA-256 hash is ever sent to the server.
2. **A shielded deposit.** The hash and a one-time refund address ride in the payment's encrypted memo. Nobody can
   see who paid, how much, or to whom.
3. **A QR check-in at the door.** The door hashes the scanned secret and looks it up. It records a yes/no, not a time,
   and keeps working with no connection.
4. **An automatic refund** to everyone who came, at an address only they know. No-show deposits sweep to the group's
   fund.
5. **A purge.** After settling, one click deletes the event's ticket hashes and refund addresses and destroys its
   wallet keys. The title, date and place go too. Only aggregate totals remain.

The organiser's dashboard includes a **"What a seizure reveals"** tab that shows every record the server holds for an
event. There is nothing in it that names anyone.

## Try it

| | Link | Chain |
|---|---|---|
| **Live app** | [cashr.site](https://cashr.site) | Zcash **mainnet**. Pay real shielded ZEC from [ZODL](https://electriccoin.co/zashi/) or any wallet that pays ZIP 321 links with memos. |
| **Testnet** | [testnet.cashr.site](https://testnet.cashr.site) | The real Zcash **testnet**, with free coins from the [faucet](https://testnet.zecfaucet.com). Same code as mainnet; the public list and refunds run on minutes, not hours. Needs a testnet-capable wallet (e.g. Zingo, YWallet). |
| **Demo, no ZEC** | [demo.cashr.site](https://demo.cashr.site) | A **simulated** chain. The RSVP page offers *Simulate this payment*, so the entire flow works with no wallet and no coins. |

All three run **the same code**. The only thing mocked anywhere is the simulated chain behind the demo site: a Zcash
stand-in that mines a block every few seconds and persists its state across restarts. The mainnet and testnet wallets
are real [librustzcash](https://github.com/zcash/librustzcash) light clients that reach lightwalletd over Tor.

> **A two-minute tour:** create an event (keep the two private links), open the invite link in another browser, RSVP
> with a fresh refund address and pay, then open the door link and scan or paste the ticket. End the event from the
> dashboard to refund everyone who came, then purge it.

## Architecture

```
  ┌──────────────┐   HTTPS    ┌──────────────┐  JSON-RPC   ┌───────────────┐  gRPC/TLS over Tor  ┌──────────────┐
  │     web      │ ─────────► │     api      │ ──────────► │ cashr-wallet  │ ──────────────────► │ lightwalletd │ ──► Zcash
  │   Next.js    │            │   FastAPI    │             │ Rust light    │   fresh circuit     │  (zec.rocks) │
  │  (Netlify)   │            │ SQLAlchemy   │             │ client        │   per fetch         └──────────────┘
  └──────────────┘            └──────────────┘             └───────────────┘
```

| Layer | What it is | Highlights |
|---|---|---|
| **`wallet/`** | `cashr-wallet` — a Rust light-client Zcash wallet built on `zcash_client_backend` / `zcash_client_sqlite`. Serves a zcashd-style JSON-RPC subset. | One account per event from its **own encrypted seed**; memo decryption; **Orchard-only** refunds in the Ironwood pool; **idempotent** sends that survive restarts; reaches lightwalletd over **Tor**, one fresh circuit per fetch. |
| **`api/`** | A FastAPI service (Python 3.11+, SQLAlchemy 2). | Deposit scanner, RSVP rules, settlement, door API, purge. All state changes serialize through `Engine.lock`. The chain lives behind `chain/base.py`: `rpc.py` (real wallet) and `sim.py` (tests / local dev). |
| **`web/`** | A Next.js 15 (App Router, Tailwind) app. | Landing, create-event, RSVP, ticket, offline door scanner, organiser dashboard. Protocol code in `src/lib/codec.ts` stays byte-identical with `api/cashr/codec.py`. |

The wallet is a light client, so **no full node is required** — it syncs compact blocks from a public lightwalletd
server and fetches only the transactions it needs to read memos. For zero third parties, point
`CASHR_WALLET_LIGHTWALLETD` at your own Zebra + lightwalletd / Zaino.

## The protocol, in brief

Implemented identically in `api/cashr/codec.py` and `web/src/lib/codec.ts`, with a shared test vector set. Full
detail in [docs/PROTOCOL.md](docs/PROTOCOL.md).

**RSVP memo** (ASCII, ≤ 512 bytes, zero-padded on chain):

```
CSH1 <event_id> <ticket_hash> <refund_address>
```

**Payment request** (ZIP 321): `zcash:<event_address>?amount=<deposit>&memo=<base64url(memo)>`
**Ticket QR**: `cashr:<event_id>:<secret>`

| Thing | Format |
|---|---|
| Event id | 10 chars, `[a-z0-9]` |
| Ticket secret | 32 random bytes (`crypto.getRandomValues`), base64url, no padding |
| Ticket hash | `base64url(SHA-256(secret))`, no padding |
| Organiser / door token | 32 random bytes, base64url. The server stores **only** `SHA-256(token)` |

Refund addresses must be a **Unified Address with an Orchard receiver** (`u1…`); both the browser and the API fully
decode them (bech32m → F4Jumble⁻¹ → ZIP 316 receiver list) before any money moves. Since NU6.3, value sent to an
Orchard receiver settles in the new **Ironwood** shielded pool, which the wallet spends and sweeps.

## Privacy model

cashr is designed so that compromising the server reveals **no identities and no timings**. The invariants the code
holds (see [docs/PROTOCOL.md](docs/PROTOCOL.md) and the live [threat model](https://cashr.site/privacy)):

- **No identities stored.** No names, emails, IPs, check-in timestamps or ticket secrets — and the API runs with
  `--no-access-log`.
- **Attendees never identify their ticket.** Confirmation polling downloads the *whole* hash list and matches
  locally, at one jittered pace whatever the ticket's state, so request timing leaks nothing.
- **Tokens never hit the wire as query/body.** Admin and door tokens live only in URL fragments and
  `Authorization: Bearer` headers.
- **Uniform payments.** Every RSVP pays exactly the deposit; a refund address is never reused within an event; event
  addresses are Orchard-only.
- **No timing side channels.** The public list changes only on its own random schedule (never triggered by a
  payment); refunds go out one per transaction at random times with the `FullPrivacy` policy; the wallet fetches and
  broadcasts over fresh Tor circuits.
- **Purge is total.** It deletes RSVP, deposit and payout rows, the event's wallet account and seed, and anything that
  names or dates the event.

**Trust model.** The server's wallet custodies deposits between payment and settlement, so attendees trust its
operator not to keep them — keep deposits small. Anyone can run their own server with one command (below).

## Quick start

### Run the demo locally (no ZEC, simulated chain)

```bash
# API on a simulated chain
cd api && uv venv && uv pip install -e '.[dev]'
CASHR_CHAIN=sim .venv/bin/uvicorn cashr.main:app --port 8000 --no-access-log

# Web, in another shell
cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Every page shows a banner, and the RSVP page offers **"Simulate this payment"**, so the whole lifecycle works with no
wallet.

### Deploy against Zcash mainnet (real wallet, real ZEC)

On a fresh Ubuntu 22.04/24.04 server (≥ 2 GB RAM) as root:

```bash
curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- api.example.com
```

`deploy/install.sh` installs Docker, generates every secret into `/opt/cashr/.env` (mode 600), opens only
SSH/HTTP/HTTPS, starts the wallet + API + Caddy (Let's Encrypt, logs nothing about visitors), sets up nightly
encrypted backups, and waits until `https://<domain>/meta` answers. Prebuilt images are pulled from
[`ghcr.io/linoxbt/cashr-wallet`](https://github.com/linoxbt/cashr/pkgs/container/cashr-wallet) and
[`ghcr.io/linoxbt/cashr-api`](https://github.com/linoxbt/cashr/pkgs/container/cashr-api).

By hand:

```bash
cp .env.example .env            # fill in the secrets — openssl rand -hex 32
docker compose up -d --build    # tor + wallet + api  (add profiles: --profile https / demo / testnet)
cd web && npm install && NEXT_PUBLIC_API_URL=https://api.example.com npm run build
```

Full options — Netlify for the web layer, demo/testnet profiles, running your own lightwalletd — are in
[docs/DEPLOY.md](docs/DEPLOY.md).

## Configuration

Set in `.env` (see [`.env.example`](.env.example)). Key variables:

| Variable | Purpose |
|---|---|
| `CASHR_NETWORK` | `main` or `test`. |
| `CASHR_CHAIN` | `rpc` (real wallet) or `sim` (simulated, for tests and local dev). |
| `CASHR_WALLET_SEED_KEY` | Encrypts every event's seed at rest. Back it up separately from the wallet volume. |
| `CASHR_WALLET_RPC_PASSWORD` | Auth between the API and the wallet. |
| `CASHR_WALLET_LIGHTWALLETD` | lightwalletd endpoint (default `zec.rocks:443`). Point at your own for zero third parties. |
| `CASHR_WALLET_SOCKS_PROXY` | Tor proxy for wallet traffic (default `tor:9050`). Empty = direct. |
| `CASHR_CORS_ORIGINS` | Allowed web origin(s). |
| `CASHR_LIST_DELAY_MIN` · `CASHR_REFUND_SPREAD_MIN` · `CASHR_DOOR_SYNC_GRACE_MIN` | Privacy timing: public-list cadence, refund spread, offline-door grace. |
| `CASHR_BACKUP_PASSPHRASE` · `CASHR_BACKUP_REMOTE` | Nightly encrypted backups (`deploy/backup.sh`). |

## API surface

A small, deliberately minimal HTTP API (`api/cashr/app.py`). Attendees **never POST** — they only ever read.

| Method | Path | Who |
|---|---|---|
| `GET` | `/health`, `/meta` | Anyone — liveness and chain parameters |
| `POST` | `/events` | Organiser — create an event, receive its three links once |
| `GET` | `/events/{id}` | Anyone — public counts (`rsvp_count`, `seats_left`, `full`) |
| `GET` | `/events/{id}/tickets` | Attendee — the full hash list, matched locally |
| `GET` | `/events/{id}/admin` | Organiser — live dashboard state (token) |
| `POST` | `/events/{id}/admin/{action}` | Organiser — `close` / `reopen` / `settle` / `retry` / `purge` (token) |
| `POST` | `/events/{id}/admin/fund` | Organiser — set the no-show fund address (token) |
| `GET` | `/events/{id}/door/manifest` | Door — cached hash list for offline use (token) |
| `POST` | `/events/{id}/door/checkin`, `/door/sync` | Door — check in / upload offline queue (token) |
| `POST` | `/sim/pay`, `/sim/mine`, `GET /sim/address` | Demo only — drive the simulated chain |

## Event lifecycle

```
open ──▶ (closed) ──▶ settling ──▶ settled ──▶ purged
```

The door works in `open` and `closed`. Settlement refunds check-ins (one private tx each), waits the door-sync grace
for offline phones, sweeps no-show deposits to the fund, then marks the event `settled`. Purge is available only once
`settled` with at most dust remaining.

## Testing

```bash
cd wallet && cargo test            # block cache, amounts, encrypted seeds, persisted operations
cd api    && .venv/bin/pytest -q   # lifecycle, idempotent payouts, expiry, sweeps, purge, limits, RPC adapter
cd web    && npm test              # codec + address decoding parity with the API (real mainnet addresses)
cd web    && npm run build && npm run e2e   # full browser journey against a running sim API
```

CI runs all four on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and validates the production
image builds.

## Project status

The wallet, API and web app are complete and run live on mainnet, testnet and the simulated demo. The money paths
(idempotent payouts, confirmation tracking, expiry, sweeps) are covered by tests against a simulated chain that models
the mempool, confirmation policy, expiry and lost responses. Before running a real event, do one full cycle with a
small amount — see the mainnet verification checklist in [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository layout

```
wallet/   cashr-wallet (Rust, librustzcash): light-client Zcash wallet, JSON-RPC, encrypted per-event seeds
api/      FastAPI service: deposit scanner, RSVP rules, settlement, door API, purge
web/      Next.js app: landing, create event, RSVP, ticket, door scanner, dashboard
docs/     SPEC.md · PROTOCOL.md · DEPLOY.md
deploy/   install.sh (one-command VPS), Caddyfile, Tor service, nightly backups
```

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — product spec, pages, lifecycle, non-goals, known limits
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — memo format, hashing, server rules, settlement, purge, privacy patterns
- [docs/DEPLOY.md](docs/DEPLOY.md) — architecture, one-command deploy, mainnet verification
- [CLAUDE.md](CLAUDE.md) — notes for contributors (the privacy invariants that must not break)

## License

[MIT](LICENSE) © cashr contributors. Built for the [Zecathon](https://thezecathon.com/) Zcash privacy hackathon
(Shielded Payments track).
