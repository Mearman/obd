import json
from pathlib import Path

from obd_read.cli import run

from .test_codenames import PROFILE
from .test_definitions import ODX
from .test_scancompare import unit, write


async def test_compare_command_prints_the_changes(tmp_path: Path) -> None:
    first = write(tmp_path / "a.json", unit("esp", faults=[("9003", "20")]))
    second = write(tmp_path / "b.json", unit("esp", faults=[]))
    lines: list[str] = []
    assert await run(["compare", str(first), str(second)], lines.append) == 0
    assert "esp:" in lines
    assert "  cleared: 9003 (status 20)" in lines


async def test_compare_command_reports_an_unreadable_file(tmp_path: Path) -> None:
    lines: list[str] = []
    assert (
        await run(["compare", str(tmp_path / "no.json"), str(tmp_path / "no.json")], lines.append)
        == 1
    )
    assert lines[-1].startswith("error:")


async def test_describe_a_generic_code() -> None:
    lines: list[str] = []
    assert await run(["describe", "p0420"], lines.append) == 0
    assert lines[0].startswith("P0420: Catalyst System Efficiency Below Threshold Bank 1  [OBDex")


async def test_describe_a_scan_names_codes_and_says_when_it_cannot(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(PROFILE)
    scan = write(tmp_path / "scan.json", unit("esp", faults=[("5123", "61"), ("9003", "20")]))
    lines: list[str] = []
    assert await run(["describe", str(scan), "--profile", str(profile)], lines.append) == 0
    assert "  esp 5123 status 61: Wheel speed sensor, front left  [invented for the test]" in lines
    assert "  esp 9003 status 20: no description known" in lines


async def test_describe_a_hex_code_needs_a_unit_to_be_looked_up(tmp_path: Path) -> None:
    profile = tmp_path / "car.toml"
    profile.write_text(PROFILE)
    lines: list[str] = []
    argv = ["describe", "5123", "--unit", "esp", "--profile", str(profile)]
    assert await run(argv, lines.append) == 0
    assert lines == ["esp 5123: Wheel speed sensor, front left  [invented for the test]"]
    lines.clear()
    assert await run(["describe", "5123"], lines.append) == 0
    assert lines == ["5123: no description known"]


async def test_describe_with_nothing_to_describe_is_an_error() -> None:
    lines: list[str] = []
    assert await run(["describe"], lines.append) == 1
    assert lines[-1].startswith("error:")


async def test_import_then_describe(tmp_path: Path) -> None:
    source = tmp_path / "test.odx-d"
    source.write_text(ODX)
    names = tmp_path / "names.json"
    lines: list[str] = []
    argv = ["import-names", str(source), "--unit", "esp", "--output", str(names)]
    assert await run([*argv, "--variant", "TestVariantA"], lines.append) == 0
    assert lines[0] == "read 2 fault codes and 1 requests"
    assert "must not be published" in lines[-1]
    assert str(tmp_path) not in json.loads(names.read_text())["source"]

    lines.clear()
    assert (
        await run(
            ["import-names", str(source), "--unit", "esp", "--output", str(names)], lines.append
        )
        == 1
    )
    assert "already exists" in lines[-1]

    lines.clear()
    argv = ["describe", "5123", "--unit", "esp", "--names", str(names), "--request", "1a 86"]
    assert await run(argv, lines.append) == 0
    assert lines == [
        "esp 5123: Test sensor A fault  [imported from test.odx-d]",
        "esp 1A86: Read test part number",
    ]
