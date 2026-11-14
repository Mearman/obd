"""The scripted adapter and car live in `obd_read.simulator`; this adds the in-process transport."""

from __future__ import annotations

from obd_read.simulator import FakeElmCore, KwpEcu, Responder, UdsEcu, isotp_frames, serve
from obd_read.transport import TransportTimeout

__all__ = [
    "FakeElmCore",
    "FakeTransport",
    "KwpEcu",
    "Responder",
    "UdsEcu",
    "isotp_frames",
    "serve",
]


class FakeTransport:
    """A Transport backed by a FakeElmCore."""

    def __init__(self, core: FakeElmCore) -> None:
        self.core = core
        self.opened = False
        self.closed = False
        self._pending = b""

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    async def write(self, data: bytes) -> None:
        self._pending += self.core.feed(data)

    async def read(self, timeout: float) -> bytes:
        if not self._pending:
            raise TransportTimeout("fake adapter has nothing to say")
        # Hand the reply back in two pieces, as a real link splits it arbitrarily.
        cut = max(1, len(self._pending) // 2)
        data, self._pending = self._pending[:cut], self._pending[cut:]
        return data
