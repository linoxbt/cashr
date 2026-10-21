from __future__ import annotations

from ..config import Settings
from .base import Balance, Chain, ChainError, OpStatus, ReceivedNote, Recipient, TxStatus


def make_chain(settings: Settings) -> Chain:
    if settings.chain_mode == "rpc":
        from .rpc import RpcChain

        return RpcChain(settings.rpc_url, settings.rpc_user, settings.rpc_password,
                        settings.privacy_policy, settings.min_conf)
    if settings.chain_mode == "sim":
        from .sim import SimChain

        return SimChain(settings.network)
    raise ValueError(f"Set UNLISTED_CHAIN to 'rpc' or 'sim' (got {settings.chain_mode!r}).")


__all__ = ["Balance", "Chain", "ChainError", "OpStatus", "ReceivedNote", "Recipient", "TxStatus", "make_chain"]
