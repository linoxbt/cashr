from __future__ import annotations

from ..config import Settings
from .base import Chain, ChainError, OpStatus, ReceivedNote, Recipient


def make_chain(settings: Settings) -> Chain:
    if settings.chain_mode == "rpc":
        from .rpc import RpcChain

        return RpcChain(settings.rpc_url, settings.rpc_user, settings.rpc_password,
                        settings.privacy_policy, settings.min_conf)
    if settings.chain_mode == "sim":
        from .sim import SimChain

        return SimChain(settings.network)
    raise ValueError(f"unknown UNLISTED_CHAIN {settings.chain_mode!r}")


__all__ = ["Chain", "ChainError", "OpStatus", "ReceivedNote", "Recipient", "make_chain"]
