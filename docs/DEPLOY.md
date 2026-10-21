# Deploying Unlisted

```
[ web: Next.js (Netlify) ] --HTTPS--> [ api: FastAPI ] --JSON-RPC--> [ wallet: unlisted-wallet ] --gRPC/TLS--> [ lightwalletd (zec.rocks) ] --> Zcash mainnet
```

The wallet is a light client, so **no full node is needed**. It syncs compact blocks from a public lightwalletd
server, then fetches the full transactions it needs to read memos.

## What has been verified on mainnet

Run against `https://zec.rocks:443` on Oct 21, 2026 (chain tip ≈ 3,525,754):

| Step | Result |
|---|---|
| Connect, track tip, scan new accounts to the tip | ✅ |
| Create a per-event account from its own seed (encrypted on disk), derive an Orchard-only UA | ✅ |
| API in `rpc` mode: create event, balance, settle with no RSVPs, purge (deletes the wallet account and seed) | ✅ |
| Keyed `z_sendmany`: same key returns the same operation; operations survive a wallet restart | ✅ |
| `z_sweep`, `gettransaction`, `z_deleteaccount`; RPC password enforced | ✅ |
| Receive a deposit, read its memo, prove and broadcast a refund, sweep forfeits | ⚠️ **Needs real ZEC. Not yet run.** |

The money paths (idempotent payouts, confirmations, expiry, sweep) are covered by tests against a simulated chain
that models the mempool, confirmation policy, expiry and lost responses. Before a real event, run one full cycle
with a small amount: create an event with a fund address, pay the deposit from ZODL, check in, settle, and confirm
the refund lands in ZODL and the remainder in the fund.

## Quick start (Docker Compose)

```bash
cp .env.example .env      # fill in UNLISTED_SECRET, UW_RPC_PASSWORD, UW_SEED_KEY, UNLISTED_CORS_ORIGINS
docker compose up -d --build
```

This runs two containers:
* `wallet`: `unlisted-wallet`. It is not exposed publicly. Its `wallet-data` volume holds `wallet.sqlite`,
  `ops.sqlite` and `seeds/` (one encrypted seed per live event).
* `api`: the FastAPI service on port 8000, with no access logs. Put TLS in front of it (Caddy, a load balancer, or
  your host's HTTPS).

**Back up the `wallet-data` volume and, separately, `UW_SEED_KEY`.** Together they control every live event's
deposits; neither alone is enough. Purging an event deletes its seed on purpose, after its money has been swept out.

Then deploy the web app with `NEXT_PUBLIC_API_URL` set to the API's public HTTPS URL (a production build without
it shows "not connected to a server" instead of calling localhost). On Netlify, `netlify.toml` already sets the base
directory to `web/` and the Next.js runtime. Add the web origin to the API's `UNLISTED_CORS_ORIGINS`.

## Railway

`api/railway.json` and `wallet/railway.json` hold the build and deploy settings. Create one project with two
services from this repo:

| Service | Root directory | Volume | Variables | Networking |
|---|---|---|---|---|
| `wallet` | `/wallet` | `/data` | `RAILWAY_RUN_UID=0`, `UW_SEED_KEY`, `UW_RPC_USER`, `UW_RPC_PASSWORD`, `UW_LISTEN=[::]:8232` | private only |
| `api` | `/api` | `/data` | `RAILWAY_RUN_UID=0`, `UNLISTED_CHAIN=rpc`, `UNLISTED_NETWORK=main`, `UNLISTED_SECRET`, `UNLISTED_RPC_URL=http://wallet.railway.internal:8232`, `UNLISTED_RPC_USER`, `UNLISTED_RPC_PASSWORD`, `UNLISTED_CORS_ORIGINS` | public domain, port 8000 |

Railway volumes are owned by root, so `RAILWAY_RUN_UID=0` lets the containers (which otherwise run as an
unprivileged user) write to them. Keep each service at one replica (the API refuses to start a second one on the same database anyway).
Free Railway accounts can be paused during high traffic ("Deploys have been paused temporarily"); Pro accounts are
not.

