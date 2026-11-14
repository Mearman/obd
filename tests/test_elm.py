import pytest

from obd_read.elm import AdapterUnsupported, Elm, ElmError, NoResponse, isotp_reassemble
from obd_read.guard import DiagProtocol, permit

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, isotp_frames


def make(core: FakeElmCore) -> Elm:
    return Elm(FakeTransport(core))


async def test_initialise_sends_the_setup_every_request_assumes() -> None:
    core = FakeElmCore({})
    info = await make(core).initialise()
    assert core.sent[:8] == ["ATZ", "ATE0", "ATL0", "ATS0", "ATH1", "ATCAF1", "ATAT0", "ATSTFF"]
    assert info.identity == "ELM327 v2.3"
    assert info.stn_identity is None
    assert not info.has_stn_extensions
    assert info.voltage == "12.4V"


async def test_an_adapter_with_stn_extensions_is_recognised() -> None:
    info = await make(FakeElmCore({}, stn_identity="STN2255 v5.6.19")).initialise()
    assert info.stn_identity == "STN2255 v5.6.19"
    assert info.has_stn_extensions


async def test_an_adapter_missing_a_needed_command_is_named() -> None:
    core = FakeElmCore({}, unsupported=frozenset({"ATFCSM1"}))
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    with pytest.raises(AdapterUnsupported, match="ATFCSM1"):
        await elm.address_unit(0x784, 0x785)


async def test_addressing_a_unit_sets_header_filter_and_flow_control() -> None:
    core = FakeElmCore({})
    elm = make(core)
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    assert core.sent == ["ATSP6", "ATSH784", "ATCRA785", "ATFCSH784", "ATFCSD300000", "ATFCSM1"]


async def test_29_bit_addressing_splits_priority_from_header() -> None:
    core = FakeElmCore({})
    elm = make(core)
    await elm.select_can(29, 500_000)
    await elm.address_unit(0x18DA10F1, 0x18DAF110)
    assert core.sent[:4] == ["ATSP7", "ATCP18", "ATSHDA10F1", "ATCRA18DAF110"]


async def test_unsupported_bus_is_refused() -> None:
    with pytest.raises(ElmError):
        await make(FakeElmCore({})).select_can(11, 83_333)


async def test_single_frame_reply() -> None:
    core = FakeElmCore({0x784: KwpEcu(0x785, [])})
    elm = make(core)
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    replies = await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("1092")))
    assert replies == {0x785: [bytes.fromhex("5092")]}


async def test_multi_frame_reply_is_reassembled() -> None:
    ecu = KwpEcu(0x785, [])
    core = FakeElmCore({0x784: ecu})
    elm = make(core)
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    replies = await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("1A86")))
    assert replies == {0x785: [b"\x5a" + ecu.ident]}


async def test_silent_unit_raises_no_response() -> None:
    elm = make(FakeElmCore({}))
    await elm.select_can(11, 500_000)
    with pytest.raises(NoResponse):
        await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("1092")))


@pytest.mark.parametrize("line", ["CAN ERROR", "BUFFER FULL", "BUS ERROR", "STOPPED"])
async def test_adapter_errors_are_raised(line: str) -> None:
    class Erroring(FakeElmCore):
        def _handle(self, text: str) -> str:
            return "OK" if text.startswith("AT") else line

    elm = make(Erroring({}))
    with pytest.raises(ElmError, match=line):
        await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("1092")))


async def test_request_longer_than_one_frame_is_refused() -> None:
    elm = make(FakeElmCore({}))
    with pytest.raises(ElmError, match="single frame"):
        await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("2101020304050607")))


async def test_no_prompt_is_an_error() -> None:
    class Silent(FakeTransport):
        async def write(self, data: bytes) -> None:
            return None

    with pytest.raises(ElmError, match="no prompt"):
        await Elm(Silent(FakeElmCore({}))).command("ATI", timeout=0.05)


def test_isotp_round_trip() -> None:
    payload = bytes(range(40))
    frames = [(0x7E8, frame) for frame in isotp_frames(payload)]
    assert isotp_reassemble(frames) == {0x7E8: [payload]}


def test_isotp_keeps_every_message_from_a_sender() -> None:
    frames = [(0x7E8, bytes.fromhex("037F1878")), (0x7E8, bytes.fromhex("025800"))]
    assert isotp_reassemble(frames) == {0x7E8: [bytes.fromhex("7F1878"), bytes.fromhex("5800")]}


def test_isotp_cut_short_is_an_error() -> None:
    frames = [(0x7E8, frame) for frame in isotp_frames(bytes(range(40)))][:-1]
    with pytest.raises(ElmError, match="cut short"):
        isotp_reassemble(frames)


def test_isotp_orphan_continuation_is_an_error() -> None:
    with pytest.raises(ElmError):
        isotp_reassemble([(0x7E8, bytes.fromhex("2101020304050607"))])
