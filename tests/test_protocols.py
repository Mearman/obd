from pathlib import Path

import pytest

from obd_read import obd
from obd_read.diag import Fault, NegativeResponse, UnitSession
from obd_read.elm import Elm, ElmError
from obd_read.guard import DiagProtocol, GuardError, authorise_clear
from obd_read.kwp2000 import Kwp2000
from obd_read.uds import Uds

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, Responder


async def session(responder: Responder, protocol: DiagProtocol) -> tuple[UnitSession, FakeElmCore]:
    core = FakeElmCore({0x784: responder})
    elm = Elm(FakeTransport(core))
    await elm.select_can(11, 500_000)
    await elm.address_unit(0x784, 0x785)
    return UnitSession(elm, protocol, 0x785), core


async def test_kwp_reads_identification_and_faults() -> None:
    unit, core = await session(
        KwpEcu(0x785, [(0x5123, 0x61), (0x9003, 0x20)]), DiagProtocol.KWP2000
    )
    client = Kwp2000(unit, 0x92)
    await client.start()
    assert (await client.identification())[0].text == "A6421500000 E280CDI"
    assert await client.faults() == [Fault("5123", 0x61), Fault("9003", 0x20)]
    assert core.requests == ["1092", "1A86", "1802FF00"]


async def test_kwp_freeze_frame_selects_by_fault_code() -> None:
    unit, core = await session(KwpEcu(0x785, [(0x5123, 0x61)]), DiagProtocol.KWP2000)
    frame = await Kwp2000(unit, 0x92).freeze_frame(Fault("5123", 0x61))
    assert core.requests == ["12FF045123"]
    assert frame == bytes.fromhex("0151230C8A31")


async def test_kwp_fault_count_mismatch_is_an_error() -> None:
    unit, _ = await session(lambda _r: [(0x785, bytes.fromhex("58025123"))], DiagProtocol.KWP2000)
    with pytest.raises(ElmError, match="declares 2"):
        await Kwp2000(unit, 0x92).faults()


async def test_negative_response_names_service_and_code() -> None:
    unit, _ = await session(lambda r: [(0x785, bytes([0x7F, r[0], 0x11]))], DiagProtocol.KWP2000)
    with pytest.raises(NegativeResponse, match="service not supported") as refusal:
        await Kwp2000(unit, 0x92).faults()
    assert (refusal.value.service, refusal.value.code) == (0x18, 0x11)


async def test_pending_then_final_reply_uses_the_final() -> None:
    def responder(request: bytes) -> list[tuple[int, bytes]]:
        return [(0x785, bytes([0x7F, request[0], 0x78])), (0x785, bytes.fromhex("5800"))]

    unit, _ = await session(responder, DiagProtocol.KWP2000)
    assert await Kwp2000(unit, 0x92).faults() == []


async def test_pending_with_no_final_reply_is_an_error() -> None:
    unit, _ = await session(lambda r: [(0x785, bytes([0x7F, r[0], 0x78]))], DiagProtocol.KWP2000)
    with pytest.raises(ElmError, match="more time"):
        await Kwp2000(unit, 0x92).faults()


async def test_reply_from_another_unit_is_an_error() -> None:
    unit, _ = await session(lambda _r: [(0x7E8, bytes.fromhex("5800"))], DiagProtocol.KWP2000)
    with pytest.raises(ElmError, match="expected a reply from 785"):
        await Kwp2000(unit, 0x92).faults()


async def test_reply_to_a_different_service_is_an_error() -> None:
    unit, _ = await session(lambda _r: [(0x785, bytes.fromhex("5A86"))], DiagProtocol.KWP2000)
    with pytest.raises(ElmError, match="does not answer"):
        await Kwp2000(unit, 0x92).faults()


async def test_raw_requests_cannot_clear_or_write() -> None:
    unit, core = await session(KwpEcu(0x785, [(0x5123, 0x61)]), DiagProtocol.KWP2000)
    for request in ("14FF00", "3101", "3B0100", "2701"):
        with pytest.raises(GuardError):
            await unit.request(bytes.fromhex(request))
    assert core.requests == []


