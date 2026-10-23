# cashr: notes for contributors and agents

* `api/` is FastAPI + SQLAlchemy. All state changes go through `cashr/engine.py` under `Engine.lock`.
  The chain is behind `cashr/chain/base.py`. `rpc.py` is the real wallet adapter, and `sim.py` is for tests and
  local dev only.
* `wallet/` is the Rust light-client wallet (librustzcash `zcash_client_backend` 0.24 / `zcash_client_sqlite` 0.22).
  It syncs from lightwalletd, enhances transactions to read memos, and serves a zcashd-style JSON-RPC subset.
  `api/cashr/chain/rpc.py` is its client.
* `web/` is Next.js (App Router, Tailwind). Protocol code lives in `web/src/lib/codec.ts` and must stay byte-identical
  with `api/cashr/codec.py`. Change both, plus `docs/PROTOCOL.md`, together.

## Privacy invariants (do not break)
1. The server never stores names, emails, IPs, check-in timestamps, or ticket secrets.
2. Attendees never send a request that identifies their ticket. Confirmation reads the whole ticket list.
3. Tokens travel only in URL fragments and `Authorization` headers.
4. Every RSVP pays exactly the deposit. Refund addresses are never reused. Event addresses are Orchard-only.
5. Purge deletes RSVP, deposit and payout rows, the event's wallet account and seed, and anything that names or
   dates the event (title, times, place, address). Server-written memos never name the event.
6. A payout is sent under its idempotency key only. Never build a second transaction for a payout that could still be mined.
7. Nothing public reveals check-in state, payment or refund timing, or order while an event runs (the public list
   changes only on its own random schedule; counts follow the list), refunds are one per transaction at random times, client polling looks the same
   in every state, and no client request links one person's events together. Only the Orchard receiver of a refund
   address is kept. The wallet reaches lightwalletd through Tor, with delayed fetches, unless the operator opts out.

## Checks before committing
```
cd wallet && cargo test
cd api && .venv/bin/pytest -q
cd web && npm test && npm run build
cd web && npm run e2e   # with a sim API (CASHR_CHAIN=sim) and `npm start` running
```
