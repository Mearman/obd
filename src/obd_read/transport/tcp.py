"""TCP link, for Wi-Fi adapters that expose their ELM327 interface on a socket."""

from __future__ import annotations

import asyncio

from .base import TransportError, TransportTimeout


class TcpTransport:
    """An ELM327 adapter reached over a TCP socket."""

    def __init__(self, host: str, port: int, connect_timeout: float = 10.0) -> None:
        self._host = host
        self._port = port
        self._connect_timeout = connect_timeout
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def open(self) -> None:
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self._host, self._port), self._connect_timeout
            )
        except (OSError, TimeoutError) as error:
            raise TransportError(f"cannot connect to {self._host}:{self._port}: {error}") from error

    async def close(self) -> None:
        if self._writer is not None:
            self._writer.close()
            await self._writer.wait_closed()
            self._writer = None
            self._reader = None

    async def write(self, data: bytes) -> None:
        if self._writer is None:
            raise TransportError("TCP link is not open")
        self._writer.write(data)
        await self._writer.drain()

    async def read(self, timeout: float) -> bytes:
        if self._reader is None:
            raise TransportError("TCP link is not open")
        try:
            data = await asyncio.wait_for(self._reader.read(4096), timeout)
        except TimeoutError as error:
            raise TransportTimeout(f"nothing received in {timeout:.1f} s") from error
        if not data:
            raise TransportError("the adapter closed the connection")
        return data
