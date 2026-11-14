"""A raw CAN link presented as an ELM327 adapter, so the same session code drives either.

The ELM327 commands the session sends are interpreted here and the ISO 15765-2 work, which an ELM327 does in firmware, is done by `obd_read.isotp`. Requests arrive already passed by the guard: this layer adds nothing to the bus beyond the frames of one request and the flow-control frames its reply needs. Commands the session does not use, and the settings this layer does not implement, are answered `?` as a clone adapter would.
"""

from __future__ import annotations

import asyncio
import re

from ..elm import (
    USER_PROTOCOL_BASE_RATE,
    USER_PROTOCOL_ISO15765_11_BIT,
    USER_PROTOCOL_ISO15765_29_BIT,
    USER_PROTOCOL_MAX_DIVISOR,
)
from ..isotp import (
    IsoTpError,
    Receiver,
    flow_control_frame,
    pad,
    send_message,
)
from .base import TransportError, TransportTimeout
from .can import CanFrame, CanLink

IDENTITY = "OBD-READ RAW CAN"

# Longest request, in bytes, that ISO-TP segmentation can carry.
MAX_REQUEST = 0xFFF

# ELM327 protocol numbers for ISO 15765-4 CAN: identifier bits and bit rate. Mirrors the numbers the session selects. Other rates arrive through user-defined protocol B.
PROTOCOLS: dict[str, tuple[int, int]] = {
    "6": (11, 500_000),
    "7": (29, 500_000),
    "8": (11, 250_000),
    "9": (29, 250_000),
}

# Settings the session sends that this layer's fixed behaviour already satisfies.
ACCEPTED = frozenset({"ATE0", "ATL0", "ATS0", "ATH1", "ATCAF1", "ATAT0", "ATFCSM0", "ATFCSM1"})

# ISO 15765-4 response identifier range for 11-bit physical addressing, and the 29-bit prefix that carries the tester address in its low byte.
RESPONSE_11_FIRST, RESPONSE_11_LAST = 0x7E8, 0x7EF
RESPONSE_29_MASK, RESPONSE_29_PREFIX = 0x1FFF_FF00, 0x18DA_F100

# A negative response "response pending" means the final answer is still to come.
NEGATIVE_RESPONSE, RESPONSE_PENDING = 0x7F, 0x78


def request_for(response_id: int, id_bits: int) -> int:
    """The request identifier a response identifier answers: 11-bit minus 8, or 29-bit with target and source swapped."""
    if id_bits == 11:
        return response_id - 8
    return swap_addresses(response_id)


def response_for(request_id: int, id_bits: int) -> int:
    """The response identifier a request identifier is answered on: 11-bit plus 8, or 29-bit with target and source swapped."""
    if id_bits == 11:
        return request_id + 8
    return swap_addresses(request_id)


def swap_addresses(can_id: int) -> int:
    """Swap the two address bytes at the bottom of a 29-bit ISO 15765-4 identifier."""
    return (can_id & 0xFFFF0000) | ((can_id & 0xFF) << 8) | ((can_id >> 8) & 0xFF)


