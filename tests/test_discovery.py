from pathlib import Path

import pytest

from obd_read.discovery import Found, draft_profile, interpret
from obd_read.guard import DiagProtocol
from obd_read.profile import load_profile
from obd_read.profile_check import check_profile

from .test_cli import Car

SWEEP = ["discover", "--adapter", "tcp://fake:1", "--protocol", "kwp2000"]


async def test_the_sweep_lists_units_that_answer_and_where_from() -> None:
    car = Car()
    assert await car.run(*SWEEP, "--first", "0x780", "--last", "0x7FF") == 0
    assert "request 0x784 -> response 0x785: session accepted" in car.output
    assert "request 0x7e0 -> response 0x7e8: session accepted" in car.output
    assert "2 replies in 128 identifiers" in car.output


async def test_the_sweep_sends_only_the_guarded_default_session_request() -> None:
    car = Car()
    assert await car.run(*SWEEP, "--first", "0x780", "--last", "0x788") == 0
    assert set(car.core.requests) == {"1081"}
    assert len(car.core.requests) == 9
    assert "ATSH784" in car.core.sent


async def test_a_uds_sweep_uses_the_uds_default_session() -> None:
    car = Car()
    car.core.responders = {0x7E0: lambda r: [(0x7E8, bytes([0x50, r[1], 0, 0x32, 1, 0xF4]))]}
    assert (
        await car.run(
            "discover",
            "--adapter",
            "tcp://fake:1",
            "--protocol",
            "uds",
            "--first",
            "0x7e0",
            "--last",
            "0x7e1",
        )
        == 0
    )
    assert set(car.core.requests) == {"1001"}


async def test_a_refused_session_is_still_a_unit_and_other_traffic_is_ignored() -> None:
    car = Car()
    car.core.responders = {
        0x700: lambda r: [(0x708, bytes([0x7F, 0x10, 0x11]))],
        0x701: lambda r: [(0x1C, bytes([0x62, 0x01, 0x02]))],
    }
    assert await car.run(*SWEEP, "--first", "0x700", "--last", "0x702") == 0
    assert "request 0x700 -> response 0x708: session refused (11)" in car.output
    assert "0x701" not in car.output.replace("0x700 to 0x702", "")


async def test_a_sweep_that_finds_nothing_exits_non_zero() -> None:
    car = Car()
    assert await car.run(*SWEEP, "--first", "0x100", "--last", "0x102") == 1
    assert "0 replies in 3 identifiers" in car.output


async def test_the_draft_profile_passes_the_check_and_loads(tmp_path: Path) -> None:
    car = Car()
    draft = tmp_path / "draft.toml"
    assert (
        await car.run(
            *SWEEP,
            "--first",
            "0x780",
            "--last",
            "0x7FF",
            "--output",
            str(draft),
            "--name",
            "my-car",
        )
        == 0
    )
    text = draft.read_text()
    assert check_profile(text, "draft") == []
    profile = load_profile(str(draft))
    assert (profile.name, profile.status) == ("my-car", "unconfirmed")
    assert (profile.units["unit-784"].request_id, profile.units["unit-784"].response_id) == (
        0x784,
        0x785,
    )
    assert "discover sweep" in profile.units["unit-784"].source


async def test_an_existing_draft_file_is_not_overwritten(tmp_path: Path) -> None:
    car = Car()
    draft = tmp_path / "draft.toml"
    draft.write_text("keep me")
    assert await car.run(*SWEEP, "--output", str(draft)) == 1
    assert draft.read_text() == "keep me"
    assert car.core.requests == []
    assert not any(line.startswith("ATSH") for line in car.core.sent)


@pytest.mark.parametrize(("first", "last"), [("0x7ff", "0x700"), ("0x700", "0x800")])
async def test_a_bad_range_is_refused_before_anything_is_sent(first: str, last: str) -> None:
    car = Car()
    assert await car.run(*SWEEP, "--first", first, "--last", last) == 1
    assert car.core.requests == []


async def test_a_session_the_guard_refuses_sends_nothing() -> None:
    car = Car()
    assert await car.run(*SWEEP, "--session", "0x85", "--first", "0x700", "--last", "0x701") == 1
    assert car.core.requests == []
    assert car.lines[-1].startswith("error:")


def test_unrelated_frames_are_not_units() -> None:
    assert interpret({0x1C: [bytes([0x62, 0x01])], 0x7E8: [bytes([0x50, 0x81])]}, 0x7E0) == [
        Found(0x7E0, 0x7E8, True, "session accepted")
    ]


def test_a_draft_needs_a_valid_name_and_distinct_identifiers() -> None:
    unit = Found(0x7E0, 0x7E8, True, "session accepted")
    with pytest.raises(ValueError, match="lower-case"):
        draft_profile([unit], "My Car", DiagProtocol.KWP2000, 0x81, 500_000)
    twin = Found(0x7E1, 0x7E8, True, "session accepted")
    with pytest.raises(ValueError, match="cannot be told apart"):
        draft_profile([unit, twin], "car", DiagProtocol.KWP2000, 0x81, 500_000)
