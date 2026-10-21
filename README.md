# Unlisted

**RSVPs without a guest list.** A refundable deposit in shielded ZEC stops no-shows, and nobody, not even the
organiser, ever holds a list of who came.

Built for the [Zecathon](https://thezecathon.com/) Zcash privacy hackathon (Shielded Payments track).

## The idea

Support groups, union organisers, journalists and activists need RSVPs because no-shows wreck planning. But every
RSVP tool produces a list of names, emails or wallet addresses, and a breach, subpoena or seized laptop turns it into
a target list.

Unlisted replaces the list with:

1. **A secret made on the attendee's phone.** Only its SHA-256 hash is ever sent.
2. **A shielded deposit.** The hash and a one-time refund address ride in the payment's encrypted memo. Nobody can see
   who paid.
3. **A QR check-in at the door.** The door hashes the secret and looks it up. It records yes/no, not a time.
4. **An automatic refund** to everyone who came, at an address only they know. No-show deposits go to the group's fund.
5. **A purge.** After settling, one click deletes every hash and address. Only totals remain.

The organiser's dashboard has a **"What a seizure reveals"** tab showing every record held for the event, exactly
as stored. There is nothing in it that names anyone.

## Repository

```
wallet/  unlisted-wallet (Rust, librustzcash): light-client Zcash wallet syncing from lightwalletd.
         One ZIP 32 account per event, memo decryption, Orchard-only refunds, zcashd-style JSON-RPC.
api/     FastAPI service: deposit scanner, RSVP rules, settlement, door API, purge (Python 3.11+)
web/     Next.js app: landing, create event, RSVP, ticket, door scanner, organiser dashboard
docs/    SPEC.md · PROTOCOL.md · DEPLOY.md
```

## Run it

**Against Zcash mainnet** (real wallet, real ZEC): see [docs/DEPLOY.md](docs/DEPLOY.md), or in short:

```bash
cp .env.example .env && docker compose up -d --build     # wallet + API
cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

**Locally without ZEC** (simulated chain; every page shows a banner, and the RSVP page offers "Simulate this
payment"):

```bash
cd api && uv venv && uv pip install -e '.[dev]'
UNLISTED_CHAIN=sim .venv/bin/uvicorn unlisted.main:app --port 8000 --no-access-log
cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

## Tests

```bash
cd wallet && cargo test          # block cache, exact amount parsing
cd api && .venv/bin/pytest -q    # lifecycle, rejections, reuse, fees, auth, RPC adapter, UA decoding
cd web && npm test               # codec + UA decoding parity with the API (real mainnet addresses)
cd web && npm run build
```

## Privacy model

Read [the threat model](web/src/app/privacy/page.tsx) (also served at `/privacy`) and
[docs/PROTOCOL.md](docs/PROTOCOL.md). In short: no access logs, no IPs stored, no accounts, tokens only in URL
fragments, Orchard-only event addresses, refunds sent with `FullPrivacy`, uniform deposit amounts, refund-address reuse
refused, and the attendee's confirmation check downloads the whole hash list rather than asking about one ticket.

What you trust: the server's wallet holds deposits until settlement, so keep deposits small.
