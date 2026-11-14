"""Passive logging of CAN traffic: nothing here transmits.

Through a raw CAN link the log is complete: the link is opened listen-only and only its receive side is handed to the monitor, so there is no way to send from it. Through an ELM327-style adapter the log holds what the adapter's filters let through, and every command the monitor sends passes an allowlist first (`monitor_command`). With the STN extensions the adapter is put in the monitoring mode that does not acknowledge frames (`STCMM 0`); whether a plain ELM327 acknowledges frames while monitoring is unconfirmed.
"""

from __future__ import annotations

import argparse
import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .elm import PROMPT, AdapterInfo, Elm, ElmError, Transcript
from .guard import GuardError
from .transport import Transport, TransportTimeout
from .transport.can import CanFrame
from .transport.rawcan import RawCanTransport

Printer = Callable[[str], None]
TransportFactory = Callable[[str], Transport]

# Identifier masks for the STN pass and block filters.
MASK_11 = 0x7FF
MASK_29 = 0x1FFF_FFFF

# Seconds to wait for each read while streaming, and to wait for the adapter to stop.
POLL = 0.5
STOP_WAIT = 3.0

_HEX_ID = r"(?:[0-9A-F]{3}|[0-9A-F]{8})"
_STN_FILTER = r"[0-9A-F]{1,10},[0-9A-F]{1,10}"

# The only commands the monitor sends to an adapter, with spaces removed and upper-cased: receive filters, the monitoring commands and the monitoring mode that does not acknowledge.
ALLOWED_COMMANDS = tuple(
    re.compile(pattern)
    for pattern in (
        rf"ATCRA{_HEX_ID}?",
        r"AT(?:CF|CM)(?:[0-9A-F]{3}|[0-9A-F]{8})",
        r"ATMA",
        r"STM",
        r"STFAC",
        rf"ST(?:FPA|FBA|FFCA){_STN_FILTER}",
        r"STCMM0",
    )
)


def monitor_command(text: str) -> str:
    """Pass one adapter command the monitor may send, or refuse it.

    Raises GuardError for anything that is not a receive filter, a monitoring command or the non-acknowledging monitoring mode.
    """
    compact = text.replace(" ", "").upper()
    if not any(pattern.fullmatch(compact) for pattern in ALLOWED_COMMANDS):
        raise GuardError(f"monitor command {text!r} refused: the monitor only listens")
    return text


@dataclass(frozen=True)
class MonitorFilter:
    """Which identifiers the log keeps. With no `pass_ids` every identifier passes, except `block_ids`."""

    pass_ids: tuple[int, ...] = ()
    block_ids: tuple[int, ...] = ()
    flow_control_ids: tuple[int, ...] = ()

    def accepts(self, can_id: int) -> bool:
        if can_id in self.block_ids:
            return False
        return not self.pass_ids or can_id in self.pass_ids or can_id in self.flow_control_ids


def format_frame(moment: datetime, can_id: int, data: bytes, id_bits: int) -> str:
    """One log line: UTC time, identifier, data in hexadecimal."""
    stamp = moment.astimezone(UTC).isoformat(timespec="milliseconds")
    return f"{stamp} {can_id:0{3 if id_bits == 11 else 8}X} {data.hex().upper()}".rstrip()


def parse_stream_line(line: str, id_bits: int) -> tuple[int, bytes] | None:
    """Read one monitor line from an adapter that prints headers without spaces.

    Returns None for a line that is not a frame, such as a status message.
    """
    compact = line.replace(" ", "").upper()
    width = 3 if id_bits == 11 else 8
    match = re.fullmatch(rf"([0-9A-F]{{{width}}})((?:[0-9A-F]{{2}}){{0,8}})", compact)
    if match is None:
        return None
    return int(match.group(1), 16), bytes.fromhex(match.group(2))


class FrameSource(Protocol):
    """The receive side of a CAN link, and nothing else."""

    async def receive(self, timeout: float) -> CanFrame: ...


