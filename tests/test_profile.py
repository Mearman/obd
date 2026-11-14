from pathlib import Path

import pytest

from obd_read.guard import DiagProtocol
from obd_read.profile import ProfileError, builtin_profiles, load_profile, parse_profile

MINIMAL = """
name = "test-car"
description = "A car for tests"
status = "confirmed"

[bus]
id_bits = 11
bitrate = 500000

[diagnostics]
protocol = "uds"
session = 0x03

[units.engine]
description = "Engine"
request = 0x7E0
response = 0x7E8
source = "made up for the test"
"""


def test_every_shipped_profile_loads() -> None:
    assert "mercedes-w211" in builtin_profiles()
    for name in builtin_profiles():
        profile = load_profile(name)
        assert profile.name == name
        assert all(unit.source for unit in profile.units.values())


def test_w211_profile_addresses() -> None:
    profile = load_profile("mercedes-w211")
    assert (profile.id_bits, profile.bitrate) == (11, 500_000)
    assert (profile.protocol, profile.session) == (DiagProtocol.KWP2000, 0x92)
    assert profile.status == "unconfirmed"
    esp = profile.unit("esp")
    assert (esp.request_id, esp.response_id) == (0x784, 0x785)
    engine = profile.unit("engine")
    assert (engine.request_id, engine.response_id) == (0x7E0, 0x7E8)


def test_profile_loads_from_a_path(tmp_path: Path) -> None:
    path = tmp_path / "car.toml"
    path.write_text(MINIMAL)
    assert load_profile(str(path)).unit("engine").request_id == 0x7E0


def test_unknown_unit_lists_the_known_ones() -> None:
    with pytest.raises(ProfileError, match="engine"):
        parse_profile(MINIMAL, "test").unit("gearbox")


def test_unknown_profile_lists_the_shipped_ones() -> None:
    with pytest.raises(ProfileError, match="mercedes-w211"):
        load_profile("no-such-car")


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("session = 0x03", "session = 0x02", "not a read-only session"),
        ('protocol = "uds"', 'protocol = "j1939"', "kwp2000 or uds"),
        ("bitrate = 500000", "bitrate = 83333", "no adapter protocol"),
        ("request = 0x7E0", 'request = "7E0"', "request must be int"),
        ("response = 0x7E8\n", "", "missing response"),
        ('status = "confirmed"\n', "", "missing status"),
        ("[bus]", "[bus", "test"),
    ],
)
def test_invalid_profiles_are_refused(old: str, new: str, message: str) -> None:
    assert old in MINIMAL
    with pytest.raises(ProfileError, match=message):
        parse_profile(MINIMAL.replace(old, new), "test")


def test_vag_mqb_profile_addresses() -> None:
    profile = load_profile("vag-mqb")
    assert (profile.id_bits, profile.bitrate) == (11, 500_000)
    assert (profile.protocol, profile.session) == (DiagProtocol.UDS, 0x01)
    assert profile.status == "unconfirmed"
    pairs = {name: (unit.request_id, unit.response_id) for name, unit in profile.units.items()}
    assert pairs["engine"] == (0x7E0, 0x7E8)
    assert pairs["dashboard"] == (0x714, 0x77E)
    assert pairs["hvac"] == (0x746, 0x7B0)