## Wallet service (`wallet/`)

| Variable | Default | Meaning |
|---|---|---|
| `UW_SEED_KEY` | **required** | 64 hex characters (`openssl rand -hex 32`). Encrypts each event's seed at rest |
| `UW_NETWORK` | `main` | `main` or `test` |
| `UW_LIGHTWALLETD` | `https://zec.rocks:443` (testnet: `https://testnet.zec.rocks:443`) | lightwalletd gRPC endpoint |
| `UW_DATA_DIR` | `./wallet-data` | `wallet.sqlite`, `ops.sqlite`, `seeds/` |
| `UW_LISTEN` | `127.0.0.1:8232` | JSON-RPC listen address. A non-loopback address requires a password |
| `UW_RPC_USER` / `UW_RPC_PASSWORD` | empty | HTTP basic auth for the RPC (checked in constant time) |
| `UW_SYNC_INTERVAL` | `10` | Seconds between syncs |
| `UW_EXTRA_CA_FILE` | none | Extra PEM CA to trust, for networks that re-sign TLS |

RPC methods: `getblockcount`, `getwalletinfo`, `z_getnewaccount`, `z_getaddressforaccount`,
`z_listreceivedbyaddress` (address, minconf, since-height), `z_getbalanceforaccount` (spendable and pending),
`z_sendmany` (6th parameter: idempotency key; `FullPrivacy` sends only to Orchard receivers), `z_sweep`,
`z_getoperationstatus`, `gettransaction` (mined / pending / expired), `z_deleteaccount`, `z_listunifiedreceivers`.
Names follow zcashd where one exists, but the API depends on the extensions, so it only supports this wallet.

**Idempotent sends.** Every send carries a key. The wallet records the txid on disk *before* broadcasting, and for a
key it never builds a second transaction while the first could still be mined: a repeated call rebroadcasts a
pending transaction, leaves a mined one alone, and rebuilds only one that failed before broadcast or expired unmined.

Spending uses librustzcash's default confirmation policy (3 confirmations for the wallet's own change, 10 for
received notes). Deposits therefore become refundable about 12 minutes after they arrive; queued refunds wait.

Build without Docker: `cd wallet && cargo build --release`. The Sapling parameters are bundled into the binary,
and Orchard needs none.

## API (`api/`)

| Variable | Required | Meaning |
|---|---|---|
| `UNLISTED_CHAIN` | yes | `rpc`. (`sim` is for tests and local dev only.) There is no default |
| `UNLISTED_NETWORK` | yes | `main` or `test`. Must match the wallet |
| `UNLISTED_SECRET` | yes | Long random string. Keys the refund-address reuse check. Never change it once set |
| `UNLISTED_RPC_URL` / `_USER` / `_PASSWORD` | yes | The wallet's RPC |
| `UNLISTED_DATABASE_URL` | no | Defaults to SQLite in `/data` in the image. `postgresql+psycopg://…` also works |
| `UNLISTED_CORS_ORIGINS` | yes | Your web origin |
| `UNLISTED_MIN_CONF` | no | Confirmations before an RSVP counts (default 1) |
| `UNLISTED_PAYOUT_CONF` | no | Confirmations before a refund or sweep counts as paid (default 3) |
| `UNLISTED_CREATE_PER_HOUR` / `UNLISTED_MAX_LIVE_EVENTS` | no | Event creation limits (default 60 / 500) |
| `UNLISTED_DUST_ZAT` | no | Below this, leftover value is not worth a sweep fee (default 20000) |

Run exactly **one** API process (one worker, one replica). It takes an exclusive lock on its database at startup
(a file lock for SQLite, an advisory lock for Postgres) and refuses to start if another process holds it.

**Modal** (optional): `api/modal_app.py` pins one always-warm container. The wallet still needs a persistent host
for its data volume.
