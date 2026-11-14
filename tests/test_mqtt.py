import json
import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from obd_read.cli import build_parser, run
from obd_read.mqtt import (
    PASSWORD_VARIABLE,
    USER_VARIABLE,
    BrokerError,
    BrokerSettings,
    Publisher,
    connect_aiomqtt,
    slug,
)
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport
from .test_live import KWP_PROFILE, ValueKwpEcu
from .transcripts import load_replies, responder

RECORDED = ("a150-modes-01-to-09.txt", "a150-since-clear.txt")
SECRET = "hunter2-made-up-password"
USER = "made-up-user"


class VoltageCore(FakeElmCore):
    """A fake adapter that reports a voltage and answers the recorded legislated values."""

    def __init__(self, units: dict[int, object], *, voltage: str = "12.4V") -> None:
        super().__init__(units)  # type: ignore[arg-type]
        self.voltage = voltage

    def _handle(self, line: str) -> str:
        if line == "ATRV":
            return self.voltage
        return super()._handle(line)


class Message:
    def __init__(self, topic: str, payload: str, retain: bool) -> None:
        self.topic, self.payload, self.retain = topic, payload, retain


class FakeBroker:
    """A recording stand-in for a broker connection: the settings it was given and what was published."""

    def __init__(self, *, fail_after: int | None = None) -> None:
        self.settings: BrokerSettings | None = None
        self.messages: list[Message] = []
        self.closed = False
        self.fail_after = fail_after

    @asynccontextmanager
    async def connect(self, settings: BrokerSettings) -> AsyncIterator[Publisher]:
        self.settings = settings
        broker = self

        class Recorder:
            async def publish(self, topic: str, payload: str, *, retain: bool) -> None:
                if broker.fail_after is not None and len(broker.messages) >= broker.fail_after:
                    raise BrokerError("connection lost")
                broker.messages.append(Message(topic, payload, retain))

        try:
            yield Recorder()
        finally:
            self.closed = True

    def on(self, topic: str) -> list[Message]:
        return [m for m in self.messages if m.topic == topic]


class Rig:
    def __init__(self, core: VoltageCore, broker: FakeBroker | None = None) -> None:
        self.core = core
        self.broker = broker or FakeBroker()
        self.transport = FakeTransport(core)
        self.lines: list[str] = []

    def factory(self, _url: str) -> Transport:
        return self.transport

    async def run(self, *argv: str) -> int:
        return await run(
            ["mqtt", "--adapter", "tcp://fake:1", "--broker-host", "broker.local", *argv],
            self.lines.append,
            factory=self.factory,
            broker=self.broker.connect,
        )

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


def legislated_core() -> VoltageCore:
    return VoltageCore({0x7DF: responder(load_replies(*RECORDED))})


@pytest.fixture(autouse=True)
def no_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(USER_VARIABLE, raising=False)
    monkeypatch.delenv(PASSWORD_VARIABLE, raising=False)


async def test_values_and_voltage_are_published_with_discovery() -> None:
    rig = Rig(legislated_core())
    assert await rig.run("--values", "short-fuel-trim-b1,fuel-level", "--count", "1") == 0
    broker = rig.broker
    config = broker.on("homeassistant/sensor/tcp_fake_1_fuel_tank_level/config")
    assert len(config) == 1
    assert config[0].retain
    payload = json.loads(config[0].payload)
    assert payload["unit_of_measurement"] == "%"
    assert payload["state_class"] == "measurement"
    assert "device_class" not in payload
    assert payload["unique_id"] == "tcp_fake_1_fuel_tank_level"
    assert payload["state_topic"] == "obd-read/tcp_fake_1/fuel_tank_level"
    assert payload["availability_topic"] == "obd-read/tcp_fake_1/availability"
    assert payload["device"]["identifiers"] == ["tcp_fake_1"]
    assert payload["expire_after"] == 30
    voltage = json.loads(
        broker.on("homeassistant/sensor/tcp_fake_1_adapter_voltage/config")[0].payload
    )
    assert (voltage["unit_of_measurement"], voltage["device_class"]) == ("V", "voltage")
    assert broker.on("obd-read/tcp_fake_1/fuel_tank_level")[0].payload == "34.90196078"
    assert broker.on("obd-read/tcp_fake_1/adapter_voltage")[0].payload == "12.4"
    assert not broker.on("obd-read/tcp_fake_1/fuel_tank_level")[0].retain


async def test_availability_is_online_then_offline_with_a_retained_will() -> None:
    rig = Rig(legislated_core())
    assert await rig.run("--values", "fuel-level", "--count", "1") == 0
    availability = rig.broker.on("obd-read/tcp_fake_1/availability")
    assert [(m.payload, m.retain) for m in availability] == [("online", True), ("offline", True)]
    settings = rig.broker.settings
    assert settings is not None
    assert (settings.will.topic, settings.will.payload, settings.will.retain) == (
        "obd-read/tcp_fake_1/availability",
        "offline",
        True,
    )
    # Discovery precedes the first state, so Home Assistant knows the sensor before its value.
    topics = [m.topic for m in rig.broker.messages]
    assert topics.index("homeassistant/sensor/tcp_fake_1_fuel_tank_level/config") < topics.index(
        "obd-read/tcp_fake_1/fuel_tank_level"
    )


async def test_offline_is_published_when_the_run_fails() -> None:
    rig = Rig(legislated_core())
    rig.core.voltage = "?"
    assert await rig.run("--values", "fuel-level", "--count", "2", "--interval", "0.01") == 0
    # A voltage the adapter cannot give is said once and not published.
    assert rig.output.count("adapter voltage not read") == 1
    assert not rig.broker.on("obd-read/tcp_fake_1/adapter_voltage")
    broken = Rig(legislated_core(), FakeBroker(fail_after=4))
    assert await broken.run("--values", "fuel-level", "--count", "3", "--interval", "0.01") == 1
    assert "error: connection lost" in broken.output
    assert broken.broker.closed


