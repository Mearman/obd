import json
from pathlib import Path

import pytest

from obd_read.codenames import (
    CodeNameError,
    CodeNames,
    Described,
    load_generic_titles,
    load_names_file,
    names_document,
    normalise_code,
    parse_profile_codes,
)

PROFILE = """
name = "test-car"
description = "A car for tests"
status = "confirmed"

[bus]
id_bits = 11
bitrate = 500000

[diagnostics]
protocol = "kwp2000"
session = 0x92

[units.esp]
description = "ESP"
request = 0x784
response = 0x785
source = "made up for the test"

[codes.esp."5123"]
text = "Wheel speed sensor, front left"
source = "invented for the test"
"""


def test_generic_titles_cover_the_sae_code_space() -> None:
    titles = load_generic_titles()
    assert titles["P0420"] == "Catalyst System Efficiency Below Threshold Bank 1"
    assert all(code[0] in "PBCU" and len(code) == 5 for code in titles)
    assert len(titles) > 9000


@pytest.mark.parametrize(
    ("raw", "key"),
    [("p0420", "P0420"), ("5123", "5123"), ("0x51", "0051"), ("1", "0001")],
)
def test_codes_normalise_to_one_key(raw: str, key: str) -> None:
    assert normalise_code(raw.removeprefix("0x")) == key


def test_a_code_that_is_neither_form_is_refused() -> None:
    with pytest.raises(CodeNameError):
        normalise_code("hello")


def test_profile_tables_carry_their_source() -> None:
    tables = parse_profile_codes(PROFILE, "test")
    assert tables == {
        "esp": {"5123": Described("Wheel speed sensor, front left", "invented for the test")}
    }


def test_a_profile_without_code_tables_has_none() -> None:
    assert parse_profile_codes(PROFILE.split("[codes")[0], "test") == {}


@pytest.mark.parametrize(
    "extra",
    [
        '\n[codes.radio."5123"]\ntext = "x"\nsource = "y"\n',
        '\n[codes.esp."9003"]\ntext = "x"\n',
        '\n[codes.esp."9003"]\ntext = "x"\nsource = ""\n',
        '\n[codes.esp."zz"]\ntext = "x"\nsource = "y"\n',
        '\n[codes.esp."0x9003"]\ntext = "x"\nsource = "y"\n',
    ],
)
def test_bad_profile_tables_are_refused(extra: str) -> None:
    with pytest.raises(CodeNameError):
        parse_profile_codes(PROFILE + extra, "test")


def test_the_profile_table_wins_over_imported_names(tmp_path: Path) -> None:
    names = tmp_path / "names.json"
    names.write_text(
        json.dumps(names_document("defs.pdx", "esp", {"5123": "imported", "9003": "other"}, {}))
    )
    lookup = CodeNames({}, parse_profile_codes(PROFILE, "t"), [load_names_file(names)])
    first = lookup.unit_code("esp", "5123")
    second = lookup.unit_code("esp", "9003")
    assert first is not None and first.text == "Wheel speed sensor, front left"
    assert second == Described("other", "imported from defs.pdx")
    assert lookup.unit_code("esp", "1111") is None
    assert lookup.generic_code("5123") is None


def test_a_names_file_must_be_one_the_tool_wrote(tmp_path: Path) -> None:
    other = tmp_path / "other.json"
    other.write_text('{"kind": "scan"}')
    with pytest.raises(CodeNameError):
        load_names_file(other)
