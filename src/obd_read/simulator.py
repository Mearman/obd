"""A scripted ELM327 adapter and car: the stand-in the tests use, and the `simulate` command's server.

Nothing here talks to hardware. The adapter interprets the AT commands this tool sends and answers diagnostic requests from per-header responders, so the whole tool can be exercised without a car.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable

from .guard import DiagProtocol
from .profile import Profile, load_profile

# A responder takes one request payload and returns (sender identifier, reply payload) pairs.
Responder = Callable[[bytes], list[tuple[int, bytes]]]

# Functional request identifier legislated OBD-II requests are broadcast to, 11-bit.
FUNCTIONAL_REQUEST_ID = 0x7DF

# The vehicle identification number the simulated car reports; it belongs to no real car.
SIMULATED_VIN = b"SIMULATEDCAR00001"


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
        stn_identity: str | None = None,
    ) -> None:
        self.responders = responders
        self.unsupported = unsupported
        self.identity = identity
        self.stn_identity = stn_identity
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
            return self.stn_identity or "?"
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


async def serve_cars(
    make_core: Callable[[], FakeElmCore], host: str = "127.0.0.1", port: int = 0
) -> asyncio.Server:
    """Serve a fake adapter over TCP, giving each connection its own core from `make_core`.

    Port 0 picks a free port.
    """

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        core = make_core()
        while data := await reader.read(1024):
            writer.write(core.feed(data))
            await writer.drain()
        writer.close()

    return await asyncio.start_server(handle, host, port)


async def serve(core: FakeElmCore) -> asyncio.Server:
    """Serve one fake adapter on a free local TCP port; every connection shares `core`."""
    return await serve_cars(lambda: core)


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


class UdsEcu:
    """A UDS control unit with stored fault codes (three code bytes and a status byte each)."""

    def __init__(self, response_id: int, faults: list[tuple[int, int]]) -> None:
        self.response_id = response_id
        self.faults = list(faults)

    def __call__(self, request: bytes) -> list[tuple[int, bytes]]:
        return [(self.response_id, self.reply(request))]

    def reply(self, request: bytes) -> bytes:
        service = request[0]
        if service == 0x10:
            return bytes([0x50, request[1], 0x00, 0x32, 0x01, 0xF4])
        if service == 0x22:
            identifier = int.from_bytes(request[1:3], "big")
            if identifier == 0xF190:
                return bytes([0x62]) + request[1:3] + SIMULATED_VIN
            return bytes([0x7F, service, 0x31])
        if service == 0x19 and request[1] == 0x02:
            records = b"".join(
                code.to_bytes(3, "big") + bytes([status]) for code, status in self.faults
            )
            return bytes([0x59, 0x02, 0xFF]) + records
        if service == 0x19 and request[1] == 0x04:
            status = next(
                (status for code, status in self.faults if code.to_bytes(3, "big") == request[2:5]),
                None,
            )
            if status is None:
                return bytes([0x7F, service, 0x31])
            return bytes([0x59, 0x04]) + request[2:5] + bytes([status, 0x01, 0x01])
        if service == 0x14:
            self.faults = []
            return bytes([0x54])
        if service == 0x3E:
            return bytes([0x7E, 0x00])
        return bytes([0x7F, service, 0x11])


def obd_responder(request: bytes) -> list[tuple[int, bytes]]:
    """The legislated OBD-II reads a simulated engine unit answers: VIN and stored codes."""
    replies: dict[bytes, bytes] = {
        bytes([0x09, 0x02]): bytes([0x49, 0x02, 0x01]) + SIMULATED_VIN,
        bytes([0x01, 0x01]): bytes.fromhex("410181000000"),
        bytes([0x03]): bytes.fromhex("43010420"),
        bytes([0x07]): bytes.fromhex("4700"),
    }
    reply = replies.get(request)
    return [] if reply is None else [(0x7E8, reply)]


# The one fault every simulated unit holds, so reads, freeze frames and clears have something to
# show. These bytes are invented and mean nothing on a real car.
SIMULATED_KWP_FAULT = (0x1234, 0x20)
SIMULATED_UDS_FAULT = (0xC12345, 0x08)


def simulated_car(profile: Profile) -> FakeElmCore:
    """A fresh adapter wired to one scripted unit per profile unit, plus OBD-II on the functional ID."""
    responders: dict[int, Responder] = {FUNCTIONAL_REQUEST_ID: obd_responder}
    for unit in profile.units.values():
        if profile.protocol is DiagProtocol.UDS:
            responders[unit.request_id] = UdsEcu(unit.response_id, [SIMULATED_UDS_FAULT])
        else:
            responders[unit.request_id] = KwpEcu(unit.response_id, [SIMULATED_KWP_FAULT])
    return FakeElmCore(responders)


async def start_simulator(profile: Profile, host: str, port: int) -> asyncio.Server:
    """Listen for adapter connections; each gets its own simulated car, untouched by the others."""
    return await serve_cars(lambda: simulated_car(profile), host, port)


async def simulate_command(args: argparse.Namespace, out: Callable[[str], None]) -> int:
    """Run the simulated adapter until interrupted. Connects to nothing and needs no hardware."""
    profile = load_profile(args.profile)
    server = await start_simulator(profile, args.host, args.port)
    host, port = server.sockets[0].getsockname()[:2]
    out(f"simulating {profile.name} ({len(profile.units)} units) on tcp://{host}:{port}")
    out("each connection gets a fresh car; press Ctrl-C to stop")
    async with server:
        await server.serve_forever()
    return 0
