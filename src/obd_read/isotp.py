"""ISO 15765-2 (ISO-TP): segmenting a message into CAN frames, flow control and reassembly.

Used by the raw CAN links, where no adapter firmware does it. Frame types by the high nibble of the first data byte: 0 single frame, 1 first frame, 2 consecutive frame, 3 flow control.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import IntEnum

from .transport.base import TransportTimeout
from .transport.can import MAX_DATA, CanFrame, CanLink

# Fill byte for the unused tail of a frame. Wikipedia recommends 0xCC; whether a given control unit cares is unconfirmed.
PADDING = 0xCC

# Largest message a twelve-bit first-frame length can announce.
MAX_MESSAGE = 0xFFF

SINGLE_FRAME_PAYLOAD = MAX_DATA - 1
FIRST_FRAME_PAYLOAD = MAX_DATA - 2
CONSECUTIVE_FRAME_PAYLOAD = MAX_DATA - 1

# How many "wait" flow-control frames a receiver may send before the sender gives up.
MAX_WAITS = 10

SINGLE, FIRST, CONSECUTIVE, FLOW_CONTROL = 0, 1, 2, 3


class IsoTpError(Exception):
    """A message could not be sent or received as ISO 15765-2 requires."""


class FlowStatus(IntEnum):
    """The flow-control status nibble."""

    CONTINUE = 0
    WAIT = 1
    OVERFLOW = 2


@dataclass(frozen=True)
class FlowControl:
    """A receiver's flow-control frame: whether to continue, in blocks of what size, how far apart."""

    status: FlowStatus
    block_size: int
    separation: float


def pad(data: bytes) -> bytes:
    """Fill a frame's data to the full eight bytes."""
    return data.ljust(MAX_DATA, bytes([PADDING]))


def segment(payload: bytes) -> list[bytes]:
    """Split one message into the data of its CAN frames, each padded to eight bytes.

    Raises IsoTpError for an empty message or one longer than a first frame can announce.
    """
    if not payload:
        raise IsoTpError("an ISO-TP message cannot be empty")
    if len(payload) > MAX_MESSAGE:
        raise IsoTpError(f"a message of {len(payload)} bytes is longer than ISO-TP carries")
    if len(payload) <= SINGLE_FRAME_PAYLOAD:
        return [pad(bytes([len(payload)]) + payload)]
    frames = [
        bytes([(FIRST << 4) | (len(payload) >> 8), len(payload) & 0xFF])
        + payload[:FIRST_FRAME_PAYLOAD]
    ]
    rest = payload[FIRST_FRAME_PAYLOAD:]
    sequence = 1
    while rest:
        frames.append(pad(bytes([(CONSECUTIVE << 4) | (sequence & 0x0F)]) + rest[:7]))
        rest, sequence = rest[CONSECUTIVE_FRAME_PAYLOAD:], sequence + 1
    return frames


def flow_control_frame(block_size: int = 0, separation: int = 0) -> bytes:
    """A clear-to-send flow-control frame: `block_size` frames per block (0 means all), `separation` as STmin."""
    return pad(bytes([(FLOW_CONTROL << 4) | FlowStatus.CONTINUE, block_size, separation]))


def separation_seconds(value: int) -> float:
    """Decode a flow-control STmin byte: 0 to 127 are milliseconds, 0xF1 to 0xF9 are 100 to 900 microseconds.

    Raises IsoTpError for a reserved value.
    """
    if value <= 0x7F:
        return value / 1000
    if 0xF1 <= value <= 0xF9:
        return (value - 0xF0) / 10_000
    raise IsoTpError(f"reserved separation time {value:#04x}")


def parse_flow_control(data: bytes) -> FlowControl:
    """Read a flow-control frame. Raises IsoTpError when it is not one or its status is reserved."""
    if len(data) < 3 or data[0] >> 4 != FLOW_CONTROL:
        raise IsoTpError(f"not a flow-control frame: {data.hex()}")
    try:
        status = FlowStatus(data[0] & 0x0F)
    except ValueError as error:
        raise IsoTpError(f"reserved flow status in {data.hex()}") from error
    return FlowControl(status, data[1], separation_seconds(data[2]))


@dataclass(frozen=True)
class Received:
    """What one received frame meant."""

    message: bytes | None = None
    frames: tuple[bytes, ...] = ()
    send_flow_control: bool = False


