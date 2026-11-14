import socket
import sys

import pytest

from obd_read.cli import run
from obd_read.elm import Elm, ElmError, NoResponse
from obd_read.guard import DiagProtocol, permit
from obd_read.isotp import segment
from obd_read.transport import (
    Transport,
    TransportError,
    open_transport,
    parse_adapter_url,
    slcan,
    socketcan,
)
from obd_read.transport.can import CanFrame
from obd_read.transport.rawcan import RawCanTransport, request_for, response_for, swap_addresses

from .fake_can import FakeCanLink
from .fake_elm import KwpEcu

ADAPTER = ["--adapter", "socketcan://can0", "--profile", "mercedes-w211"]


class RawCar:
    """A fake W211 on a raw CAN link."""

    def __init__(self) -> None:
        self.esp = KwpEcu(0x785, [(0x5123, 0x61)])
        self.link = FakeCanLink(
            {0x7E0: KwpEcu(0x7E8, []), 0x784: self.esp}, {0x7E0: 0x7E8, 0x784: 0x785}
        )
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return RawCanTransport(self.link, "test")

    async def run(self, *argv: str) -> int:
        return await run(list(argv), self.lines.append, lambda _p: "", self.factory)

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


async def test_probe_and_faults_work_over_a_raw_link() -> None:
    car = RawCar()
    assert await car.run("probe", *ADAPTER) == 0
    assert "engine (7E0 -> 7E8): answered" in car.output
    assert "esp (784 -> 785): answered" in car.output
    assert "kombi (796 -> 797): no answer" in car.output
    assert car.link.configured == [(500_000, False)]
    assert car.link.opened and car.link.closed
    car.lines.clear()
    assert await car.run("faults", "esp", *ADAPTER) == 0
    assert "5123  status 61" in car.output


async def test_multi_frame_replies_get_flow_control_from_the_tool() -> None:
    car = RawCar()
    assert await car.run("ident", "esp", *ADAPTER) == 0
    assert "A6421500000 E280CDI" in car.output
    control = [frame for frame in car.link.sent if frame.data[0] >> 4 == 3]
    assert control and all(frame.can_id == 0x784 for frame in control)
    assert control[0].data[:3] == bytes([0x30, 0, 0])


async def test_requests_longer_than_one_frame_are_sent_segmented() -> None:
    car = RawCar()
    request = bytes.fromhex("21" + "00" * 12)
    seen: list[bytes] = []

    def unit(payload: bytes) -> list[tuple[int, bytes]]:
        seen.append(payload)
        return [(0x785, bytes([0x61, 0x00]))]

    car.link.responders[0x784] = unit
    status = await car.run("request", "esp", request.hex(), *ADAPTER)
    assert status == 0
    assert seen == [request]
    assert car.link.sent[0].data == segment(request)[0]
    assert car.output.endswith("6100")


async def test_the_guard_still_refuses_writes_before_anything_is_sent() -> None:
    car = RawCar()
    assert await car.run("request", "esp", "2E0101", *ADAPTER) == 1
    assert "refused" in car.output
    assert car.link.sent == []


async def test_a_silent_unit_is_no_response_and_a_cut_short_reply_is_an_error() -> None:
    link = FakeCanLink({})
    elm = Elm(RawCanTransport(link), max_request=4095)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x7E0, 0x7E8)
    with pytest.raises(NoResponse):
        await elm.request(permit(DiagProtocol.OBD, bytes([0x01, 0x00])))
    link.inject(0x7E8, bytes([0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x32, 0x33]))
    link._queue.insert(0, link._queue.pop())  # the cut-short first frame is already on the bus
    with pytest.raises(ElmError, match="cut short"):
        await elm.request(permit(DiagProtocol.OBD, bytes([0x09, 0x02])))


