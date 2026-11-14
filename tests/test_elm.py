import pytest

from obd_read.elm import AdapterUnsupported, Elm, ElmError, NoResponse, isotp_reassemble
from obd_read.guard import DiagProtocol, GuardError, permit

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, Responder, isotp_frames


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


async def test_a_rate_that_is_not_a_divisor_of_500_kbit_is_refused_on_a_plain_adapter() -> None:
    core = FakeElmCore({})
    with pytest.raises(ElmError, match="whole number"):
        await make(core).select_can(11, 83_333)
    assert core.sent == []


@pytest.mark.parametrize("bitrate", [0, -125_000])
async def test_a_non_positive_bit_rate_is_refused(bitrate: int) -> None:
    with pytest.raises(ElmError, match="positive"):
        await make(FakeElmCore({})).select_can(11, bitrate)


async def test_an_identifier_width_other_than_11_or_29_is_refused() -> None:
    with pytest.raises(ElmError, match="11 or 29"):
        await make(FakeElmCore({})).select_can(12, 500_000)


async def test_125_kbit_on_a_plain_adapter_uses_user_protocol_b() -> None:
    core = FakeElmCore({})
    await make(core).select_can(11, 125_000)
    assert core.sent == ["ATPC", "ATPB 81 04", "ATSPB"]
    assert core.baud == 125_000
    assert core.id_chars == 3


async def test_29_bit_user_protocol_sets_the_identifier_width() -> None:
    core = FakeElmCore({})
    elm = make(core)
    await elm.select_can(29, 125_000)
    assert core.sent == ["ATPC", "ATPB 01 04", "ATSPB"]
    assert core.id_chars == 8
    await elm.address_unit(0x18DA10F1, 0x18DAF110)
    assert core.sent[3:5] == ["ATCP18", "ATSHDA10F1"]


async def test_the_divisor_limit_of_the_user_protocol_is_enforced() -> None:
    core = FakeElmCore({})
    await make(core).select_can(11, 10_000)
    assert core.sent[1] == "ATPB 81 32"
    with pytest.raises(ElmError, match="whole number"):
        await make(FakeElmCore({})).select_can(11, 5_000)


async def test_an_adapter_without_user_protocol_b_fails_loudly() -> None:
    core = FakeElmCore({}, unsupported=frozenset({"ATPB 81 04"}))
    with pytest.raises(AdapterUnsupported, match=r"ATPB 81 04.*no user-defined CAN protocol"):
        await make(core).select_can(11, 125_000)
    assert "ATSPB" not in core.sent


async def test_an_stn_adapter_sets_and_verifies_the_rate() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    core.sent.clear()
    await elm.select_can(11, 125_000)
    assert core.sent == ["ATSP6", "STPBR 125000", "STPBRR"]
    assert core.baud == 125_000


async def test_an_stn_adapter_that_rounds_the_rate_is_refused() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19", stn_rate_step=1000)
    elm = make(core)
    await elm.initialise()
    with pytest.raises(ElmError, match="set 83000 bit/s when 83333 bit/s was requested"):
        await elm.select_can(11, 83_333)


async def test_an_stn_adapter_rejecting_the_rate_command_fails_loudly() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19", unsupported=frozenset({"STPBR 125000"}))
    elm = make(core)
    await elm.initialise()
    with pytest.raises(AdapterUnsupported, match="STPBR 125000"):
        await elm.select_can(11, 125_000)


async def test_standard_rates_keep_their_protocols_on_an_stn_adapter() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    core.sent.clear()
    await elm.select_can(29, 250_000)
    assert core.sent == ["ATSP9"]


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


LONG_UDS_READ = bytes.fromhex("22F190F191F192F193F194")


def echo_ecu(response_id: int) -> Responder:
    def respond(request: bytes) -> list[tuple[int, bytes]]:
        return [(response_id, bytes([request[0] + 0x40]) + request[1:3] + bytes(range(20)))]

    return respond


async def test_a_request_longer_than_one_frame_is_refused_on_a_plain_adapter() -> None:
    core = FakeElmCore({0x784: echo_ecu(0x785)})
    elm = make(core)
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    sent = len(core.sent)
    with pytest.raises(ElmError, match=r"plain ELM327.*STN"):
        await elm.request(permit(DiagProtocol.UDS, LONG_UDS_READ))
    assert core.sent[sent:] == []


async def test_a_long_request_goes_through_stpx_on_an_stn_adapter() -> None:
    core = FakeElmCore({0x784: echo_ecu(0x785)}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    replies = await elm.request(permit(DiagProtocol.UDS, LONG_UDS_READ))
    assert core.sent[-1] == f"STPX H:784, D:{LONG_UDS_READ.hex().upper()}"
    assert core.long_requests == [LONG_UDS_READ]
    assert replies == {0x785: [b"\x62\xf1\x90" + bytes(range(20))]}


async def test_a_short_request_still_goes_as_plain_hex_on_an_stn_adapter() -> None:
    core = FakeElmCore({0x784: echo_ecu(0x785)}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    await elm.request(permit(DiagProtocol.UDS, bytes.fromhex("22F190")))
    assert core.sent[-1] == "22F190"


async def test_a_long_request_to_a_29_bit_unit_names_the_full_identifier() -> None:
    core = FakeElmCore({0x18DA10F1: echo_ecu(0x18DAF110)}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    await elm.select_can(29, 500_000)
    await elm.address_unit(0x18DA10F1, 0x18DAF110)
    await elm.request(permit(DiagProtocol.UDS, LONG_UDS_READ))
    assert core.sent[-1].startswith("STPX H:18DA10F1, D:")


async def test_addressing_on_an_stn_adapter_registers_the_flow_control_pair() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    assert "STCFCPA 784, 785" in core.sent
    assert core.flow_control_pairs == {(0x784, 0x785)}


async def test_a_long_request_without_a_registered_pair_fails_loudly() -> None:
    core = FakeElmCore({0x784: echo_ecu(0x785)}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm._set_header(0x784)
    with pytest.raises(ElmError, match="FB ERROR"):
        await elm.request(permit(DiagProtocol.UDS, LONG_UDS_READ))


async def test_an_stn_adapter_rejecting_stpx_is_named() -> None:
    core = FakeElmCore(
        {0x784: echo_ecu(0x785)},
        stn_identity="STN2255 v5.6.19",
        unsupported=frozenset({f"STPX H:784, D:{LONG_UDS_READ.hex().upper()}"}),
    )
    elm = make(core)
    await elm.initialise()
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    with pytest.raises(AdapterUnsupported, match="STPX"):
        await elm.request(permit(DiagProtocol.UDS, LONG_UDS_READ))


async def test_a_request_beyond_the_iso_tp_limit_is_refused() -> None:
    core = FakeElmCore({}, stn_identity="STN2255 v5.6.19")
    elm = make(core)
    await elm.initialise()
    sent = len(core.sent)
    with pytest.raises(ElmError, match="4095"):
        await elm.request(permit(DiagProtocol.UDS, b"\x22" + bytes(4095)))
    assert core.sent[sent:] == []


async def test_the_guard_still_refuses_a_long_write_before_the_adapter() -> None:
    with pytest.raises(GuardError):
        permit(DiagProtocol.UDS, bytes.fromhex("2EF190") + bytes(20))


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
