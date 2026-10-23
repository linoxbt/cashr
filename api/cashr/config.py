"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # "rpc" talks to the real wallet (cashr-wallet). "sim" is an in-process
    # simulated chain for tests and local development. No default: a server
    # that forgot to set it must not quietly accept simulated payments.
    chain_mode: str = field(default_factory=lambda: os.environ.get("CASHR_CHAIN", ""))
    network: str = field(default_factory=lambda: os.environ.get("CASHR_NETWORK", "main"))
    # Where the sim chain keeps its wallets between restarts. Empty keeps them in
    # memory only, which strands every event's money when the process restarts.
    sim_state_path: str = field(default_factory=lambda: os.environ.get("CASHR_SIM_STATE", ""))
    database_url: str = field(
        default_factory=lambda: os.environ.get("CASHR_DATABASE_URL", "sqlite:///./cashr.db")
    )
    # Keys the refund-address reuse check. Must be stable and secret in production.
    secret: str = field(default_factory=lambda: os.environ.get("CASHR_SECRET", "dev-only-secret"))
    # Reused refund addresses are remembered (as keyed digests) for one to two
    # periods of this many days, then forgotten.
    address_memory_days: int = field(default_factory=lambda: _int("CASHR_ADDRESS_MEMORY_DAYS", 365))

    rpc_url: str = field(default_factory=lambda: os.environ.get("CASHR_RPC_URL", "http://127.0.0.1:8232"))
    rpc_user: str = field(default_factory=lambda: os.environ.get("CASHR_RPC_USER", ""))
    rpc_password: str = field(default_factory=lambda: os.environ.get("CASHR_RPC_PASSWORD", ""))
    # Privacy policy for outgoing refunds. FullPrivacy refuses any send
    # that would reveal amounts or recipients on chain.
    privacy_policy: str = field(
        default_factory=lambda: os.environ.get("CASHR_PRIVACY_POLICY", "FullPrivacy")
    )

    min_conf: int = field(default_factory=lambda: _int("CASHR_MIN_CONF", 1))
    # Confirmations before a refund or sweep counts as paid.
    payout_conf: int = field(default_factory=lambda: _int("CASHR_PAYOUT_CONF", 3))
    scan_interval_s: int = field(default_factory=lambda: _int("CASHR_SCAN_INTERVAL", 15))
    # Deducted from refunds of *rejected* payments (wrong amount, full, closed…),
    # so junk payments cannot drain the event's fee float. ZIP 317 minimum fee.
    reject_fee_zat: int = field(default_factory=lambda: _int("CASHR_REJECT_FEE_ZAT", 10_000))
    # One refund per transaction: a batch is fetched by every recipient's wallet,
    # which shows a sync server which attendees came together.
    refund_batch_size: int = field(default_factory=lambda: _int("CASHR_REFUND_BATCH", 1))
    # Refunds go out at random times within this many minutes of settling, so
    # they don't line up with the event's end or with each other.
    refund_spread_min: int = field(default_factory=lambda: _int("CASHR_REFUND_SPREAD_MIN", 180))
    # The public list (new tickets and returned payments) is updated only at random
    # moments, about this many minutes apart, scheduled independently of payments,
    # so polling it can't time any payment. 0 updates it on every scan (demo).
    list_delay_min: int = field(default_factory=lambda: _int("CASHR_LIST_DELAY_MIN", 120))
    # Left in an event wallet after the sweep (less than a fee): destroyed on purge.
    # Capped at the wallet's own delete limit (DELETE_MAX_ZAT), above which it refuses every purge.
    dust_zat: int = field(default_factory=lambda: min(_int("CASHR_DUST_ZAT", 20_000), 20_000))

    # Every event is a wallet account the wallet must scan, so creation is
    # capped. Global limits, because the server never sees who is asking.
    create_per_hour: int = field(default_factory=lambda: _int("CASHR_CREATE_PER_HOUR", 60))
    max_live_events: int = field(default_factory=lambda: _int("CASHR_MAX_LIVE_EVENTS", 500))

    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.environ.get("CASHR_CORS_ORIGINS", "http://localhost:3000").split(",")
            if o.strip()
        )
    )
    run_scanner: bool = field(default_factory=lambda: os.environ.get("CASHR_RUN_SCANNER", "1") == "1")

    @property
    def is_sim(self) -> bool:
        return self.chain_mode == "sim"


def get_settings() -> Settings:
    return Settings()
