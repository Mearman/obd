"""Log the adapter's own voltage reading at a fixed interval, for example through an engine start.

The adapter measures the voltage at the diagnostic socket's battery pin, so this needs no car-specific data and no bus. A weak supply explains many stored fault codes, and the dip while cranking and the charging voltage afterwards show how healthy it is.
"""

from __future__ import annotations

import argparse
import asyncio
import re
from collections.abc import Callable
from datetime import UTC, datetime

from .csvlog import CsvLog
from .elm import AdapterInfo, Elm, ElmError

# Adapter replies read like "12.4V" (ELM327 ATRV) and, on adapters with the STN extensions, STVR gives the same with a chosen number of decimals.
VOLTAGE = re.compile(r"(\d+(?:\.\d+)?)\s*V", re.IGNORECASE)


async def read_voltage(elm: Elm, *, stn: bool, precision: int | None) -> float:
    """Read the supply voltage in volts.

    Uses `STVR` (with the precision, when given) on an adapter that has the STN extensions and the standard `ATRV` otherwise. Raises ElmError when the reply holds no voltage.
    """
    command = "ATRV" if not stn else "STVR" if precision is None else f"STVR {precision}"
    lines = await elm.command(command)
    for line in lines:
        found = VOLTAGE.search(line)
        if found is not None:
            return float(found.group(1))
    raise ElmError(f"no voltage in the reply to {command}: {lines!r}")


async def battery_command(
    elm: Elm, adapter: AdapterInfo, args: argparse.Namespace, out: Callable[[str], None]
) -> int:
    """Run the `battery` command: sample the voltage for `--duration` seconds, `--interval` apart.

    Prints each sample and a summary, and logs to `--csv` when given. Raises ValueError for a bad duration, interval or precision.
    """
    if args.duration < 0 or args.interval <= 0:
        raise ValueError("--duration must not be negative and --interval must be positive")
    if args.precision is not None and args.precision < 0:
        raise ValueError("--precision must not be negative")
    stn = adapter.has_stn_extensions
    out(f"reading the voltage with {'STVR' if stn else 'ATRV'} every {args.interval:g} s")
    log = CsvLog(args.csv, ["time", "elapsed (s)", "voltage (V)"]) if args.csv else None
    loop = asyncio.get_running_loop()
    start = loop.time()
    samples: list[tuple[float, float]] = []
    try:
        while True:
            volts = await read_voltage(elm, stn=stn, precision=args.precision)
            elapsed = loop.time() - start
            samples.append((elapsed, volts))
            out(f"{elapsed:.2f} s: {volts:g} V")
            if log is not None:
                log.write(
                    [
                        datetime.now(UTC).isoformat(timespec="milliseconds"),
                        f"{elapsed:.3f}",
                        f"{volts:g}",
                    ]
                )
            if elapsed + args.interval > args.duration:
                break
            await asyncio.sleep(args.interval)
    finally:
        if log is not None:
            log.close()
    lowest = min(samples, key=lambda sample: sample[1])
    highest = max(samples, key=lambda sample: sample[1])
    out(
        f"{len(samples)} sample{'' if len(samples) == 1 else 's'}: lowest {lowest[1]:g} V at {lowest[0]:.2f} s, "
        f"highest {highest[1]:g} V at {highest[0]:.2f} s, last {samples[-1][1]:g} V"
    )
    return 0
