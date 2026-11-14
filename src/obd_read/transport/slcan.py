"""SLCAN, the ASCII serial protocol for CAN adapters, over any byte-pipe link.

Commands and frames end in a carriage return and the adapter answers a command with a carriage return, or a bell on failure. `S0` to `S8` choose 10, 20, 50, 100, 125, 250, 500, 800 kbit/s and 1 Mbit/s, `O` opens the bus, `L` opens it listen-only and `C` closes it. A frame is `t` and three hexadecimal identifier digits (`T` and eight for an extended identifier), one data length digit and the data in hexadecimal. Source: the Linux kernel's SLCAN driver, https://github.com/torvalds/linux/blob/master/drivers/net/can/slcan/slcan-core.c

A candleLight adapter flashed with SLCAN firmware speaks this; one with gs_usb firmware is a SocketCAN device on Linux instead.
"""

from __future__ import annotations

import re

from .base import Transport, TransportError
from .can import CanFrame

BITRATE_CODES: dict[int, int] = {
    10_000: 0,
    20_000: 1,
    50_000: 2,
    100_000: 3,
    125_000: 4,
    250_000: 5,
    500_000: 6,
    800_000: 7,
    1_000_000: 8,
}

CARRIAGE_RETURN = b"\r"
BELL = b"\x07"

_FRAME = re.compile(rb"(?:t([0-9A-F]{3})|T([0-9A-F]{8}))([0-8])((?:[0-9A-F]{2})*)", re.IGNORECASE)


def encode_frame(frame: CanFrame) -> bytes:
    """The SLCAN text for one data frame, ending in a carriage return."""
    identifier = f"T{frame.can_id:08X}" if frame.extended else f"t{frame.can_id:03X}"
    return f"{identifier}{len(frame.data)}{frame.data.hex().upper()}\r".encode("ascii")


def decode_frame(line: bytes) -> CanFrame | None:
    """Parse one received line. Returns None for a line that is not a data frame, such as a command acknowledgement or a remote frame.

    Raises TransportError for a data frame whose declared length disagrees with its data.
    """
    match = _FRAME.fullmatch(line)
    if match is None:
        return None
    standard, extended, length, data = match.groups()
    payload = bytes.fromhex(data.decode("ascii"))
    if len(payload) != int(length):
        raise TransportError(f"SLCAN frame {line!r} declares {length!r} data bytes")
    if extended is not None:
        return CanFrame(int(extended, 16), payload, extended=True)
    return CanFrame(int(standard, 16), payload)


class SlcanLink:
    """A CAN channel on an SLCAN adapter reached through a byte-pipe transport."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._buffer = b""
        self._started = False

    async def open(self) -> None:
        await self._transport.open()

    async def _next_line(self, timeout: float) -> bytes:
        """The next line from the adapter, or a lone bell when it reported a failure."""
        while True:
            ends = [
                index for index in (self._buffer.find(b"\r"), self._buffer.find(BELL)) if index >= 0
            ]
            if ends:
                end = min(ends)
                line, terminator = self._buffer[:end], self._buffer[end : end + 1]
                self._buffer = self._buffer[end + 1 :]
                return BELL if terminator == BELL else line
            self._buffer += await self._transport.read(timeout)

    async def _command(
        self, text: str, *, allow_refusal: bool = False, timeout: float = 2.0
    ) -> None:
        """Send one command and wait for its acknowledgement, skipping frames that arrive first.

        Raises TransportError when the adapter answers with a bell, unless `allow_refusal` is set.
        """
        await self._transport.write(text.encode("ascii") + CARRIAGE_RETURN)
        while True:
            line = await self._next_line(timeout)
            if line == BELL:
                if allow_refusal:
                    return
                raise TransportError(f"the SLCAN adapter refused {text!r}")
            if not line:
                return

    async def configure(self, bitrate: int, listen_only: bool) -> None:
        if bitrate not in BITRATE_CODES:
            raise TransportError(f"an SLCAN adapter has no setting for {bitrate} bit/s")
        # Closing a channel that is already closed is refused by some adapters, which is not a failure.
        await self._command("C", allow_refusal=True)
        await self._command(f"S{BITRATE_CODES[bitrate]}")
        await self._command("L" if listen_only else "O")
        self._started = True

    async def close(self) -> None:
        try:
            if self._started:
                await self._command("C", allow_refusal=True)
        finally:
            self._started = False
            await self._transport.close()

    async def send(self, frame: CanFrame) -> None:
        await self._transport.write(encode_frame(frame))

    async def receive(self, timeout: float) -> CanFrame:
        while True:
            frame = decode_frame(await self._next_line(timeout))
            if frame is not None:
                return frame
