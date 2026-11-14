"""Bluetooth LE link, for adapters that expose a serial-style notify and write pair."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

from .base import TransportError, TransportTimeout

# Services every Bluetooth LE device carries that never hold the adapter's data channel: Generic Access, Generic Attribute and Device Information.
STANDARD_SERVICES = ("00001800", "00001801", "0000180a")

# The smallest payload every Bluetooth LE link accepts in one write.
MIN_WRITE_SIZE = 20


@dataclass(frozen=True)
class GattCharacteristic:
    """One characteristic as the picker sees it: where it is and what it allows."""

    service: str
    uuid: str
    properties: tuple[str, ...]


@dataclass(frozen=True)
class DataChannel:
    """The pair of characteristics that carry the adapter's text interface."""

    notify: str
    write: str
    write_with_response: bool


def pick_data_channel(
    characteristics: Sequence[GattCharacteristic],
    service: str | None = None,
    notify: str | None = None,
    write: str | None = None,
) -> DataChannel:
    """Choose the notify and write characteristics that carry the adapter's data.

    With no overrides, the first non-standard service holding both a notifying and a writable characteristic is used. `service`, `notify` and `write` are UUIDs (or UUID prefixes) that narrow or fix the choice. Raises TransportError when nothing fits.
    """

    def matches(uuid: str, wanted: str | None) -> bool:
        return wanted is None or uuid.lower().startswith(wanted.lower())

    by_service: dict[str, list[GattCharacteristic]] = {}
    for characteristic in characteristics:
        if characteristic.service.lower().startswith(STANDARD_SERVICES):
            continue
        if not matches(characteristic.service, service):
            continue
        by_service.setdefault(characteristic.service, []).append(characteristic)

    for members in by_service.values():
        notifying = [
            c
            for c in members
            if ("notify" in c.properties or "indicate" in c.properties) and matches(c.uuid, notify)
        ]
        writable = [
            c
            for c in members
            if ("write" in c.properties or "write-without-response" in c.properties)
            and matches(c.uuid, write)
        ]
        if notifying and writable:
            target = writable[0]
            return DataChannel(
                notify=notifying[0].uuid,
                write=target.uuid,
                write_with_response="write-without-response" not in target.properties,
            )
    raise TransportError(
        "no service on this device has both a notifying and a writable characteristic; "
        "run `obd-read adapters --inspect <name>` and pass service, notify and write in the URL"
    )


def describe_services(client: BleakClient) -> list[GattCharacteristic]:
    """List every characteristic the connected device exposes."""
    return [
        GattCharacteristic(service.uuid, characteristic.uuid, tuple(characteristic.properties))
        for service in client.services
        for characteristic in service.characteristics
    ]


async def find_device(target: str, timeout: float) -> BLEDevice:
    """Find the device whose address equals `target` or whose name contains it."""
    wanted = target.lower()

    def is_target(device: BLEDevice, advertisement: AdvertisementData) -> bool:
        name = (advertisement.local_name or device.name or "").lower()
        return device.address.lower() == wanted or (bool(name) and wanted in name)

    device = await BleakScanner.find_device_by_filter(is_target, timeout=timeout)
    if device is None:
        raise TransportError(f"no Bluetooth LE device matching {target!r} seen in {timeout:.0f} s")
    return device


class BleTransport:
    """An ELM327 adapter reached over Bluetooth LE."""

    def __init__(
        self,
        target: str,
        service: str | None = None,
        notify: str | None = None,
        write: str | None = None,
        scan_timeout: float = 15.0,
    ) -> None:
        self._target = target
        self._service = service
        self._notify = notify
        self._write = write
        self._scan_timeout = scan_timeout
        self._client: BleakClient | None = None
        self._channel: DataChannel | None = None
        self._incoming: asyncio.Queue[bytes] = asyncio.Queue()

    async def open(self) -> None:
        device = await find_device(self._target, self._scan_timeout)
        client = BleakClient(device)
        try:
            await client.connect()
        except Exception as error:
            raise TransportError(f"cannot connect to {self._target!r}: {error}") from error
        self._client = client
        try:
            self._channel = pick_data_channel(
                describe_services(client), self._service, self._notify, self._write
            )
            await client.start_notify(self._channel.notify, self._on_data)
        except Exception:
            await self.close()
            raise

    def _on_data(self, _characteristic: BleakGATTCharacteristic, data: bytearray) -> None:
        self._incoming.put_nowait(bytes(data))

    async def close(self) -> None:
        if self._client is not None:
            await self._client.disconnect()
            self._client = None
            self._channel = None

    async def write(self, data: bytes) -> None:
        if self._client is None or self._channel is None:
            raise TransportError("Bluetooth LE link is not open")
        for start in range(0, len(data), MIN_WRITE_SIZE):
            await self._client.write_gatt_char(
                self._channel.write,
                data[start : start + MIN_WRITE_SIZE],
                response=self._channel.write_with_response,
            )

    async def read(self, timeout: float) -> bytes:
        try:
            return await asyncio.wait_for(self._incoming.get(), timeout)
        except TimeoutError as error:
            raise TransportTimeout(f"nothing received in {timeout:.1f} s") from error
