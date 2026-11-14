"""Publish the values the `live` command reads, and the adapter voltage, to an MQTT broker.

Home Assistant finds the values through MQTT discovery and shows them as sensors under one device per adapter. The values come from the same `Source` the `live` command reads, so nothing is decoded or requested here that `live` would not request, and every request still passes the guard. The broker client is the optional `mqtt` extra and is imported only when a broker is connected to.

The broker credentials come only from the environment (`OBD_READ_MQTT_USER`, `OBD_READ_MQTT_PASSWORD`): nothing on the command line carries them and nothing printed, logged or published includes them.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from .battery import read_voltage
from .elm import AdapterInfo, Elm, ElmError
from .live import Printer, Reading, Source, add_source_options, build_source
from .pids import Column
from .profile import Profile

if TYPE_CHECKING:
    import aiomqtt

USER_VARIABLE = "OBD_READ_MQTT_USER"
PASSWORD_VARIABLE = "OBD_READ_MQTT_PASSWORD"

# The payloads of the availability topic. These are Home Assistant's defaults for `payload_available` and `payload_not_available` (https://www.home-assistant.io/integrations/mqtt/, "Using Availability topics"), so the discovery payload does not repeat them.
ONLINE = "online"
OFFLINE = "offline"

# Home Assistant accepts only these units for each device class (https://www.home-assistant.io/integrations/sensor/, "Device class"), so a class is set only for a unit that is one of its listed units. Any other unit is published with no device class.
DEVICE_CLASSES = {
    "°C": "temperature",
    "V": "voltage",
    "kPa": "pressure",
    "km/h": "speed",
}

VOLTAGE_COLUMN = Column("adapter voltage", "V")


class BrokerError(Exception):
    """The broker could not be reached, refused the connection or the client library is absent."""


class Publisher(Protocol):
    """What this command needs from a broker connection."""

    async def publish(self, topic: str, payload: str, *, retain: bool) -> None:
        """Send one message at QoS 0, retained when `retain` is true."""
        ...


@dataclass(frozen=True)
class Will:
    """The message the broker publishes if the connection is lost without a clean disconnect."""

    topic: str
    payload: str
    retain: bool


@dataclass(frozen=True)
class BrokerSettings:
    """Where and how to connect. The credentials are kept out of the repr so they cannot reach a log through it."""

    host: str
    port: int
    client_id: str
    will: Will
    tls: bool
    username: str | None = field(default=None, repr=False)
    password: str | None = field(default=None, repr=False)


Connect = Callable[[BrokerSettings], AbstractAsyncContextManager[Publisher]]


class AiomqttPublisher:
    """A `Publisher` over an aiomqtt client."""

    def __init__(self, client: aiomqtt.Client) -> None:
        self._client = client

    async def publish(self, topic: str, payload: str, *, retain: bool) -> None:
        import aiomqtt

        try:
            await self._client.publish(topic, payload, qos=0, retain=retain)
        except aiomqtt.MqttError as error:
            raise BrokerError(f"publishing to the broker failed: {error}") from error


@asynccontextmanager
async def connect_aiomqtt(settings: BrokerSettings) -> AsyncIterator[Publisher]:
    """Connect to the broker with aiomqtt, registering the last-will message.

    Raises BrokerError when the `mqtt` extra is not installed or the broker cannot be reached or refuses the connection.
    """
    try:
        import aiomqtt
    except ImportError as error:
        raise BrokerError(
            "MQTT support is not installed; install the extra, for example `uv sync --extra mqtt`"
        ) from error
    client = aiomqtt.Client(
        settings.host,
        settings.port,
        username=settings.username,
        password=settings.password,
        identifier=settings.client_id,
        will=aiomqtt.Will(
            settings.will.topic, settings.will.payload, qos=0, retain=settings.will.retain
        ),
        tls_params=aiomqtt.TLSParameters() if settings.tls else None,
    )
    try:
        async with client:
            yield AiomqttPublisher(client)
    except aiomqtt.MqttError as error:
        raise BrokerError(f"broker {settings.host}:{settings.port}: {error}") from error


def slug(text: str) -> str:
    """Lower-case `text` as a run of letters, digits and underscores.

    Home Assistant allows only letters, digits, underscore and hyphen in a discovery topic's object id (https://www.home-assistant.io/integrations/mqtt/, "Discovery topic").
    """
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


@dataclass(frozen=True)
class Sensor:
    """One published value: where its state goes and how Home Assistant should show it."""

    column: Column
    key: str
    state_topic: str
    discovery_topic: str
    config: str


def unique_keys(columns: tuple[Column, ...]) -> list[str]:
    """One distinct topic-safe key per column, from its label; a repeated label gets a number."""
    keys: list[str] = []
    for column in columns:
        base = slug(column.label) or "value"
        key, number = base, 1
        while key in keys:
            number += 1
            key = f"{base}_{number}"
        keys.append(key)
    return keys


def build_sensors(
    columns: tuple[Column, ...],
    *,
    prefix: str,
    discovery_prefix: str,
    device_id: str,
    adapter: AdapterInfo,
    interval: float,
) -> list[Sensor]:
    """The sensors for `columns`, each with its retained discovery payload.

    Every payload field is a documented sensor or device option of Home Assistant's MQTT integration (https://www.home-assistant.io/integrations/sensor.mqtt/ and https://www.home-assistant.io/integrations/mqtt/).
    """
    availability_topic = f"{prefix}/{device_id}/availability"
    sensors: list[Sensor] = []
    for column, key in zip(columns, unique_keys(columns), strict=True):
        # unique_id is required for discovered entities, and the guide recommends it as the topic's object id with no node id.
        unique_id = f"{device_id}_{key}"
        state_topic = f"{prefix}/{device_id}/{key}"
        config: dict[str, object] = {
            "name": column.label,
            "unique_id": unique_id,
            "state_topic": state_topic,
            "availability_topic": availability_topic,
            # The device map ties every sensor of one adapter to one device in the registry; identifiers is what makes it the same device across restarts.
            "device": {
                "identifiers": [device_id],
                "name": f"obd-read {adapter.identity}",
                "model": adapter.identity,
            },
        }
        if column.unit:
            config["unit_of_measurement"] = column.unit
            # A state class marks a quantity worth long-term statistics; a reading with a unit is a measurement, one with none may be text, which a state class would reject.
            config["state_class"] = "measurement"
            if column.unit in DEVICE_CLASSES:
                config["device_class"] = DEVICE_CLASSES[column.unit]
        if interval > 0:
            # After this many seconds with no update the state becomes unavailable, so a value the car stopped answering does not stay on screen as current. Three intervals tolerate two missed samples.
            config["expire_after"] = math.ceil(interval * 3)
        sensors.append(
            Sensor(
                column,
                key,
                state_topic,
                f"{discovery_prefix}/sensor/{unique_id}/config",
                json.dumps(config),
            )
        )
    return sensors


def state_payload(reading: Reading) -> str | None:
    """The text published for one reading, or None for a value not read this time."""
    if reading is None:
        return None
    return reading if isinstance(reading, str) else f"{reading:.10g}"


def settings_from(
    args: argparse.Namespace, device_id: str, availability_topic: str, environ: Mapping[str, str]
) -> BrokerSettings:
    """The connection settings, with the credentials read from `environ` and nowhere else.

    Raises ValueError for a password with no user, since MQTT 3.1.1 does not allow one.
    """
    username = environ.get(USER_VARIABLE) or None
    password = environ.get(PASSWORD_VARIABLE) or None
    if password is not None and username is None:
        raise ValueError(f"{PASSWORD_VARIABLE} is set but {USER_VARIABLE} is not")
    return BrokerSettings(
        host=args.broker_host,
        port=args.broker_port,
        client_id=f"obd-read-{device_id}",
        will=Will(availability_topic, OFFLINE, retain=True),
        tls=args.tls,
        username=username,
        password=password,
    )


def add_arguments(sub: argparse.ArgumentParser) -> None:
    """Add the `mqtt` command's options. The broker credentials are deliberately not among them."""
    add_source_options(sub)
    sub.add_argument("--broker-host", required=True, help="MQTT broker host name or address")
    sub.add_argument("--broker-port", type=int, default=1883, help="MQTT broker port")
    sub.add_argument("--tls", action="store_true", help="connect to the broker over TLS")
    sub.add_argument("--topic-prefix", default="obd-read", help="prefix of the state topics")
    sub.add_argument(
        "--discovery-prefix",
        default="homeassistant",
        help="Home Assistant's MQTT discovery prefix",
    )
    sub.add_argument(
        "--device-id",
        help="identifier of the Home Assistant device; default is derived from --adapter",
    )
    sub.add_argument("--interval", type=float, default=10.0, help="seconds between samples")
    sub.add_argument(
        "--count", type=int, default=0, help="samples to publish; 0 keeps going until interrupted"
    )
    sub.add_argument(
        "--no-voltage", action="store_true", help="do not publish the adapter's voltage reading"
    )


