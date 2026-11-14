"""The legislated reads beyond the codes: supported values, readiness, monitor results, calibration.

Every request is read-only and goes through the guard (`obd._read` permits each one). A car says in its supported-identifier bitmaps which values it holds, so nothing is requested that it has said it lacks.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .elm import Elm
from .obd import (
    CURRENT_DATA,
    MISFIRE_GENERAL,
    MISFIRE_LAST_CYLINDER,
    MONITOR_ENTRY_LENGTH,
    MONITORING_RESULTS,
    PID_MONITOR_STATUS,
    VEHICLE_INFORMATION,
    _read,
)
from .pids import PIDS, Pid, Value

# Identifier 0x00 and every multiple of 0x20 after it answer with a bitmap of the next 32 identifiers (this is the same in modes 01, 06 and 09). The last bit of a bitmap says whether the next bitmap exists.
BITMAP_SPAN = 0x20
BITMAP_BYTES = 4

INFO_CALIBRATION_ID = 0x04
CALIBRATION_ID_LENGTH = 16

# Mode 06 monitor identifiers 01 to 10 are the oxygen sensor monitors, in bank then sensor order. That follows the mode 05 oxygen sensor table in SAE J1979 as reproduced at https://en.wikipedia.org/wiki/OBD-II_PIDs (latest snapshot: https://web.archive.org/web/https://en.wikipedia.org/wiki/OBD-II_PIDs), which describes mode 05 for adapters that are not on CAN; carrying its numbering over to mode 06 is unconfirmed, and no source for the other monitor identifiers was opened, so they are shown by number only.
OXYGEN_MONITORS = range(0x01, 0x11)

# Unit and scaling identifiers from 0x80 up describe signed values.
SIGNED_SCALING = 0x80

# Readiness monitors common to every engine: (name, availability bit, incomplete bit) in byte B.
COMMON_MONITORS: tuple[tuple[str, int, int], ...] = (
    ("misfire", 0, 4),
    ("fuel system", 1, 5),
    ("components", 2, 6),
)
# Monitors that depend on the engine type: (name, bit) in bytes C and D. Bit 3 of byte B selects the table (0 spark ignition, 1 compression ignition). A set bit in C means the monitor is fitted, a set bit in D (and in B for the common monitors) means it has not completed. Source: the same SAE J1979 table at https://en.wikipedia.org/wiki/OBD-II_PIDs.
SPARK_MONITORS: tuple[tuple[str, int], ...] = (
    ("catalyst", 0),
    ("heated catalyst", 1),
    ("evaporative system", 2),
    ("secondary air", 3),
    ("gasoline particulate filter", 4),
    ("oxygen sensor", 5),
    ("oxygen sensor heater", 6),
    ("EGR or variable valve timing", 7),
)
COMPRESSION_MONITORS: tuple[tuple[str, int], ...] = (
    ("NMHC catalyst", 0),
    ("NOx or SCR", 1),
    ("boost pressure", 3),
    ("exhaust gas sensor", 5),
    ("particulate filter", 6),
    ("EGR or variable valve timing", 7),
)
COMPRESSION_IGNITION_BIT = 3


@dataclass(frozen=True)
class MonitorReadiness:
    """Which on-board monitors a unit has, and whether each has completed since codes were cleared."""

    compression_ignition: bool
    complete: tuple[str, ...]
    incomplete: tuple[str, ...]


def decode_support_bitmap(base: int, data: bytes) -> frozenset[int]:
    """The identifiers `base + 1` to `base + 0x20` that a four-byte bitmap marks as supported."""
    bits = int.from_bytes(data[:BITMAP_BYTES], "big")
    return frozenset(
        base + 1 + index for index in range(BITMAP_SPAN) if bits >> (BITMAP_SPAN - 1 - index) & 1
    )


async def supported_ids(elm: Elm, mode: int) -> dict[int, frozenset[int]]:
    """Read each unit's supported-identifier bitmaps for one mode, following the chain.

    Reads the bitmap at 0x00, then at each multiple of 0x20 a unit says exists. The result maps a unit's identifier to every identifier it supports, bitmap identifiers included. A unit that does not answer is left out.
    """
    result: dict[int, set[int]] = {}
    base = 0x00
    while base <= 0xE0:
        answers = await _read(elm, bytes([mode, base]))
        found = {
            sender: decode_support_bitmap(base, message[2:])
            for sender, message in answers.items()
            if len(message) >= 2 + BITMAP_BYTES
        }
        for sender, ids in found.items():
            result.setdefault(sender, set()).update(ids)
        if not any(base + BITMAP_SPAN in ids for ids in found.values()):
            break
        base += BITMAP_SPAN
    return {sender: frozenset(ids) for sender, ids in result.items()}


def decode_readiness(data: bytes) -> MonitorReadiness:
    """Turn the four data bytes of mode 01 identifier 01 into the monitors that completed.

    A monitor that is not fitted is left out of both lists.
    """
    _, b, c, d = data[:4]
    compression = bool(b >> COMPRESSION_IGNITION_BIT & 1)
    complete: list[str] = []
    incomplete: list[str] = []

    def place(name: str, fitted: bool, not_complete: bool) -> None:
        if fitted:
            (incomplete if not_complete else complete).append(name)

    for name, available, pending in COMMON_MONITORS:
        place(name, bool(b >> available & 1), bool(b >> pending & 1))
    for name, bit in COMPRESSION_MONITORS if compression else SPARK_MONITORS:
        place(name, bool(c >> bit & 1), bool(d >> bit & 1))
    return MonitorReadiness(compression, tuple(complete), tuple(incomplete))


async def readiness_monitors(elm: Elm) -> dict[int, MonitorReadiness]:
    """Read which monitors each unit has completed since its codes were last cleared."""
    answers = await _read(elm, bytes([CURRENT_DATA, PID_MONITOR_STATUS]))
    return {
        sender: decode_readiness(message[2:])
        for sender, message in answers.items()
        if len(message) >= 2 + BITMAP_BYTES
    }


async def read_pid(elm: Elm, pid: Pid) -> dict[int, tuple[Value, ...]]:
    """Read one current-data parameter from every unit that answers, decoded."""
    answers = await _read(elm, bytes([CURRENT_DATA, pid.code]))
    return {
        sender: pid.decode(message[2:])
        for sender, message in answers.items()
        if len(message) >= 2 + pid.size
    }


def format_value(value: Value, unit: str) -> str:
    """One reading as text: numbers rounded to three decimals, with the unit."""
    text = value if isinstance(value, str) else f"{round(value, 3):.12g}"
    return f"{text} {unit}".rstrip()


@dataclass(frozen=True)
class MonitorTest:
    """One mode 06 test result: the value and the limits the unit holds it against."""

    monitor: int
    test: int
    scaling: int
    value: int
    minimum: int
    maximum: int

    @property
    def within_limits(self) -> bool:
        return self.minimum <= self.value <= self.maximum


def _monitor_word(scaling: int, raw: bytes) -> int:
    return int.from_bytes(raw, "big", signed=scaling >= SIGNED_SCALING)


def decode_monitor_tests(monitor: int, message: bytes) -> list[MonitorTest]:
    """Split one mode 06 reply into its tests.

    Each test is nine bytes: monitor, test, unit and scaling, then value, minimum and maximum as two bytes each.
    """
    body = message[1:]
    tests: list[MonitorTest] = []
    for start in range(0, len(body) - MONITOR_ENTRY_LENGTH + 1, MONITOR_ENTRY_LENGTH):
        entry = body[start : start + MONITOR_ENTRY_LENGTH]
        if entry[0] != monitor:
            continue
        scaling = entry[2]
        tests.append(
            MonitorTest(
                monitor,
                entry[1],
                scaling,
                _monitor_word(scaling, entry[3:5]),
                _monitor_word(scaling, entry[5:7]),
                _monitor_word(scaling, entry[7:9]),
            )
        )
    return tests


def describe_monitor(monitor: int) -> str:
    """Name a mode 06 monitor where a source for the name is known, else give its number."""
    if monitor in OXYGEN_MONITORS:
        index = monitor - OXYGEN_MONITORS.start
        return f"oxygen sensor bank {index // 4 + 1} sensor {index % 4 + 1}"
    return f"monitor {monitor:02X}"


async def monitor_results(elm: Elm) -> dict[int, list[MonitorTest]]:
    """Read every mode 06 monitor a unit supports except the misfire monitors.

    The result maps a unit's identifier to its test results. Monitors that are bitmap identifiers, and the misfire monitors (read by `obd.misfire_counts`), are skipped.
    """
    supported = await supported_ids(elm, MONITORING_RESULTS)
    wanted = sorted(
        {
            monitor
            for ids in supported.values()
            for monitor in ids
            if monitor % BITMAP_SPAN != 0
            and not MISFIRE_GENERAL <= monitor <= MISFIRE_LAST_CYLINDER
        }
    )
    result: dict[int, list[MonitorTest]] = {}
    for monitor in wanted:
        answers = await _read(elm, bytes([MONITORING_RESULTS, monitor]))
        for sender, message in answers.items():
            result.setdefault(sender, []).extend(decode_monitor_tests(monitor, message))
    return result


async def calibration_ids(elm: Elm) -> dict[int, list[str]]:
    """Read each unit's calibration identifiers (mode 09, identifier 04).

    Asked only when a unit's mode 09 bitmap lists it. A unit reports a count, then that many sixteen-byte texts padded with zero bytes.
    """
    holders = {
        sender
        for sender, ids in (await supported_ids(elm, VEHICLE_INFORMATION)).items()
        if INFO_CALIBRATION_ID in ids
    }
    if not holders:
        return {}
    answers = await _read(elm, bytes([VEHICLE_INFORMATION, INFO_CALIBRATION_ID]))
    result: dict[int, list[str]] = {}
    for sender, message in answers.items():
        if sender not in holders:
            continue
        if len(message) < 3:
            continue
        body = message[3:]
        count = message[2]
        texts = [
            body[start : start + CALIBRATION_ID_LENGTH]
            for start in range(0, len(body), CALIBRATION_ID_LENGTH)
        ][:count]
        result[sender] = [
            "".join(chr(byte) for byte in text if 0x20 <= byte < 0x7F).strip() for text in texts
        ]
    return result


def supported_pids(supported: dict[int, frozenset[int]]) -> list[Pid]:
    """The decodable current-data parameters that at least one unit supports, in identifier order."""
    wanted = {code for ids in supported.values() for code in ids}
    return [pid for code, pid in sorted(PIDS.items()) if code in wanted]


async def report(elm: Elm, out: Callable[[str], None]) -> None:
    """Print what a car says about itself through the legislated reads, asking only for what it supports."""
    current = await supported_ids(elm, CURRENT_DATA)
    if not current:
        out("no unit answered the supported current-data request")
    multiple = len(current) > 1
    for sender, readiness in (await readiness_monitors(elm)).items():
        engine = "compression ignition" if readiness.compression_ignition else "spark ignition"
        out(f"readiness from {sender:X} ({engine}):")
        out(f"  complete: {', '.join(readiness.complete) or 'none'}")
        out(f"  not complete: {', '.join(readiness.incomplete) or 'none'}")
    for pid in supported_pids(current):
        for sender, values in (await read_pid(elm, pid)).items():
            where = f" from {sender:X}" if multiple else ""
            for column, value in zip(pid.columns, values, strict=True):
                out(f"{column.label}{where}: {format_value(value, column.unit)}")
    results = await monitor_results(elm)
    if results:
        out(
            "monitor test results (what each test measures differs per maker: meanings unconfirmed):"
        )
    for sender, tests in results.items():
        for test in tests:
            verdict = "within" if test.within_limits else "outside"
            out(
                f"  {describe_monitor(test.monitor)} from {sender:X}, test {test.test:02X} "
                f"(unit and scaling {test.scaling:02X}): value {test.value}, "
                f"limits {test.minimum} to {test.maximum}, {verdict} the limits"
            )
    for sender, identifiers in (await calibration_ids(elm)).items():
        out(f"calibration identifier from {sender:X}: {', '.join(identifiers) or 'none'}")
