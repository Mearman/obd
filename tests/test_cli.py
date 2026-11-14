import json
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu

ADAPTER = ["--adapter", "tcp://fake:1", "--profile", "mercedes-w211"]


class Car:
    """A fake W211 with an engine unit and an ESP unit, and a record of what was said."""

    def __init__(self) -> None:
        self.esp = KwpEcu(0x785, [(0x5123, 0x61), (0x9003, 0x20)])
        self.core = FakeElmCore({0x7E0: KwpEcu(0x7E8, []), 0x784: self.esp})
        self.lines: list[str] = []
        self.transport = FakeTransport(self.core)

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str, answer: str = "") -> int:
        return await run(list(argv), self.lines.append, lambda _prompt: answer, self.factory)

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


async def test_probe_reports_which_units_answer() -> None:
    car = Car()
    assert await car.run("probe", *ADAPTER) == 0
    assert "engine (7E0 -> 7E8): answered" in car.output
    assert "esp (784 -> 785): answered" in car.output
    assert "kombi (796 -> 797): no answer" in car.output
    assert "2 of 13 units answered" in car.output
    assert "address table is unconfirmed" in car.output
    assert car.transport.closed
    assert "1802FF00" not in car.core.requests


async def test_faults_prints_codes_and_status() -> None:
    car = Car()
    assert await car.run("faults", "esp", *ADAPTER) == 0
    assert "fault codes: 2" in car.output
    assert "5123  status 61" in car.output
    assert "9003  status 20" in car.output


async def test_freeze_reads_a_frame_per_code() -> None:
    car = Car()
    assert await car.run("freeze", "esp", *ADAPTER) == 0
    assert "freeze frame: 0151230C8A31" in car.output
    assert "freeze frame: 0190030C8A31" in car.output


async def test_silent_unit_exits_non_zero() -> None:
    car = Car()
    assert await car.run("ident", "kombi", *ADAPTER) == 1
    assert "kombi (796 -> 797): no answer" in car.output


async def test_scan_writes_json_and_markdown(tmp_path: Path) -> None:
    car = Car()
    assert await car.run("scan", *ADAPTER, "--output", str(tmp_path / "scan"), "--freeze") == 0
    saved = json.loads((tmp_path / "scan.json").read_text())
    esp = next(unit for unit in saved["units"] if unit["unit"] == "esp")
    assert esp["faults"] == [{"code": "5123", "status": "61"}, {"code": "9003", "status": "20"}]
    assert esp["freeze_frames"]["5123"] == "0151230C8A31"
    assert saved["profile"] == {"name": "mercedes-w211", "status": "unconfirmed"}
    assert any("1802FF00" in entry for entry in saved["transcript"])
    markdown = (tmp_path / "scan.md").read_text()
    assert "| esp | yes | 2 |" in markdown
    assert "| kombi | no | not read |" in markdown
    assert "fault `5123`, status `61`, freeze frame `0151230C8A31`" in markdown


async def test_request_sends_read_only_bytes() -> None:
    car = Car()
    assert await car.run("request", "esp", "1A86", *ADAPTER) == 0
    assert car.lines[-1].startswith("5A86")


@pytest.mark.parametrize("request_hex", ["14FF00", "3101", "3B0100", "2701", "1085", "zz"])
async def test_request_cannot_change_the_car(request_hex: str) -> None:
    car = Car()
    assert await car.run("request", "esp", request_hex, *ADAPTER) == 1
    assert car.lines[-1].startswith("error:")
    assert car.core.requests == []
    assert len(car.esp.faults) == 2


async def test_clear_saves_then_clears_then_reads_again(tmp_path: Path) -> None:
    car = Car()
    save = tmp_path / "before.json"
    assert await car.run("clear", "esp", *ADAPTER, "--save", str(save), answer="yes") == 0
    saved = json.loads(save.read_text())
    assert saved["units"][0]["faults"] == [
        {"code": "5123", "status": "61"},
        {"code": "9003", "status": "20"},
    ]
    assert saved["units"][0]["freeze_frames"] == {"5123": "0151230C8A31", "9003": "0190030C8A31"}
    requests = car.core.requests
    assert requests.index("14FF00") > requests.index("12FF049003")
    assert requests[requests.index("14FF00") + 1 :] == ["1092", "1A86", "1802FF00"]
    assert car.esp.faults == []
    assert "cleared; reading the unit again:" in car.output
    assert car.lines[-1] == "  fault codes: 0"


async def test_clear_declined_sends_no_clear(tmp_path: Path) -> None:
    car = Car()
    save = tmp_path / "before.json"
    assert await car.run("clear", "esp", *ADAPTER, "--save", str(save), answer="y") == 1
    assert "14FF00" not in car.core.requests
    assert len(car.esp.faults) == 2
    assert save.exists()
    assert car.lines[-1] == "nothing cleared"


async def test_clear_refuses_an_existing_snapshot_file(tmp_path: Path) -> None:
    car = Car()
    save = tmp_path / "before.json"
    save.write_text("an earlier snapshot")
    assert await car.run("clear", "esp", *ADAPTER, "--save", str(save), "--yes") == 1
    assert car.core.requests == []
    assert save.read_text() == "an earlier snapshot"


async def test_clear_refuses_when_codes_cannot_be_read(tmp_path: Path) -> None:
    car = Car()
    car.core.responders[0x784] = lambda r: [(0x785, bytes([0x7F, r[0], 0x11]))]
    save = tmp_path / "before.json"
    assert await car.run("clear", "esp", *ADAPTER, "--save", str(save), "--yes") == 1
    assert "14FF00" not in car.core.requests
    assert not save.exists()
    assert "nothing cleared" in car.lines[-1]


async def test_clear_proceeds_when_only_freeze_frames_are_refused(tmp_path: Path) -> None:
    car = Car()
    car.esp.freeze_refused = True
    save = tmp_path / "before.json"
    assert await car.run("clear", "esp", *ADAPTER, "--save", str(save), "--yes") == 0
    saved = json.loads(save.read_text())
    assert saved["units"][0]["freeze_frames"]["5123"].startswith("not read:")
    assert car.esp.faults == []


async def test_clear_of_a_silent_unit_sends_nothing(tmp_path: Path) -> None:
    car = Car()
    save = tmp_path / "before.json"
    assert await car.run("clear", "kombi", *ADAPTER, "--save", str(save), "--yes") == 1
    assert "14FF00" not in car.core.requests
    assert not save.exists()


async def test_unknown_unit_is_an_error() -> None:
    car = Car()
    assert await car.run("faults", "radio", *ADAPTER) == 1
    assert "has no unit 'radio'" in car.lines[-1]


async def test_obd_command_needs_no_profile() -> None:
    car = Car()
    car.core.responders[0x7DF] = lambda r: {
        "0902": [(0x7E8, bytes.fromhex("490201") + b"WDB2110200A000000")],
        "03": [(0x7E8, bytes.fromhex("43010420"))],
    }.get(r.hex().upper(), [])
    assert await car.run("obd", "--adapter", "tcp://fake:1") == 0
    assert "VIN: WDB2110200A000000" in car.output
    assert "stored codes from 7E8: P0420" in car.output
    assert "04" not in car.core.requests


async def test_transcript_is_logged_to_a_file(tmp_path: Path) -> None:
    car = Car()
    log = tmp_path / "run.log"
    assert await car.run("ident", "esp", *ADAPTER, "--log", str(log)) == 0
    text = log.read_text()
    assert "> ATSH784" in text
    assert "> 1A86" in text
    assert "< 785" in text
