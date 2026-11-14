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

# Longest diagnostic message ISO 15765-2 can carry: the first frame's length field is 12 bits.
MAX_ISOTP_MESSAGE = 4095

# CAN data bytes per frame.
FRAME_BYTES = 8

# ELM327 protocol numbers for ISO 15765-4 CAN, keyed by (identifier bits, bit rate).
CAN_PROTOCOLS: dict[tuple[int, int], str] = {
    (11, 500_000): "6",
    (29, 500_000): "7",
    (11, 250_000): "8",
    (29, 250_000): "9",
}

# The ELM327 user-defined CAN protocol B takes its bit rate as a divisor of 500 kbit/s: "baud rate (in kbps) = 500 / (PP 2B value)", the same rule for PP 2D, which holds protocol B's divisor, accepting 01 to 40 hex.
# Source: ELM327 datasheet (Elm Electronics, ELM327DSJ), "Programmable Parameter Summary", PP 2B to 2D; https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
USER_PROTOCOL_BASE_RATE = 500_000
USER_PROTOCOL_MAX_DIVISOR = 0x40

# Protocol B options byte (PP 2C). Bit 7 set means an 11-bit transmit identifier, clear means 29-bit; bit 6 clear means fixed 8-byte frames, which ISO 15765-4 requires; bits 2 to 0 equal to 001 select ISO 15765-4 data formatting, so ATCAF1 and the flow-control commands behave as they do on protocols 6 to 9.
# Source: the same datasheet, PP 2C; its AT PB example for 11-bit ISO 15765 at 50 kbit/s is `AT PB 81 0A`.
USER_PROTOCOL_ISO15765_11_BIT = 0x81
USER_PROTOCOL_ISO15765_29_BIT = 0x01

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

    def __init__(
        self,
        transport: Transport,
        transcript: Transcript | None = None,
        max_request: int = MAX_SINGLE_FRAME,
    ) -> None:
        self._transport = transport
        self._max_request = max_request
        self._transcript = transcript or Transcript()
        self._id_bits = 11
        self._stn = False
        self._request_id: int | None = None

    @property
    def transport(self) -> Transport:
        """The link to the adapter, for the one caller that streams from it instead of exchanging lines."""
        return self._transport

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

    async def require(self, text: str, why: str | None = None) -> None:
        """Send a set-up command that must answer OK.

        Raises AdapterUnsupported when it does not, naming the command and giving `why` (default: the tool needs the full ELM327 command set).
        """
        lines = await self.command(text)
        if "OK" not in lines:
            reason = why or "this tool needs an adapter that implements the full ELM327 command set"
            raise AdapterUnsupported(f"the adapter rejected {text} (replied {lines!r}); {reason}")

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
        info = AdapterInfo(
            identity=" ".join(reset) or (await self._optional("ATI")) or "unknown",
            description=await self._optional("AT@1"),
            stn_identity=await self._optional("STI"),
            voltage=await self._optional("ATRV"),
        )
        self._stn = info.has_stn_extensions
        return info

    async def select_can(self, id_bits: int, bitrate: int) -> None:
        """Select ISO 15765-4 CAN with the given identifier width and bit rate.

        250 and 500 kbit/s use the ELM327 protocols 6 to 9. Any other rate needs either the STN extensions (`STPBR`, checked with `STPBRR`) or, on a plain ELM327, a rate that is 500 kbit/s divided by a whole number from 1 to 64, set through the user-defined protocol B. Raises ElmError for a width or rate no route reaches, and AdapterUnsupported when the adapter rejects the command that sets the rate.
        """
        if id_bits not in (11, 29):
            raise ElmError(f"CAN identifiers are 11 or 29 bits, not {id_bits}")
        if bitrate <= 0:
            raise ElmError(f"a CAN bit rate must be positive, not {bitrate}")
        protocol = CAN_PROTOCOLS.get((id_bits, bitrate))
        if protocol is not None:
            await self.require(f"ATSP{protocol}")
        elif self._stn:
            await self._select_stn_rate(id_bits, bitrate)
        else:
            await self._select_user_protocol(id_bits, bitrate)
        self._id_bits = id_bits

    async def _select_stn_rate(self, id_bits: int, bitrate: int) -> None:
        # STPBR sets "current OBD protocol baud rate", so start from the 500 kbit/s protocol of the right identifier width. The manual says it rounds to the closest rate the hardware can generate and clamps out-of-range values without an error, so STPBRR reads back the rate actually set and any difference is refused.
        # Source: OBDLink Family Reference and Programming Manual (FRPM) revision F, "STPBR" and "STPBRR"; https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
        # Unconfirmed on hardware: whether STPBR takes effect before the protocol is opened, and which rates a given adapter's transceiver supports.
        await self.require(f"ATSP{CAN_PROTOCOLS[(id_bits, 500_000)]}")
        await self.require(
            f"STPBR {bitrate}",
            "the adapter has STN extensions but would not set that bit rate; the manual does not say which rates each model accepts",
        )
        lines = await self.command("STPBRR")
        if len(lines) != 1 or not lines[0].isdigit():
            raise AdapterUnsupported(
                f"the adapter did not report its bit rate after STPBRR (replied {lines!r})"
            )
        actual = int(lines[0])
        if actual != bitrate:
            raise ElmError(f"the adapter set {actual} bit/s when {bitrate} bit/s was requested")

    async def _select_user_protocol(self, id_bits: int, bitrate: int) -> None:
        # A plain ELM327 reaches other rates only through user-defined protocol B: ATPB sets its options byte and baud rate divisor, then ATSPB selects it. The datasheet closes the protocol (ATPC) before sending new values and says they last only until the chip is reset, so every selection sends them.
        # Source: ELM327 datasheet (see USER_PROTOCOL_BASE_RATE), "AT PB", "AT PC" and "AT SP" (protocol B is USER1 CAN, 11-bit ID, 125 kbaud by default).
        # Unconfirmed on hardware: clones that accept ATPB but ignore the divisor.
        divisor, remainder = divmod(USER_PROTOCOL_BASE_RATE, bitrate)
        if remainder or not 1 <= divisor <= USER_PROTOCOL_MAX_DIVISOR:
            raise ElmError(
                f"no ELM327 protocol for {id_bits}-bit CAN at {bitrate} bit/s: a plain ELM327 "
                f"reaches only {USER_PROTOCOL_BASE_RATE} bit/s divided by a whole number from 1 to "
                f"{USER_PROTOCOL_MAX_DIVISOR}; an adapter with the STN extensions accepts other rates"
            )
        options = USER_PROTOCOL_ISO15765_11_BIT if id_bits == 11 else USER_PROTOCOL_ISO15765_29_BIT
        unsupported = (
            "this adapter has no user-defined CAN protocol, so it cannot reach that bit rate"
        )
        await self.require("ATPC", unsupported)
        await self.require(f"ATPB {options:02X} {divisor:02X}", unsupported)
        await self.require("ATSPB", unsupported)

    async def _set_header(self, can_id: int) -> None:
        self._request_id = can_id
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
        if self._stn:
            # Transmit segmentation (STPX) waits for the unit's flow-control frame, which the adapter recognises only for a registered (tester identifier, unit identifier) pair; the defaults cover the legislated identifiers only. "Takes two three-digit or eight-digit parameters: txid is transmitter ID (i.e. ID transmitted by the OBDLink), and rxid is receiver ID (i.e. ID transmitted by the ECU)."
            # Source: OBDLink FRPM revision F, "STCFCPA"; https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
            await self.require(
                f"STCFCPA {self._format_id(request_id)}, {self._format_id(response_id)}",
                "the adapter has STN extensions but would not register the flow-control pair that long requests need",
            )

    async def address_functional(self, request_id: int) -> None:
        """Broadcast requests to every emissions-related unit and accept all replies."""
        await self._set_header(request_id)
        await self.require("ATAR")
        await self.require("ATFCSM0")

    def _long_request_command(self, payload: bytes) -> str:
        if not self._stn:
            raise ElmError(
                f"request of {len(payload)} bytes does not fit a single frame, and a plain ELM327 "
                "cannot send more than one: its datasheet documents no multi-frame sending "
                "(only an adapter with the STN extensions can)"
            )
        if len(payload) > MAX_ISOTP_MESSAGE:
            raise ElmError(
                f"request of {len(payload)} bytes exceeds the {MAX_ISOTP_MESSAGE} bytes ISO 15765-2 can carry"
            )
        # STPX transmits an arbitrary message; "This command will turn on segmentation but will revert segmentation back to its previous state (on or off) after sending the message", so STCSEGT is never left on. `h` is the CAN identifier and `d` the data bytes without the PCI bytes. With segmentation on the first frame, consecutive frames and the wait for the unit's flow control are the adapter's work; the separation time defaults to the unit's STmin.
        # Source: OBDLink FRPM revision F, "STPX" and "STCSEGT"; https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
        # Unconfirmed on hardware: the longest command line an adapter accepts (the manual's `l:` mode exists for messages longer than the UART buffer, and gives 2 kB or 4 kB maxima by model), and whether `h:` takes an eight-digit identifier for 29-bit CAN.
        header = "" if self._request_id is None else f"h:{self._format_id(self._request_id)}, "
        return f"STPX {header}d:{payload.hex().upper()}"

    async def request(self, permit: Permit, timeout: float = 8.0) -> dict[int, list[bytes]]:
        """Send one guarded request and return each sender's reply messages.

        A request over one frame (more than 7 bytes) is sent with the STN `STPX` command, which segments it per ISO 15765-2 and handles the unit's flow control. A plain ELM327 has no documented way to send one, so it refuses.
        Raises NoResponse when no unit answers, and ElmError for an adapter error, an unreadable reply, or a request too long for the adapter or for ISO 15765-2. Raises AdapterUnsupported when an STN adapter rejects STPX.
        """
        payload = permit.payload
        # A link that segments in software (a raw CAN link) takes any length up to its limit as a plain request line; otherwise a request over one frame needs the STN STPX command.
        native_long = MAX_SINGLE_FRAME < len(payload) <= self._max_request
        if len(payload) > self._max_request and self._max_request > MAX_SINGLE_FRAME:
            raise ElmError(
                f"request of {len(payload)} bytes does not fit {self._max_request} bytes"
            )
        long_request = len(payload) > MAX_SINGLE_FRAME and not native_long
        text = self._long_request_command(payload) if long_request else payload.hex().upper()
        lines = await self.command(text, timeout=timeout)
        id_chars = 3 if self._id_bits == 11 else 8
        frames: list[tuple[int, bytes]] = []
        for line in lines:
            compact = line.replace(" ", "").upper()
            if compact in NOISE:
                continue
            if compact == "NODATA":
                raise NoResponse("no control unit answered")
            if compact == "?":
                if long_request:
                    raise AdapterUnsupported(
                        "the adapter rejected STPX (replied '?'); "
                        "it has STN extensions but would not send a request over one frame"
                    )
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
