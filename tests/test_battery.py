import csv
from pathlib import Path

import pytest

from obd_read.battery import VOLTAGE, read_voltage
from obd_read.cli import run
from obd_read.elm import Elm, ElmError
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport

# Voltages as an adapter reports them through an engine start: resting, cranking dip, charging.
START = ["12.6V", "12.5V", "9.8V", "10.4V", "13.9V", "14.2V", "14.3V", "14.3V", "14.3V", "14.3V"]


class VoltageCore(FakeElmCore):
    """A fake adapter whose voltage command replays a script, then repeats its last value."""

    def __init__(self, script: list[str], *, stn: bool = False) -> None:
        super().__init__({}, stn_identity="STN1110 v4.0" if stn else None)
        self.script = script
        self.reads: list[str] = []

    def _handle(self, line: str) -> str:
        if line == "ATRV" or line.startswith("STVR"):
            self.sent.append(line)
            self.reads.append(line)
            return self.script[min(len(self.reads) - 1, len(self.script) - 1)]
        return super()._handle(line)


class Rig:
    def __init__(self, core: VoltageCore) -> None:
        self.core = core
        self.transport = FakeTransport(core)
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str) -> int:
        return await run(
            ["battery", "--adapter", "tcp://fake:1", *argv], self.lines.append, factory=self.factory
        )


async def test_voltage_is_logged_through_a_start(tmp_path: Path) -> None:
    rig = Rig(VoltageCore(START))
    log = tmp_path / "start.csv"
    assert await rig.run("--duration", "0.45", "--interval", "0.05", "--csv", str(log)) == 0
    with log.open(newline="") as file:
        table = list(csv.reader(file))
    assert table[0] == ["time", "elapsed (s)", "voltage (V)"]
    # The first read is the adapter's own start-up reading, so the log starts at the second value.
    assert [row[2] for row in table[1:4]] == ["12.5", "9.8", "10.4"]
    assert len(table) >= 4
    elapsed = [float(row[1]) for row in table[1:]]
    assert elapsed == sorted(elapsed)
    assert "lowest 9.8 V" in rig.lines[-1]
    assert rig.core.reads[0] == "ATRV"


async def test_one_sample_when_the_duration_is_zero() -> None:
    rig = Rig(VoltageCore(START))
    assert await rig.run("--duration", "0") == 0
    assert "1 sample: lowest 12.5 V" in rig.lines[-1]
    assert len(rig.core.reads) == 2  # start-up reading and one sample


async def test_an_adapter_with_stn_extensions_is_read_with_stvr() -> None:
    rig = Rig(VoltageCore(["12.60V", "12.345V"], stn=True))
    assert await rig.run("--duration", "0", "--precision", "3") == 0
    assert rig.core.reads == ["ATRV", "STVR 3"]
    assert "12.345 V" in rig.lines[-1]
    assert "with STVR" in "\n".join(rig.lines)


async def test_stvr_without_a_precision_is_sent_bare() -> None:
    rig = Rig(VoltageCore(["12.6V"], stn=True))
    assert await rig.run("--duration", "0") == 0
    assert rig.core.reads == ["ATRV", "STVR"]


async def test_a_reply_with_no_voltage_is_an_error() -> None:
    rig = Rig(VoltageCore(["12.6V", "OK"]))
    assert await rig.run("--duration", "0") == 1
    assert "no voltage in the reply to ATRV" in rig.lines[-1]


async def test_an_existing_log_is_not_overwritten(tmp_path: Path) -> None:
    log = tmp_path / "start.csv"
    log.write_text("earlier")
    rig = Rig(VoltageCore(START))
    assert await rig.run("--duration", "0", "--csv", str(log)) == 1
    assert log.read_text() == "earlier"


@pytest.mark.parametrize("args", [["--interval", "0"], ["--duration", "-1"], ["--precision", "-1"]])
async def test_bad_numbers_are_refused(args: list[str]) -> None:
    rig = Rig(VoltageCore(START))
    assert await rig.run(*args) == 1
    assert rig.lines[-1].startswith("error: --")


async def test_read_voltage_takes_the_first_voltage_in_any_line() -> None:
    elm = Elm(FakeTransport(VoltageCore(["SEARCHING...\r13.1 V"])))
    assert await read_voltage(elm, stn=False, precision=None) == 13.1


async def test_read_voltage_names_the_command_when_nothing_parses() -> None:
    elm = Elm(FakeTransport(VoltageCore(["?"])))
    with pytest.raises(ElmError, match="STVR 2"):
        await read_voltage(elm, stn=True, precision=2)


def test_voltage_pattern() -> None:
    match = VOLTAGE.search("14.35V")
    assert match is not None
    assert match.group(1) == "14.35"
    assert VOLTAGE.search("OK") is None
