# Deploying cashr

```
[ web: Next.js (Netlify) ] --HTTPS--> [ api: FastAPI ] --JSON-RPC--> [ wallet: cashr-wallet ] --Tor--gRPC/TLS--> [ lightwalletd (zec.rocks) ] --> Zcash mainnet
```

The wallet is a light client, so **no full node is needed**. It syncs compact blocks from a public lightwalletd
server, then fetches the full transactions it needs to read memos. Those fetches tell lightwalletd's operator which
transactions are RSVPs, so the wallet makes them through Tor (the bundled `tor` service), each over a fresh
circuit. For no third party at all, run your own Zebra with lightwalletd or Zaino and point `CASHR_WALLET_LIGHTWALLETD` at it.

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

## One command on a VPS (recommended)

On a fresh Ubuntu 22.04/24.04 server with at least 2 GB of memory (4 GB builds faster), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- api.example.com
```

`deploy/install.sh` installs Docker, generates every secret into `/opt/cashr/.env` (mode 600), opens only
SSH/HTTP/HTTPS in the firewall, builds and starts the wallet, the API and Caddy, and waits until
`https://<domain>/meta` answers. Caddy gets a Let's Encrypt certificate and writes no access logs. Without a domain
argument it uses `<server-ip>.sslip.io`, which needs no DNS setup. It prints the API URL to put in the web app's
`NEXT_PUBLIC_API_URL`, the backup commands, and (on first run) `CASHR_WALLET_SEED_KEY`. A backup keeps the keys and records of
any event purged after it was taken, so replace old backups once an event is purged.

Re-run the same command to update: it pulls the latest code and restarts, keeping the secrets and data volumes.

## Quick start (Docker Compose)

```bash
cp .env.example .env      # fill in CASHR_SECRET, CASHR_WALLET_RPC_PASSWORD, CASHR_WALLET_SEED_KEY, CASHR_CORS_ORIGINS
docker compose up -d --build
```

This runs three containers (add `--profile https` and set `API_DOMAIN` for a fourth, Caddy, serving HTTPS):
* `tor`: a SOCKS proxy built from Alpine's Tor package, used only by the wallet. Set `CASHR_WALLET_SOCKS_PROXY=` (empty) to
  connect directly instead.
* `wallet`: `cashr-wallet`. It is not exposed publicly. Its `wallet-data` volume holds `wallet.sqlite`,
  `ops.sqlite` and `seeds/` (one encrypted seed per live event).
* `api`: the FastAPI service on `127.0.0.1:8000`, with no access logs. The `https` profile puts Caddy in front of
  it; otherwise use your own TLS proxy.

**Back up the `wallet-data` volume, encrypted, and, separately, `CASHR_WALLET_SEED_KEY`.** Spending needs both, but the
volume alone holds every live event's viewing keys, ticket hashes and refund addresses, so never store it
unencrypted (the installer prints an `openssl enc` command). Purging an event deletes its seed on purpose, after
its money has been swept out; a backup taken before keeps it, so replace old backups after a purge.

Images are pinned to exact base-image digests, and the API and wallet images carry healthchecks.

Container logs use Docker's `local` driver capped at 1 MB per service, since logs sit outside anything a purge
deletes. Nothing logs visitors, ticket hashes, addresses or txids at the default level.

Then deploy the web app with `NEXT_PUBLIC_API_URL` set to the API's public HTTPS URL (a production build without
it shows "not connected to a server" instead of calling localhost). On Netlify, `netlify.toml` already sets the base
directory to `web/` and the Next.js runtime. Add the web origin to the API's `CASHR_CORS_ORIGINS`.

## Railway

`api/railway.json` and `wallet/railway.json` hold the build and deploy settings. Create one project with two
services from this repo:

