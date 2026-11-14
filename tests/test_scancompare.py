import json
from pathlib import Path

import pytest

from obd_read.scancompare import ScanFileError, compare_scans, load_scan, parse_scan


def unit(
    name: str,
    *,
    answered: bool = True,
    faults: list[tuple[str, str]] | None = None,
    frames: dict[str, str] | None = None,
    ident: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "unit": name,
        "answered": answered,
        "faults": None if faults is None else [{"code": c, "status": s} for c, s in faults],
        "freeze_frames": frames or {},
        "identification": {k: {"hex": v, "text": ""} for k, v in (ident or {}).items()},
    }


def write(path: Path, *units: dict[str, object], taken: str = "2026-01-01T00:00:00+00:00") -> Path:
    path.write_text(
        json.dumps(
            {
                "tool": "obd-read",
                "taken": taken,
                "profile": {"name": "test", "status": "confirmed"},
                "units": list(units),
            }
        ),
        encoding="utf-8",
    )
    return path


def test_codes_that_appeared_cleared_and_changed(tmp_path: Path) -> None:
    first = write(
        tmp_path / "a.json",
        unit("esp", faults=[("5123", "61"), ("9003", "20"), ("1111", "08")]),
    )
    second = write(
        tmp_path / "b.json",
        unit("esp", faults=[("5123", "21"), ("1111", "08"), ("2222", "40")]),
    )
    (change,) = compare_scans(load_scan(first), load_scan(second))
    assert change.appeared == ["2222 (status 40)"]
    assert change.cleared == ["9003 (status 20)"]
    assert change.changed == ["5123: status 61 -> 21"]


def test_units_that_start_and_stop_answering_or_are_missing(tmp_path: Path) -> None:
    first = write(
        tmp_path / "a.json",
        unit("engine", answered=False),
        unit("esp", faults=[]),
        unit("gone", faults=[]),
    )
    second = write(
        tmp_path / "b.json",
        unit("engine", faults=[]),
        unit("esp", answered=False),
        unit("new", faults=[]),
    )
    changes = {c.unit: c for c in compare_scans(load_scan(first), load_scan(second))}
    assert changes["engine"].answering == "started answering"
    assert changes["esp"].answering == "stopped answering"
    assert changes["gone"].presence == "only in the first scan"
    assert changes["new"].presence == "only in the second scan"


def test_identical_scans_have_no_differences(tmp_path: Path) -> None:
    scan = write(tmp_path / "a.json", unit("esp", faults=[("5123", "61")], ident={"part": "AA"}))
    assert compare_scans(load_scan(scan), load_scan(scan)) == []


def test_codes_are_not_compared_when_one_scan_did_not_read_them(tmp_path: Path) -> None:
    first = write(tmp_path / "a.json", unit("esp", faults=None))
    second = write(tmp_path / "b.json", unit("esp", faults=[("5123", "61")]))
    (change,) = compare_scans(load_scan(first), load_scan(second))
    assert change.faults_note == "fault codes were not read in the first scan"
    assert change.appeared == []


def test_freeze_frame_and_identification_changes(tmp_path: Path) -> None:
    first = write(
        tmp_path / "a.json",
        unit("esp", faults=[("5123", "61")], frames={"5123": "01"}, ident={"part": "AA"}),
    )
    second = write(
        tmp_path / "b.json",
        unit("esp", faults=[("5123", "61")], frames={"5123": "02"}, ident={"part": "BB"}),
    )
    (change,) = compare_scans(load_scan(first), load_scan(second))
    assert change.freeze_changed == ["5123: 01 -> 02"]
    assert change.identification_changed == ["part: AA -> BB"]


def test_a_repeated_code_is_compared_by_all_its_statuses() -> None:
    text = json.dumps(
        {
            "tool": "obd-read",
            "taken": "t",
            "profile": {"name": "p"},
            "units": [unit("esp", faults=[("5123", "61"), ("5123", "20")])],
        }
    )
    scan = parse_scan(text, Path("x.json"))
    assert scan.units["esp"].faults == {"5123": ("20", "61")}


@pytest.mark.parametrize(
    "text",
    ["not json", "[]", '{"tool": "other"}', '{"tool": "obd-read", "units": 3}'],
)
def test_files_that_are_not_scans_are_refused(text: str) -> None:
    with pytest.raises(ScanFileError):
        parse_scan(text, Path("x.json"))