async def test_functional_requests_collect_every_responder() -> None:
    link = FakeCanLink(
        {
            0x7E0: lambda request: [(0x7E8, bytes([0x41, request[1], 1]))],
            0x7E1: lambda request: [(0x7E9, bytes([0x41, request[1], 2]))],
        }
    )
    elm = Elm(RawCanTransport(link))
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_functional(0x7DF)
    replies = await elm.request(permit(DiagProtocol.OBD, bytes([0x01, 0x05])))
    assert replies == {0x7E8: [bytes([0x41, 5, 1])], 0x7E9: [bytes([0x41, 5, 2])]}


async def test_29_bit_addressing_pairs_identifiers() -> None:
    link = FakeCanLink({0x18DA10F1: lambda _r: [(0x18DAF110, bytes([0x50, 0x81]))]})
    elm = Elm(RawCanTransport(link))
    await elm.initialise()
    await elm.select_can(29, 250_000)
    await elm.address_unit(0x18DA10F1, 0x18DAF110)
    replies = await elm.request(permit(DiagProtocol.KWP2000, bytes([0x10, 0x81])))
    assert replies == {0x18DAF110: [bytes([0x50, 0x81])]}
    assert link.configured == [(250_000, False)]
    assert link.sent[0].extended and link.sent[0].can_id == 0x18DA10F1


def test_identifier_pairs() -> None:
    assert response_for(0x7E0, 11) == 0x7E8 and request_for(0x7E8, 11) == 0x7E0
    assert swap_addresses(0x18DAF110) == 0x18DA10F1
    assert response_for(0x18DA10F1, 29) == 0x18DAF110


async def test_unsupported_commands_are_refused_like_a_clone_would() -> None:
    transport = RawCanTransport(FakeCanLink({}))
    for command in ("ATSP1", "ATH0", "ATD", "ATSH12", "0100"):
        await transport.write(command.encode() + b"\r")
        assert (await transport.read(0.1)).startswith(b"?")
    with pytest.raises(TransportError):
        await transport.read(0.01)


def test_socketcan_frames_round_trip() -> None:
    standard = CanFrame(0x7E8, bytes([0x06, 0x41, 0x00, 0xBE, 0x3F, 0xA8, 0x13]))
    extended = CanFrame(0x18DAF110, b"\x01\x02", extended=True)
    for frame in (standard, extended):
        assert socketcan.decode_frame(socketcan.encode_frame(frame)) == frame
    assert len(socketcan.encode_frame(standard)) == 16
    remote = socketcan.CAN_FRAME.pack(0x7E8 | socketcan.REMOTE_FLAG, 0, bytes(8))
    assert socketcan.decode_frame(remote) is None


async def test_socketcan_without_the_socket_family_fails_clearly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(socketcan, "can_family", lambda: None)
    with pytest.raises(TransportError, match="Linux"):
        await socketcan.SocketCanLink("can0").open()


@pytest.mark.skipif(sys.platform == "linux", reason="Linux has the socket family")
def test_this_platform_has_no_can_family() -> None:
    assert socketcan.can_family() is None
    assert not hasattr(socket, "AF_CAN")


async def test_a_missing_interface_is_a_transport_error() -> None:
    with pytest.raises(TransportError):
        await socketcan.SocketCanLink("no-such-can9").open()


def test_can_urls_build_raw_transports() -> None:
    assert parse_adapter_url("socketcan://can0").target == "can0"
    assert parse_adapter_url("slcan:///dev/ttyACM0?baud=921600").params == {"baud": "921600"}
    assert isinstance(open_transport("socketcan://can0"), RawCanTransport)
    assert isinstance(open_transport("slcan:///dev/ttyACM0"), RawCanTransport)


def test_slcan_frame_text() -> None:
    assert slcan.encode_frame(CanFrame(0x456, bytes([0x11, 0x22, 0x33]))) == b"t4563112233\r"
    assert (
        slcan.encode_frame(CanFrame(0x12ABCDEF, b"\xaa\x55", extended=True)) == b"T12ABCDEF2AA55\r"
    )
    assert slcan.decode_frame(b"t1230") == CanFrame(0x123, b"")
    assert slcan.decode_frame(b"T12ABCDEF2AA55") == CanFrame(0x12ABCDEF, b"\xaa\x55", extended=True)
    assert slcan.decode_frame(b"r1230") is None
    assert slcan.decode_frame(b"z") is None
    with pytest.raises(TransportError):
        slcan.decode_frame(b"t12331122")