def validate(args: argparse.Namespace) -> None:
    """Raise ValueError for an option the broker or Home Assistant would reject."""
    if args.count < 0:
        raise ValueError("--count must not be negative")
    if args.interval <= 0:
        raise ValueError("--interval must be positive")
    if not 0 < args.broker_port < 65536:
        raise ValueError("--broker-port must be between 1 and 65535")
    for name in ("topic_prefix", "discovery_prefix"):
        text: str = getattr(args, name)
        flag = "--" + name.replace("_", "-")
        if not text or "+" in text or "#" in text or text.startswith("/") or text.endswith("/"):
            raise ValueError(
                f"{flag} must be a topic with no wildcard and no leading or trailing slash"
            )
    if args.device_id is not None and slug(args.device_id) != args.device_id:
        raise ValueError("--device-id may hold only lower-case letters, digits and underscores")


async def read_all(
    source: Source,
    elm: Elm,
    adapter: AdapterInfo,
    out: Printer,
    *,
    voltage: bool,
    reported: set[str],
) -> tuple[Reading, ...]:
    """One reading per source column, followed by the adapter voltage when `voltage` is set."""
    readings = await source.read(out)
    if not voltage:
        return readings
    try:
        volts: Reading = await read_voltage(elm, stn=adapter.has_stn_extensions, precision=None)
    except ElmError as error:
        # Say so once; an adapter that cannot report a voltage cannot on any sample.
        if "voltage" not in reported:
            reported.add("voltage")
            out(f"adapter voltage not read: {error}")
        volts = None
    return (*readings, volts)


