# Deploying Unlisted

```
[ web: Next.js on Vercel ] --HTTPS--> [ api: FastAPI ] --JSON-RPC--> [ wallet: unlisted-wallet ] --gRPC/TLS--> [ lightwalletd (zec.rocks) ] --> Zcash mainnet
```

The wallet is a light client, so **no full node is needed**. It syncs compact blocks from a public lightwalletd
server, then fetches the full transactions it needs to read memos.

## What has been verified on mainnet

Run against `https://zec.rocks:443` on Oct 21, 2026 (chain tip ≈ 3,525,545):

| Step | Result |
|---|---|
| Connect, track tip | ✅ |
| Create a per-event account with birthday = tip, derive Orchard-only / Sapling / combined UAs | ✅ |
| Scan the account to the chain tip | ✅ |
| API in `rpc` mode: create event (real Orchard address), scanner, admin balance, settle with no RSVPs | ✅ |
| Build a transfer proposal, enforce FullPrivacy (non-Orchard recipient refused) | ✅ |
| Receive a deposit, read its memo, prove and broadcast a refund | ⚠️ **Needs real ZEC. Not yet run.** |

Before a real event, run one full cycle with a small amount: create an event, pay the deposit from ZODL, check in,
settle, and confirm the refund lands in ZODL.

## Quick start (Docker Compose)

```bash
cp .env.example .env      # fill in UNLISTED_SECRET, UW_RPC_PASSWORD, UNLISTED_CORS_ORIGINS
docker compose up -d --build
docker compose exec wallet cat /data/seed.txt   # write this down, offline
```

This runs two containers:
* `wallet`: `unlisted-wallet`. It is not exposed publicly, and its seed lives in the `wallet-data` volume.
* `api`: the FastAPI service on port 8000, with no access logs. Put TLS in front of it (Caddy, a load balancer, or
  your host's HTTPS).

**The seed controls every event's deposits.** `seed.txt` is a standard 24-word BIP 39 phrase, and each event is ZIP
32 account *n*, so it can be restored into any Zcash wallet in an emergency.

Then deploy the web app with `NEXT_PUBLIC_API_URL` set to the API's public HTTPS URL:
* **Netlify:** import the repo. `netlify.toml` already sets the base directory to `web/` and the Next.js build.
* **Vercel:** import the repo with root directory `web/`.

Also add the web origin to the API's `UNLISTED_CORS_ORIGINS`.

## Wallet service (`wallet/`)

| Variable | Default | Meaning |
|---|---|---|
| `UW_NETWORK` | `main` | `main` or `test` |
| `UW_LIGHTWALLETD` | `https://zec.rocks:443` (testnet: `https://testnet.zec.rocks:443`) | lightwalletd gRPC endpoint |
| `UW_DATA_DIR` | `./wallet-data` | `seed.txt` and `wallet.sqlite` |
| `UW_LISTEN` | `127.0.0.1:8232` | JSON-RPC listen address. A non-loopback address requires a password |
| `UW_RPC_USER` / `UW_RPC_PASSWORD` | empty | HTTP basic auth for the RPC |
| `UW_SYNC_INTERVAL` | `10` | Seconds between syncs |
| `UW_EXTRA_CA_FILE` | none | Extra PEM CA to trust, for networks that re-sign TLS |

RPC methods (zcashd-compatible shapes): `getblockcount`, `getwalletinfo`, `z_getnewaccount`,
`z_getaddressforaccount`, `z_listreceivedbyaddress`, `z_getbalanceforaccount`, `z_sendmany` (`FullPrivacy` sends
only to Orchard receivers; `AllowRevealedAmounts` also allows Sapling), `z_getoperationstatus`,
`z_listunifiedreceivers`.

Spending uses librustzcash's default confirmation policy (3 confirmations for the wallet's own change, 10 for
received notes). Deposits therefore become refundable about 12 minutes after they arrive. That's well before any
event ends; queued refunds simply wait.

Build without Docker: `cd wallet && cargo build --release`. The Sapling parameters are bundled into the binary,
and Orchard needs none.

## API (`api/`)

| Variable | Required | Meaning |
|---|---|---|
| `UNLISTED_CHAIN` | yes | `rpc` (`sim` is for tests and local dev only) |
| `UNLISTED_NETWORK` | yes | `main` or `test`. Must match the wallet |
| `UNLISTED_SECRET` | yes | Long random string. Keys the refund-address reuse check. Never change it once set |
| `UNLISTED_RPC_URL` / `_USER` / `_PASSWORD` | yes | The wallet's RPC |
| `UNLISTED_DATABASE_URL` | no | Defaults to SQLite in `/data` in the image. `postgresql+psycopg://…` also works |
| `UNLISTED_CORS_ORIGINS` | yes | Your web origin |
| `UNLISTED_MIN_CONF` | no | Confirmations before an RSVP counts (default 1) |

Run exactly **one** API instance: its deposit scanner runs in-process.

`UNLISTED_CHAIN=rpc` also works against zcashd or Zallet instead of `unlisted-wallet`, since they speak the same RPC.

**Modal** (optional): `api/modal_app.py` pins one always-warm container. The wallet still needs a persistent host
for its seed and database.
