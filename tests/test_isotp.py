import pytest

from obd_read.elm import isotp_reassemble
from obd_read.isotp import (
    PADDING,
    FlowStatus,
    IsoTpError,
    Receiver,
    flow_control_frame,
    parse_flow_control,
    segment,
    send_message,
    separation_seconds,
)
from obd_read.transport import TransportTimeout
from obd_read.transport.can import CanFrame

from .fake_elm import isotp_frames


def test_a_short_message_is_one_padded_frame() -> None:
    assert segment(bytes([0x10, 0x92])) == [bytes([0x02, 0x10, 0x92]) + bytes([PADDING]) * 5]


@pytest.mark.parametrize("length", [8, 13, 14, 20, 100, 4095])
def test_segmentation_matches_the_adapter_layers_reassembly(length: int) -> None:
    payload = bytes(index % 251 for index in range(length))
    frames = segment(payload)
    assert all(len(frame) == 8 for frame in frames)
    assert [frame[:2] for frame in frames[:1]] == [bytes([0x10 | (length >> 8), length & 0xFF])]
    assert isotp_reassemble([(0x7E8, frame) for frame in frames]) == {0x7E8: [payload]}
    assert frames[0].rstrip(bytes([PADDING])) == isotp_frames(payload)[0]


def test_sequence_numbers_wrap_after_fifteen() -> None:
    frames = segment(bytes(6 + 7 * 17))
    sequence = [frame[0] & 0x0F for frame in frames[1:]]
    assert sequence == [*range(1, 16), 0, 1]
    assert all(frame[0] >> 4 == 2 for frame in frames[1:])


@pytest.mark.parametrize("payload", [b"", bytes(4096)])
def test_unsendable_messages_are_refused(payload: bytes) -> None:
    with pytest.raises(IsoTpError):
        segment(payload)


def test_receiver_reassembles_per_sender_and_asks_for_flow_control_once() -> None:
    payload = bytes(range(30))
    frames = segment(payload)
    receiver = Receiver()
    first = receiver.feed(0x7E8, frames[0])
    assert first.send_flow_control and first.message is None
    other = receiver.feed(0x7E9, segment(b"\x41\x00")[0])
    assert other.message == b"\x41\x00"
    done = None
    for frame in frames[1:]:
        result = receiver.feed(0x7E8, frame)
        assert not result.send_flow_control
        done = result
    assert done is not None and done.message == payload and done.frames == tuple(frames)
    assert receiver.incomplete() == []


def test_receiver_ignores_traffic_that_is_not_its_conversation() -> None:
    receiver = Receiver()
    assert receiver.feed(0x7E8, flow_control_frame()).message is None
    assert receiver.feed(0x7E8, bytes([0x21]) + bytes(7)) == receiver.feed(
        0x7E8, flow_control_frame()
    )


@pytest.mark.parametrize(
    "data",
    [
        b"",
        bytes([0x00, 1]),
        bytes([0x09, 1, 2]),
        bytes([0x10, 0x03, 0, 0, 0, 0, 0, 0]),
        bytes([0x10, 20]),
        bytes([0x40]),
    ],
)
def test_malformed_frames_are_errors(data: bytes) -> None:
    with pytest.raises(IsoTpError):
        Receiver().feed(0x7E8, data)


def test_a_broken_sequence_is_an_error_and_forgets_the_message() -> None:
    frames = segment(bytes(30))
    receiver = Receiver()
    receiver.feed(0x7E8, frames[0])
    with pytest.raises(IsoTpError, match="sequence"):
        receiver.feed(0x7E8, frames[2])
    assert receiver.incomplete() == []


def test_flow_control_parsing() -> None:
    control = parse_flow_control(bytes([0x30, 4, 0x0A]))
    assert (control.status, control.block_size, control.separation) == (
        FlowStatus.CONTINUE,
        4,
        0.01,
    )
    assert separation_seconds(0xF3) == pytest.approx(0.0003)
    for bad in (bytes([0x33, 0, 0]), bytes([0x30, 0, 0x80]), bytes([0x20, 0, 0]), b"\x30"):
        with pytest.raises(IsoTpError):
            parse_flow_control(bad)


class ScriptedLink:
    """A link that hands out scripted frames in order and records what was sent."""

    def __init__(self, script: list[CanFrame]) -> None:
        self.script = script
        self.sent: list[CanFrame] = []

    async def open(self) -> None: ...
    async def configure(self, bitrate: int, listen_only: bool) -> None: ...
    async def close(self) -> None: ...

    async def send(self, frame: CanFrame) -> None:
        self.sent.append(frame)

    async def receive(self, timeout: float) -> CanFrame:
        if not self.script:
            raise TransportTimeout("script exhausted")
        return self.script.pop(0)


def flow(status: int, block: int = 0) -> CanFrame:
    return CanFrame(0x7E8, bytes([0x30 | status, block, 0]))


async def test_a_long_message_waits_for_flow_control_each_block() -> None:
    payload = bytes(range(30))  # first frame plus four consecutive frames
    stray = CanFrame(0x123, b"\x01\x02")
    link = ScriptedLink([flow(0, 2), stray, flow(0, 2)])
    meanwhile = await send_message(link, 0x7E0, False, payload, 0x7E8, 0.1)
    assert [frame.data for frame in link.sent] == segment(payload)
    assert meanwhile == [stray]
    assert link.script == []


async def test_wait_frames_defer_the_next_block() -> None:
    link = ScriptedLink([flow(1), flow(1), flow(0)])
    await send_message(link, 0x7E0, False, bytes(20), 0x7E8, 0.1)
    assert len(link.sent) == len(segment(bytes(20)))


@pytest.mark.parametrize(
    ("script", "message"),
    [
        ([], "no flow control"),
        ([flow(2)], "cannot take"),
        ([flow(1)] * 11, "kept the sender waiting"),
    ],
)
async def test_flow_control_failures_are_errors(script: list[CanFrame], message: str) -> None:
    with pytest.raises(IsoTpError, match=message):
        await send_message(ScriptedLink(script), 0x7E0, False, bytes(20), 0x7E8, 0.1)


async def test_a_single_frame_needs_no_flow_control() -> None:
    link = ScriptedLink([])
    assert await send_message(link, 0x7E0, False, b"\x01\x00", 0x7E8, 0.1) == []
    assert len(link.sent) == 1
