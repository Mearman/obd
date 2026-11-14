"""Coding and adaptation writes, and putting a saved value back.

The tool carries no vendor requests: the user supplies the exact write request and the read request for the same identifier. The order is fixed and stops at the first step that fails: read the current value, save it with the request to a new snapshot file, show both, ask for a typed `yes`, send the write once through the guard's write token, then read the value back.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from .diag import NegativeResponse, UnitSession
from .elm import AdapterInfo, Elm, ElmError
from .guard import (
    READ_SERVICE,
    WRITE_SERVICE,
    DiagProtocol,
    GuardError,
    authorise_write,
    identifier,
)
from .operations import make_client, unit_session
from .profile import Profile, Unit

Printer = Callable[[str], None]

WRITE_COMMANDS = ("write", "restore")

# Marks a snapshot file as one this module wrote, so restore refuses any other kind of file.
SNAPSHOT_KIND = "write"


class WriteRefused(Exception):
    """The write or restore command stopped before sending anything that changes the car."""


def hexadecimal(text: str) -> bytes:
    """Request bytes given on the command line as hexadecimal. Raises ValueError when they are not."""
    return bytes.fromhex(text)


@dataclass(frozen=True)
class WritePlan:
    """One write request and the read request that reads the same identifier."""

    protocol: DiagProtocol
    write: bytes
    read: bytes

    @property
    def identifier(self) -> bytes:
        return identifier(self.protocol, self.write)

    @property
    def value(self) -> bytes:
        """The bytes the write sets, after its service byte and identifier."""
        return self.write[1 + len(self.identifier) :]


def plan_write(protocol: DiagProtocol, write: bytes, read: bytes) -> WritePlan:
    """Check that `write` is the protocol's write service with a value and `read` reads exactly the same identifier.

    Raises GuardError otherwise, before anything is sent.
    """
    service = WRITE_SERVICE.get(protocol)
    if service is None or not write or write[0] != service:
        raise GuardError(
            f"{write.hex().upper() or 'an empty request'} is not a {protocol.value} write request"
        )
    plan = WritePlan(protocol, write, read)
    if not plan.value:
        raise GuardError(f"write {write.hex().upper()} carries no value to write")
    expected = bytes([READ_SERVICE[protocol]]) + plan.identifier
    if read != expected:
        raise GuardError(
            f"the read request must be {expected.hex().upper()}, which reads the identifier the "
            f"write names; got {read.hex().upper() or 'an empty request'}"
        )
    return plan


@dataclass
class WriteOutcome:
    """The result of one write or restore command."""

    previous: bytes
    written: bool
    reply: bytes | None = None
    after: bytes | None = None
    read_back_error: str | None = None


async def read_value(session: UnitSession, plan: WritePlan) -> bytes:
    """Send the plan's read request and return the value after the identifier in the reply.

    Raises ElmError when the reply names another identifier, and what UnitSession.request raises.
    """
    reply = await session.request(plan.read)
    named = reply[1 : 1 + len(plan.identifier)]
    if named != plan.identifier:
        raise ElmError(
            f"reply {reply.hex().upper()} names identifier {named.hex().upper()}, "
            f"not {plan.identifier.hex().upper()}"
        )
    return reply[1 + len(plan.identifier) :]


async def write_value(
    elm: Elm,
    profile: Profile,
    adapter: AdapterInfo,
    unit: Unit,
    plan: WritePlan,
    save: Path,
    confirm: Callable[[bytes], bool],
    restores: Path | None = None,
) -> WriteOutcome:
    """Save the value `plan` replaces, ask `confirm` with it, write once, then read the value back.

    Raises WriteRefused, having sent nothing that changes the car, when `save` already exists or the session or the current value cannot be read. When `confirm` returns False the snapshot stays on disk and nothing is written. A write the unit refuses raises NegativeResponse. A read back that fails after the write is reported in the outcome, not raised.
    """
    if save.exists():
        raise WriteRefused(f"{save} already exists; choose a new file for the snapshot")
    await elm.address_unit(unit.request_id, unit.response_id)
    session = unit_session(elm, profile, unit)
    try:
        await make_client(elm, profile, unit).start()
        previous = await read_value(session, plan)
    except (NegativeResponse, ElmError) as error:
        raise WriteRefused(
            f"could not read the current value from {unit.name} ({error}); nothing written"
        ) from error
    saved = {
        "tool": "obd-read",
        "kind": SNAPSHOT_KIND,
        "taken": datetime.now(UTC).isoformat(timespec="seconds"),
        "profile": {"name": profile.name, "status": profile.status},
        "protocol": plan.protocol.value,
        "unit": {
            "name": unit.name,
            "request_id": f"{unit.request_id:X}",
            "response_id": f"{unit.response_id:X}",
        },
        "read_request": plan.read.hex().upper(),
        "write_request": plan.write.hex().upper(),
        "previous_value": previous.hex().upper(),
        "restores": None if restores is None else str(restores),
        "adapter": asdict(adapter),
        "transcript": list(elm.transcript.entries),
    }
    with save.open("x", encoding="utf-8") as snapshot:
        json.dump(saved, snapshot, indent=2)
        snapshot.write("\n")
    token = authorise_write(save, plan.protocol, plan.write)
    if not confirm(previous):
        return WriteOutcome(previous=previous, written=False)
    outcome = WriteOutcome(
        previous=previous, written=True, reply=await session.request(plan.write, token)
    )
    try:
        outcome.after = await read_value(session, plan)
    except (NegativeResponse, ElmError) as error:
        outcome.read_back_error = str(error)
    return outcome


def plan_restore(snapshot: Path, profile: Profile, unit: Unit) -> WritePlan:
    """The write that puts back the previous value a write snapshot recorded for `unit`.

    Raises WriteRefused when the file is not a write snapshot, or was taken from another unit, address pair or protocol.
    """
    try:
        saved: object = json.loads(snapshot.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise WriteRefused(f"cannot read the snapshot {snapshot}: {error}") from error
    if not isinstance(saved, dict) or saved.get("kind") != SNAPSHOT_KIND:
        raise WriteRefused(f"{snapshot} is not a write snapshot")
    recorded = saved.get("unit")
    expected = {
        "name": unit.name,
        "request_id": f"{unit.request_id:X}",
        "response_id": f"{unit.response_id:X}",
    }
    if recorded != expected:
        raise WriteRefused(f"{snapshot} was taken from {recorded}, not {expected}")
    if saved.get("protocol") != profile.protocol.value:
        raise WriteRefused(
            f"{snapshot} was taken over {saved.get('protocol')}, not {profile.protocol.value}"
        )
    fields = {key: saved.get(key) for key in ("read_request", "write_request", "previous_value")}
    texts = {key: value for key, value in fields.items() if isinstance(value, str)}
    if len(texts) != len(fields):
        raise WriteRefused(f"{snapshot} lacks {', '.join(sorted(set(fields) - set(texts)))}")
    try:
        write = hexadecimal(texts["write_request"])
        previous = hexadecimal(texts["previous_value"])
        read = hexadecimal(texts["read_request"])
    except ValueError as error:
        raise WriteRefused(f"{snapshot} holds a value that is not hexadecimal") from error
    if not write:
        raise WriteRefused(f"{snapshot} records an empty write request")
    original = plan_write(profile.protocol, write, read)
    return plan_write(
        profile.protocol, bytes([write[0]]) + original.identifier + previous, original.read
    )


def add_commands(car_command: Callable[[str, str], argparse.ArgumentParser]) -> None:
    """Add the write and restore commands to the parser through the CLI's car_command."""
    write = car_command(
        "write", "save the current value, then write one coding or adaptation value"
    )
    write.add_argument("unit")
    write.add_argument(
        "--request", type=hexadecimal, required=True, help="the write request, as hexadecimal"
    )
    write.add_argument(
        "--read",
        type=hexadecimal,
        required=True,
        help="the request that reads the identifier the write names, as hexadecimal",
    )
    write.add_argument("--save", type=Path, required=True, help="new file for the snapshot")

    restore = car_command("restore", "write back the previous value a write snapshot saved")
    restore.add_argument("unit")
    restore.add_argument(
        "--snapshot", type=Path, required=True, help="the snapshot a write command saved"
    )
    restore.add_argument(
        "--save", type=Path, required=True, help="new file for this restore's own snapshot"
    )


