"""Links to an adapter: Bluetooth LE, serial and TCP."""

from .base import (
    AdapterAddress,
    Transport,
    TransportError,
    TransportTimeout,
    open_transport,
    parse_adapter_url,
)

__all__ = [
    "AdapterAddress",
    "Transport",
    "TransportError",
    "TransportTimeout",
    "open_transport",
    "parse_adapter_url",
]
