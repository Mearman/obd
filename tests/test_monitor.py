from datetime import UTC, datetime
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.guard import GuardError
from obd_read.monitor import MonitorFilter, format_frame, monitor_command, parse_stream_line
from obd_read.transport import Transport, TransportTimeout
from obd_read.transport.can import CanFrame
from obd_read.transport.rawcan import RawCanTransport

from .fake_can import FakeCanLink
from .fake_elm import FakeElmCore


class MonitoringAdapter:
    """A scripted adapter that streams frames after STM or ATMA until it is sent any byte."""

    def __init__(self, stream: list[str], stn: bool) -> None:
        self.core = FakeElmCore({}, stn_identity="STN1110 v4.2" if stn else None)
        self.stream = stream
        self.monitoring = False
        self.stopped = False
        self._out = b""

    async def open(self) -> None: ...
    async def close(self) -> None: ...

    async def write(self, data: bytes) -> None:
        if self.monitoring:
            self.monitoring = False
            self.stopped = True
            self._out += b"STOPPED\r\r>"
            return
        if data.strip() in (b"STM", b"ATMA"):
            self.core.sent.append(data.strip().decode())
            self.monitoring = True
            self._out += "".join(f"{line}\r" for line in self.stream).encode("ascii")
            return
        self._out += self.core.feed(data)

    async def read(self, timeout: float) -> bytes:
        if not self._out:
            raise TransportTimeout("quiet")
        data, self._out = self._out[:7], self._out[7:]
        return data


class Run:
    def __init__(self, transport: Transport) -> None:
        self.transport = transport
        self.lines: list[str] = []

    async def go(self, *argv: str) -> int:
        return await run(
            ["monitor", "--adapter", "tcp://fake:1", *argv],
            self.lines.append,
            lambda _p: "",
            lambda _url: self.transport,
        )

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


STREAM = ["7E8064100BE3FA813", "7E1034100BE", "BUFFER FULL", "5A0", "7DF02010C"]


def test_the_monitor_only_allows_listening_commands() -> None:
    for text in (
        "ATMA",
        "STM",
        "STFAC",
        "ATCRA7E8",
        "ATCRA",
        "STFPA 07E8,07FF",
        "STFBA 07DF,07FF",
        "STFFCA 07E0,07FF",
        "ATCF7E8",
        "ATCM7F8",
        "STCMM 0",
    ):
        assert monitor_command(text) == text
    for text in (
        "0100",
        "STCMM 1",
        "STCMM 2",
        "ATSH7E0",
        "STPX d:0100",
        "ATFCSH7E0",
        "ATZ",
        "ATCRA7E8 ;",
        "ATCAF0",
    ):
        with pytest.raises(GuardError):
            monitor_command(text)


def test_filter_semantics() -> None:
    assert MonitorFilter().accepts(0x123)
    assert not MonitorFilter(block_ids=(0x123,)).accepts(0x123)
    keep = MonitorFilter(pass_ids=(0x7E8,), flow_control_ids=(0x7E0,))
    assert keep.accepts(0x7E8) and keep.accepts(0x7E0) and not keep.accepts(0x7DF)
    assert not MonitorFilter(pass_ids=(0x7E8,), block_ids=(0x7E8,)).accepts(0x7E8)


def test_log_line_and_stream_parsing() -> None:
    moment = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=UTC)
    assert (
        format_frame(moment, 0x7E8, bytes([6, 0x41]), 11)
        == "2026-01-02T03:04:05.678+00:00 7E8 0641"
    )
    assert format_frame(moment, 0x18DAF110, b"", 29).endswith(" 18DAF110")
    assert parse_stream_line("7E8 06 41 00", 11) == (0x7E8, bytes([6, 0x41, 0]))
    assert parse_stream_line("7E8", 11) == (0x7E8, b"")
    assert parse_stream_line("BUFFER FULL", 11) is None
    assert parse_stream_line("7E8064", 11) is None


async def test_an_stn_adapter_filters_in_hardware_and_never_acknowledges() -> None:
    adapter = MonitoringAdapter(STREAM, stn=True)
    session = Run(adapter)
    assert await session.go("--id", "7E8", "--id", "7E1", "--block", "7DF", "--count", "2") == 0
    sent = adapter.core.sent
    assert sent[-7:] == [
        "ATSP6",
        "STFAC",
        "STFPA 07E8,07FF",
        "STFPA 07E1,07FF",
        "STFBA 07DF,07FF",
        "STCMM0",
        "STM",
    ]
    assert adapter.core.requests == []
    assert adapter.stopped
    frames = [line for line in session.lines if line[:4] == "2026" or line[:2] == "20"]
    assert [line.split()[1:] for line in frames] == [
        ["7E8", "0641 00BE3FA813".replace(" ", "")],
        ["7E1", "034100BE"],
    ]
    assert "2 frames logged" in session.output


async def test_a_plain_adapter_uses_one_receive_address_and_software_filters() -> None:
    adapter = MonitoringAdapter(STREAM, stn=False)
    session = Run(adapter)
    assert await session.go("--id", "7E8", "--block", "7E1", "--duration", "0.05") == 0
    assert "ATCRA7E8" in adapter.core.sent and "ATMA" in adapter.core.sent
    assert not any(line.startswith(("STF", "STCMM")) for line in adapter.core.sent)
    logged = [line.split()[1] for line in session.lines if line[:2] == "20"]
    assert logged == ["7E8"]
    assert "# adapter: BUFFER FULL" in session.lines


async def test_several_identifiers_on_a_plain_adapter_share_a_filter_and_mask() -> None:
    adapter = MonitoringAdapter(STREAM, stn=False)
    await Run(adapter).go("--id", "7E8", "--id", "7E9", "--duration", "0.05")
    assert "ATCF7E8" in adapter.core.sent
    assert "ATCM7FE" in adapter.core.sent


async def test_a_raw_link_is_listened_to_complete_and_never_transmits() -> None:
    link = FakeCanLink({})
    for can_id, data in ((0x7E8, b"\x03\x41\x00\xbe"), (0x7DF, b"\x02\x01\x00"), (0x123, b"\x01")):
        link.inject(can_id, data)
    session = Run(RawCanTransport(link))
    assert await session.go("--block", "7DF", "--count", "2") == 0
    assert link.sent == []
    assert link.configured == [(500_000, True)]
    assert link.opened and link.closed
    logged = [line.split()[1:] for line in session.lines if line[:2] == "20"]
    assert logged == [["7E8", "034100BECCCCCCCC"], ["123", "01CCCCCCCCCCCCCC"]]
    assert "2 frames logged" in session.output


async def test_the_log_goes_to_a_new_file_and_is_never_overwritten(tmp_path: Path) -> None:
    link = FakeCanLink({})
    link.inject(0x7E8, b"\x01")
    target = tmp_path / "bus.log"
    session = Run(RawCanTransport(link))
    assert await session.go("--count", "1", "--output", str(target)) == 0
    assert target.read_text(encoding="utf-8").split()[1] == "7E8"
    assert f"1 frames logged to {target}" in session.output
    again = Run(RawCanTransport(FakeCanLink({})))
    assert await again.go("--output", str(target)) == 1
    assert "already exists" in again.output
    assert target.read_text(encoding="utf-8").count("\n") == 1


async def test_identifiers_must_fit_the_frame_format() -> None:
    session = Run(RawCanTransport(FakeCanLink({})))
    assert await session.go("--id", "800") == 1
    assert "does not fit 11 bits" in session.output
    assert CanFrame(0x7FF, b"").can_id == 0x7FF
