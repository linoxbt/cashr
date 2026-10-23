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
SSH/HTTP/HTTPS in the firewall, starts the wallet, the API and Caddy, sets up the nightly backup, and waits until
`https://<domain>/meta` answers. Caddy gets a Let's Encrypt certificate and logs nothing about visitors. Without a
domain argument it uses `<server-ip>.sslip.io`, which needs no DNS setup. It prints the API URL to put in the web
app's `NEXT_PUBLIC_API_URL`. It never prints a secret: read `CASHR_WALLET_SEED_KEY` and `CASHR_BACKUP_PASSPHRASE`
from `.env` yourself and keep them offline.

Re-run the same command to update: it pulls the latest code and images and restarts, keeping `.env` (a web-origin
argument given again replaces `CASHR_CORS_ORIGINS`) and the data volumes. On a server whose own HTTPS proxy already
holds ports 80/443, run it with `CASHR_PROXY=none` (no Caddy, no firewall changes) and point the proxy at
`127.0.0.1:$CASHR_API_PORT`. Such a proxy must not log visitors either: in Caddy, add `log default { exclude
http.log.error }` to the global options, since Caddy's error log otherwise records the client IP and path of every
request that fails (during a restart, for example).

To update by hand instead: `git pull --ff-only && docker compose pull wallet api && docker compose up -d --no-build`
(add `demo-api` to the pull with `COMPOSE_PROFILES=demo`). Set `CASHR_TAG=<commit>` in `.env` to pin the wallet and
API images to the same commit; `main` is always the latest.

## Quick start (Docker Compose)

```bash
cp .env.example .env      # fill in CASHR_WALLET_RPC_PASSWORD, CASHR_WALLET_SEED_KEY, CASHR_BACKUP_PASSPHRASE, CASHR_CORS_ORIGINS
docker compose up -d --build
```

This runs three containers (add `--profile https` and set `API_DOMAIN` for a fourth, Caddy, serving HTTPS):
* `tor`: a SOCKS proxy built from Alpine's Tor package, used only by the wallet. Set `CASHR_WALLET_SOCKS_PROXY=` (empty) to
  connect directly instead.
* `wallet`: `cashr-wallet`. It is not exposed publicly. Its `wallet-data` volume holds `wallet.sqlite`,
  `ops.sqlite` and `seeds/` (one encrypted seed per live event).
* `api`: the FastAPI service on `127.0.0.1:8000`, with no access logs. The `https` profile puts Caddy in front of
  it; otherwise use your own TLS proxy.

The demo API (`--profile demo`, or `COMPOSE_PROFILES=demo` in `.env`) runs on its own network, so it can't reach the
wallet or Tor.

### Backups

`deploy/backup.sh` (nightly at 03:40 UTC from `/etc/cron.d/cashr-backup`, or by hand) writes an encrypted snapshot of
the `wallet-data` and `api-data` volumes to `/var/backups/cashr`, keeping the last 7. The snapshot is taken with
SQLite's online backup while the services run, built in memory, and encrypted with `CASHR_BACKUP_PASSPHRASE` before
it reaches the disk. Set `CASHR_BACKUP_REMOTE` (an rsync target, `user@host:/path`) to copy each one off the server:
a backup on the same disk doesn't survive it. Keep `CASHR_WALLET_SEED_KEY` and `CASHR_BACKUP_PASSPHRASE` offline,
apart from the backups: restoring needs the passphrase, spending needs the seed key.

A backup keeps events purged after it was taken until it rotates out (a week). Restore onto a stopped stack:

```bash
docker compose down
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in cashr-<time>.tgz.enc -pass env:CASHR_BACKUP_PASSPHRASE \
  | docker run --rm -i -v cashr_wallet-data:/w -v cashr_api-data:/a alpine:3.20 sh -c \
    'mkdir -p /r && tar xz -C /r && cp -a /r/wallet-data/. /w/ && cp -a /r/api-data/. /a/'
docker compose up -d
```

### Monitoring

`GET /health` answers 200 only while the wallet has caught up with the chain in the last 5 minutes (503 with the
age otherwise, for example when Tor or lightwalletd is down). Point an uptime monitor at
`https://<api-domain>/health` so a stalled wallet pages someone.

Images are pinned to exact base-image digests, CI labels them with their commit, and the API and wallet images
carry healthchecks.

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
| `api` | `/api` | `/data` | `RAILWAY_RUN_UID=0`, `CASHR_CHAIN=rpc`, `CASHR_NETWORK=main`, `CASHR_RPC_URL=http://wallet.railway.internal:8232`, `CASHR_RPC_USER`, `CASHR_RPC_PASSWORD`, `CASHR_CORS_ORIGINS` | public domain, port 8000 |

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
`z_getoperationstatus`, `gettransaction` (mined / pending / expired), `z_deleteaccount`, `z_heightattime`.
`getwalletinfo` also reports `last_sync_age_s`, which the API's `/health` uses.

**Deleting an account** is refused unless the wallet synced within the last 5 minutes with no block left unscanned,
the account holds no more than 20,000 zatoshis (including unconfirmed and uneconomic notes), and no send from it is
being built or could still be mined. A wrong `CASHR_WALLET_SEED_KEY` stops the wallet at startup (it checks the key
against a `seeds/key-check` file written on first start).
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
| `CASHR_RPC_URL` / `_USER` / `_PASSWORD` | yes | The wallet's RPC |
| `CASHR_DATABASE_URL` | no | SQLite only (default `/data/cashr.db` in the image): a purge's guarantee rests on rewriting the file |
| `CASHR_LIST_DELAY_MIN` | no | The public ticket list updates at random moments 0.5 to 1.5 times this apart (default 120) |
| `CASHR_REFUND_SPREAD_MIN` | no | Each refund goes out at a random time within this many minutes of settling (default 180) |
| `CASHR_REFUND_BATCH` | no | Refunds per transaction (default 1; more lets a sync server see who came together) |
| `CASHR_DOOR_SYNC_GRACE_MIN` | no | After settling, minutes to accept offline door check-ins before sweeping (default 30) |
| `CASHR_REJECT_FEE_ZAT` | no | Kept from a returned payment to cover its fee (default 10000); smaller returns are kept |
| `CASHR_SCAN_INTERVAL` | no | Seconds between scans of every live event (default 15) |
| `CASHR_PRIVACY_POLICY` | no | Wallet send policy (default `FullPrivacy`: Orchard recipients only) |
| `CASHR_SIM_STATE` | no | `sim` only: file that keeps the simulated wallets across restarts |
| `CASHR_CORS_ORIGINS` | yes | Your web origin |
| `CASHR_MIN_CONF` | no | Confirmations before an RSVP counts (default 1) |
| `CASHR_PAYOUT_CONF` | no | Confirmations before a refund or sweep counts as paid (default 3) |
| `CASHR_CREATE_PER_HOUR` / `CASHR_MAX_LIVE_EVENTS` | no | Event creation limits (default 60 / 500) |
| `CASHR_DUST_ZAT` | no | Below this, leftover value is not worth a sweep fee (default 20000) |

Run exactly **one** API process (one worker, one replica). It takes an exclusive lock on its database at startup
and refuses to start if another process holds it.

Python dependencies are pinned with hashes in `api/requirements.lock` (`uv pip compile pyproject.toml
--generate-hashes -o requirements.lock`); the image installs exactly those.