async def test_kwp_clear_with_token_sends_the_clear(tmp_path: Path) -> None:
    ecu = KwpEcu(0x785, [(0x5123, 0x61)])
    unit, core = await session(ecu, DiagProtocol.KWP2000)
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    await Kwp2000(unit, 0x92).clear(authorise_clear(snapshot))
    assert core.requests == ["14FF00"]
    assert ecu.faults == []


def uds_ecu(request: bytes) -> list[tuple[int, bytes]]:
    replies = {
        "1003": "5003003201F4",
        "22F190": "62F190" + b"WDB2110201A000001".hex(),
        "22F187": "7F2231",
        "22F18C": "7F2231",
        "22F195": "62F1950102",
        "1902FF": "5902FF" + "C1234508" + "D0010009",
        "1904C12345FF": "5904C12345080101",
        "14FFFFFF": "54",
    }
    return [(0x785, bytes.fromhex(replies[request.hex().upper()]))]


async def test_uds_reads_identification_and_faults() -> None:
    unit, core = await session(uds_ecu, DiagProtocol.UDS)
    client = Uds(unit, 0x03)
    await client.start()
    fields = {item.label: item.text for item in await client.identification()}
    assert fields == {"VIN": "WDB2110201A000001", "software version": ""}
    assert await client.faults() == [Fault("C12345", 0x08), Fault("D00100", 0x09)]
    assert await client.freeze_frame(Fault("C12345", 0x08)) == bytes.fromhex("C12345080101")
    assert core.requests[0] == "1003"


async def test_uds_clear_with_token(tmp_path: Path) -> None:
    unit, core = await session(uds_ecu, DiagProtocol.UDS)
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    await Uds(unit, 0x03).clear(authorise_clear(snapshot))
    assert core.requests == ["14FFFFFF"]


def obd_car(request: bytes) -> list[tuple[int, bytes]]:
    replies: dict[str, list[tuple[int, str]]] = {
        "0902": [(0x7E8, "490201" + b"WDB2110200A000000".hex())],
        "0101": [(0x7E8, "410182076500"), (0x7E9, "410100000000")],
        "03": [(0x7E8, "430201230420"), (0x7E9, "4300")],
        "07": [(0x7E8, "4700")],
        "0A": [],
        "010C": [(0x7E8, "410C0C80")],
        "0105": [(0x7E8, "41055A")],
        "0142": [(0x7E8, "41423070")],
    }
    return [
        (sender, bytes.fromhex(text)) for sender, text in replies.get(request.hex().upper(), [])
    ]


async def obd_elm() -> tuple[Elm, FakeElmCore]:
    core = FakeElmCore({0x7DF: obd_car})
    elm = Elm(FakeTransport(core))
    await elm.select_can(11, 500_000)
    await elm.address_functional(obd.FUNCTIONAL_ID[11])
    return elm, core


async def test_obd_reads() -> None:
    elm, core = await obd_elm()
    assert core.sent[1:] == ["ATSH7DF", "ATAR", "ATFCSM0"]
    assert await obd.vin(elm) == "WDB2110200A000000"
    state = await obd.readiness(elm)
    assert (state[0x7E8].lamp_on, state[0x7E8].code_count) == (True, 2)
    assert (state[0x7E9].lamp_on, state[0x7E9].code_count) == (False, 0)
    assert await obd.codes(elm, obd.STORED_CODES) == {0x7E8: ["P0123", "P0420"], 0x7E9: []}
    assert await obd.live(elm) == {
        "coolant temperature": "50 °C",
        "engine speed": "800 rpm",
        "control module voltage": "12.4 V",
    }


@pytest.mark.parametrize(
    ("pair", "code"),
    [("0123", "P0123"), ("4321", "C0321"), ("9003", "B1003"), ("C100", "U0100"), ("3FFF", "P3FFF")],
)
def test_obd_code_decoding(pair: str, code: str) -> None:
    assert obd.decode_code(bytes.fromhex(pair)) == code


async def test_obd_cannot_clear_without_the_clear_command() -> None:
    elm, core = await obd_elm()
    with pytest.raises(GuardError):
        await obd._read(elm, bytes([0x04]))
    assert core.requests == []
