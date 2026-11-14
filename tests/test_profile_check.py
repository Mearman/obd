import re
from pathlib import Path

import pytest

from obd_read.profile import builtin_profiles, profile_source
from obd_read.profile_check import check_profile

from .test_cli import Car
from .test_profile import MINIMAL


@pytest.mark.parametrize("name", builtin_profiles())
def test_every_shipped_profile_passes_the_check(name: str) -> None:
    text, where = profile_source(name)
    assert check_profile(text, where) == []


def test_a_sound_profile_has_no_problems() -> None:
    assert check_profile(MINIMAL, "test") == []


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("session = 0x03", "session = 0x02", "not a read-only session"),
        ('status = "confirmed"', 'status = "probably"', "status must be"),
        ('name = "test-car"', 'name = "Test Car"', "lower-case words"),
        ("request = 0x7E0", "request = 0x800", "does not fit 11-bit"),
        ("request = 0x7E0", "request = 0x7E8", "request and response are both 0x7e8"),
        ('source = "made up for the test"', 'source = "  "', "source is blank"),
        ('description = "Engine"', 'description = ""', "description is blank"),
        ("bitrate = 500000", "bitrate = 500000\nbit_rate = 1", r"\[bus\]: unknown key bit_rate"),
        (
            'source = "made up for the test"',
            'source = "x"\nnote = "stray"',
            r"\[units.engine\]: unknown key note",
        ),
    ],
)
def test_a_flawed_profile_is_reported(old: str, new: str, message: str) -> None:
    assert old in MINIMAL
    problems = check_profile(MINIMAL.replace(old, new), "test")
    assert any(re.search(message, problem) for problem in problems), problems


def test_a_shared_identifier_is_reported() -> None:
    extra = (
        MINIMAL
        + '\n[units.gearbox]\ndescription = "G"\nrequest = 0x7E0\nresponse = 0x7E9\nsource = "s"\n'
    )
    assert check_profile(extra, "test") == ["[units.gearbox]: request 0x7e0 is also used by engine"]


def test_unreadable_toml_is_one_problem() -> None:
    assert len(check_profile("[bus", "test")) == 1


async def test_profile_check_command_reports_and_sets_the_exit_status(tmp_path: Path) -> None:
    good = tmp_path / "good.toml"
    good.write_text(MINIMAL)
    bad = tmp_path / "bad.toml"
    bad.write_text(MINIMAL.replace("0x7E8", "0x7E0"))
    car = Car()
    assert await car.run("profile", "check", str(good), "mercedes-w211") == 0
    assert f"{good}: ok" in car.lines
    assert "mercedes-w211: ok" in car.lines
    assert await car.run("profile", "check", str(good), str(bad), "no-such-car") == 1
    assert f"{bad}: 1 problem" in car.output
    assert "no profile named 'no-such-car'" in car.output
    assert car.core.sent == []
