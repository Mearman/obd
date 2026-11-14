"""Live values by name, once or repeatedly, printed and optionally logged to CSV.

Two kinds of value share one reading loop: the legislated current-data values (any compliant car, named by `pids.py`, offered only where the car's supported-identifier bitmaps list them) and the named values a vehicle profile defines for one unit (KWP2000 local identifiers and UDS data identifiers).
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .csvlog import CsvLog
from .diag import NegativeResponse
from .elm import Elm, ElmError
from .legislated import format_value, read_pid, supported_ids, supported_pids
from .obd import CURRENT_DATA, FUNCTIONAL_ID
from .operations import make_client
from .pids import Column, Value
from .profile import DataValue, Profile, ProfileError, Unit

Printer = Callable[[str], None]
Reading = Value | None


@dataclass(frozen=True)
class Source:
    """What a live run reads: one column per reading, and a way to read them all once.

    `read` takes a printer for anything worth saying about a read and returns one entry per column, `None` where the value could not be read this time. `available` are the names that can be chosen, and `notes` are shown before the first sample.
    """

    columns: tuple[Column, ...]
    read: Callable[[Printer], Awaitable[tuple[Reading, ...]]]
    available: tuple[str, ...]
    notes: tuple[str, ...] = ()


def column_title(column: Column) -> str:
    """The CSV header and printed name for one column."""
    return f"{column.label} ({column.unit})" if column.unit else column.label


def choose(available: list[str], wanted: list[str], what: str) -> list[str]:
    """The requested names, or all of `available` when none were requested.

    Raises ValueError listing the available names when a requested one is not among them.
    """
    unknown = [name for name in wanted if name not in available]
    if unknown:
        raise ValueError(f"unknown {what} {', '.join(unknown)}; available: {', '.join(available)}")
    return wanted or available


async def legislated_source(elm: Elm, wanted: list[str]) -> Source:
    """The legislated values the car supports, or those named in `wanted`.

    Raises ValueError when a name is unknown or the car does not list it as supported.
    """
    pids = {pid.name: pid for pid in supported_pids(await supported_ids(elm, CURRENT_DATA))}
    if not pids:
        raise ValueError("no unit reported any supported current-data value")
    chosen = [pids[name] for name in choose(list(pids), wanted, "value")]

    async def read(_out: Printer) -> tuple[Reading, ...]:
        readings: list[Reading] = []
        for pid in chosen:
            answers = await read_pid(elm, pid)
            # With several answering units the first one to reply is logged.
            readings.extend(next(iter(answers.values()), (None,) * len(pid.columns)))
        return tuple(readings)

    return Source(tuple(column for pid in chosen for column in pid.columns), read, tuple(pids))


async def unit_source(elm: Elm, profile: Profile, unit: Unit, wanted: list[str]) -> Source:
    """The named values the profile defines for one unit, or those named in `wanted`.

    Opens the profile's diagnostic session first. Raises ValueError when the unit defines no values or a name is unknown, and NegativeResponse or ElmError when the session cannot be opened.
    """
    if not unit.values:
        raise ValueError(f"unit {unit.name} in profile {profile.name} defines no named values")
    chosen = [unit.values[name] for name in choose(list(unit.values), wanted, "value")]
    await elm.address_unit(unit.request_id, unit.response_id)
    client = make_client(elm, profile, unit)
    await client.start()
    refused: set[str] = set()

    async def read_one(item: DataValue, out: Printer) -> Reading:
        try:
            return item.decode(await client.read_value(item.identifier))
        except (NegativeResponse, ElmError, ValueError) as error:
            # Say so once; a value a unit refuses is refused on every sample.
            if item.name not in refused:
                refused.add(item.name)
                out(f"{item.name} not read: {error}")
            return None

    async def read(out: Printer) -> tuple[Reading, ...]:
        return tuple([await read_one(item, out) for item in chosen])

    unconfirmed = [item.name for item in chosen if item.status != "confirmed"]
    header = (
        (f"unconfirmed identifiers, check against the car: {', '.join(unconfirmed)}",)
        if unconfirmed
        else ()
    )
    return Source(
        tuple(Column(item.label, item.unit) for item in chosen), read, tuple(unit.values), header
    )


async def run_samples(
    source: Source,
    *,
    count: int,
    interval: float,
    csv_path: Path | None,
    out: Printer,
) -> None:
    """Read the source `count` times, `interval` seconds apart, printing and logging each sample."""
    titles = [column_title(column) for column in source.columns]
    for note in source.notes:
        out(note)
    log = CsvLog(csv_path, ["time", "elapsed (s)", *titles]) if csv_path is not None else None
    loop = asyncio.get_running_loop()
    start = loop.time()
    try:
        for index in range(count):
            if index:
                await asyncio.sleep(interval)
            readings = await source.read(out)
            elapsed = loop.time() - start
            if count > 1:
                out(f"sample {index + 1} at {elapsed:.1f} s:")
            for column, reading in zip(source.columns, readings, strict=True):
                shown = "not read" if reading is None else format_value(reading, column.unit)
                out(f"{column.label}: {shown}")
            if log is not None:
                log.write(
                    [
                        datetime.now(UTC).isoformat(timespec="milliseconds"),
                        f"{elapsed:.3f}",
                        *(
                            "" if r is None else r if isinstance(r, str) else f"{r:.10g}"
                            for r in readings
                        ),
                    ]
                )
    finally:
        if log is not None:
            log.close()


def split_names(text: str | None) -> list[str]:
    """The comma-separated value names on the command line."""
    return [name.strip() for name in text.split(",") if name.strip()] if text else []


async def live_command(
    elm: Elm, profile: Profile | None, args: argparse.Namespace, out: Printer
) -> int:
    """Run the `live` command: a unit's profile values when a unit is named, else the legislated ones.

    Raises ValueError for a bad count, interval or value name, and ProfileError when a unit is named without a profile.
    """
    if args.count < 1:
        raise ValueError("--count must be at least 1")
    if args.interval < 0:
        raise ValueError("--interval must not be negative")
    wanted = split_names(args.values)
    if args.unit is None:
        await elm.select_can(args.id_bits, args.bitrate)
        await elm.address_functional(FUNCTIONAL_ID[args.id_bits])
        source = await legislated_source(elm, wanted)
    else:
        if profile is None:
            raise ProfileError("naming a unit needs --profile")
        await elm.select_can(profile.id_bits, profile.bitrate)
        if profile.status != "confirmed":
            out(f"profile {profile.name}: address table is {profile.status}")
        source = await unit_source(elm, profile, profile.unit(args.unit), wanted)
    if args.list:
        out(f"available values: {', '.join(source.available)}")
        return 0
    await run_samples(source, count=args.count, interval=args.interval, csv_path=args.csv, out=out)
    return 0