class RawCanTransport:
    """An ELM327 look-alike on a raw CAN link."""

    max_request = MAX_REQUEST

    def __init__(self, link: CanLink, description: str = "") -> None:
        self._link = link
        self._description = description
        self._output = bytearray()
        self._partial = b""
        self._reset()

    def _reset(self) -> None:
        self._id_bits = 11
        self._header_high = 0
        self._header_low: int | None = None
        self._receive_address: int | None = None
        self._flow_header: int | None = None
        self._flow_data = b""
        self._flow_mode = 0
        self._timeout = 1.02
        self._user_protocol: tuple[int, int] | None = None

    @property
    def link(self) -> CanLink:
        """The raw CAN link, for a caller that reads frames directly, such as the bus monitor."""
        return self._link

    async def open(self) -> None:
        await self._link.open()

    async def close(self) -> None:
        await self._link.close()

    async def write(self, data: bytes) -> None:
        self._partial += data
        while b"\r" in self._partial:
            line, _, self._partial = self._partial.partition(b"\r")
            reply = await self._handle(line.decode("ascii", "replace").replace(" ", "").upper())
            self._output += reply.replace("\n", "\r").encode("ascii") + b"\r\r>"

    async def read(self, timeout: float) -> bytes:
        if not self._output:
            raise TransportTimeout("the raw CAN link has nothing to say")
        data, self._output = bytes(self._output), bytearray()
        return data

    async def _handle(self, line: str) -> str:
        if line in ACCEPTED:
            if line.startswith("ATFCSM"):
                self._flow_mode = int(line[-1])
            return "OK"
        if line == "ATZ":
            self._reset()
            return f"{IDENTITY} {self._description}".strip()
        if line == "ATI":
            return IDENTITY
        if line == "ATPC":
            return "OK"
        if re.fullmatch(r"ATPB[0-9A-F]{4}", line):
            return self._define_user_protocol(int(line[4:6], 16), int(line[6:], 16))
        if line == "ATSPB":
            if self._user_protocol is None:
                return "?"
            return await self._start(*self._user_protocol)
        if re.fullmatch(r"ATSP[0-9A-F]", line):
            return await self._select_protocol(line[4:])
        if re.fullmatch(r"ATSH[0-9A-F]{3}", line) and self._id_bits == 11:
            self._header_low = int(line[4:], 16)
            return "OK"
        if re.fullmatch(r"ATSH[0-9A-F]{6}", line) and self._id_bits == 29:
            self._header_low = int(line[4:], 16)
            return "OK"
        if re.fullmatch(r"ATCP[0-9A-F]{2}", line) and self._id_bits == 29:
            self._header_high = int(line[4:], 16) & 0x1F
            return "OK"
        if re.fullmatch(r"ATCRA[0-9A-F]{3}", line) and self._id_bits == 11:
            self._receive_address = int(line[5:], 16)
            return "OK"
        if re.fullmatch(r"ATCRA[0-9A-F]{8}", line) and self._id_bits == 29:
            self._receive_address = int(line[5:], 16)
            return "OK"
        if line == "ATAR":
            self._receive_address = None
            return "OK"
        if re.fullmatch(r"ATFCSH[0-9A-F]{3}", line) and self._id_bits == 11:
            self._flow_header = int(line[6:], 16)
            return "OK"
        if re.fullmatch(r"ATFCSH[0-9A-F]{8}", line) and self._id_bits == 29:
            self._flow_header = int(line[6:], 16)
            return "OK"
        if re.fullmatch(r"ATFCSD(?:[0-9A-F]{2}){1,5}", line):
            self._flow_data = bytes.fromhex(line[6:])
            return "OK"
        if line == "ATSTFF" or re.fullmatch(r"ATST[0-9A-F]{2}", line):
            self._timeout = max(1, int(line[4:], 16)) * 0.004
            return "OK"
        if re.fullmatch(r"(?:[0-9A-F]{2})+", line):
            return await self._request(bytes.fromhex(line))
        return "?"

    async def _select_protocol(self, number: str) -> str:
        if number not in PROTOCOLS:
            return "?"
        return await self._start(*PROTOCOLS[number])

    def _define_user_protocol(self, options: int, divisor: int) -> str:
        """Take the session's ATPB: the options byte names the identifier width and the divisor sets the rate."""
        widths = {USER_PROTOCOL_ISO15765_11_BIT: 11, USER_PROTOCOL_ISO15765_29_BIT: 29}
        if options not in widths or not 1 <= divisor <= USER_PROTOCOL_MAX_DIVISOR:
            return "?"
        self._user_protocol = (widths[options], USER_PROTOCOL_BASE_RATE // divisor)
        return "OK"

    async def _start(self, id_bits: int, bitrate: int) -> str:
        self._id_bits = id_bits
        self._header_low = self._receive_address = None
        await self._link.configure(bitrate, listen_only=False)
        return "OK"

    def _accepts(self, can_id: int) -> bool:
        if self._receive_address is not None:
            return can_id == self._receive_address
        if self._id_bits == 11:
            return RESPONSE_11_FIRST <= can_id <= RESPONSE_11_LAST
        return can_id & RESPONSE_29_MASK == RESPONSE_29_PREFIX

    def _flow_target(self, sender: int, request_id: int) -> int:
        if self._flow_mode == 1 and self._flow_header is not None:
            return self._flow_header
        if self._receive_address is not None:
            return request_id
        return request_for(sender, self._id_bits)

    async def _request(self, payload: bytes) -> str:
        if self._header_low is None:
            return "?"
        extended = self._id_bits == 29
        request_id = (self._header_high << 24 if extended else 0) | self._header_low
        digits = 8 if extended else 3
        receiver = Receiver()
        lines: list[str] = []
        final = False
        try:
            expected_flow = (
                self._receive_address
                if self._receive_address is not None
                else response_for(request_id, self._id_bits)
            )
            queued = await send_message(
                self._link, request_id, extended, payload, expected_flow, self._timeout
            )
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._timeout
            pending = list(queued)
            while not final:
                if pending:
                    frame = pending.pop(0)
                else:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        break
                    try:
                        frame = await self._link.receive(remaining)
                    except TransportTimeout:
                        break
                if frame.extended != extended or not self._accepts(frame.can_id):
                    continue
                received = receiver.feed(frame.can_id, frame.data)
                if received.send_flow_control:
                    control = (
                        pad(self._flow_data)
                        if self._flow_mode == 1 and self._flow_data
                        else flow_control_frame()
                    )
                    target = self._flow_target(frame.can_id, request_id)
                    await self._link.send(CanFrame(target, control, extended))
                if received.message is not None:
                    lines += [
                        f"{frame.can_id:0{digits}X}{raw.hex().upper()}" for raw in received.frames
                    ]
                    answered = received.message
                    pending_answer = (
                        len(answered) >= 3
                        and answered[0] == NEGATIVE_RESPONSE
                        and answered[2] == RESPONSE_PENDING
                    )
                    final = self._receive_address is not None and not pending_answer
            incomplete = receiver.incomplete()
        except (IsoTpError, TransportError) as error:
            return f"CAN ERROR: {error}"
        if incomplete:
            senders = ", ".join(f"{sender:X}" for sender in incomplete)
            return f"CAN ERROR: multi-frame reply cut short from {senders}"
        return "\n".join(lines) if lines else "NO DATA"
