import csv
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.csvlog import CsvLog
from obd_read.profile import ProfileError, parse_profile
from obd_read.profile_check import check_profile
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, UdsEcu
from .transcripts import load_replies, responder

RECORDED = ("a150-modes-01-to-09.txt", "a150-since-clear.txt")

KWP_PROFILE = """
name = "test-kwp"
description = "A car for tests"
status = "confirmed"

[bus]
id_bits = 11
bitrate = 500000

[diagnostics]
protocol = "kwp2000"
session = 0x92

[units.engine]
description = "Engine"
request = 0x7E0
response = 0x7E8
source = "made up for the test"

[units.engine.values.boost]
label = "boost pressure"
unit = "kPa"
identifier = 0x10
offset = 1
size = 2
scale = 0.1
source = "made up for the test"
status = "confirmed"

[units.engine.values.rail-temperature]
label = "rail temperature"
unit = "°C"
identifier = 0x11
signed = true
bias = -40
source = "made up for the test"

[units.engine.values.refused]
label = "refused value"
identifier = 0x7F
source = "made up for the test"
"""

UDS_PROFILE = (
    KWP_PROFILE.replace('"kwp2000"', '"uds"')
    .replace("0x92", "0x03")
    .replace("identifier = 0x10", "identifier = 0xF410")
)


class ValueKwpEcu(KwpEcu):
    """A KWP2000 unit that also answers service 21 for two identifiers and refuses the rest."""

    def reply(self, request: bytes) -> bytes:
        if request[0] == 0x21:
            data = {0x10: "00 0A28", 0x11: "FB"}.get(request[1])
            if data is None:
                return bytes([0x7F, 0x21, 0x31])
            return bytes([0x61, request[1]]) + bytes.fromhex(data)
        return super().reply(request)


class ValueUdsEcu(UdsEcu):
    def reply(self, request: bytes) -> bytes:
        if request[0] == 0x22 and request[1:3] == b"\xf4\x10":
            return bytes([0x62, 0xF4, 0x10, 0x00, 0x0A, 0x28])
        return super().reply(request)


class Rig:
    def __init__(self, core: FakeElmCore) -> None:
        self.core = core
        self.transport = FakeTransport(core)
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str) -> int:
        return await run(
            ["live", "--adapter", "tcp://fake:1", *argv], self.lines.append, factory=self.factory
        )

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


def rows(path: Path) -> list[list[str]]:
    with path.open(newline="") as file:
        return list(csv.reader(file))


