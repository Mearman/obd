"""Actuator tests: drive one input or output for a bounded time, then always hand control back.

The tool carries no vendor requests: the user supplies the exact start request and the request that returns control to the unit. Once the start request has been attempted, the stop request is sent whatever happens next: a refused or failed start, a failed tester present, a timeout, a cancelled task or a keyboard interrupt.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Awaitable, Callable

from .diag import UnitSession
from .elm import Elm
from .guard import (
    ACTUATION_MAX_SECONDS,
    ActuationTokens,
    DiagProtocol,
    authorise_actuation,
    check_actuation,
)
from .operations import make_client, unit_session
from .profile import Profile, Unit
from .writes import hexadecimal

Printer = Callable[[str], None]
Sleep = Callable[[float], Awaitable[None]]

# Tester present with a reply requested: KWP2000 responseRequired yes (ISO/DIS 14230-3 table 6.4.2.1), and UDS sub-function 0 (python-udsoncan's TesterPresent service).
TESTER_PRESENT: dict[DiagProtocol, bytes] = {
    DiagProtocol.KWP2000: bytes([0x3E, 0x01]),
    DiagProtocol.UDS: bytes([0x3E, 0x00]),
}

# Seconds between tester present requests while a test holds control. ISO/DIS 14230-3 section 6.4.3 says a unit that hears no request returns to normal operation, which ends the test early; units time out after a few seconds of silence, so two seconds keeps the session open with margin.
TESTER_PRESENT_SECONDS = 2.0


class ActuationError(Exception):
    """The stop request that hands control back to the unit failed."""


def add_command(car_command: Callable[[str, str], argparse.ArgumentParser]) -> None:
    """Add the actuate command to the parser through the CLI's car_command."""
    actuate = car_command(
        "actuate", "drive one actuator for a bounded time, then hand control back to the unit"
    )
    actuate.add_argument("unit")
    actuate.add_argument(
        "--request", type=hexadecimal, required=True, help="the start request, as hexadecimal"
    )
    actuate.add_argument(
        "--stop",
        type=hexadecimal,
        required=True,
        help="the request that returns control to the unit, as hexadecimal",
    )
    actuate.add_argument(
        "--seconds",
        type=float,
        required=True,
        help=f"how long to hold control, at most {ACTUATION_MAX_SECONDS:g}",
    )


async def hold(session: UnitSession, seconds: float, sleep: Sleep) -> None:
    """Wait `seconds`, sending tester present every TESTER_PRESENT_SECONDS so the session stays open."""
    remaining = seconds
    while remaining > 0:
        step = min(TESTER_PRESENT_SECONDS, remaining)
        await sleep(step)
        remaining -= step
        if remaining > 0:
            await session.request(TESTER_PRESENT[session.protocol])


async def actuate(
    session: UnitSession,
    tokens: ActuationTokens,
    seconds: float,
    out: Printer,
    sleep: Sleep = asyncio.sleep,
) -> None:
    """Send the start request, hold for `seconds`, then send the stop request, printing each and its reply.

    The stop request is sent in a `finally`, so it goes out after any error or interruption once the start has been attempted, and that error is raised after it. Raises ActuationError when the stop request itself fails, naming any earlier error too.
    """
    start, stop = tokens.start.payload, tokens.stop.payload
    failure: BaseException | None = None
    try:
        out(f"sending start request {start.hex().upper()}")
        out(f"start reply: {(await session.request(start, tokens.start)).hex().upper()}")
        out(f"holding for {seconds:g} seconds")
        await hold(session, seconds, sleep)
    except BaseException as error:
        failure = error
        raise
    finally:
        out(f"sending stop request {stop.hex().upper()}")
        try:
            stop_reply = await session.request(stop, tokens.stop)
        except Exception as error:
            after = "" if failure is None else f" after {type(failure).__name__}: {failure}"
            raise ActuationError(
                f"the stop request {stop.hex().upper()} failed ({error}){after}; the unit may "
                "still be under test control, so switch the ignition off to end it"
            ) from error
        out(f"stop reply: {stop_reply.hex().upper()}")


async def actuate_command(
    elm: Elm,
    profile: Profile,
    unit: Unit,
    args: argparse.Namespace,
    out: Printer,
    ask: Callable[[str], str],
    sleep: Sleep = asyncio.sleep,
) -> int:
    """The actuate command: check, open the session, confirm, then start, hold and always stop."""
    start: bytes = args.request
    stop: bytes = args.stop
    check_actuation(profile.protocol, start, stop, args.seconds)
    await elm.address_unit(unit.request_id, unit.response_id)
    await make_client(elm, profile, unit).start()
    out(f"unit: {unit.name} ({unit.request_id:X} -> {unit.response_id:X})")
    out(f"start request: {start.hex().upper()}")
    out(f"stop request: {stop.hex().upper()}, sent after {args.seconds:g} seconds or on any error")
    prompt = (
        f"Drive {unit.name} with {start.hex().upper()} for {args.seconds:g} seconds, then send "
        f"{stop.hex().upper()}? Type yes to continue: "
    )
    if ask(prompt) != "yes":
        out("nothing sent")
        return 1
    tokens = authorise_actuation(profile.protocol, start, stop, args.seconds)
    await actuate(unit_session(elm, profile, unit), tokens, args.seconds, out, sleep)
    out("control handed back to the unit")
    return 0
