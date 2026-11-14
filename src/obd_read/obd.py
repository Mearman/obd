"""Legislated OBD-II (SAE J1979) reads, which work on any compliant car without a profile."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .elm import Elm, ElmError, NoResponse
from .guard import DiagProtocol, permit

# Functional request identifiers every emissions-related unit listens on.
FUNCTIONAL_ID: dict[int, int] = {11: 0x7DF, 29: 0x18DB33F1}

CURRENT_DATA = 0x01
FREEZE_FRAME = 0x02
STORED_CODES = 0x03
PENDING_CODES = 0x07
MONITORING_RESULTS = 0x06
VEHICLE_INFORMATION = 0x09
PERMANENT_CODES = 0x0A

PID_MONITOR_STATUS = 0x01
PID_FREEZE_FRAME_CODE = 0x02
FRAME_NUMBER = 0x00
INFO_VIN = 0x02

POSITIVE_OFFSET = 0x40
NEGATIVE_RESPONSE = 0x7F

# Mode 06 misfire monitors: the first is for the engine as a whole, the next ones are per cylinder in monitor order.
MISFIRE_GENERAL = 0xA1
MISFIRE_FIRST_CYLINDER = 0xA2
MISFIRE_LAST_CYLINDER = 0xAD
# Misfire test identifiers. Their meaning here is GM's published data definition and a Saab service table, not a legislated one, so a caller shows them as unconfirmed for a given maker.
TID_MISFIRE_AVERAGE = 0x0B  # average over the last ten driving cycles
TID_MISFIRE_LATEST = 0x0C  # count for the last or current driving cycle
MONITOR_ENTRY_LENGTH = 9  # monitor, test, unit and scaling, value, minimum, maximum

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


@dataclass(frozen=True)
class FreezeFrame:
    """The fault code a unit froze its data for, and the live values stored with it."""

    code: str | None
    values: dict[str, str]


async def freeze_frame(elm: Elm) -> dict[int, FreezeFrame]:
    """Read the freeze frame each unit stored with its first fault code.

    A unit with no freeze frame, or one that does not answer, is left out.
    """
    frames: dict[int, FreezeFrame] = {}
    request = bytes([FREEZE_FRAME, PID_FREEZE_FRAME_CODE, FRAME_NUMBER])
    for sender, message in (await _read(elm, request)).items():
        if len(message) < 5:
            continue
        pair = message[3:5]
        code = None if pair == b"\x00\x00" else decode_code(pair)
        frames[sender] = FreezeFrame(code, {})
    for pid, value in LIVE_VALUES.items():
        answers = await _read(elm, bytes([FREEZE_FRAME, pid, FRAME_NUMBER]))
        for sender, message in answers.items():
            data = message[3:]
            if sender in frames and len(data) >= value.size:
                frames[sender].values[value.label] = f"{value.decode(data):g} {value.unit}"
    return frames


@dataclass(frozen=True)
class MisfireCounts:
    """One misfire monitor's counts, keyed by test identifier."""

    monitor: int
    average_last_ten_cycles: int | None
    last_cycle: int | None


def _monitor_counts(monitor: int, message: bytes) -> MisfireCounts:
    """Pick the average and latest counts out of one monitor's reply, ignoring other tests."""
    counts: dict[int, int] = {}
    body = message[1:]
    for start in range(0, len(body) - MONITOR_ENTRY_LENGTH + 1, MONITOR_ENTRY_LENGTH):
        entry = body[start : start + MONITOR_ENTRY_LENGTH]
        if entry[0] == monitor:
            counts[entry[1]] = entry[3] * 256 + entry[4]
    return MisfireCounts(monitor, counts.get(TID_MISFIRE_AVERAGE), counts.get(TID_MISFIRE_LATEST))


async def misfire_counts(elm: Elm) -> dict[int, list[MisfireCounts]]:
    """Read the misfire monitors from every unit: the whole engine first, then each cylinder.

    Cylinder monitors are read until the first one a unit does not report.
    """
    result: dict[int, list[MisfireCounts]] = {}
    for monitor in range(MISFIRE_GENERAL, MISFIRE_LAST_CYLINDER + 1):
        answers = await _read(elm, bytes([MONITORING_RESULTS, monitor]))
        if not answers and monitor != MISFIRE_GENERAL:
            break
        for sender, message in answers.items():
            result.setdefault(sender, []).append(_monitor_counts(monitor, message))
    return result