async def test_profile_values_are_read_by_name_and_logged(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    log = tmp_path / "run.csv"
    assert (
        await rig.run(
            "engine", "--profile", str(profile), "--values", "boost,rail-temperature",
            "--count", "3", "--interval", "0", "--csv", str(log),
        )
        == 0
    )  # fmt: skip
    assert "boost pressure: 260 kPa" in rig.output
    assert "rail temperature: -45 °C" in rig.output
    assert "sample 3 at" in rig.output
    table = rows(log)
    assert table[0] == ["time", "elapsed (s)", "boost pressure (kPa)", "rail temperature (°C)"]
    assert len(table) == 4
    assert table[1][2:] == ["260", "-45"]
    assert rig.core.requests.count("2110") == 3
    assert "2111" in rig.core.requests
    assert "217F" not in rig.core.requests


async def test_unconfirmed_identifiers_are_flagged(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    assert (
        await rig.run("engine", "--profile", str(profile), "--values", "boost,rail-temperature")
        == 0
    )
    assert "unconfirmed identifiers, check against the car: rail-temperature" in rig.output


async def test_a_refused_value_is_reported_once_and_logged_empty(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    log = tmp_path / "run.csv"
    assert (
        await rig.run(
            "engine", "--profile", str(profile), "--values", "boost,refused",
            "--count", "2", "--interval", "0", "--csv", str(log),
        )
        == 0
    )  # fmt: skip
    assert rig.output.count("refused not read") == 1
    assert "refused value: not read" in rig.output
    assert rows(log)[1][2:] == ["260", ""]


async def test_uds_data_identifiers_are_read(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(UDS_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueUdsEcu(0x7E8, [])}))
    assert await rig.run("engine", "--profile", str(profile), "--values", "boost") == 0
    assert "boost pressure: 260 kPa" in rig.output
    assert "22F410" in rig.core.requests


async def test_list_names_the_values_and_reads_none(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    assert await rig.run("engine", "--profile", str(profile), "--list") == 0
    assert "available values: boost, rail-temperature, refused" in rig.output
    assert "2110" not in rig.core.requests


async def test_unknown_value_name_lists_the_choices(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    assert await rig.run("engine", "--profile", str(profile), "--values", "boots") == 1
    assert "unknown value boots; available: boost, rail-temperature, refused" in rig.output


async def test_a_unit_without_values_is_an_error() -> None:
    rig = Rig(FakeElmCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    assert await rig.run("engine", "--profile", "mercedes-w211") == 1
    assert "defines no named values" in rig.output


async def test_a_unit_needs_a_profile() -> None:
    rig = Rig(FakeElmCore({}))
    assert await rig.run("engine") == 1
    assert "naming a unit needs --profile" in rig.output


async def test_an_existing_log_is_never_overwritten(tmp_path: Path) -> None:
    log = tmp_path / "run.csv"
    log.write_text("earlier evidence")
    rig = Rig(FakeElmCore({0x7DF: responder(load_replies(*RECORDED))}))
    assert await rig.run("--values", "engine-load", "--csv", str(log)) == 1
    assert "already exists" in rig.output
    assert log.read_text() == "earlier evidence"


async def test_legislated_values_are_read_by_name_and_logged(tmp_path: Path) -> None:
    rig = Rig(FakeElmCore({0x7DF: responder(load_replies(*RECORDED))}))
    log = tmp_path / "run.csv"
    assert (
        await rig.run(
            "--values", "short-fuel-trim-b1,fuel-level,o2-sensor-2",
            "--count", "2", "--interval", "0", "--csv", str(log),
        )
        == 0
    )  # fmt: skip
    table = rows(log)
    assert table[0][2:] == [
        "short-term fuel trim bank 1 (%)",
        "fuel tank level (%)",
        "oxygen sensor 2 voltage (V)",
        "oxygen sensor 2 short-term fuel trim (%)",
    ]
    assert table[1][2:] == ["-2.34375", "34.90196078", "0.43", "not used"]
    assert len(table) == 3
    assert rig.core.requests.count("0106") == 2


async def test_legislated_list_shows_only_supported_values() -> None:
    rig = Rig(FakeElmCore({0x7DF: responder(load_replies(*RECORDED))}))
    assert await rig.run("--list") == 0
    listed = rig.lines[-1]
    assert "engine-speed" in listed
    assert "air-flow" not in listed  # identifier 10 is not in the car's bitmap


async def test_legislated_value_the_car_lacks_is_refused() -> None:
    rig = Rig(FakeElmCore({0x7DF: responder(load_replies(*RECORDED))}))
    assert await rig.run("--values", "air-flow") == 1
    assert "unknown value air-flow" in rig.output
    assert "0110" not in rig.core.requests


async def test_bad_count_is_refused() -> None:
    rig = Rig(FakeElmCore({}))
    assert await rig.run("--count", "0") == 1
    assert "--count must be at least 1" in rig.output


def test_csv_log_refuses_an_existing_file_and_flushes_each_row(tmp_path: Path) -> None:
    path = tmp_path / "log.csv"
    with CsvLog(path, ["a", "b"]) as log:
        log.write(["1", "2"])
        assert path.read_text().splitlines() == ["a,b", "1,2"]
    with pytest.raises(ValueError, match="already exists"):
        CsvLog(path, ["a"])


def test_profile_values_parse_with_defaults() -> None:
    value = parse_profile(KWP_PROFILE, "test").unit("engine").values["rail-temperature"]
    assert (value.offset, value.size, value.signed, value.scale, value.bias) == (0, 1, True, 1, -40)
    assert value.decode(bytes([0xFB])) == -45
    assert (
        parse_profile(KWP_PROFILE, "test").unit("engine").values["refused"].status == "unconfirmed"
    )


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("identifier = 0x11", "identifier = 0x111", "does not fit a kwp2000 identifier"),
        ("size = 2", "size = 5", "size must be 1 to 4"),
        ("scale = 0.1", 'scale = "x"', "scale must be a number"),
        ("offset = 1", "offset = -1", "offset must be"),
    ],
)
def test_profile_values_reject_bad_fields(old: str, new: str, message: str) -> None:
    text = KWP_PROFILE.replace(old, new)
    with pytest.raises(ProfileError, match=message):
        parse_profile(text, "test")


def test_short_reply_is_an_error() -> None:
    value = parse_profile(KWP_PROFILE, "test").unit("engine").values["boost"]
    with pytest.raises(ValueError, match="3 are needed"):
        value.decode(bytes(2))


def test_profile_check_flags_a_misspelt_value_key() -> None:
    problems = check_profile(KWP_PROFILE.replace("scale = 0.1", "scal = 0.1"), "test")
    assert problems == ["[units.engine.values.boost]: unknown key scal"]


def test_profile_check_accepts_named_values() -> None:
    assert check_profile(KWP_PROFILE, "test") == []