async def mqtt_command(
    elm: Elm,
    adapter: AdapterInfo,
    profile: Profile | None,
    args: argparse.Namespace,
    out: Printer,
    connect: Connect = connect_aiomqtt,
    environ: Mapping[str, str] = os.environ,
) -> int:
    """Run the `mqtt` command: publish what `live` reads, and the voltage, every `--interval` seconds.

    Prints the broker address and the sensor count, never the credentials. Returns 1 when the broker cannot be reached. Raises ValueError for a bad option and ProfileError when a unit is named without a profile.
    """
    validate(args)
    source = await build_source(elm, profile, args, out)
    columns = (*source.columns, *(() if args.no_voltage else (VOLTAGE_COLUMN,)))
    device_id = args.device_id or slug(args.adapter) or "adapter"
    sensors = build_sensors(
        columns,
        prefix=args.topic_prefix,
        discovery_prefix=args.discovery_prefix,
        device_id=device_id,
        adapter=adapter,
        interval=args.interval,
    )
    availability_topic = f"{args.topic_prefix}/{device_id}/availability"
    settings = settings_from(args, device_id, availability_topic, environ)
    for note in source.notes:
        out(note)
    out(
        f"publishing {len(sensors)} sensors to {args.broker_host}:{args.broker_port} "
        f"under {args.topic_prefix}/{device_id}, discovery under {args.discovery_prefix}"
    )
    reported: set[str] = set()
    try:
        async with connect(settings) as publisher:
            for sensor in sensors:
                await publisher.publish(sensor.discovery_topic, sensor.config, retain=True)
            await publisher.publish(availability_topic, ONLINE, retain=True)
            try:
                index = 0
                while args.count == 0 or index < args.count:
                    if index:
                        await asyncio.sleep(args.interval)
                    readings = await read_all(
                        source, elm, adapter, out, voltage=not args.no_voltage, reported=reported
                    )
                    for sensor, reading in zip(sensors, readings, strict=True):
                        payload = state_payload(reading)
                        if payload is not None:
                            await publisher.publish(sensor.state_topic, payload, retain=False)
                    index += 1
            finally:
                # A clean disconnect does not make the broker send the last will, so say offline here; the will covers a lost connection.
                await publisher.publish(availability_topic, OFFLINE, retain=True)
    except BrokerError as error:
        out(f"error: {error}")
        return 1
    return 0
