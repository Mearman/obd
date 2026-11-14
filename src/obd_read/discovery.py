"""A sweep of CAN request identifiers for a car with no profile, ending in a draft profile."""

from __future__ import annotations

import argparse
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .diag import NEGATIVE_RESPONSE, POSITIVE_OFFSET
from .elm import Elm, ElmError, NoResponse
from .guard import DiagProtocol, permit

# The default-session request each protocol's guard allows, and the service byte it echoes back.
SESSION_SERVICE = 0x10
DEFAULT_SESSION = {DiagProtocol.KWP2000: 0x81, DiagProtocol.UDS: 0x01}

# 11-bit identifiers only: a 29-bit sweep would be too large to run blind.
MAX_ID = 0x7FF

DRAFT_NAME = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


@dataclass(frozen=True)
class Found:
    """One request identifier that drew a reply to the session request, and who replied."""

    request_id: int
    response_id: int
    accepted: bool
    detail: str


@dataclass
class Sweep:
    """What a sweep learned: units that answered, and identifiers that produced adapter errors."""

    found: list[Found] = field(default_factory=list)
    errors: dict[int, str] = field(default_factory=dict)


def interpret(replies: dict[int, list[bytes]], request_id: int) -> list[Found]:
    """Pick out the replies that answer a session request.

    A reply counts only when it is a positive session response or a negative response to
    the session service, so unrelated frames the adapter hears on the bus are ignored.
    """
    positive = SESSION_SERVICE + POSITIVE_OFFSET
    found: list[Found] = []
    for sender, messages in replies.items():
        for message in messages:
            if message[0] == positive:
                found.append(Found(request_id, sender, True, "session accepted"))
            elif (
                message[0] == NEGATIVE_RESPONSE
                and len(message) >= 3
                and message[1] == SESSION_SERVICE
            ):
                found.append(
                    Found(request_id, sender, False, f"session refused ({message[2]:02X})")
                )
    return found


async def sweep(
    elm: Elm,
    protocol: DiagProtocol,
    session: int,
    first: int,
    last: int,
    progress: Callable[[int], None] | None = None,
) -> Sweep:
    """Send a default-session request on every identifier from `first` to `last` inclusive.

    Only the guarded default or standard session request is sent, and the adapter accepts a
    reply from any sender so the unit's own response identifier is learned, not assumed.
    Raises GuardError if `session` is not a read-only session for `protocol`, and ValueError
    for an identifier range outside 11-bit CAN.
    """
    if not 0 <= first <= last <= MAX_ID:
        raise ValueError(f"identifier range must lie within 0x000 to {MAX_ID:#x}, first to last")
    request = permit(protocol, bytes([SESSION_SERVICE, session]))
    result = Sweep()
    for request_id in range(first, last + 1):
        if progress is not None:
            progress(request_id)
        await elm.require(f"ATSH{request_id:03X}")
        await elm.require("ATAR")
        await elm.require(f"ATFCSH{request_id:03X}")
        await elm.require("ATFCSD300000")
        await elm.require("ATFCSM1")
        try:
            replies = await elm.request(request)
        except NoResponse:
            continue
        except ElmError as error:
            result.errors[request_id] = str(error)
            continue
        result.found += interpret(replies, request_id)
    return result


def draft_profile(
    found: list[Found], name: str, protocol: DiagProtocol, session: int, bitrate: int
) -> str:
    """TOML for a draft profile of the units that answered, marked unconfirmed.

    Units are named by request identifier because nothing in a session reply says what
    they are. Raises ValueError for a name that is not lower-case words joined by hyphens,
    or when two units share a request or response identifier, which a profile cannot hold.
    """
    if not DRAFT_NAME.fullmatch(name):
        raise ValueError(f"profile name {name!r} must be lower-case words joined by hyphens")
    requests = [item.request_id for item in found]
    responses = [item.response_id for item in found]
    if len(set(requests)) != len(requests) or len(set(responses)) != len(responses):
        raise ValueError(
            "more than one reply shares an identifier, so the units cannot be told apart; "
            "build the profile by hand from the sweep output"
        )
    taken = datetime.now(UTC).date().isoformat()
    lines = [
        f"# Draft written by obd-read discover on {taken}.",
        "# Every unit is a CAN identifier pair that answered a session request. Nothing says",
        "# what the units are: rename them and fill in the descriptions before relying on this.",
        "",
        f'name = "{name}"',
        'description = "Draft from a discovery sweep"',
        'status = "unconfirmed"',
        "",
        "[bus]",
        "id_bits = 11",
        f"bitrate = {bitrate}",
        "",
        "[diagnostics]",
        f'protocol = "{protocol.value}"',
        f"session = {session:#04x}",
    ]
    for item in found:
        lines += [
            "",
            f"[units.unit-{item.request_id:03x}]",
            f'description = "Unidentified unit that answered on {item.request_id:#05x}"',
            f"request = {item.request_id:#05x}",
            f"response = {item.response_id:#05x}",
            f'source = "obd-read discover sweep on {taken}: {item.detail}"',
        ]
    return "\n".join(lines) + "\n"


async def discover_command(elm: Elm, args: argparse.Namespace, out: Callable[[str], None]) -> int:
    """Sweep the requested identifier range and report, and optionally write, what answered."""
    if args.output is not None and args.output.exists():
        raise ValueError(f"{args.output} already exists; choose a new file for the draft")
    protocol = DiagProtocol(args.protocol)
    session = args.session if args.session is not None else DEFAULT_SESSION[protocol]
    await elm.select_can(11, args.bitrate)
    out(
        f"sweeping request identifiers {args.first:#05x} to {args.last:#05x} "
        f"with {protocol.value} session {session:#04x}; each silent identifier waits out the adapter's reply timeout"
    )
    result = await sweep(elm, protocol, session, args.first, args.last)
    for item in result.found:
        out(f"request {item.request_id:#05x} -> response {item.response_id:#05x}: {item.detail}")
    for request_id, error in result.errors.items():
        out(f"request {request_id:#05x}: adapter error: {error}")
    out(f"{len(result.found)} replies in {args.last - args.first + 1} identifiers")
    if args.output is not None:
        text = draft_profile(result.found, args.name, protocol, session, args.bitrate)
        with args.output.open("x", encoding="utf-8") as draft:
            draft.write(text)
        out(
            f"wrote draft profile {args.output}; check it with: obd-read profile check {args.output}"
        )
    return 0 if result.found else 1
