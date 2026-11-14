import asyncio
from dataclasses import dataclass

import pytest

from obd_read.actuate import TESTER_PRESENT_SECONDS, ActuationError, Sleep, actuate_command
from obd_read.cli import build_parser, run
from obd_read.diag import NegativeResponse
from obd_read.elm import Elm, Transcript
from obd_read.guard import ACTUATION_MAX_SECONDS
from obd_read.profile import load_profile
from obd_read.transport import Transport

from .fake_elm import FakeElmCore, FakeTransport, KwpEcu, UdsEcu

ADAPTER = ["--adapter", "tcp://fake:1"]


@dataclass(frozen=True)
class Case:
    """One protocol's profile and an invented actuator: these bytes address nothing on a real car."""

    profile: str
    start: str
    stop: str
    tester_present: str
    reply: str


KWP = Case("mercedes-w211", start="304207FF", stop="304200", tester_present="3E01", reply="70")
UDS = Case("vag-mqb", start="2F014203FF", stop="2F014200", tester_present="3E00", reply="6F")
CASES = pytest.mark.parametrize("case", [KWP, UDS], ids=["kwp2000", "uds"])


class Car:
    """A fake car whose engine unit answers actuation requests, unless told to refuse a service."""

    def __init__(self, case: Case) -> None:
        self.case = case
        self.ecu = KwpEcu(0x7E8, []) if case is KWP else UdsEcu(0x7E8, [])
        self.refused: set[int] = set()
        self.silent: set[int] = set()
        self.core = FakeElmCore({0x7E0: self.respond})
        self.transport = FakeTransport(self.core)
        self.lines: list[str] = []

    def respond(self, request: bytes) -> list[tuple[int, bytes]]:
        if request[0] in self.silent:
            return []
        if request[0] in self.refused:
            return [(0x7E8, bytes([0x7F, request[0], 0x22]))]
        return self.ecu(request)

    def factory(self, _url: str) -> Transport:
        return self.transport

    def argv(self, *, start: str = "", stop: str = "", seconds: float = 0.01) -> list[str]:
        return [
            "actuate",
            "engine",
            "--request",
            start or self.case.start,
            "--stop",
            stop or self.case.stop,
            "--seconds",
            str(seconds),
            *ADAPTER,
            "--profile",
            self.case.profile,
        ]

    async def run(self, argv: list[str], answer: str = "yes") -> int:
        return await run(argv, self.lines.append, lambda _prompt: answer, self.factory)

    async def direct(self, sleep: Sleep, seconds: float = 5) -> int:
        """Run the actuate command with a stand-in for asyncio.sleep, as the CLI would."""
        args = build_parser().parse_args(self.argv(seconds=seconds))
        profile = load_profile(args.profile)
        elm = Elm(self.transport, Transcript())
        await elm.initialise()
        await elm.select_can(profile.id_bits, profile.bitrate)
        return await actuate_command(
            elm, profile, profile.unit("engine"), args, self.lines.append, lambda _p: "yes", sleep
        )

    @property
    def actuation_requests(self) -> list[str]:
        return [line for line in self.core.requests if line.startswith(("30", "2F"))]

    @property
    def output(self) -> str:
        return "\n".join(self.lines)


def raising(error: BaseException) -> Sleep:
    async def sleep(_seconds: float) -> None:
        raise error

    return sleep


@CASES
async def test_actuate_starts_holds_and_stops(case: Case) -> None:
    car = Car(case)
    assert await car.run(car.argv()) == 0
    assert car.actuation_requests == [case.start, case.stop]
    assert f"start request: {case.start}" in car.output
    assert f"stop request: {case.stop}" in car.output
    assert "unit: engine (7E0 -> 7E8)" in car.output
    assert f"start reply: {case.reply}{case.start[2:]}" in car.output
    assert f"sending stop request {case.stop}" in car.output
    assert car.lines[-1] == "control handed back to the unit"


@CASES
async def test_a_long_hold_keeps_the_session_open_with_tester_present(case: Case) -> None:
    car = Car(case)
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    assert await car.direct(sleep, seconds=5) == 0
    assert sum(slept) == 5
    assert max(slept) <= TESTER_PRESENT_SECONDS
    requests = car.core.requests
    held = requests[requests.index(case.start) + 1 : requests.index(case.stop)]
    assert held == [case.tester_present] * (len(slept) - 1)