@dataclass
class MonitorLog:
    """Where frames go, and when the monitor should stop."""

    emit: Printer
    id_bits: int
    count_limit: int | None = None
    frames: int = 0
    notes: list[str] = field(default_factory=list)

    def frame(self, can_id: int, data: bytes) -> None:
        self.emit(format_frame(datetime.now(UTC), can_id, data, self.id_bits))
        self.frames += 1

    def note(self, text: str) -> None:
        self.notes.append(text)
        self.emit(f"# {text}")

    @property
    def done(self) -> bool:
        return self.count_limit is not None and self.frames >= self.count_limit


async def monitor_raw(
    source: FrameSource,
    log: MonitorLog,
    frame_filter: MonitorFilter,
    duration: float | None,
) -> None:
    """Log every frame the link receives that the filter keeps, until the count or duration is reached."""
    loop = asyncio.get_running_loop()
    deadline = None if duration is None else loop.time() + duration
    while not log.done:
        remaining = POLL if deadline is None else min(POLL, deadline - loop.time())
        if remaining <= 0:
            return
        try:
            frame = await source.receive(remaining)
        except TransportTimeout:
            continue
        if frame_filter.accepts(frame.can_id):
            log.frame(frame.can_id, frame.data)


def id_pattern(can_id: int, id_bits: int) -> str:
    """An identifier as the STN filter commands write it: two bytes for 11-bit, four for 29-bit."""
    return f"{can_id:04X}" if id_bits == 11 else f"{can_id:08X}"


async def _setup(elm: Elm, command: str) -> None:
    await elm.require(monitor_command(command))


async def configure_filters(
    elm: Elm, info: AdapterInfo, frame_filter: MonitorFilter, id_bits: int
) -> None:
    """Set the adapter's own receive filters as far as its command set allows.

    The software filter in the log applies in every case, so a filter the adapter cannot express (several identifiers on a plain adapter, a block list) is still honoured, at the cost of more traffic over the link.
    """
    if info.has_stn_extensions:
        mask = id_pattern(MASK_11 if id_bits == 11 else MASK_29, id_bits)
        await _setup(elm, "STFAC")
        for command, ids in (
            ("STFPA", frame_filter.pass_ids),
            ("STFBA", frame_filter.block_ids),
            ("STFFCA", frame_filter.flow_control_ids),
        ):
            for can_id in ids:
                await _setup(elm, f"{command} {id_pattern(can_id, id_bits)},{mask}")
        await _setup(elm, "STCMM0")
        return
    wanted = (*frame_filter.pass_ids, *frame_filter.flow_control_ids)
    if len(wanted) == 1:
        await _setup(elm, f"ATCRA{wanted[0]:0{3 if id_bits == 11 else 8}X}")
    elif wanted:
        width = 3 if id_bits == 11 else 8
        # One filter and mask: the bits every wanted identifier agrees on must match.
        agreed = ~0
        for can_id in wanted[1:]:
            agreed &= ~(can_id ^ wanted[0])
        full = MASK_11 if id_bits == 11 else MASK_29
        await _setup(elm, f"ATCF{wanted[0]:0{width}X}")
        await _setup(elm, f"ATCM{agreed & full:0{width}X}")


async def monitor_elm(
    elm: Elm,
    info: AdapterInfo,
    log: MonitorLog,
    frame_filter: MonitorFilter,
    duration: float | None,
) -> None:
    """Log frames through an ELM327-style adapter's monitoring mode, then stop it."""
    await configure_filters(elm, info, frame_filter, log.id_bits)
    transport = elm.transport
    start = monitor_command("STM" if info.has_stn_extensions else "ATMA")
    elm.transcript.record(">", start)
    await transport.write(start.encode("ascii") + b"\r")
    loop = asyncio.get_running_loop()
    deadline = None if duration is None else loop.time() + duration
    buffer = ""
    try:
        while not log.done:
            remaining = POLL if deadline is None else min(POLL, deadline - loop.time())
            if remaining <= 0:
                break
            try:
                buffer += (await transport.read(remaining)).decode("ascii", "replace")
            except TransportTimeout:
                continue
            *lines, buffer = re.split(r"[\r\n]+", buffer)
            for line in lines:
                _take_line(line.strip().lstrip(">").strip(), log, frame_filter, elm.transcript)
    finally:
        await _stop(transport)


