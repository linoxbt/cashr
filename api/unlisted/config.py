"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # "rpc" talks to a real Zcash wallet (Zallet / zcashd JSON-RPC).
    # "sim" is an in-process simulated chain for tests and local development.
    chain_mode: str = field(default_factory=lambda: os.environ.get("UNLISTED_CHAIN", "sim"))
    network: str = field(default_factory=lambda: os.environ.get("UNLISTED_NETWORK", "main"))
    database_url: str = field(
        default_factory=lambda: os.environ.get("UNLISTED_DATABASE_URL", "sqlite:///./unlisted.db")
    )
    # Keys the refund-address reuse check. Must be stable and secret in production.
    secret: str = field(default_factory=lambda: os.environ.get("UNLISTED_SECRET", "dev-only-secret"))

    rpc_url: str = field(default_factory=lambda: os.environ.get("UNLISTED_RPC_URL", "http://127.0.0.1:8232"))
    rpc_user: str = field(default_factory=lambda: os.environ.get("UNLISTED_RPC_USER", ""))
    rpc_password: str = field(default_factory=lambda: os.environ.get("UNLISTED_RPC_PASSWORD", ""))
    # zcashd privacy policy for outgoing refunds. FullPrivacy refuses any send
    # that would reveal amounts or recipients on chain.
    privacy_policy: str = field(
        default_factory=lambda: os.environ.get("UNLISTED_PRIVACY_POLICY", "FullPrivacy")
    )

    min_conf: int = field(default_factory=lambda: _int("UNLISTED_MIN_CONF", 1))
    scan_interval_s: int = field(default_factory=lambda: _int("UNLISTED_SCAN_INTERVAL", 15))
    # Deducted from refunds of *rejected* payments (wrong amount, full, closed…),
    # so junk payments cannot drain the event's fee float. ZIP 317 minimum fee.
    reject_fee_zat: int = field(default_factory=lambda: _int("UNLISTED_REJECT_FEE_ZAT", 10_000))
    refund_batch_size: int = field(default_factory=lambda: _int("UNLISTED_REFUND_BATCH", 25))

    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.environ.get("UNLISTED_CORS_ORIGINS", "http://localhost:3000").split(",")
            if o.strip()
        )
    )
    run_scanner: bool = field(default_factory=lambda: os.environ.get("UNLISTED_RUN_SCANNER", "1") == "1")

    @property
    def is_sim(self) -> bool:
        return self.chain_mode == "sim"


def get_settings() -> Settings:
    return Settings()