@CASES
@pytest.mark.parametrize("answer", ["", "y", "no", "YES", "yes please"])
async def test_declined_prompt_sends_no_actuation(case: Case, answer: str) -> None:
    car = Car(case)
    assert await car.run(car.argv(), answer=answer) == 1
    assert car.actuation_requests == []
    assert car.lines[-1] == "nothing sent"


@CASES
async def test_the_stop_request_follows_a_refused_start(case: Case) -> None:
    car = Car(case)
    car.refused.add(int(case.start[:2], 16))
    assert await car.run(car.argv()) == 1
    assert car.actuation_requests == [case.start, case.stop]
    assert "refused with code 22" in car.lines[-1]


@CASES
async def test_the_stop_request_follows_a_silent_start(case: Case) -> None:
    car = Car(case)
    respond = car.respond

    def silent_once(request: bytes) -> list[tuple[int, bytes]]:
        if request.hex().upper() == case.start:
            return []
        return respond(request)

    car.core.responders[0x7E0] = silent_once
    assert await car.run(car.argv()) == 1
    assert car.actuation_requests == [case.start, case.stop]


@CASES
async def test_the_stop_request_follows_an_error_mid_test(case: Case) -> None:
    car = Car(case)
    car.refused.add(0x3E)

    async def sleep(_seconds: float) -> None:
        pass

    with pytest.raises(NegativeResponse, match="refused with code 22"):
        await car.direct(sleep, seconds=5)
    requests = car.core.requests
    assert car.actuation_requests == [case.start, case.stop]
    assert requests.index(case.stop) > requests.index(case.tester_present)


@CASES
@pytest.mark.parametrize(
    "interruption",
    [KeyboardInterrupt(), asyncio.CancelledError(), TimeoutError("the hold timed out")],
    ids=["keyboard-interrupt", "cancelled", "timeout"],
)
async def test_the_stop_request_follows_an_interruption(
    case: Case, interruption: BaseException
) -> None:
    car = Car(case)
    with pytest.raises(type(interruption)):
        await car.direct(raising(interruption))
    assert car.actuation_requests == [case.start, case.stop]
    assert f"stop reply: {case.reply}{case.stop[2:]}" in car.output


@CASES
async def test_a_failed_stop_request_is_reported_with_the_earlier_error(case: Case) -> None:
    car = Car(case)
    respond = car.respond

    def refuse_stop(request: bytes) -> list[tuple[int, bytes]]:
        if request.hex().upper() == case.stop:
            return [(0x7E8, bytes([0x7F, request[0], 0x22]))]
        return respond(request)

    car.core.responders[0x7E0] = refuse_stop
    with pytest.raises(ActuationError, match=r"KeyboardInterrupt.*switch the ignition off"):
        await car.direct(raising(KeyboardInterrupt()))
    assert car.actuation_requests == [case.start, case.stop]


@CASES
@pytest.mark.parametrize("seconds", [0, -1, ACTUATION_MAX_SECONDS + 1])
async def test_a_duration_outside_the_limit_sends_nothing(case: Case, seconds: float) -> None:
    car = Car(case)
    assert await car.run(car.argv(seconds=seconds)) == 1
    assert car.core.requests == []
    assert "at most" in car.lines[-1]


@CASES
async def test_a_stop_for_another_identifier_sends_nothing(case: Case) -> None:
    car = Car(case)
    stop = case.stop[:2] + "FF" + case.stop[4:]
    assert await car.run(car.argv(stop=stop)) == 1
    assert car.core.requests == []
    assert "same identifier" in car.lines[-1]


@CASES
@pytest.mark.parametrize("start", ["2701", "3101", "1101", "3B4201", "2E014201", "1002", "3480"])
async def test_actuate_sends_only_the_actuation_service(case: Case, start: str) -> None:
    car = Car(case)
    stop = start[:2] + "00" * (len(start) // 2)
    assert await car.run(car.argv(start=start, stop=stop)) == 1
    assert car.core.requests == []
    assert "not a" in car.lines[-1]
