# cashr

**RSVPs without a guest list.** A refundable deposit in shielded ZEC stops no-shows, and nobody, not even the
organiser, ever holds a list of who came.

Built for the [Zecathon](https://thezecathon.com/) Zcash privacy hackathon (Shielded Payments track).

## The idea

Support groups, union organisers, journalists and activists need RSVPs because no-shows wreck planning. But every
RSVP tool produces a list of names, emails or wallet addresses, and a breach, subpoena or seized laptop turns it into
a target list.

cashr replaces the list with:

1. **A secret made on the attendee's phone.** Only its SHA-256 hash is ever sent.
2. **A shielded deposit.** The hash and a one-time refund address ride in the payment's encrypted memo. Nobody can see
   who paid.
3. **A QR check-in at the door.** The door hashes the secret and looks it up. It records yes/no, not a time.
4. **An automatic refund** to everyone who came, at an address only they know. No-show deposits go to the group's fund.
5. **A purge.** After settling, one click deletes the event's ticket hashes and refund addresses, and destroys its
   wallet keys so its memos can never be decrypted again. The title, date and place go too. Only totals remain.

The organiser's dashboard has a **"What a seizure reveals"** tab showing every record held for the event. There is
nothing in it that names anyone.

## Try it

| | Link | Chain |
|---|---|---|
| **Live app** | https://cashr.site | Zcash **mainnet**. Pay real shielded ZEC from ZODL (or any wallet that pays ZIP 321 links with memos). |
| **Testnet** | https://testnet.cashr.site | The real Zcash **testnet**, with test coins from the [faucet](https://testnet.zecfaucet.com). Same wallet and server as mainnet; the public list and refunds run on minutes, not hours. Needs a testnet-capable wallet (e.g. Zingo, YWallet). |
| **Demo without ZEC** | https://demo.cashr.site | A **simulated** chain. The RSVP page shows *Simulate this payment*, so the whole flow works without a wallet. |

All three run the same code. The only thing mocked anywhere is the simulated chain behind the demo site: a Zcash
stand-in that mines a block every few seconds and keeps its state on disk across restarts. The mainnet and testnet
wallets are real librustzcash light clients that reach lightwalletd through Tor.

A two-minute tour: create an event (keep the two private links), open the invite link in another browser, RSVP
with a fresh refund address and pay, then open the door link and scan or paste the ticket. End the event from the
dashboard to refund everyone who came, and purge it.

**Trust model.** The server's wallet holds deposits between payment and settlement, so attendees trust its
operator not to keep them; deposits should stay small. Anyone can run their own server with one command
([DEPLOY.md](docs/DEPLOY.md)), and the [threat model](https://cashr.site/privacy) lists what is
stored and what could still leak.

## Repository

```
wallet/  cashr-wallet (Rust, librustzcash): light-client Zcash wallet syncing from lightwalletd.
         One account per event from its own encrypted seed, memo decryption, Orchard-only refunds,
         idempotent sends that survive restarts, JSON-RPC.
api/     FastAPI service: deposit scanner, RSVP rules, settlement, door API, purge (Python 3.11+)
web/     Next.js app: landing, create event, RSVP, ticket, door scanner, organiser dashboard
docs/    SPEC.md · PROTOCOL.md · DEPLOY.md
```

## Run it

**Against Zcash mainnet** (real wallet, real ZEC), on a fresh Ubuntu server as root:

```bash
curl -fsSL https://raw.githubusercontent.com/linoxbt/cashr/main/deploy/install.sh | bash -s -- api.example.com
```

Details and other options in [docs/DEPLOY.md](docs/DEPLOY.md). By hand:

```bash
cp .env.example .env     # then fill in its secrets (openssl rand -hex 32), see docs/DEPLOY.md
docker compose up -d --build     # wallet + API
cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

**Locally without ZEC** (simulated chain; every page shows a banner, and the RSVP page offers "Simulate this
payment"):

```bash
cd api && uv venv && uv pip install -e '.[dev]'
CASHR_CHAIN=sim .venv/bin/uvicorn cashr.main:app --port 8000 --no-access-log
cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

## Tests

```bash
cd wallet && cargo test          # block cache, amounts, encrypted seeds, persisted operations
cd api && .venv/bin/pytest -q    # lifecycle, idempotent payouts, expiry, sweeps, purge, limits, RPC adapter
cd web && npm test               # codec + UA decoding parity with the API (real mainnet addresses)
cd web && npm run build && npm run e2e   # browser journey against a running sim API (see web/e2e/journey.mjs)
```

## Privacy model

Read [the threat model](web/src/app/privacy/page.tsx) (also served at `/privacy`) and
[docs/PROTOCOL.md](docs/PROTOCOL.md). In short: no access or proxy logs of visitors, no IPs stored, no accounts, tokens
only in URL fragments, Orchard-only event addresses, refunds sent with `FullPrivacy` one per transaction at random
times, uniform deposit amounts, a public list that changes only on its own random schedule, and the attendee's
confirmation check downloads the whole hash list rather than asking about one ticket.

What you trust: the server's wallet holds deposits until settlement, so keep deposits small.

## License

[MIT](LICENSE).
