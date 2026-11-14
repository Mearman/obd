import json
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.guard import DiagProtocol, GuardError, permit
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport

ARGS = ["--adapter", "tcp://fake:1"]


class ObdCar:
    """A fake legislated-OBD car with one engine unit that holds a stored code until mode 04."""

    def __init__(self) -> None:
        self.codes: list[bytes] = [bytes.fromhex("0420")]
        self.core = FakeElmCore({0x7DF: self.respond})
        self.lines: list[str] = []
        self.transport = FakeTransport(self.core)
        self.refuse_clear = False

    def respond(self, request: bytes) -> list[tuple[int, bytes]]:
        key = request.hex().upper()
        if key == "04":
            if self.refuse_clear:
                return [(0x7E8, bytes.fromhex("7F0422"))]
            self.codes = []
            return [(0x7E8, bytes([0x44]))]
        if key == "03":
            return [(0x7E8, bytes([0x43, len(self.codes)]) + b"".join(self.codes))]
        if key == "07":
            return [(0x7E8, bytes([0x47, 0]))]
        if key == "0101":
            return [
                (0x7E8, bytes([0x41, 0x01, (0x80 if self.codes else 0) | len(self.codes), 0, 0, 0]))
            ]
        if key == "0902":
            return [(0x7E8, bytes.fromhex("490201") + b"WDB2110200A000000")]
        if key == "020200":
            return [(0x7E8, bytes.fromhex("4202000420"))] if self.codes else []
        return []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str, answer: str = "") -> int:
        return await run(list(argv), self.lines.append, lambda _prompt: answer, self.factory)

    @property
    def output(self) -> str:
        return "\n".join(self.lines)

    @property
    def clears_sent(self) -> int:
        return self.core.requests.count("04")


async def test_clear_codes_saves_then_clears_then_reads_again(tmp_path: Path) -> None:
    car = ObdCar()
    save = tmp_path / "before.json"
    assert await car.run("clear-codes", *ARGS, "--save", str(save), answer="yes") == 0
    saved = json.loads(save.read_text())
    assert saved["snapshot"]["stored"] == {"7E8": ["P0420"]}
    assert saved["snapshot"]["vin"] == "WDB2110200A000000"
    assert saved["snapshot"]["freeze_frames"]["7E8"]["code"] == "P0420"
    assert any(entry.endswith("0902") for entry in saved["transcript"])
    requests = car.core.requests
    assert requests.index("04") > requests.index("020200")
    assert requests.index("04") > requests.index("03")
    assert requests[requests.index("04") + 1 :] == ["03", "07", "0101"]
    assert car.codes == []
    assert "every emissions-related unit" in car.output
    assert "resets the readiness monitors" in car.output
    assert "readiness monitors are reset" in car.output
    after = car.lines[car.lines.index("reading the codes again:") + 1 :]
    assert after == [
        "stored codes from 7E8: none",
        "pending codes from 7E8: none",
        "unit 7E8: warning lamp off, 0 stored codes",
    ]


@pytest.mark.parametrize("answer", ["", "y", "no", "YES"])
async def test_declined_prompt_leaves_mode_04_unsent(tmp_path: Path, answer: str) -> None:
    car = ObdCar()
    save = tmp_path / "before.json"
    assert await car.run("clear-codes", *ARGS, "--save", str(save), answer=answer) == 1
    assert car.clears_sent == 0
    assert car.codes != []
    assert save.exists()
    assert car.lines[-1] == "nothing cleared"


async def test_yes_flag_skips_the_prompt(tmp_path: Path) -> None:
    car = ObdCar()
    assert await car.run("clear-codes", *ARGS, "--save", str(tmp_path / "s.json"), "--yes") == 0
    assert car.clears_sent == 1


async def test_existing_save_file_leaves_mode_04_unsent(tmp_path: Path) -> None:
    car = ObdCar()
    save = tmp_path / "before.json"
    save.write_text("an earlier snapshot")
    assert await car.run("clear-codes", *ARGS, "--save", str(save), "--yes") == 1
    assert car.core.requests == []
    assert save.read_text() == "an earlier snapshot"


async def test_failed_snapshot_leaves_mode_04_unsent(tmp_path: Path) -> None:
    car = ObdCar()
    # A stored-codes reply that declares more codes than it carries cannot be saved.
    car.core.responders[0x7DF] = lambda r: (
        [(0x7E8, bytes.fromhex("4305"))] if r.hex() == "03" else car.respond(r)
    )
    save = tmp_path / "before.json"
    assert await car.run("clear-codes", *ARGS, "--save", str(save), "--yes") == 1
    assert car.clears_sent == 0
    assert not save.exists()
    assert "nothing cleared" in car.lines[-1]


async def test_silent_car_leaves_mode_04_unsent(tmp_path: Path) -> None:
    car = ObdCar()
    car.core.responders[0x7DF] = lambda r: []
    save = tmp_path / "before.json"
    assert await car.run("clear-codes", *ARGS, "--save", str(save), "--yes") == 1
    assert car.clears_sent == 0
    assert not save.exists()


async def test_save_file_removed_before_the_clear_sends_nothing(tmp_path: Path) -> None:
    car = ObdCar()
    save = tmp_path / "before.json"

    def remove_then_agree(_prompt: str) -> str:
        save.unlink()
        return "yes"

    status = await run(
        ["clear-codes", *ARGS, "--save", str(save)],
        car.lines.append,
        remove_then_agree,
        car.factory,
    )
    assert status == 1
    assert car.clears_sent == 0
    assert car.codes != []
    assert "has gone" in car.lines[-1]


async def test_a_unit_refusing_the_clear_is_an_error(tmp_path: Path) -> None:
    car = ObdCar()
    car.refuse_clear = True
    assert await car.run("clear-codes", *ARGS, "--save", str(tmp_path / "s.json"), "--yes") == 1
    assert "refused the clear with code 22" in car.lines[-1]
    assert car.codes != []


async def test_obd_and_request_paths_cannot_send_mode_04() -> None:
    car = ObdCar()
    assert await car.run("obd", *ARGS) == 0
    assert car.clears_sent == 0
    with pytest.raises(GuardError):
        permit(DiagProtocol.OBD, bytes([0x04]))


async def test_request_cannot_send_the_obd_clear() -> None:
    car = ObdCar()
    assert await car.run("request", "engine", "04", *ARGS, "--profile", "mercedes-w211") == 1
    assert car.core.requests == []