class FakeSlcanDevice:
    """A byte pipe that behaves like an SLCAN adapter, with frames to deliver and commands recorded."""

    def __init__(self, refuse: frozenset[str] = frozenset()) -> None:
        self.commands: list[str] = []
        self.refuse = refuse
        self.incoming = b""
        self.opened = self.closed = False

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    async def write(self, data: bytes) -> None:
        for line in data.split(b"\r")[:-1]:
            text = line.decode("ascii")
            self.commands.append(text)
            if text in self.refuse:
                self.incoming += b"\x07"
            elif text[:1] in ("t", "T"):
                self.incoming += b"z\r"
            else:
                self.incoming += b"\r"

    async def read(self, timeout: float) -> bytes:
        from obd_read.transport import TransportTimeout

        if not self.incoming:
            raise TransportTimeout("quiet")
        data, self.incoming = self.incoming[:3], self.incoming[3:]
        return data


async def test_slcan_configures_sends_and_receives() -> None:
    device = FakeSlcanDevice(refuse=frozenset({"C"}))
    link = slcan.SlcanLink(device)
    await link.open()
    await link.configure(500_000, listen_only=False)
    assert device.commands == ["C", "S6", "O"]
    await link.send(CanFrame(0x7E0, bytes([2, 0x10, 0x92])))
    assert device.commands[-1] == "t7E0302109 2".replace(" ", "")
    device.incoming += b"t7E8 2 5092\r".replace(b" ", b"") + b"T18DAF1100 \r".replace(b" ", b"")
    assert await link.receive(0.1) == CanFrame(0x7E8, bytes([0x50, 0x92]))
    assert await link.receive(0.1) == CanFrame(0x18DAF110, b"", extended=True)
    await link.close()
    assert device.commands[-1] == "C" and device.closed


async def test_slcan_listen_only_and_refusals() -> None:
    device = FakeSlcanDevice()
    link = slcan.SlcanLink(device)
    await link.configure(250_000, listen_only=True)
    assert device.commands == ["C", "S5", "L"]
    with pytest.raises(TransportError, match="no setting"):
        await link.configure(83_333, listen_only=False)
    with pytest.raises(TransportError, match="refused"):
        await slcan.SlcanLink(FakeSlcanDevice(refuse=frozenset({"S6"}))).configure(500_000, False)


async def test_a_session_runs_over_slcan() -> None:
    device = FakeSlcanDevice()
    elm = Elm(RawCanTransport(slcan.SlcanLink(device)))
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x7E0, 0x7E8)
    device.incoming += b"t7E88025092CCCCCCCCCC\r"
    replies = await elm.request(permit(DiagProtocol.KWP2000, bytes([0x10, 0x92])))
    assert replies == {0x7E8: [bytes([0x50, 0x92])]}
    assert "t7E08021092CCCCCCCCCC" in device.commands


@pytest.mark.parametrize(("id_bits", "bitrate"), [(11, 125_000), (29, 100_000), (11, 10_000)])
async def test_other_bit_rates_go_through_user_protocol_b(id_bits: int, bitrate: int) -> None:
    link = FakeCanLink({})
    elm = Elm(RawCanTransport(link))
    await elm.initialise()
    await elm.select_can(id_bits, bitrate)
    assert link.configured == [(bitrate, False)]


async def test_a_rate_the_session_cannot_express_is_refused_before_the_link_is_touched() -> None:
    link = FakeCanLink({})
    elm = Elm(RawCanTransport(link))
    await elm.initialise()
    with pytest.raises(ElmError, match="whole number"):
        await elm.select_can(11, 83_333)
    assert link.configured == []
