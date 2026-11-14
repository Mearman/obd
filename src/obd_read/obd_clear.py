"""Clear emissions fault codes on the profile-free OBD-II path, with the snapshot saved first.

Mode 04 erases the stored codes, freeze frame and misfire data of every emissions-related unit on the bus and resets their readiness monitors. It is sent only through the guard's clear token, and only after what it erases is on disk.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import obd
from .diag import NEGATIVE_RESPONSE
from .elm import AdapterInfo, Elm, ElmError
from .guard import ClearToken, DiagProtocol, authorise_clear, permit
from .operations import ClearRefused

CLEAR_MODE = 0x04

Printer = Callable[[str], None]


@dataclass
class ObdSnapshot:
    """Everything mode 04 is about to erase that the legislated reads can report, in plain values."""

    vin: str | None = None
    readiness: dict[str, dict[str, object]] = field(default_factory=dict)
    stored: dict[str, list[str]] = field(default_factory=dict)
    pending: dict[str, list[str]] = field(default_factory=dict)
    permanent: dict[str, list[str]] = field(default_factory=dict)
    freeze_frames: dict[str, dict[str, object]] = field(default_factory=dict)
    misfire_counts: dict[str, list[dict[str, int | None]]] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


@dataclass
class ObdClearOutcome:
    """The result of one clear-codes command."""

    before: ObdSnapshot
    cleared: bool
    after: ObdSnapshot | None


def _by_unit(found: dict[int, list[str]]) -> dict[str, list[str]]:
    return {f"{sender:X}": value for sender, value in found.items()}


async def read_snapshot(elm: Elm, *, full: bool) -> ObdSnapshot:
    """Read the codes and readiness state, and with `full` the VIN, freeze frames and misfire counts.

    Raises ElmError when the stored or pending codes cannot be read, or when no unit reports
    stored codes: nothing may be erased that was not first read. A freeze frame or misfire read
    that fails is recorded in `notes`, since those are optional reads on many cars.
    """
    snapshot = ObdSnapshot()
    stored = await obd.codes(elm, obd.STORED_CODES)
    if not stored:
        raise ElmError("no unit reported its stored codes")
    snapshot.stored = _by_unit(stored)
    snapshot.pending = _by_unit(await obd.codes(elm, obd.PENDING_CODES))
    snapshot.readiness = {
        f"{sender:X}": {"lamp_on": state.lamp_on, "code_count": state.code_count}
        for sender, state in (await obd.readiness(elm)).items()
    }
    if not full:
        return snapshot
    snapshot.vin = await obd.vin(elm)
    try:
        snapshot.permanent = _by_unit(await obd.codes(elm, obd.PERMANENT_CODES))
    except ElmError as error:
        snapshot.notes.append(f"permanent codes not read: {error}")
    try:
        snapshot.freeze_frames = {
            f"{sender:X}": {"code": frame.code, "values": frame.values}
            for sender, frame in (await obd.freeze_frame(elm)).items()
        }
    except ElmError as error:
        snapshot.notes.append(f"freeze frame not read: {error}")
    try:
        snapshot.misfire_counts = {
            f"{sender:X}": [asdict(counts) for counts in monitors]
            for sender, monitors in (await obd.misfire_counts(elm)).items()
        }
    except ElmError as error:
        snapshot.notes.append(f"misfire counts not read: {error}")
    return snapshot


async def send_clear(elm: Elm, token: ClearToken) -> list[int]:
    """Send mode 04 to every unit and return the senders that confirmed the clear.

    Raises GuardError when the token's snapshot has gone, and ElmError when a unit refuses the
    clear or none confirms it.
    """
    replies = await elm.request(permit(DiagProtocol.OBD, bytes([CLEAR_MODE]), token))
    confirmed: list[int] = []
    for sender, messages in replies.items():
        for message in messages:
            if message[0] == CLEAR_MODE + obd.POSITIVE_OFFSET:
                confirmed.append(sender)
            elif message[0] == NEGATIVE_RESPONSE and len(message) >= 3:
                raise ElmError(f"unit {sender:X} refused the clear with code {message[2]:02X}")
    if not confirmed:
        raise ElmError("no unit confirmed the clear")
    return confirmed


async def clear_codes(
    elm: Elm,
    adapter: AdapterInfo,
    save: Path,
    confirm: Callable[[ObdSnapshot], bool],
) -> ObdClearOutcome:
    """Save what mode 04 will erase, ask `confirm`, send the clear, then read the codes again.

    The functional address must already be selected. Raises ClearRefused, having sent nothing
    that changes the car, when `save` already exists or the codes cannot be read. When
    `confirm` returns False the snapshot stays on disk and the outcome reports nothing cleared.
    """
    if save.exists():
        raise ClearRefused(f"{save} already exists; choose a new file for the snapshot")
    try:
        before = await read_snapshot(elm, full=True)
    except ElmError as error:
        raise ClearRefused(f"could not read the fault codes ({error}); nothing cleared") from error
    saved = {
        "tool": "obd-read",
        "taken": datetime.now(UTC).isoformat(timespec="seconds"),
        "adapter": asdict(adapter),
        "snapshot": asdict(before),
        "transcript": list(elm.transcript.entries),
    }
    with save.open("x", encoding="utf-8") as snapshot_file:
        json.dump(saved, snapshot_file, indent=2)
        snapshot_file.write("\n")
    token = authorise_clear(save)
    if not confirm(before):
        return ObdClearOutcome(before=before, cleared=False, after=None)
    await send_clear(elm, token)
    return ObdClearOutcome(before=before, cleared=True, after=await read_snapshot(elm, full=False))


def print_snapshot(snapshot: ObdSnapshot, out: Printer) -> None:
    """Print the codes in a snapshot, one line per kind and unit."""
    for label, found in (
        ("stored", snapshot.stored),
        ("pending", snapshot.pending),
        ("permanent", snapshot.permanent),
    ):
        for sender, codes in found.items():
            out(f"{label} codes from {sender}: {', '.join(codes) or 'none'}")
    for sender, state in snapshot.readiness.items():
        lamp = "on" if state["lamp_on"] else "off"
        out(f"unit {sender}: warning lamp {lamp}, {state['code_count']} stored codes")
    for note in snapshot.notes:
        out(f"note: {note}")


async def clear_codes_command(
    elm: Elm,
    adapter: AdapterInfo,
    args: argparse.Namespace,
    out: Printer,
    ask: Callable[[str], str],
) -> int:
    """The clear-codes command: select the bus, snapshot, confirm, clear and read again."""
    await elm.select_can(args.id_bits, args.bitrate)
    await elm.address_functional(obd.FUNCTIONAL_ID[args.id_bits])

    def confirm(before: ObdSnapshot) -> bool:
        out(f"VIN: {before.vin or 'not reported'}")
        print_snapshot(before, out)
        if before.freeze_frames:
            out("freeze frames and misfire counts are saved with the snapshot")
        out(f"snapshot saved to {args.save}")
        out(
            "Mode 04 erases the stored codes, freeze frame and misfire data of every "
            "emissions-related unit on the car, not one unit, and resets the readiness monitors."
        )
        if args.yes:
            return True
        return ask("Erase them? Type yes to continue: ") == "yes"

    outcome = await clear_codes(elm, adapter, args.save, confirm)
    if not outcome.cleared or outcome.after is None:
        out("nothing cleared")
        return 1
    out("cleared; the readiness monitors are reset and will need a drive cycle to complete")
    out("reading the codes again:")
    print_snapshot(outcome.after, out)
    return 0