async def write_command(
    elm: Elm,
    adapter: AdapterInfo,
    profile: Profile,
    unit: Unit,
    args: argparse.Namespace,
    out: Printer,
    ask: Callable[[str], str],
) -> int:
    """The write and restore commands: plan, snapshot, confirm, write once, read back."""
    restores: Path | None = args.snapshot if args.command == "restore" else None
    plan = (
        plan_write(profile.protocol, args.request, args.read)
        if restores is None
        else plan_restore(restores, profile, unit)
    )

    def confirm(previous: bytes) -> bool:
        out(f"unit: {unit.name} ({unit.request_id:X} -> {unit.response_id:X})")
        out(f"read request: {plan.read.hex().upper()}")
        out(f"current value: {previous.hex().upper() or '(empty)'}")
        out(f"write request: {plan.write.hex().upper()}")
        out(f"new value: {plan.value.hex().upper()}")
        if restores is not None:
            out(f"this puts back the value saved in {restores}")
        out(f"current value saved to {args.save}")
        prompt = f"Write {plan.write.hex().upper()} to {unit.name}? Type yes to continue: "
        return ask(prompt) == "yes"

    outcome = await write_value(elm, profile, adapter, unit, plan, args.save, confirm, restores)
    if not outcome.written or outcome.reply is None:
        out("nothing written")
        return 1
    out(f"sent {plan.write.hex().upper()}; reply {outcome.reply.hex().upper()}")
    if outcome.after is None:
        out(f"the value could not be read back: {outcome.read_back_error}")
        return 1
    out(f"read back: {outcome.after.hex().upper() or '(empty)'}")
    if outcome.after == plan.value:
        out("the value now matches the request")
        return 0
    out(f"the value does not match the request; restore with --snapshot {args.save}")
    return 1
