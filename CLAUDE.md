# Unlisted: notes for contributors and agents

* `api/` is FastAPI + SQLAlchemy. All state changes go through `unlisted/engine.py` under `Engine.lock`.
  The chain is behind `unlisted/chain/base.py`. `rpc.py` is the real wallet adapter, and `sim.py` is for tests and
  local dev only.
* `web/` is Next.js (App Router, Tailwind). Protocol code lives in `web/src/lib/codec.ts` and must stay byte-identical
  with `api/unlisted/codec.py`. Change both, plus `docs/PROTOCOL.md`, together.

## Privacy invariants (do not break)
1. The server never stores names, emails, IPs, check-in timestamps, or ticket secrets.
2. Attendees never send a request that identifies their ticket. Confirmation reads the whole ticket list.
3. Tokens travel only in URL fragments and `Authorization` headers.
4. Every RSVP pays exactly the deposit. Refund addresses are never reused. Event addresses are Orchard-only.
5. Purge deletes RSVP, deposit and payout rows.

## Checks before committing
```
cd api && .venv/bin/pytest -q
cd web && npm test && npm run build
```
