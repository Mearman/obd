"""The link to an adapter: a byte pipe with a timeout on reads."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import parse_qsl, unquote


class TransportError(Exception):
    """The link to the adapter could not be opened or failed in use."""


class TransportTimeout(TransportError):
    """No bytes arrived from the adapter within the allowed time."""


class Transport(Protocol):
    """A byte pipe to an ELM327-style adapter."""

    async def open(self) -> None:
        """Connect to the adapter. Raises TransportError if it cannot be reached."""

    async def close(self) -> None:
        """Release the link. Safe to call when the link never opened."""

    async def write(self, data: bytes) -> None:
        """Send bytes to the adapter."""

    async def read(self, timeout: float) -> bytes:
        """Return the next bytes from the adapter, at least one.

        Raises TransportTimeout when nothing arrives within `timeout` seconds.
        """


@dataclass(frozen=True)
class AdapterAddress:
    """A parsed adapter URL such as `ble://vLinker` or `tcp://192.168.80.1:35000`."""

    scheme: str
    target: str
    params: dict[str, str] = field(default_factory=dict)


SCHEMES = ("ble", "serial", "tcp")


def parse_adapter_url(url: str) -> AdapterAddress:
    """Split an adapter URL into scheme, target and query parameters.

    The target is the Bluetooth LE name or address, the serial device path, or `host:port`. Raises ValueError for an unknown scheme or an empty target.
    """
    scheme, separator, rest = url.partition("://")
    if not separator or scheme not in SCHEMES:
        raise ValueError(f"adapter URL must start with one of {', '.join(SCHEMES)}://, got {url!r}")
    target, _, query = rest.partition("?")
    target = unquote(target)
    if not target:
        raise ValueError(f"adapter URL {url!r} names no device")
    return AdapterAddress(scheme, target, dict(parse_qsl(query)))


def open_transport(url: str) -> Transport:
    """Build the transport an adapter URL names. The link is not opened yet."""
    address = parse_adapter_url(url)
    if address.scheme == "tcp":
        from .tcp import TcpTransport

        host, separator, port = address.target.rpartition(":")
        if not separator or not port.isdigit():
            raise ValueError(f"tcp adapter URL needs host:port, got {address.target!r}")
        return TcpTransport(host, int(port))
    if address.scheme == "serial":
        from .serial import SerialTransport

        return SerialTransport(address.target, int(address.params.get("baud", "115200")))
    from .ble import BleTransport

    return BleTransport(
        address.target,
        service=address.params.get("service"),
        notify=address.params.get("notify"),
        write=address.params.get("write"),
    )
