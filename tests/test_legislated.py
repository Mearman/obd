import pytest

from obd_read.cli import run
from obd_read.elm import Elm
from obd_read.legislated import (
    decode_monitor_tests,
    decode_readiness,
    decode_support_bitmap,
    format_value,
    supported_ids,
)
from obd_read.obd import CURRENT_DATA, FUNCTIONAL_ID
from obd_read.pids import PIDS
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport
from .transcripts import Replies, load_replies, responder

RECORDED = ("a150-modes-01-to-09.txt", "a150-since-clear.txt")


class Car:
    """A fake car on the functional address that answers from recorded replies."""

    def __init__(self, replies: Replies) -> None:
        self.core = FakeElmCore({0x7DF: responder(replies)})
        self.transport = FakeTransport(self.core)
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def obd(self) -> int:
        return await run(
            ["obd", "--adapter", "tcp://fake:1"], self.lines.append, factory=self.factory
        )

    async def elm(self) -> Elm:
        elm = Elm(self.transport)
        await elm.select_can(11, 500_000)
        await elm.address_functional(FUNCTIONAL_ID[11])
        return elm

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


def test_support_bitmap_from_a_recorded_reply() -> None:
    # The recorded reply to 0100 from a 2009 petrol hatchback.
    assert decode_support_bitmap(0x00, bytes.fromhex("BE3EB813")) == {
        *(0x01, 0x03, 0x04, 0x05, 0x06, 0x07),
        *(0x0B, 0x0C, 0x0D, 0x0E, 0x0F),
        *(0x11, 0x13, 0x14, 0x15),
        *(0x1C, 0x1F, 0x20),
    }


async def test_supported_ids_follow_the_chain_and_stop_where_it_ends() -> None:
    car = Car(load_replies(*RECORDED))
    supported = await supported_ids(await car.elm(), CURRENT_DATA)
    assert 0x40 in supported[0x7E8]
    assert 0x4E in supported[0x7E8]
    assert 0x10 not in supported[0x7E8]
    # 0140 says there is no bitmap at 0160, so none is requested.
    assert car.core.requests == ["0100", "0120", "0140"]


async def test_obd_command_reads_only_what_the_car_supports() -> None:
    car = Car(load_replies(*RECORDED))
    assert await car.obd() == 0
    assert "0104" in car.core.requests
    assert "0110" not in car.core.requests  # not in the bitmap, although the car was once asked
    assert "014F" not in car.core.requests
    assert {request[:2] for request in car.core.requests} <= {
        "01",
        "02",
        "03",
        "06",
        "07",
        "09",
        "0A",
    }


async def test_obd_command_decodes_recorded_values() -> None:
    car = Car(load_replies(*RECORDED))
    assert await car.obd() == 0
    out = car.output
    assert "short-term fuel trim bank 1: -2.344 %" in out
    assert "long-term fuel trim bank 1: 2.344 %" in out
    assert "timing advance: 11.5 ° before TDC" in out
    assert "throttle position: 12.941 %" in out
    assert "oxygen sensor 1 voltage: 0.095 V" in out
    assert "oxygen sensor 1 short-term fuel trim: 0 %" in out
    assert "oxygen sensor 2 voltage: 0.43 V" in out
    assert "oxygen sensor 2 short-term fuel trim: not used" in out
    assert "fuel system 1 status: closed loop, using oxygen sensor feedback" in out
    assert "fuel system 2 status: not fitted" in out
    assert "run time since engine start: 263 s" in out
    assert "fuel tank level: 34.902 %" in out
    assert "ambient air temperature: 12 °C" in out
    assert "distance with warning lamp on: 13 km" in out
    assert "warm-ups since codes cleared: 255" in out
    assert "distance since codes cleared: 49700 km" in out
    assert "time run with warning lamp on: 35 min" in out
    assert "time since codes cleared: 65535 min" in out


async def test_obd_command_reports_readiness_and_calibration_identifier() -> None:
    car = Car(load_replies(*RECORDED))
    assert await car.obd() == 0
    assert "readiness from 7E8 (spark ignition):" in car.output
    assert (
        "  complete: misfire, fuel system, components, catalyst, oxygen sensor, oxygen sensor heater"
        in car.output
    )
    assert "  not complete: none" in car.output
    assert "calibration identifier from 7E8: 0034466040150284" in car.output
    assert "0904" in car.core.requests


