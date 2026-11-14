from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.elm import Elm, ElmError, NoResponse
from obd_read.guard import DiagProtocol, GuardError, permit
from obd_read.kline import KLineElm, checksum, parse_reply_line, select_bus
from obd_read.profile import KLineBus, ProfileError, parse_profile
from obd_read.transport import Transport

from .fake_elm import FakeTransport
from .fake_kline import FakeKLineCore, reply_line

PROFILE = """
name = "old-car"
description = "Example K-line car"
status = "unconfirmed"

[bus]
kline = "kwp2000-slow"

[diagnostics]
protocol = "kwp2000"
session = 0x81

[units.engine]
description = "Engine control unit"
request = 0x01
response = 0x01
source = "test"

[units.abs]
description = "Brakes"
request = 0x03
response = 0x03
source = "test"
"""


def engine(request: bytes) -> bytes | None:
    service = request[0]
    if service == 0x10:
        return bytes([0x50, request[1]])
    if service == 0x1A:
        return bytes([0x5A, 0x86]) + b"06A906032"
    if service == 0x18:
        return bytes([0x58, 0x01, 0x01, 0x23, 0x60])
    if service == 0x01:
        return bytes([0x41, request[1], 0xBE, 0x3E])
    return bytes([0x7F, service, 0x11])


class KLineCar:
    def __init__(self, silent_init: frozenset[int] = frozenset()) -> None:
        self.core = FakeKLineCore({0x01: engine}, silent_init)
        self.lines: list[str] = []
        self.transport = FakeTransport(self.core)  # type: ignore[arg-type]

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str, profile: str) -> int:
        return await run(
            [*argv, "--adapter", "tcp://fake:1", "--profile", profile],
            self.lines.append,
            lambda _prompt: "",
            self.factory,
        )

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


def write(directory: Path, text: str) -> str:
    path = directory / "car.toml"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_checksum_is_the_modular_sum() -> None:
    assert checksum(bytes([0xFF, 0x02])) == 0x01


def test_reply_line_is_split_into_source_and_data() -> None:
    line = reply_line(0x01, bytes([0x41, 0x00, 0xBE]))
    assert parse_reply_line(line) == (0x01, bytes([0x41, 0x00, 0xBE]))
    assert parse_reply_line(" ".join(line[i : i + 2] for i in range(0, len(line), 2)))[0] == 0x01


@pytest.mark.parametrize(
    "line", ["", "48F101", "XYZ", "48F10141FF", reply_line(1, b"\x41", corrupt=True)]
)
def test_malformed_reply_lines_are_refused(line: str) -> None:
    with pytest.raises(ElmError):
        parse_reply_line(line)


async def test_probe_initialises_each_unit_and_reports_who_answers(tmp_path: Path) -> None:
    car = KLineCar(silent_init=frozenset({0x03}))
    assert await car.run("probe", profile=write(tmp_path, PROFILE)) == 0
    assert "engine (1 -> 1): answered" in car.output
    assert "abs (3 -> 3): no answer" in car.output
    sent = car.core.sent
    assert "ATSP4" in sent
    assert sent.index("ATIIA01") < sent.index("ATSH C0 01 F1".replace(" ", "")) < sent.index("ATSI")
    assert "ATIIA03" in sent
    assert car.core.requests == ["1081", "1A86"]


async def test_faults_and_identification_over_k_line(tmp_path: Path) -> None:
    car = KLineCar()
    assert await car.run("faults", "engine", profile=write(tmp_path, PROFILE)) == 0
    assert "fault codes: 1" in car.output
    assert "0123  status 60" in car.output
    assert "06A906032" in car.output


async def test_fast_init_uses_atfi_and_no_slow_address(tmp_path: Path) -> None:
    car = KLineCar()
    profile = write(tmp_path, PROFILE.replace("kwp2000-slow", "kwp2000-fast"))
    assert await car.run("ident", "engine", profile=profile) == 0
    assert "ATFI" in car.core.sent
    assert "ATSI" not in car.core.sent
    assert not any(line.startswith("ATIIA") for line in car.core.sent)
    assert "ATSP5" in car.core.sent


async def test_a_reply_that_fails_its_checksum_is_an_error_not_data(tmp_path: Path) -> None:
    car = KLineCar()
    car.core.corrupt = True
    await car.run("probe", profile=write(tmp_path, PROFILE))
    assert "engine (1 -> 1): no answer" in car.output
    assert "fails its checksum" in car.output


async def test_the_guard_still_refuses_writes_on_k_line(tmp_path: Path) -> None:
    car = KLineCar()
    assert await car.run("request", "engine", "2E0101", profile=write(tmp_path, PROFILE)) == 1
    assert "refused" in car.output
    assert car.core.requests == []


async def test_obd_over_k_line_reads_the_legislated_modes() -> None:
    car = KLineCar()
    # A functional request leaves the header at its default, so the fake answers from address 0.
    car.core.units[0x00] = engine
    lines: list[str] = []
    status = await run(
        ["obd", "--adapter", "tcp://fake:1", "--kline", "iso9141"],
        lines.append,
        lambda _p: "",
        car.factory,
    )
    assert "ATSP3" in car.core.sent
    assert status == 0
    assert any(line.startswith("unit 0: warning lamp") for line in lines)


async def test_request_before_a_protocol_is_selected_fails() -> None:
    elm = KLineElm(FakeTransport(FakeKLineCore({})))  # type: ignore[arg-type]
    with pytest.raises(ElmError):
        await elm.address_unit(1, 1)


async def test_silent_initialisation_is_no_response() -> None:
    elm = KLineElm(FakeTransport(FakeKLineCore({}, frozenset({0}))))  # type: ignore[arg-type]
    await elm.select_kline(KLineBus("iso9141", 0xF1, 0x68))
    await elm.address_unit(0, 0)
    with pytest.raises(NoResponse):
        await elm.request(permit(DiagProtocol.OBD, bytes([0x01, 0x00])))


async def test_the_k_line_session_refuses_can_and_can_sessions_refuse_k_line() -> None:
    elm = KLineElm(FakeTransport(FakeKLineCore({})))  # type: ignore[arg-type]
    with pytest.raises(ElmError):
        await elm.select_can(11, 500_000)
    profile = parse_profile(PROFILE, "test")
    with pytest.raises(ElmError):
        await select_bus(Elm(FakeTransport(FakeKLineCore({}))), profile)  # type: ignore[arg-type]


def test_profile_rules_for_k_line() -> None:
    profile = parse_profile(PROFILE, "test")
    assert profile.bus == KLineBus("kwp2000-slow", 0xF1, 0xC0)
    with pytest.raises(ProfileError):
        _ = profile.id_bits
    with pytest.raises(ProfileError, match="kline must be one of"):
        parse_profile(PROFILE.replace("kwp2000-slow", "carrier-pigeon"), "test")
    with pytest.raises(ProfileError, match="carries kwp2000 only"):
        parse_profile(PROFILE.replace('protocol = "kwp2000"', 'protocol = "uds"'), "test")
    custom = parse_profile(
        PROFILE.replace('kline = "kwp2000-slow"', 'kline = "iso9141"\ntester = 0xF2'), "t"
    )
    assert custom.bus == KLineBus("iso9141", 0xF2, 0x68)
    with pytest.raises(GuardError):
        permit(DiagProtocol.KWP2000, bytes([0x2E, 0x01]))
