"""An ELM327 session: adapter set-up, addressing and one request with its replies."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .guard import Permit
from .transport import Transport, TransportTimeout

PROMPT = b">"

# Longest request the adapter can send as a single CAN frame: 8 data bytes less the length byte.
MAX_SINGLE_FRAME = 7

# CAN data bytes per frame.
FRAME_BYTES = 8

# ELM327 protocol numbers for ISO 15765-4 CAN, keyed by (identifier bits, bit rate).
CAN_PROTOCOLS: dict[tuple[int, int], str] = {
    (11, 500_000): "6",
    (29, 500_000): "7",
    (11, 250_000): "8",
    (29, 250_000): "9",
}

# Replies that mean the adapter could not complete the request.
ADAPTER_ERRORS = (
    "CANERROR",
    "BUFFERFULL",
    "BUSBUSY",
    "BUSERROR",
    "UNABLETOCONNECT",
    "STOPPED",
    "ERROR",
    "FBERROR",
    "DATAERROR",
    "RXERROR",
    "ACTALERT",
    "LVRESET",
    "LPALERT",
)

# Status lines the adapter prints that carry no data.
NOISE = ("SEARCHING...", "BUSINIT:OK", "BUSINIT:...OK")


class ElmError(Exception):
    """The adapter reported an error or replied with something unreadable."""


class AdapterUnsupported(ElmError):
    """The adapter rejected a command this tool depends on."""


class NoResponse(ElmError):
    """The adapter sent the request and no control unit answered."""


class Transcript:
    """Everything sent to and received from the adapter, in order."""

    def __init__(self, path: Path | None = None) -> None:
        self.entries: list[str] = []
        self._path = path

    def record(self, direction: str, text: str) -> None:
        """Add one line; `direction` is `>` for sent and `<` for received."""
        entry = f"{datetime.now(UTC).isoformat(timespec='milliseconds')} {direction} {text}"
        self.entries.append(entry)
        if self._path is not None:
            with self._path.open("a", encoding="utf-8") as log:
                log.write(entry + "\n")


@dataclass(frozen=True)
class AdapterInfo:
    """What the adapter says about itself."""

    identity: str
    description: str | None
    stn_identity: str | None
    voltage: str | None

    @property
    def has_stn_extensions(self) -> bool:
        """Whether the adapter answered the STN identity command, so ST commands exist."""
        return self.stn_identity is not None


def isotp_reassemble(frames: list[tuple[int, bytes]]) -> dict[int, list[bytes]]:
    """Rebuild diagnostic messages from CAN frames, per sender.

    Each frame is (CAN identifier, data bytes). Returns every complete message each sender sent, in order. Raises ElmError for a frame that does not fit ISO 15765-2 or a multi-frame message cut short.
    """
    complete: dict[int, list[bytes]] = {}
    pending: dict[int, tuple[int, bytearray]] = {}
    for can_id, data in frames:
        if not data:
            raise ElmError(f"empty frame from {can_id:X}")
        kind = data[0] >> 4
        if kind == 0:
            length = data[0] & 0x0F
            if length == 0 or length > len(data) - 1:
                raise ElmError(f"bad single-frame length from {can_id:X}: {data.hex()}")
            complete.setdefault(can_id, []).append(bytes(data[1 : 1 + length]))
        elif kind == 1:
            if len(data) < 2:
                raise ElmError(f"short first frame from {can_id:X}: {data.hex()}")
            length = ((data[0] & 0x0F) << 8) | data[1]
            pending[can_id] = (length, bytearray(data[2:]))
        elif kind == 2:
            if can_id not in pending:
                raise ElmError(f"continuation frame with no first frame from {can_id:X}")
            length, buffer = pending[can_id]
            buffer.extend(data[1:])
            if len(buffer) >= length:
                complete.setdefault(can_id, []).append(bytes(buffer[:length]))
                del pending[can_id]
        elif kind == 3:
            continue  # flow control from another tester on the bus
        else:
            raise ElmError(f"unknown frame type from {can_id:X}: {data.hex()}")
    if pending:
        senders = ", ".join(f"{can_id:X}" for can_id in pending)
        raise ElmError(f"multi-frame reply cut short from {senders}")
    return complete


class Elm:
    """One ELM327-style adapter, driven over a transport."""

    def __init__(self, transport: Transport, transcript: Transcript | None = None) -> None:
        self._transport = transport
        self._transcript = transcript or Transcript()
        self._id_bits = 11

    @property
    def transcript(self) -> Transcript:
        return self._transcript

    async def command(self, text: str, timeout: float = 5.0) -> list[str]:
        """Send one line and return the reply lines up to the adapter's prompt.

        Raises ElmError when no prompt arrives within `timeout` seconds.
        """
        self._transcript.record(">", text)
        await self._transport.write(text.encode("ascii") + b"\r")
        buffer = bytearray()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while PROMPT not in buffer:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise ElmError(f"no prompt from the adapter after {text!r}")
            try:
                buffer.extend(await self._transport.read(remaining))
            except TransportTimeout as error:
                raise ElmError(f"no prompt from the adapter after {text!r}") from error
        reply = bytes(buffer).split(PROMPT)[0].decode("ascii", "replace")
        lines = [line.strip() for line in re.split(r"[\r\n]+", reply) if line.strip()]
        if lines and lines[0].replace(" ", "").upper() == text.replace(" ", "").upper():
            lines = lines[1:]  # the adapter echoed the command
        for line in lines:
            self._transcript.record("<", line)
        return lines

    async def require(self, text: str) -> None:
        """Send a set-up command that must answer OK.

        Raises AdapterUnsupported when it does not, naming the command.
        """
        lines = await self.command(text)
        if "OK" not in lines:
            raise AdapterUnsupported(
                f"the adapter rejected {text} (replied {lines!r}); "
                "this tool needs an adapter that implements the full ELM327 command set"
            )

    async def _optional(self, text: str) -> str | None:
        lines = await self.command(text)
        if not lines or lines == ["?"]:
            return None
        return " ".join(lines)

    async def initialise(self) -> AdapterInfo:
        """Reset the adapter and put it in the state every request assumes.

        Raises AdapterUnsupported when the adapter lacks a command this tool depends on.
        """
        reset = await self.command("ATZ", timeout=10.0)
        await self.require("ATE0")  # no echo
        await self.require("ATL0")  # no line feeds
        await self.require("ATS0")  # no spaces in replies
        await self.require("ATH1")  # show the sender's identifier on every frame
        await self.require("ATCAF1")  # the adapter adds the length byte to requests
        await self.require("ATAT0")  # fixed reply timeout, so a silent unit costs a known wait
        await self.require("ATSTFF")  # the longest reply timeout the adapter offers
        return AdapterInfo(
            identity=" ".join(reset) or (await self._optional("ATI")) or "unknown",
            description=await self._optional("AT@1"),
            stn_identity=await self._optional("STI"),
            voltage=await self._optional("ATRV"),
        )

    async def select_can(self, id_bits: int, bitrate: int) -> None:
        """Select ISO 15765-4 CAN with the given identifier width and bit rate.

        Raises ElmError for a combination the ELM327 command set has no protocol for.
        """
        protocol = CAN_PROTOCOLS.get((id_bits, bitrate))
        if protocol is None:
            raise ElmError(f"no ELM327 protocol for {id_bits}-bit CAN at {bitrate} bit/s")
        await self.require(f"ATSP{protocol}")
        self._id_bits = id_bits

    async def _set_header(self, can_id: int) -> None:
        if self._id_bits == 11:
            await self.require(f"ATSH{can_id:03X}")
        else:
            await self.require(f"ATCP{can_id >> 24:02X}")
            await self.require(f"ATSH{can_id & 0xFFFFFF:06X}")

    def _format_id(self, can_id: int) -> str:
        return f"{can_id:03X}" if self._id_bits == 11 else f"{can_id:08X}"

    async def address_unit(self, request_id: int, response_id: int) -> None:
        """Direct requests to one control unit and accept replies only from it."""
        await self._set_header(request_id)
        await self.require(f"ATCRA{self._format_id(response_id)}")
        # Flow control for multi-frame replies goes back to the unit on its request identifier: send everything, no delay between frames.
        await self.require(f"ATFCSH{self._format_id(request_id)}")
        await self.require("ATFCSD300000")
        await self.require("ATFCSM1")

    async def address_functional(self, request_id: int) -> None:
        """Broadcast requests to every emissions-related unit and accept all replies."""
        await self._set_header(request_id)
        await self.require("ATAR")
        await self.require("ATFCSM0")

    async def request(self, permit: Permit, timeout: float = 8.0) -> dict[int, list[bytes]]:
        """Send one guarded request and return each sender's reply messages.

        Raises NoResponse when no unit answers, and ElmError for an adapter error, an unreadable reply or a request too long for a single frame.
        """
        payload = permit.payload
        if len(payload) > MAX_SINGLE_FRAME:
            raise ElmError(f"request of {len(payload)} bytes does not fit a single frame")
        lines = await self.command(payload.hex().upper(), timeout=timeout)
        id_chars = 3 if self._id_bits == 11 else 8
        frames: list[tuple[int, bytes]] = []
        for line in lines:
            compact = line.replace(" ", "").upper()
            if compact in NOISE:
                continue
            if compact == "NODATA":
                raise NoResponse("no control unit answered")
            if compact == "?":
                raise ElmError(f"the adapter did not understand {payload.hex().upper()}")
            if compact.startswith(ADAPTER_ERRORS):
                raise ElmError(f"adapter error: {line}")
            body = compact[id_chars:]
            if (
                not re.fullmatch(r"[0-9A-F]+", compact)
                or len(body) % 2
                or not 2 <= len(body) <= 2 * FRAME_BYTES
            ):
                raise ElmError(f"unreadable reply line: {line!r}")
            frames.append((int(compact[:id_chars], 16), bytes.fromhex(body)))
        if not frames:
            raise NoResponse("no control unit answered")
        return isotp_reassemble(frames)