async def test_options_set_the_topics_and_the_device() -> None:
    rig = Rig(legislated_core())
    assert (
        await rig.run(
            "--values", "fuel-level", "--count", "1", "--topic-prefix", "car", "--discovery-prefix",
            "ha", "--device-id", "w211", "--no-voltage", "--broker-port", "8883", "--tls",
        )
        == 0
    )  # fmt: skip
    assert rig.broker.on("ha/sensor/w211_fuel_tank_level/config")
    assert rig.broker.on("car/w211/fuel_tank_level")
    assert not rig.broker.on("ha/sensor/w211_adapter_voltage/config")
    settings = rig.broker.settings
    assert settings is not None
    assert (settings.host, settings.port, settings.tls) == ("broker.local", 8883, True)


async def test_profile_values_are_published_and_a_known_unit_gets_a_device_class(
    tmp_path: Path,
) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(KWP_PROFILE)
    rig = Rig(VoltageCore({0x7E0: ValueKwpEcu(0x7E8, [])}))
    assert (
        await rig.run(
            "engine",
            "--profile",
            str(profile),
            "--values",
            "boost,rail-temperature",
            "--count",
            "1",
        )
        == 0
    )
    boost = json.loads(
        rig.broker.on("homeassistant/sensor/tcp_fake_1_boost_pressure/config")[0].payload
    )
    assert boost["device_class"] == "pressure"
    assert rig.broker.on("obd-read/tcp_fake_1/boost_pressure")[0].payload == "260"
    assert rig.broker.on("obd-read/tcp_fake_1/rail_temperature")[0].payload == "-45"
    assert "unconfirmed identifiers" in rig.output


async def test_the_requests_sent_are_those_the_live_command_sends() -> None:
    published = Rig(legislated_core())
    assert await published.run("--values", "fuel-level", "--count", "1") == 0
    live_core = legislated_core()
    live_lines: list[str] = []
    transport = FakeTransport(live_core)
    assert (
        await run(
            ["live", "--adapter", "tcp://fake:1", "--values", "fuel-level"],
            live_lines.append,
            factory=lambda _url: transport,
        )
        == 0
    )
    # Only the adapter's own voltage reading is added, and that is an AT command, not a bus request.
    assert published.core.requests == live_core.requests


async def test_credentials_come_from_the_environment_and_are_never_shown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv(USER_VARIABLE, USER)
    monkeypatch.setenv(PASSWORD_VARIABLE, SECRET)
    rig = Rig(legislated_core())
    log = tmp_path / "adapter.log"
    with caplog.at_level(logging.DEBUG):
        assert await rig.run("--values", "fuel-level", "--count", "1", "--log", str(log)) == 0
    settings = rig.broker.settings
    assert settings is not None
    assert (settings.username, settings.password) == (USER, SECRET)
    everything = [
        rig.output,
        repr(settings),
        str(settings),
        caplog.text,
        log.read_text(),
        *(m.topic + m.payload for m in rig.broker.messages),
    ]
    for text in everything:
        assert SECRET not in text
        assert USER not in text


async def test_a_failure_does_not_echo_the_password(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(USER_VARIABLE, USER)
    monkeypatch.setenv(PASSWORD_VARIABLE, SECRET)
    rig = Rig(legislated_core(), FakeBroker(fail_after=0))
    assert await rig.run("--values", "fuel-level", "--count", "1") == 1
    assert SECRET not in rig.output


async def test_a_password_without_a_user_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(PASSWORD_VARIABLE, SECRET)
    rig = Rig(legislated_core())
    assert await rig.run("--values", "fuel-level", "--count", "1") == 1
    assert f"{PASSWORD_VARIABLE} is set but {USER_VARIABLE} is not" in rig.output
    assert SECRET not in rig.output
    assert rig.broker.settings is None


@pytest.mark.parametrize("flag", ["--password", "--user", "--username", "--broker-password"])
def test_credentials_are_not_accepted_on_the_command_line(
    flag: str, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            ["mqtt", "--adapter", "tcp://x:1", "--broker-host", "b", flag, SECRET]
        )
    assert SECRET not in capsys.readouterr().err.replace(
        f"unrecognized arguments: {flag} {SECRET}", ""
    )


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--interval", "0"], "--interval must be positive"),
        (["--count", "-1"], "--count must not be negative"),
        (["--broker-port", "0"], "--broker-port must be between"),
        (["--topic-prefix", "a/#"], "--topic-prefix must be a topic"),
        (["--discovery-prefix", "/ha"], "--discovery-prefix must be a topic"),
        (["--device-id", "My Car"], "--device-id may hold only"),
    ],
)
async def test_bad_options_are_refused_before_connecting(args: list[str], message: str) -> None:
    rig = Rig(legislated_core())
    assert await rig.run("--values", "fuel-level", *args) == 1
    assert message in rig.output
    assert rig.broker.settings is None


async def test_a_missing_client_library_is_reported_with_the_fix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "aiomqtt", None)
    settings = BrokerSettings(
        "h",
        1883,
        "c",
        __import__("obd_read.mqtt", fromlist=["Will"]).Will("t", "offline", True),
        False,
    )
    with pytest.raises(BrokerError, match="uv sync --extra mqtt"):
        async with connect_aiomqtt(settings):
            pass


def test_slug_keeps_topic_safe_characters_only() -> None:
    assert slug("ble://vLinker MC+") == "ble_vlinker_mc"
    assert slug("boost pressure, actual") == "boost_pressure_actual"