@dataclass
class _Pending:
    length: int
    data: bytearray
    frames: list[bytes]
    next_sequence: int = 1


@dataclass
class Receiver:
    """Reassembles messages from received frames, one pending message per sender."""

    _pending: dict[int, _Pending] = field(default_factory=dict)

    def feed(self, sender: int, data: bytes) -> Received:
        """Take one frame from `sender`.

        Returns the completed message with all of its frames when this frame finished one, and whether the sender is waiting for a flow-control frame. Flow-control frames and consecutive frames of a message that was never started belong to another conversation and mean nothing here. Raises IsoTpError for a malformed frame or a break in a message's sequence.
        """
        if not data:
            raise IsoTpError(f"empty frame from {sender:X}")
        kind = data[0] >> 4
        if kind == SINGLE:
            length = data[0] & 0x0F
            if length == 0 or length > len(data) - 1:
                raise IsoTpError(f"bad single-frame length from {sender:X}: {data.hex()}")
            return Received(bytes(data[1 : 1 + length]), (data,))
        if kind == FIRST:
            if len(data) < MAX_DATA:
                raise IsoTpError(f"short first frame from {sender:X}: {data.hex()}")
            length = ((data[0] & 0x0F) << 8) | data[1]
            if length <= SINGLE_FRAME_PAYLOAD:
                raise IsoTpError(f"first frame from {sender:X} announces {length} bytes")
            self._pending[sender] = _Pending(length, bytearray(data[2:]), [data])
            return Received(send_flow_control=True)
        if kind == CONSECUTIVE:
            pending = self._pending.get(sender)
            if pending is None:
                return Received()
            if data[0] & 0x0F != pending.next_sequence & 0x0F:
                del self._pending[sender]
                raise IsoTpError(
                    f"sequence error from {sender:X}: expected {pending.next_sequence & 0x0F}, "
                    f"got {data[0] & 0x0F}"
                )
            pending.next_sequence += 1
            pending.data.extend(data[1:])
            pending.frames.append(data)
            if len(pending.data) >= pending.length:
                del self._pending[sender]
                return Received(bytes(pending.data[: pending.length]), tuple(pending.frames))
            return Received()
        if kind == FLOW_CONTROL:
            return Received()
        raise IsoTpError(f"unknown frame type from {sender:X}: {data.hex()}")

    def incomplete(self) -> list[int]:
        """The senders whose multi-frame message has not finished."""
        return list(self._pending)


async def send_message(
    link: CanLink,
    can_id: int,
    extended: bool,
    payload: bytes,
    flow_control_id: int,
    timeout: float,
) -> list[CanFrame]:
    """Send one message, waiting for the receiver's flow control between the frames of a long one.

    Returns the frames that arrived meanwhile from anyone but `flow_control_id`'s flow control, so none is lost. Raises IsoTpError when no flow control arrives within `timeout` seconds, the receiver reports overflow, or it asks to wait more than MAX_WAITS times.
    """
    frames = segment(payload)
    await link.send(CanFrame(can_id, frames[0], extended))
    meanwhile: list[CanFrame] = []
    index = 1
    while index < len(frames):
        control = await _flow_control(link, flow_control_id, timeout, meanwhile)
        remaining_in_block = control.block_size or len(frames)
        while remaining_in_block and index < len(frames):
            await link.send(CanFrame(can_id, frames[index], extended))
            index += 1
            remaining_in_block -= 1
            if control.separation:
                await asyncio.sleep(control.separation)
    return meanwhile


async def _flow_control(
    link: CanLink, flow_control_id: int, timeout: float, meanwhile: list[CanFrame]
) -> FlowControl:
    waits = 0
    while True:
        try:
            frame = await link.receive(timeout)
        except TransportTimeout as error:
            raise IsoTpError(f"no flow control from {flow_control_id:X}") from error
        if frame.can_id != flow_control_id or frame.data[:1] == b"" or frame.data[0] >> 4 != 3:
            meanwhile.append(frame)
            continue
        control = parse_flow_control(frame.data)
        if control.status is FlowStatus.OVERFLOW:
            raise IsoTpError(f"{flow_control_id:X} cannot take a message this long")
        if control.status is FlowStatus.WAIT:
            waits += 1
            if waits > MAX_WAITS:
                raise IsoTpError(f"{flow_control_id:X} kept the sender waiting")
            continue
        return control
