"""A scripted ELM327 adapter and car, for tests and for a local TCP stand-in."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from obd_read.transport import TransportTimeout

# A responder takes one request payload and returns (sender identifier, reply payload) pairs.
Responder = Callable[[bytes], list[tuple[int, bytes]]]


def isotp_frames(payload: bytes) -> list[bytes]:
    """Split one diagnostic message into ISO 15765-2 CAN frame data."""
    if len(payload) <= 7:
        return [bytes([len(payload)]) + payload]
    frames = [bytes([0x10 | (len(payload) >> 8), len(payload) & 0xFF]) + payload[:6]]
    rest, sequence = payload[6:], 1
    while rest:
        frames.append(bytes([0x20 | (sequence & 0x0F)]) + rest[:7])
        rest, sequence = rest[7:], sequence + 1
    return frames


class FakeElmCore:
    """The adapter's command interpreter: feed it bytes, collect what it would send back."""

    def __init__(
        self,
        responders: dict[int, Responder],
        unsupported: frozenset[str] = frozenset(),
        identity: str = "ELM327 v2.3",
    ) -> None:
        self.responders = responders
        self.unsupported = unsupported
        self.identity = identity
        self.sent: list[str] = []
        self.header = 0
        self.id_chars = 3
        self._partial = b""

    @property
    def requests(self) -> list[str]:
        """Every line that was a diagnostic request, not an adapter command."""
        return [line for line in self.sent if not line.startswith(("AT", "ST"))]

    def feed(self, data: bytes) -> bytes:
        self._partial += data
        output = b""
        while b"\r" in self._partial:
            line, _, self._partial = self._partial.partition(b"\r")
            output += self._handle(line.decode("ascii").strip().upper()).encode("ascii") + b"\r\r>"
        return output

    def _handle(self, line: str) -> str:
        self.sent.append(line)
        if line in self.unsupported:
            return "?"
        if line == "ATZ":
            return self.identity
        if line == "ATI":
            return self.identity
        if line == "AT@1":
            return "OBDII to RS232 Interpreter"
        if line == "STI":
            return "?"
        if line == "ATRV":
            return "12.4V"
        if line.startswith("ATSP"):
            self.id_chars = 8 if line[4:] in ("7", "9") else 3
            return "OK"
        if line.startswith("ATSH"):
            self.header = int(line[4:], 16)
            return "OK"
        if line.startswith(("AT", "ST")):
            return "OK"
        responder = self.responders.get(self.header)
        replies = responder(bytes.fromhex(line)) if responder is not None else []
        if not replies:
            return "NO DATA"
        return "\r".join(
            f"{sender:0{self.id_chars}X}{frame.hex().upper()}"
            for sender, payload in replies
            for frame in isotp_frames(payload)
        )


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


async def serve(core: FakeElmCore) -> asyncio.Server:
    """Serve the fake adapter on a free local TCP port."""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while data := await reader.read(1024):
            writer.write(core.feed(data))
            await writer.drain()
        writer.close()

    return await asyncio.start_server(handle, "127.0.0.1", 0)


class KwpEcu:
    """A KWP2000 control unit with stored fault codes, for one response identifier."""

    def __init__(self, response_id: int, faults: list[tuple[int, int]]) -> None:
        self.response_id = response_id
        self.faults = list(faults)
        self.ident = b"\x86A6421500000 E280CDI"
        self.freeze_refused = False

    def __call__(self, request: bytes) -> list[tuple[int, bytes]]:
        return [(self.response_id, self.reply(request))]

    def reply(self, request: bytes) -> bytes:
        service = request[0]
        if service == 0x10:
            return bytes([0x50, request[1]])
        if service == 0x1A:
            return bytes([0x5A]) + self.ident
        if service == 0x18:
            body = b"".join(
                code.to_bytes(2, "big") + bytes([status]) for code, status in self.faults
            )
            return bytes([0x58, len(self.faults)]) + body
        if service == 0x12:
            if self.freeze_refused:
                return bytes([0x7F, 0x12, 0x11])
            return bytes([0x52, 0x01]) + request[3:5] + b"\x0c\x8a\x31"
        if service == 0x14:
            self.faults = []
            return bytes([0x54, 0xFF, 0x00])
        return bytes([0x7F, service, 0x11])