def _take_line(
    line: str, log: MonitorLog, frame_filter: MonitorFilter, transcript: Transcript
) -> None:
    if not line:
        return
    parsed = parse_stream_line(line, log.id_bits)
    if parsed is None:
        transcript.record("<", line)
        log.note(f"adapter: {line}")
    elif frame_filter.accepts(parsed[0]):
        log.frame(*parsed)


async def _stop(transport: Transport) -> None:
    """Any byte stops the adapter's monitoring; wait for its prompt so the link is left in a known state."""
    await transport.write(b"\r")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + STOP_WAIT
    seen = ""
    while PROMPT.decode() not in seen:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise ElmError("the adapter did not stop monitoring")
        try:
            seen += (await transport.read(remaining)).decode("ascii", "replace")
        except TransportTimeout as error:
            raise ElmError("the adapter did not stop monitoring") from error


def add_arguments(commands: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """Register the `monitor` command."""
    monitor = commands.add_parser(
        "monitor",
        help="log CAN traffic without transmitting",
        description="Log CAN traffic without transmitting. Through a raw CAN adapter the log is "
        "complete; through an ELM327-style adapter it holds what the adapter's filters pass.",
    )
    monitor.add_argument("--adapter", required=True, help="adapter URL, as for the other commands")
    monitor.add_argument("--id-bits", type=int, choices=(11, 29), default=11)
    monitor.add_argument("--bitrate", type=int, choices=(250000, 500000), default=500000)
    for name, summary in (
        ("id", "keep only this identifier (hexadecimal); repeat for several"),
        ("block", "drop this identifier (hexadecimal); repeat for several"),
        (
            "flow-control",
            "also keep this flow-control identifier (hexadecimal); repeat for several",
        ),
    ):
        monitor.add_argument(
            f"--{name}", action="append", default=[], type=lambda text: int(text, 16), help=summary
        )
    monitor.add_argument("--duration", type=float, help="stop after this many seconds")
    monitor.add_argument("--count", type=int, help="stop after this many frames")
    monitor.add_argument("--output", type=Path, help="write the log to this new file")
    monitor.add_argument("--log", type=Path, help="append the adapter transcript to this file")


async def run_monitor(args: argparse.Namespace, out: Printer, factory: TransportFactory) -> int:
    """Run the `monitor` command and return its exit status."""
    for name in ("id", "block", "flow_control"):
        limit = MASK_11 if args.id_bits == 11 else MASK_29
        for can_id in getattr(args, name):
            if not 0 <= can_id <= limit:
                raise ValueError(f"identifier {can_id:X} does not fit {args.id_bits} bits")
    frame_filter = MonitorFilter(tuple(args.id), tuple(args.block), tuple(args.flow_control))
    sink = None
    if args.output is not None:
        if args.output.exists():
            raise ValueError(f"{args.output} already exists; the monitor will not overwrite a log")
        sink = args.output.open("x", encoding="utf-8")
    try:

        def emit(line: str) -> None:
            if sink is None:
                out(line)
            else:
                sink.write(line + "\n")

        log = MonitorLog(emit, args.id_bits, args.count)
        transport = factory(args.adapter)
        await transport.open()
        try:
            if isinstance(transport, RawCanTransport):
                await transport.link.configure(args.bitrate, listen_only=True)
                out("raw CAN link, listen-only: the log is complete")
                await monitor_raw(transport.link, log, frame_filter, args.duration)
            else:
                elm = Elm(transport, Transcript(args.log))
                info = await elm.initialise()
                await elm.select_can(args.id_bits, args.bitrate)
                kind = (
                    "STN filters, no acknowledgement"
                    if info.has_stn_extensions
                    else "ELM327 filters"
                )
                out(
                    f"adapter {info.identity}, monitoring with {kind}: the log holds what passes them"
                )
                await monitor_elm(elm, info, log, frame_filter, args.duration)
        finally:
            await transport.close()
    finally:
        if sink is not None:
            sink.close()
    out(f"{log.frames} frames logged" + (f" to {args.output}" if args.output else ""))
    return 0
