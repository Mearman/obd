"""SocketCAN, the Linux kernel's CAN interface: `can0`, `vcan0`, a candleLight adapter running gs_usb firmware, and anything else the kernel exposes as a CAN device.

The bit rate and listen-only mode belong to the interface and are set outside this tool, for example `ip link set can0 type can bitrate 500000 listen-only on`. Source: https://docs.kernel.org/networking/can.html
"""

from __future__ import annotations

import asyncio
import socket
import struct

from .base import TransportError, TransportTimeout
from .can import CanFrame

# struct can_frame from <linux/can.h>: identifier with flags, data length, three padding bytes, eight data bytes.
CAN_FRAME = struct.Struct("=IB3x8s")

# The CAN_RAW protocol number from <linux/can.h>.
CAN_RAW = 1

# Flag bits the kernel ORs into the identifier.
EXTENDED_FLAG = 0x8000_0000
REMOTE_FLAG = 0x4000_0000
ERROR_FLAG = 0x2000_0000
EXTENDED_ID_MASK = 0x1FFF_FFFF
STANDARD_ID_MASK = 0x7FF


def can_family() -> int | None:
    """The socket address family for CAN, or None where the socket module has none (every platform but Linux)."""
    family: int | None = getattr(socket, "AF_CAN", None)
    return family


def encode_frame(frame: CanFrame) -> bytes:
    """Pack a frame as the kernel's `struct can_frame`."""
    can_id = frame.can_id | (EXTENDED_FLAG if frame.extended else 0)
    return CAN_FRAME.pack(can_id, len(frame.data), frame.data.ljust(8, b"\x00"))


def decode_frame(raw: bytes) -> CanFrame | None:
    """Unpack a `struct can_frame`. Returns None for a remote or error frame, which carry no data to read."""
    can_id, length, data = CAN_FRAME.unpack(raw)
    if can_id & (REMOTE_FLAG | ERROR_FLAG):
        return None
    if can_id & EXTENDED_FLAG:
        return CanFrame(can_id & EXTENDED_ID_MASK, bytes(data[:length]), extended=True)
    return CanFrame(can_id & STANDARD_ID_MASK, bytes(data[:length]))


class SocketCanLink:
    """A raw CAN socket bound to one interface."""

    def __init__(self, interface: str) -> None:
        self._interface = interface
        self._socket: socket.socket | None = None

    async def open(self) -> None:
        family = can_family()
        if family is None:
            raise TransportError(
                "SocketCAN is a Linux feature and this platform's socket module has no CAN family; "
                "use an slcan:// adapter, or run on Linux"
            )
        try:
            opened = socket.socket(family, socket.SOCK_RAW, CAN_RAW)
            opened.bind((self._interface,))
        except OSError as error:
            raise TransportError(f"cannot open CAN interface {self._interface}: {error}") from error
        opened.setblocking(False)
        self._socket = opened

    async def configure(self, bitrate: int, listen_only: bool) -> None:
        """Do nothing: the interface's bit rate and listen-only mode are set outside the program."""

    async def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    async def send(self, frame: CanFrame) -> None:
        if self._socket is None:
            raise TransportError("SocketCAN link is not open")
        try:
            await asyncio.get_running_loop().sock_sendall(self._socket, encode_frame(frame))
        except OSError as error:
            raise TransportError(f"cannot send on {self._interface}: {error}") from error

    async def receive(self, timeout: float) -> CanFrame:
        if self._socket is None:
            raise TransportError("SocketCAN link is not open")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TransportTimeout(f"no CAN frame in {timeout:.1f} s")
            try:
                raw = await asyncio.wait_for(
                    loop.sock_recv(self._socket, CAN_FRAME.size), remaining
                )
            except TimeoutError as error:
                raise TransportTimeout(f"no CAN frame in {timeout:.1f} s") from error
            except OSError as error:
                raise TransportError(f"cannot read {self._interface}: {error}") from error
            frame = decode_frame(raw)
            if frame is not None:
                return frame
