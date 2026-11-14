"""Legislated current-data parameters (OBD-II mode 01): which bytes mean what.

Every formula follows SAE J1979 as tabulated, with the same formulas and ranges, in https://en.wikipedia.org/wiki/OBD-II_PIDs (latest snapshot: https://web.archive.org/web/https://en.wikipedia.org/wiki/OBD-II_PIDs). The standard itself is not freely readable, so that table is the source each decoder here was checked against. A, B, C and D in the comments are the data bytes in the order the unit sends them.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

Value = float | str


@dataclass(frozen=True)
class Column:
    """One reading a parameter yields: its label and unit."""

    label: str
    unit: str


@dataclass(frozen=True)
class Pid:
    """One current-data parameter: how to name it and turn its data bytes into readings.

    `decode` receives at least `size` data bytes and returns one value per column.
    """

    code: int
    name: str
    size: int
    columns: tuple[Column, ...]
    decode: Callable[[bytes], tuple[Value, ...]]


def _word(data: bytes) -> int:
    return data[0] * 256 + data[1]


def _signed_word(data: bytes) -> int:
    value = _word(data)
    return value - 0x10000 if value >= 0x8000 else value


def _percent(byte: int) -> float:
    return byte * 100 / 255


# Fuel trims are centred on 128 so they can be negative: 0 is -100 %, 128 is 0 %, 255 is +99.2 %.
def _trim(byte: int) -> float:
    return byte * 100 / 128 - 100


def _single(
    code: int,
    name: str,
    label: str,
    unit: str,
    size: int,
    decode: Callable[[bytes], float | str],
) -> Pid:
    return Pid(code, name, size, (Column(label, unit),), lambda data: (decode(data),))


# Fuel system status values; any other value is invalid in the standard.
FUEL_SYSTEM_STATUS: dict[int, str] = {
    0: "off",
    1: "open loop, engine too cold",
    2: "closed loop, using oxygen sensor feedback",
    4: "open loop, engine load or deceleration fuel cut",
    8: "open loop, system failure",
    16: "closed loop, fault in the feedback system",
}

SECONDARY_AIR_STATUS: dict[int, str] = {
    1: "upstream",
    2: "downstream of the catalytic converter",
    4: "outside atmosphere or off",
    8: "pump commanded on for diagnostics",
}

OBD_STANDARD: dict[int, str] = {
    1: "OBD-II (CARB)",
    2: "OBD (EPA)",
    3: "OBD and OBD-II",
    4: "OBD-I",
    5: "not OBD compliant",
    6: "EOBD",
    7: "EOBD and OBD-II",
    8: "EOBD and OBD",
    9: "EOBD, OBD and OBD-II",
    10: "JOBD",
    11: "JOBD and OBD-II",
    12: "JOBD and EOBD",
    13: "JOBD, EOBD and OBD-II",
}


def _enumerated(table: dict[int, str]) -> Callable[[bytes], float | str]:
    return lambda data: table.get(data[0], f"unlisted value {data[0]}")


def _fuel_system(data: bytes) -> tuple[Value, ...]:
    # The second byte describes fuel system 2 and is zero when the car has only one.
    second = "not fitted" if data[1] == 0 else FUEL_SYSTEM_STATUS.get(data[1], "invalid")
    return (FUEL_SYSTEM_STATUS.get(data[0], "invalid"), second)


def _oxygen_voltage_and_trim(sensor: int, code: int) -> Pid:
    def decode(data: bytes) -> tuple[Value, ...]:
        # B is 0xFF when the sensor takes no part in the short-term fuel trim.
        trim: Value = "not used" if data[1] == 0xFF else _trim(data[1])
        return (data[0] / 200, trim)

    return Pid(
        code,
        f"o2-sensor-{sensor}",
        2,
        (
            Column(f"oxygen sensor {sensor} voltage", "V"),
            Column(f"oxygen sensor {sensor} short-term fuel trim", "%"),
        ),
        decode,
    )


def _wide_range_ratio_and_voltage(sensor: int, code: int) -> Pid:
    return Pid(
        code,
        f"lambda-sensor-{sensor}",
        4,
        (
            Column(f"oxygen sensor {sensor} equivalence ratio", "ratio"),
            Column(f"oxygen sensor {sensor} voltage", "V"),
        ),
        lambda data: (_word(data) * 2 / 65536, _word(data[2:]) * 8 / 65536),
    )


def _wide_range_ratio_and_current(sensor: int, code: int) -> Pid:
    return Pid(
        code,
        f"lambda-current-sensor-{sensor}",
        4,
        (
            Column(f"oxygen sensor {sensor} equivalence ratio", "ratio"),
            Column(f"oxygen sensor {sensor} current", "mA"),
        ),
        lambda data: (_word(data) * 2 / 65536, _word(data[2:]) / 256 - 128),
    )


def _build_table() -> dict[int, Pid]:
    pids: list[Pid] = [
        Pid(
            0x03,
            "fuel-system-status",
            2,
            (Column("fuel system 1 status", ""), Column("fuel system 2 status", "")),
            _fuel_system,
        ),
        _single(0x04, "engine-load", "engine load", "%", 1, lambda d: _percent(d[0])),
        _single(0x05, "coolant-temperature", "coolant temperature", "°C", 1, lambda d: d[0] - 40),
        _single(
            0x06, "short-fuel-trim-b1", "short-term fuel trim bank 1", "%", 1, lambda d: _trim(d[0])
        ),
        _single(
            0x07, "long-fuel-trim-b1", "long-term fuel trim bank 1", "%", 1, lambda d: _trim(d[0])
        ),
        _single(
            0x08, "short-fuel-trim-b2", "short-term fuel trim bank 2", "%", 1, lambda d: _trim(d[0])
        ),
        _single(
            0x09, "long-fuel-trim-b2", "long-term fuel trim bank 2", "%", 1, lambda d: _trim(d[0])
        ),
        _single(0x0A, "fuel-pressure", "fuel pressure (gauge)", "kPa", 1, lambda d: d[0] * 3),
        _single(0x0B, "intake-pressure", "intake manifold pressure", "kPa", 1, lambda d: d[0]),
        _single(0x0C, "engine-speed", "engine speed", "rpm", 2, lambda d: _word(d) / 4),
        _single(0x0D, "vehicle-speed", "vehicle speed", "km/h", 1, lambda d: d[0]),
        _single(
            0x0E, "timing-advance", "timing advance", "° before TDC", 1, lambda d: d[0] / 2 - 64
        ),
        _single(
            0x0F, "intake-air-temperature", "intake air temperature", "°C", 1, lambda d: d[0] - 40
        ),
        _single(0x10, "air-flow", "air flow rate", "g/s", 2, lambda d: _word(d) / 100),
        _single(0x11, "throttle-position", "throttle position", "%", 1, lambda d: _percent(d[0])),
        _single(
            0x12,
            "secondary-air",
            "commanded secondary air",
            "",
            1,
            _enumerated(SECONDARY_AIR_STATUS),
        ),
        *(_oxygen_voltage_and_trim(sensor, 0x13 + sensor) for sensor in range(1, 9)),
        _single(0x1C, "obd-standard", "OBD standard", "", 1, _enumerated(OBD_STANDARD)),
        _single(0x1F, "run-time", "run time since engine start", "s", 2, lambda d: _word(d)),
        _single(
            0x21, "distance-with-lamp", "distance with warning lamp on", "km", 2, lambda d: _word(d)
        ),
        _single(
            0x22,
            "fuel-rail-pressure",
            "fuel rail pressure (relative to manifold)",
            "kPa",
            2,
            lambda d: 0.079 * _word(d),
        ),
        _single(
            0x23,
            "fuel-rail-gauge-pressure",
            "fuel rail pressure (gauge)",
            "kPa",
            2,
            lambda d: 10 * _word(d),
        ),
        *(_wide_range_ratio_and_voltage(sensor, 0x23 + sensor) for sensor in range(1, 9)),
        _single(0x2C, "egr-commanded", "commanded EGR", "%", 1, lambda d: _percent(d[0])),
        _single(0x2D, "egr-error", "EGR error", "%", 1, lambda d: _trim(d[0])),
        _single(
            0x2E, "purge-commanded", "commanded evaporative purge", "%", 1, lambda d: _percent(d[0])
        ),
        _single(0x2F, "fuel-level", "fuel tank level", "%", 1, lambda d: _percent(d[0])),
        _single(0x30, "warm-ups", "warm-ups since codes cleared", "", 1, lambda d: d[0]),
        _single(
            0x31,
            "distance-since-clear",
            "distance since codes cleared",
            "km",
            2,
            lambda d: _word(d),
        ),
        _single(
            0x32,
            "evap-vapour-pressure",
            "evaporative system vapour pressure",
            "Pa",
            2,
            lambda d: _signed_word(d) / 4,
        ),
        _single(0x33, "barometric-pressure", "barometric pressure", "kPa", 1, lambda d: d[0]),
        *(_wide_range_ratio_and_current(sensor, 0x33 + sensor) for sensor in range(1, 9)),
        _single(
            0x3C,
            "catalyst-temperature-b1s1",
            "catalyst temperature bank 1 sensor 1",
            "°C",
            2,
            lambda d: _word(d) / 10 - 40,
        ),
        _single(
            0x3D,
            "catalyst-temperature-b2s1",
            "catalyst temperature bank 2 sensor 1",
            "°C",
            2,
            lambda d: _word(d) / 10 - 40,
        ),
        _single(
            0x3E,
            "catalyst-temperature-b1s2",
            "catalyst temperature bank 1 sensor 2",
            "°C",
            2,
            lambda d: _word(d) / 10 - 40,
        ),
        _single(
            0x3F,
            "catalyst-temperature-b2s2",
            "catalyst temperature bank 2 sensor 2",
            "°C",
            2,
            lambda d: _word(d) / 10 - 40,
        ),
        _single(
            0x42, "module-voltage", "control module voltage", "V", 2, lambda d: _word(d) / 1000
        ),
        _single(
            0x43, "absolute-load", "absolute load value", "%", 2, lambda d: _word(d) * 100 / 255
        ),
        _single(
            0x44,
            "commanded-equivalence-ratio",
            "commanded equivalence ratio",
            "ratio",
            2,
            lambda d: _word(d) * 2 / 65536,
        ),
        _single(
            0x45,
            "relative-throttle",
            "relative throttle position",
            "%",
            1,
            lambda d: _percent(d[0]),
        ),
        _single(
            0x46, "ambient-temperature", "ambient air temperature", "°C", 1, lambda d: d[0] - 40
        ),
        _single(
            0x47, "throttle-b", "absolute throttle position B", "%", 1, lambda d: _percent(d[0])
        ),
        _single(
            0x48, "throttle-c", "absolute throttle position C", "%", 1, lambda d: _percent(d[0])
        ),
        _single(0x49, "pedal-d", "accelerator pedal position D", "%", 1, lambda d: _percent(d[0])),
        _single(0x4A, "pedal-e", "accelerator pedal position E", "%", 1, lambda d: _percent(d[0])),
        _single(0x4B, "pedal-f", "accelerator pedal position F", "%", 1, lambda d: _percent(d[0])),
        _single(
            0x4C,
            "throttle-commanded",
            "commanded throttle actuator",
            "%",
            1,
            lambda d: _percent(d[0]),
        ),
        _single(
            0x4D, "time-with-lamp", "time run with warning lamp on", "min", 2, lambda d: _word(d)
        ),
        _single(0x4E, "time-since-clear", "time since codes cleared", "min", 2, lambda d: _word(d)),
        _single(0x52, "ethanol", "ethanol fuel", "%", 1, lambda d: _percent(d[0])),
        _single(
            0x53,
            "evap-absolute-pressure",
            "absolute evaporative system vapour pressure",
            "kPa",
            2,
            lambda d: _word(d) / 200,
        ),
        _single(
            0x54,
            "evap-pressure",
            "evaporative system vapour pressure (signed)",
            "Pa",
            2,
            lambda d: _signed_word(d),
        ),
        _single(
            0x59,
            "fuel-rail-absolute-pressure",
            "fuel rail absolute pressure",
            "kPa",
            2,
            lambda d: 10 * _word(d),
        ),
        _single(
            0x5A,
            "pedal-relative",
            "relative accelerator pedal position",
            "%",
            1,
            lambda d: _percent(d[0]),
        ),
        _single(0x5C, "oil-temperature", "engine oil temperature", "°C", 1, lambda d: d[0] - 40),
        _single(
            0x5D,
            "injection-timing",
            "fuel injection timing",
            "°",
            2,
            lambda d: _word(d) / 128 - 210,
        ),
        _single(0x5E, "fuel-rate", "engine fuel rate", "L/h", 2, lambda d: _word(d) / 20),
    ]
    return {pid.code: pid for pid in pids}


PIDS: dict[int, Pid] = _build_table()
