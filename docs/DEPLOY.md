# Deploying Unlisted

Three pieces:

```
[ Next.js on Vercel ] --HTTPS--> [ FastAPI (always on) ] --JSON-RPC--> [ Zcash wallet: Zallet or zcashd ]
```

## 1. Wallet

The API talks to a wallet over the zcashd JSON-RPC dialect. It uses these methods:

`getblockcount`, `z_getnewaccount`, `z_getaddressforaccount`, `z_listreceivedbyaddress` (falls back to
`z_listunspent`), `z_getbalanceforaccount`, `z_sendmany`, `z_getoperationstatus`.

> **Not yet verified against a live wallet.** The adapter is tested against zcashd 5.x response shapes
> (`api/tests/test_rpc.py`) but has not been run against a synced Zallet or zcashd on mainnet. Before a real event:
> create an event, pay a real deposit from ZODL, check in, settle, and confirm the refund lands. Zallet's coverage of
> these methods may differ from zcashd's.

Fund nothing up front: each event gets its own account, and fees are covered by forfeits or a small top-up sent to
the event address without a memo.

## 2. API

Environment:

| Variable | Required | Meaning |
|---|---|---|
| `UNLISTED_CHAIN` | yes | `rpc` for a real wallet (`sim` is dev only) |
| `UNLISTED_NETWORK` | yes | `main` or `test` |
| `UNLISTED_SECRET` | yes | Long random string. Keys the refund-address reuse check. Never change it once set |
| `UNLISTED_RPC_URL` / `_USER` / `_PASSWORD` | yes | Wallet RPC |
| `UNLISTED_DATABASE_URL` | yes | `postgresql+psycopg://…` in production, or `sqlite:////data/unlisted.db` on a persistent disk |
| `UNLISTED_CORS_ORIGINS` | yes | Your web origin, e.g. `https://unlisted.vercel.app` |
| `UNLISTED_MIN_CONF` | no | Confirmations before an RSVP counts (default 1) |
| `UNLISTED_SCAN_INTERVAL` | no | Seconds between wallet scans (default 15) |
| `UNLISTED_REJECT_FEE_ZAT` | no | Withheld from returned payments (default 10000) |

The scanner runs in-process, so run **exactly one** API instance and keep it always on.

**Container (Fly.io, Railway, a VPS):** `docker build -t unlisted-api api/` and run it with the variables above.
The image starts uvicorn with `--no-access-log`.

**Modal:** `cd api && modal secret create unlisted UNLISTED_CHAIN=rpc …` then `modal deploy modal_app.py`. It pins
one always-warm container. Use Postgres rather than SQLite on a Modal Volume.

Turn off request logging at any proxy in front of the API as well.

## 3. Web

On Vercel, import the repo with **root directory `web/`** and set `NEXT_PUBLIC_API_URL` to the API's public URL.
Vercel keeps its own request logs; for the highest-risk groups, also offer the site over Tor.