| Service | Root directory | Volume | Variables | Networking |
|---|---|---|---|---|
| `wallet` | `/wallet` | `/data` | `RAILWAY_RUN_UID=0`, `CASHR_WALLET_SEED_KEY`, `CASHR_WALLET_RPC_USER`, `CASHR_WALLET_RPC_PASSWORD`, `CASHR_WALLET_LISTEN=[::]:8232` | private only |
| `api` | `/api` | `/data` | `RAILWAY_RUN_UID=0`, `CASHR_CHAIN=rpc`, `CASHR_NETWORK=main`, `CASHR_SECRET`, `CASHR_RPC_URL=http://wallet.railway.internal:8232`, `CASHR_RPC_USER`, `CASHR_RPC_PASSWORD`, `CASHR_CORS_ORIGINS` | public domain, port 8000 |

Railway volumes are owned by root, so `RAILWAY_RUN_UID=0` lets the containers (which otherwise run as an
unprivileged user) write to them. Keep each service at one replica (the API refuses to start a second one on the same database anyway).
Free Railway accounts can be paused during high traffic ("Deploys have been paused temporarily"); Pro accounts are
not.

## Wallet service (`wallet/`)

| Variable | Default | Meaning |
|---|---|---|
| `CASHR_WALLET_SEED_KEY` | **required** | 64 hex characters (`openssl rand -hex 32`). Encrypts each event's seed at rest |
| `CASHR_WALLET_NETWORK` | `main` | `main` or `test` |
| `CASHR_WALLET_LIGHTWALLETD` | `https://zec.rocks:443` (testnet: `https://testnet.zec.rocks:443`) | lightwalletd gRPC endpoint |
| `CASHR_WALLET_DATA_DIR` | `./wallet-data` | `wallet.sqlite`, `ops.sqlite`, `seeds/` |
| `CASHR_WALLET_LISTEN` | `127.0.0.1:8232` | JSON-RPC listen address. A non-loopback address requires a password |
| `CASHR_WALLET_RPC_USER` / `CASHR_WALLET_RPC_PASSWORD` | empty | HTTP basic auth for the RPC (checked in constant time) |
| `CASHR_WALLET_SYNC_INTERVAL` | `10` | Seconds between syncs |
| `CASHR_WALLET_EXTRA_CA_FILE` | none | Extra PEM CA to trust, for networks that re-sign TLS |
| `CASHR_WALLET_SOCKS_PROXY` | none (compose: `tor:9050`) | SOCKS5 proxy, normally Tor, for lightwalletd. Each connection gets its own circuit |

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
| `CASHR_CHAIN` | yes | `rpc`. (`sim` is for tests and local dev only.) There is no default |
| `CASHR_NETWORK` | yes | `main` or `test`. Must match the wallet |
| `CASHR_SECRET` | yes | Long random string. Keys the refund-address reuse check. Never change it once set |
| `CASHR_ADDRESS_MEMORY_DAYS` | no | Used refund addresses are refused for one to two periods of this many days (default 365), then forgotten |
| `CASHR_RPC_URL` / `_USER` / `_PASSWORD` | yes | The wallet's RPC |
| `CASHR_DATABASE_URL` | no | Defaults to SQLite in `/data` in the image. `postgresql+psycopg://…` also works |
| `CASHR_CORS_ORIGINS` | yes | Your web origin |
| `CASHR_MIN_CONF` | no | Confirmations before an RSVP counts (default 1) |
| `CASHR_PAYOUT_CONF` | no | Confirmations before a refund or sweep counts as paid (default 3) |
| `CASHR_CREATE_PER_HOUR` / `CASHR_MAX_LIVE_EVENTS` | no | Event creation limits (default 60 / 500) |
| `CASHR_DUST_ZAT` | no | Below this, leftover value is not worth a sweep fee (default 20000) |

Run exactly **one** API process (one worker, one replica). It takes an exclusive lock on its database at startup
(a file lock for SQLite, an advisory lock for Postgres) and refuses to start if another process holds it.

**Modal** (optional): `api/modal_app.py` pins one always-warm container. The wallet still needs a persistent host
for its data volume.
