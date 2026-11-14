import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, UdsEcu

ADAPTER = ["--adapter", "tcp://fake:1"]


@dataclass(frozen=True)
class Case:
    """One protocol's profile and an invented record: these bytes address nothing on a real car."""

    profile: str
    read: str
    write: str
    previous: str
    value: str


KWP = Case("mercedes-w211", read="2142", write="3B420203", previous="0001", value="0203")
UDS = Case("vag-mqb", read="220142", write="2E01420203", previous="0001", value="0203")
CASES = pytest.mark.parametrize("case", [KWP, UDS], ids=["kwp2000", "uds"])


class Car:
    """A fake car whose engine unit holds one writable record, and a record of what was said."""

    def __init__(self, case: Case) -> None:
        self.case = case
        self.ecu: KwpEcu | UdsEcu
        if case is KWP:
            self.ecu = KwpEcu(0x7E8, [])
            self.ecu.records[0x42] = bytes.fromhex(case.previous)
        else:
            self.ecu = UdsEcu(0x7E8, [])
            self.ecu.records[0x0142] = bytes.fromhex(case.previous)
        self.core = FakeElmCore({0x7E0: self.ecu})
        self.transport = FakeTransport(self.core)
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str, answer: str = "") -> int:
        return await run(
            [*argv, *ADAPTER, "--profile", self.case.profile],
            self.lines.append,
            lambda _prompt: answer,
            self.factory,
        )

    async def write(self, save: Path, *, answer: str = "yes", request: str = "") -> int:
        return await self.run(
            "write",
            "engine",
            "--request",
            request or self.case.write,
            "--read",
            self.case.read,
            "--save",
            str(save),
            answer=answer,
        )

    @property
    def record(self) -> bytes:
        key = 0x42 if self.case is KWP else 0x0142
        return self.ecu.records[key]

    @property
    def writes_sent(self) -> list[str]:
        return [line for line in self.core.requests if line.startswith(("3B", "2E"))]

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


