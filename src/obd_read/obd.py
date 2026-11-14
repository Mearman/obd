"""Legislated OBD-II (SAE J1979) reads, which work on any compliant car without a profile."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .elm import Elm, ElmError, NoResponse
from .guard import DiagProtocol, permit

# Functional request identifiers every emissions-related unit listens on.
FUNCTIONAL_ID: dict[int, int] = {11: 0x7DF, 29: 0x18DB33F1}

CURRENT_DATA = 0x01
STORED_CODES = 0x03
PENDING_CODES = 0x07
VEHICLE_INFORMATION = 0x09
PERMANENT_CODES = 0x0A

PID_MONITOR_STATUS = 0x01
INFO_VIN = 0x02

POSITIVE_OFFSET = 0x40
NEGATIVE_RESPONSE = 0x7F

CODE_LETTERS = "PCBU"


@dataclass(frozen=True)
class LiveValue:
    """One current-data parameter: how to label it and turn its bytes into a number."""

    label: str
    unit: str
    size: int
    decode: Callable[[bytes], float]


LIVE_VALUES: dict[int, LiveValue] = {
    0x04: LiveValue("engine load", "%", 1, lambda d: d[0] * 100 / 255),
    0x05: LiveValue("coolant temperature", "°C", 1, lambda d: d[0] - 40),
    0x0B: LiveValue("intake manifold pressure", "kPa", 1, lambda d: d[0]),
    0x0C: LiveValue("engine speed", "rpm", 2, lambda d: (d[0] * 256 + d[1]) / 4),
    0x0D: LiveValue("vehicle speed", "km/h", 1, lambda d: d[0]),
    0x0F: LiveValue("intake air temperature", "°C", 1, lambda d: d[0] - 40),
    0x42: LiveValue("control module voltage", "V", 2, lambda d: (d[0] * 256 + d[1]) / 1000),
}


@dataclass(frozen=True)
class Readiness:
    """One unit's warning-lamp state and stored-code count."""

    lamp_on: bool
    code_count: int


def decode_code(pair: bytes) -> str:
    """Turn two bytes into a standard fault code such as P0420."""
    return f"{CODE_LETTERS[pair[0] >> 6]}{(pair[0] >> 4) & 0x3:X}{pair[0] & 0xF:X}{pair[1]:02X}"


async def _read(elm: Elm, payload: bytes) -> dict[int, bytes]:
    """Send one request and return each answering unit's positive reply.

    A request no unit answers returns an empty result: a car is free to support only
    some of the legislated reads.
    """
    try:
        replies = await elm.request(permit(DiagProtocol.OBD, payload))
    except NoResponse:
        return {}
    answers: dict[int, bytes] = {}
    for sender, messages in replies.items():
        for message in messages:
            if message[0] == payload[0] + POSITIVE_OFFSET:
                answers[sender] = message
    return answers


async def codes(elm: Elm, mode: int) -> dict[int, list[str]]:
    """Read fault codes of one kind (stored, pending or permanent) from every unit.

    Raises ElmError when a reply's length does not match the count it declares.
    """
    result: dict[int, list[str]] = {}
    for sender, message in (await _read(elm, bytes([mode]))).items():
        count, body = message[1], message[2:]
        if len(body) < 2 * count:
            raise ElmError(f"unit {sender:X} declares {count} codes but sent {body.hex()}")
        result[sender] = [decode_code(body[i : i + 2]) for i in range(0, 2 * count, 2)]
    return result


async def readiness(elm: Elm) -> dict[int, Readiness]:
    """Read each unit's warning-lamp state and stored-code count."""
    answers = await _read(elm, bytes([CURRENT_DATA, PID_MONITOR_STATUS]))
    return {
        sender: Readiness(bool(message[2] & 0x80), message[2] & 0x7F)
        for sender, message in answers.items()
        if len(message) >= 3
    }


async def vin(elm: Elm) -> str | None:
    """Read the vehicle identification number, or None when no unit reports one."""
    answers = await _read(elm, bytes([VEHICLE_INFORMATION, INFO_VIN]))
    for message in answers.values():
        text = "".join(chr(byte) for byte in message[3:] if 0x20 < byte < 0x7F)
        if text:
            return text
    return None


async def live(elm: Elm) -> dict[str, str]:
    """Read the current-data parameters the car supports, formatted with units."""
    values: dict[str, str] = {}
    for pid, value in LIVE_VALUES.items():
        for message in (await _read(elm, bytes([CURRENT_DATA, pid]))).values():
            if len(message) >= 2 + value.size:
                values[value.label] = f"{value.decode(message[2:]):g} {value.unit}"
                break
    return values