async def test_calibration_identifier_is_not_requested_when_the_bitmap_omits_it() -> None:
    replies = load_replies(*RECORDED)
    replies["0900"] = [(0x7E8, bytes.fromhex("490040000000"))]  # only identifier 02
    car = Car(replies)
    assert await car.obd() == 0
    assert "0904" not in car.core.requests
    assert "calibration identifier" not in car.output


async def test_monitor_results_beyond_misfire_are_marked_unconfirmed() -> None:
    # The bitmap is the recorded one (monitors 01 and 02); the two results are made up in the layout of the recorded misfire replies.
    replies = load_replies(*RECORDED)
    replies["0601"] = [(0x7E8, bytes.fromhex("460107240064000000C8"))]
    replies["0602"] = [(0x7E8, bytes.fromhex("46020784FF9CFF38006402082401F4000000C8"))]
    replies["0620"] = [(0x7E8, bytes.fromhex("462000000000"))]
    car = Car(replies)
    assert await car.obd() == 0
    assert "meanings unconfirmed" in car.output
    assert (
        "oxygen sensor bank 1 sensor 1 from 7E8, test 07 (unit and scaling 24): value 100, limits 0 to 200, within the limits"
        in car.output
    )
    assert (
        "oxygen sensor bank 1 sensor 2 from 7E8, test 07 (unit and scaling 84): value -100, limits -200 to 100, within the limits"
        in car.output
    )
    assert (
        "sensor 2 from 7E8, test 08 (unit and scaling 24): value 500, limits 0 to 200, outside the limits"
        in car.output
    )
    assert "0600" in car.core.requests


async def test_car_that_answers_nothing_prints_no_values() -> None:
    car = Car({})
    assert await car.obd() == 0
    assert "no unit answered the supported current-data request" in car.output


def test_diesel_readiness_uses_its_own_monitor_table() -> None:
    # Byte B bit 3 set: compression ignition. C0 (NMHC catalyst) and C6 (particulate filter) fitted, D6 not complete.
    readiness = decode_readiness(bytes.fromhex("000F4140"))
    assert readiness.compression_ignition
    assert readiness.complete == ("misfire", "fuel system", "components", "NMHC catalyst")
    assert readiness.incomplete == ("particulate filter",)


def test_common_monitor_incomplete_bit_is_read_from_the_high_nibble() -> None:
    readiness = decode_readiness(
        bytes.fromhex("00170000")
    )  # all three fitted, misfire not complete
    assert readiness.incomplete == ("misfire",)
    assert readiness.complete == ("fuel system", "components")


@pytest.mark.parametrize(
    ("code", "data", "expected"),
    [
        (0x06, "00", (-100.0,)),
        (0x06, "80", (0.0,)),
        (0x06, "FF", (99.21875,)),
        (0x0A, "64", (300,)),
        (0x10, "0190", (4.0,)),
        (0x14, "5AFF", (0.45, "not used")),
        (0x24, "80004000", (1.0, 2.0)),
        (0x34, "80008000", (1.0, 0.0)),
        (0x32, "FFFC", (-1.0,)),
        (0x3C, "0000", (-40.0,)),
        (0x5D, "0000", (-210.0,)),
        (0x5E, "0064", (5.0,)),
    ],
)
def test_pid_decoders_follow_the_published_formulas(
    code: int, data: str, expected: tuple[object, ...]
) -> None:
    assert PIDS[code].decode(bytes.fromhex(data)) == expected


def test_every_pid_decodes_its_own_size_of_zeros() -> None:
    for pid in PIDS.values():
        assert len(pid.decode(bytes(pid.size))) == len(pid.columns)


def test_monitor_test_decoding_ignores_other_monitors_entries() -> None:
    message = bytes.fromhex("460B012400040000FFFF0C012400050000FFFF")
    assert [test.value for test in decode_monitor_tests(0x0B, message)] == [4]


def test_values_are_formatted_without_exponents() -> None:
    assert format_value(49700.0, "km") == "49700 km"
    assert format_value("closed loop", "") == "closed loop"