@CASES
async def test_write_saves_confirms_writes_once_and_reads_back(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    save = tmp_path / "before.json"
    assert await car.write(save) == 0
    saved = json.loads(save.read_text())
    assert saved["kind"] == "write"
    assert saved["unit"] == {"name": "engine", "request_id": "7E0", "response_id": "7E8"}
    assert saved["read_request"] == case.read
    assert saved["write_request"] == case.write
    assert saved["previous_value"] == case.previous
    assert saved["taken"]
    assert car.writes_sent == [case.write]
    requests = car.core.requests
    assert requests.index(case.write) > requests.index(case.read)
    assert requests[requests.index(case.write) + 1 :] == [case.read]
    assert car.record == bytes.fromhex(case.value)
    assert f"current value: {case.previous}" in car.output
    assert f"write request: {case.write}" in car.output
    assert "unit: engine (7E0 -> 7E8)" in car.output
    assert f"read back: {case.value}" in car.output
    assert car.lines[-1] == "the value now matches the request"


@CASES
@pytest.mark.parametrize("answer", ["", "y", "no", "YES", "yes please"])
async def test_declined_prompt_sends_no_write(case: Case, answer: str, tmp_path: Path) -> None:
    car = Car(case)
    save = tmp_path / "before.json"
    assert await car.write(save, answer=answer) == 1
    assert car.writes_sent == []
    assert car.record == bytes.fromhex(case.previous)
    assert save.exists()
    assert car.lines[-1] == "nothing written"


@CASES
async def test_there_is_no_flag_that_skips_the_prompt(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    with pytest.raises(SystemExit):
        await car.run(
            "write",
            "engine",
            "--request",
            case.write,
            "--read",
            case.read,
            "--save",
            str(tmp_path / "s.json"),
            "--yes",
        )
    assert car.core.sent == []


@CASES
async def test_existing_save_file_sends_nothing(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    save = tmp_path / "before.json"
    save.write_text("an earlier snapshot")
    assert await car.write(save) == 1
    assert car.core.requests == []
    assert save.read_text() == "an earlier snapshot"
    assert "already exists" in car.lines[-1]


@CASES
async def test_failed_pre_read_sends_no_write(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    car.ecu.records.clear()
    save = tmp_path / "before.json"
    assert await car.write(save) == 1
    assert car.writes_sent == []
    assert not save.exists()
    assert "nothing written" in car.lines[-1]


@CASES
async def test_silent_unit_sends_no_write(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    car.core.responders[0x7E0] = lambda _request: []
    save = tmp_path / "before.json"
    assert await car.write(save) == 1
    assert car.writes_sent == []
    assert not save.exists()


@CASES
async def test_save_file_removed_before_the_write_sends_nothing(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    save = tmp_path / "before.json"

    def remove_then_agree(_prompt: str) -> str:
        save.unlink()
        return "yes"

    status = await run(
        [
            "write",
            "engine",
            "--request",
            case.write,
            "--read",
            case.read,
            "--save",
            str(save),
            *ADAPTER,
            "--profile",
            case.profile,
        ],
        car.lines.append,
        remove_then_agree,
        car.factory,
    )
    assert status == 1
    assert car.writes_sent == []
    assert "has gone" in car.lines[-1]


@CASES
@pytest.mark.parametrize(
    "mismatch",
    ["the read names another identifier", "the read is a different service"],
)
async def test_a_read_that_does_not_match_the_write_sends_nothing(
    case: Case, mismatch: str, tmp_path: Path
) -> None:
    car = Car(case)
    read = case.read[:-2] + "43" if "identifier" in mismatch else "1A86"
    status = await car.run(
        "write",
        "engine",
        "--request",
        case.write,
        "--read",
        read,
        "--save",
        str(tmp_path / "s.json"),
        answer="yes",
    )
    assert status == 1
    assert car.core.requests == []
    assert "the read request must be" in car.lines[-1]


@CASES
@pytest.mark.parametrize("request_hex", ["2701", "3101", "1A86", "300A07", "2F012303", "1002"])
async def test_write_sends_only_the_write_service(
    case: Case, request_hex: str, tmp_path: Path
) -> None:
    car = Car(case)
    status = await car.write(tmp_path / "s.json", request=request_hex)
    assert status == 1
    assert car.core.requests == []


@CASES
async def test_a_refused_write_is_reported(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    car.ecu.writes_refused = True
    assert await car.write(tmp_path / "s.json") == 1
    assert "refused with code 22" in car.lines[-1]
    assert car.record == bytes.fromhex(case.previous)


@CASES
async def test_a_value_that_reads_back_differently_is_reported(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    respond = car.ecu.reply

    def keep_old_value(request: bytes) -> list[tuple[int, bytes]]:
        reply = respond(request)
        car.ecu.records = {key: bytes.fromhex(case.previous) for key in car.ecu.records}
        return [(0x7E8, reply)]

    car.core.responders[0x7E0] = keep_old_value
    save = tmp_path / "s.json"
    assert await car.write(save) == 1
    assert "does not match the request" in car.lines[-1]
    assert str(save) in car.lines[-1]


@CASES
async def test_restore_writes_back_the_saved_value(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    first = tmp_path / "first.json"
    assert await car.write(first) == 0
    assert car.record == bytes.fromhex(case.value)
    second = tmp_path / "second.json"
    restore = ["restore", "engine", "--snapshot", str(first), "--save", str(second)]
    assert await car.run(*restore, answer="yes") == 0
    assert car.record == bytes.fromhex(case.previous)
    saved = json.loads(second.read_text())
    assert saved["previous_value"] == case.value
    assert saved["restores"] == str(first)
    restore_write = case.write[: -len(case.value)] + case.previous
    assert saved["write_request"] == restore_write
    assert car.writes_sent == [case.write, restore_write]
    assert f"this puts back the value saved in {first}" in car.output


@CASES
async def test_restore_has_the_same_safeguards(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    first = tmp_path / "first.json"
    assert await car.write(first) == 0
    second = tmp_path / "second.json"
    restore = ["restore", "engine", "--snapshot", str(first), "--save", str(second)]
    assert await car.run(*restore, answer="no") == 1
    assert car.writes_sent == [case.write]
    assert second.exists()
    assert await car.run(*restore, answer="yes") == 1
    assert "already exists" in car.lines[-1]
    assert car.writes_sent == [case.write]
    in_place = ["restore", "engine", "--snapshot", str(first), "--save", str(first)]
    assert await car.run(*in_place, answer="yes") == 1
    assert car.writes_sent == [case.write]


@CASES
async def test_restore_refuses_a_snapshot_from_another_unit(case: Case, tmp_path: Path) -> None:
    car = Car(case)
    first = tmp_path / "first.json"
    assert await car.write(first) == 0
    saved = json.loads(first.read_text())
    saved["unit"]["name"] = "gearbox"
    moved = tmp_path / "moved.json"
    moved.write_text(json.dumps(saved))
    sent = list(car.core.sent)
    restore = ["restore", "engine", "--snapshot", str(moved), "--save", str(tmp_path / "r.json")]
    assert await car.run(*restore, answer="yes") == 1
    assert "was taken from" in car.lines[-1]
    assert [line for line in car.core.sent[len(sent) :] if line.startswith(("3B", "2E"))] == []


@CASES
async def test_restore_refuses_a_file_that_is_not_a_write_snapshot(
    case: Case, tmp_path: Path
) -> None:
    car = Car(case)
    other = tmp_path / "clear.json"
    other.write_text(json.dumps({"tool": "obd-read", "units": []}))
    restore = ["restore", "engine", "--snapshot", str(other), "--save", str(tmp_path / "r.json")]
    assert await car.run(*restore, answer="yes") == 1
    assert "not a write snapshot" in car.lines[-1]
    assert car.writes_sent == []


@CASES
@pytest.mark.parametrize("request_hex", ["3B420203", "2E01420203", "300A07", "2F012303"])
async def test_request_and_read_paths_cannot_write_or_actuate(case: Case, request_hex: str) -> None:
    car = Car(case)
    assert await car.run("request", "engine", request_hex, answer="yes") == 1
    assert car.core.requests == []
    assert "refused" in car.lines[-1]
    for command in ("ident", "faults", "freeze"):
        await car.run(command, "engine")
    assert car.writes_sent == []
    assert [line for line in car.core.requests if line.startswith(("30", "2F"))] == []
