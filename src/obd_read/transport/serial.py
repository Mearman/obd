"""Serial link, for USB adapters and classic Bluetooth adapters paired as a serial port."""

from __future__ import annotations

import asyncio

import serial

from .base import TransportError, TransportTimeout


class SerialTransport:
    """An ELM327 adapter on a serial device such as `/dev/tty.usbserial-1`."""

    def __init__(self, device: str, baud: int) -> None:
        self._device = device
        self._baud = baud
        self._port: serial.Serial | None = None

    async def open(self) -> None:
        try:
            self._port = await asyncio.to_thread(serial.Serial, self._device, self._baud, timeout=0)
        except serial.SerialException as error:
            raise TransportError(f"cannot open {self._device}: {error}") from error

    async def close(self) -> None:
        if self._port is not None:
            await asyncio.to_thread(self._port.close)
            self._port = None

    async def write(self, data: bytes) -> None:
        if self._port is None:
            raise TransportError("serial link is not open")
        await asyncio.to_thread(self._port.write, data)

    async def read(self, timeout: float) -> bytes:
        if self._port is None:
            raise TransportError("serial link is not open")
        port = self._port

        def blocking_read() -> bytes:
            # The first byte waits for the full timeout; whatever else has already arrived is then taken without waiting again.
            port.timeout = timeout
            first: bytes = port.read(1)
            if not first:
                return b""
            port.timeout = 0
            rest: bytes = port.read(port.in_waiting)
            return first + rest

        data = await asyncio.to_thread(blocking_read)
        if not data:
            raise TransportTimeout(f"nothing received in {timeout:.1f} s")
        return data
