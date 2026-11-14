"""Compare two saved scans: which units answered, which fault codes appeared, cleared or changed."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


class ScanFileError(Exception):
    """A file is not a scan written by `obd-read scan --output` or `obd-read clear --save`."""


@dataclass(frozen=True)
class SavedUnit:
    """One unit's entry in a saved scan, reduced to what a comparison needs."""

    name: str
    answered: bool
    faults: dict[str, tuple[str, ...]] | None
    freeze_frames: dict[str, str]
    identification: dict[str, str]


@dataclass(frozen=True)
class SavedScan:
    """A saved scan: when it was taken, with which profile, and each unit's entry."""

    path: Path
    taken: str
    profile: str
    units: dict[str, SavedUnit]


@dataclass
class UnitChange:
    """Everything that differs for one unit between two scans."""

    unit: str
    presence: str | None = None
    answering: str | None = None
    faults_note: str | None = None
    appeared: list[str] = field(default_factory=list)
    cleared: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    freeze_changed: list[str] = field(default_factory=list)
    identification_changed: list[str] = field(default_factory=list)

    @property
    def any(self) -> bool:
        return bool(
            self.presence
            or self.answering
            or self.faults_note
            or self.appeared
            or self.cleared
            or self.changed
            or self.freeze_changed
            or self.identification_changed
        )


def _mapping(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ScanFileError(f"{where}: expected an object")
    return {str(key): item for key, item in value.items()}


def _text(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise ScanFileError(f"{where}: expected text")
    return value


def _parse_unit(entry: object, where: str) -> SavedUnit:
    data = _mapping(entry, where)
    answered = data.get("answered")
    if not isinstance(answered, bool):
        raise ScanFileError(f"{where}: answered must be true or false")
    faults: dict[str, tuple[str, ...]] | None = None
    raw_faults = data.get("faults")
    if raw_faults is not None:
        if not isinstance(raw_faults, list):
            raise ScanFileError(f"{where}: faults must be a list or null")
        grouped: dict[str, list[str]] = {}
        for index, item in enumerate(raw_faults):
            fault = _mapping(item, f"{where} fault {index}")
            code = _text(fault.get("code"), f"{where} fault {index} code")
            status = _text(fault.get("status"), f"{where} fault {index} status")
            grouped.setdefault(code, []).append(status)
        faults = {code: tuple(sorted(statuses)) for code, statuses in grouped.items()}
    frames = {
        code: _text(frame, f"{where} freeze frame {code}")
        for code, frame in _mapping(data.get("freeze_frames", {}), f"{where} freeze_frames").items()
    }
    identification = {
        label: _text(_mapping(value, f"{where} identification {label}").get("hex"), label)
        for label, value in _mapping(
            data.get("identification", {}), f"{where} identification"
        ).items()
    }
    return SavedUnit(
        _text(data.get("unit"), f"{where} unit"), answered, faults, frames, identification
    )


def parse_scan(text: str, path: Path) -> SavedScan:
    """Read a saved scan from its JSON text. Raises ScanFileError when it is not one."""
    where = str(path)
    try:
        data = _mapping(json.loads(text), where)
    except json.JSONDecodeError as error:
        raise ScanFileError(f"{where}: {error}") from error
    if data.get("tool") != "obd-read":
        raise ScanFileError(f"{where}: not an obd-read scan (no tool field)")
    raw_units = data.get("units")
    if not isinstance(raw_units, list):
        raise ScanFileError(f"{where}: units must be a list")
    units: dict[str, SavedUnit] = {}
    for index, entry in enumerate(raw_units):
        unit = _parse_unit(entry, f"{where} unit {index}")
        if unit.name in units:
            raise ScanFileError(f"{where}: unit {unit.name} appears twice")
        units[unit.name] = unit
    profile = _mapping(data.get("profile"), f"{where} profile")
    return SavedScan(
        path, _text(data.get("taken"), f"{where} taken"), _text(profile.get("name"), where), units
    )


def load_scan(path: Path) -> SavedScan:
    """Read a saved scan file. Raises ScanFileError when it is missing or not a scan."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ScanFileError(f"{path}: {error}") from error
    return parse_scan(text, path)


def _statuses(statuses: tuple[str, ...]) -> str:
    return "/".join(statuses)


def _compare_unit(name: str, before: SavedUnit, after: SavedUnit) -> UnitChange:
    change = UnitChange(name)
    if before.answered != after.answered:
        change.answering = "started answering" if after.answered else "stopped answering"
    if before.faults is None or after.faults is None:
        if (before.faults is None) != (after.faults is None):
            side = "first" if before.faults is None else "second"
            change.faults_note = f"fault codes were not read in the {side} scan"
        elif before.answered or after.answered:
            change.faults_note = "fault codes were not read in either scan"
    else:
        for code, statuses in after.faults.items():
            if code not in before.faults:
                change.appeared.append(f"{code} (status {_statuses(statuses)})")
            elif before.faults[code] != statuses:
                change.changed.append(
                    f"{code}: status {_statuses(before.faults[code])} -> {_statuses(statuses)}"
                )
        for code, statuses in before.faults.items():
            if code not in after.faults:
                change.cleared.append(f"{code} (status {_statuses(statuses)})")
        for code, frame in after.freeze_frames.items():
            earlier = before.freeze_frames.get(code)
            if earlier is not None and earlier != frame and code in before.faults:
                change.freeze_changed.append(f"{code}: {earlier} -> {frame}")
    for label in sorted(before.identification.keys() | after.identification.keys()):
        old = before.identification.get(label)
        new = after.identification.get(label)
        if old != new:
            change.identification_changed.append(f"{label}: {old or 'absent'} -> {new or 'absent'}")
    return change


def compare_scans(before: SavedScan, after: SavedScan) -> list[UnitChange]:
    """Per unit, what differs between two scans. Units with no difference are omitted.

    Units are ordered as in the first scan, then those only in the second. Fault codes are
    compared only when both scans read them for the unit, and a code's freeze frame only when
    both scans hold one for it.
    """
    names = [*before.units, *(name for name in after.units if name not in before.units)]
    changes: list[UnitChange] = []
    for name in names:
        old, new = before.units.get(name), after.units.get(name)
        if old is None or new is None:
            changes.append(
                UnitChange(
                    name,
                    presence="only in the second scan" if old is None else "only in the first scan",
                )
            )
            continue
        change = _compare_unit(name, old, new)
        if change.any:
            changes.append(change)
    return changes


def render_comparison(before: SavedScan, after: SavedScan, changes: list[UnitChange]) -> list[str]:
    """The comparison as plain text lines."""
    lines = [
        f"first scan:  {before.path} (taken {before.taken}, profile {before.profile})",
        f"second scan: {after.path} (taken {after.taken}, profile {after.profile})",
    ]
    if before.profile != after.profile:
        lines.append("note: the scans used different profiles, so unit names may not line up")
    if not changes:
        lines.append("no differences")
        return lines
    for change in changes:
        lines.append(f"{change.unit}:")
        if change.presence:
            lines.append(f"  unit {change.presence}")
        if change.answering:
            lines.append(f"  {change.answering}")
        if change.faults_note:
            lines.append(f"  {change.faults_note}")
        for label, items in (
            ("appeared", change.appeared),
            ("cleared", change.cleared),
            ("changed", change.changed),
            ("freeze frame changed", change.freeze_changed),
            ("identification changed", change.identification_changed),
        ):
            for item in items:
                lines.append(f"  {label}: {item}")
    return lines
