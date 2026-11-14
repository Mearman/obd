"""Links that carry raw CAN frames, beside the byte-pipe links that carry an ELM327 conversation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

# Data bytes in a classic CAN frame.
MAX_DATA = 8

# Largest identifiers: 11 bits standard, 29 bits extended.
MAX_STANDARD_ID = 0x7FF
MAX_EXTENDED_ID = 0x1FFFFFFF


@dataclass(frozen=True)
class CanFrame:
    """One classic CAN data frame. Remote, error and CAN FD frames are not represented."""

    can_id: int
    data: bytes
    extended: bool = False

    def __post_init__(self) -> None:
        limit = MAX_EXTENDED_ID if self.extended else MAX_STANDARD_ID
        if not 0 <= self.can_id <= limit:
            raise ValueError(f"CAN identifier {self.can_id:#x} does not fit the frame format")
        if len(self.data) > MAX_DATA:
            raise ValueError(f"a CAN frame carries at most {MAX_DATA} bytes, got {len(self.data)}")


class CanLink(Protocol):
    """A raw CAN channel: frames in and out, with the bus speed chosen once it is open."""

    async def open(self) -> None:
        """Open the device. Raises TransportError if it cannot be reached."""

    async def configure(self, bitrate: int, listen_only: bool) -> None:
        """Start the bus at `bitrate` bit/s, in listen-only mode when `listen_only` is set.

        A link whose bit rate and mode belong to the operating system's interface (SocketCAN) leaves both to the interface.
        """

    async def close(self) -> None:
        """Release the device. Safe to call when it never opened."""

    async def send(self, frame: CanFrame) -> None:
        """Put one frame on the bus. Raises TransportError when the link is not open or fails."""

    async def receive(self, timeout: float) -> CanFrame:
        """Return the next data frame on the bus.

        Raises TransportTimeout when none arrives within `timeout` seconds.
        """
