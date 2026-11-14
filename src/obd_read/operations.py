"""What the commands do with a connected adapter: read a unit, scan a car, clear a unit."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .diag import Fault, IdentField, NegativeResponse, UnitSession
from .elm import AdapterInfo, Elm, ElmError, NoResponse
from .guard import ClearToken, DiagProtocol, authorise_clear
from .kwp2000 import Kwp2000
from .profile import Profile, Unit
from .uds import Uds


class DiagClient(Protocol):
    """The requests every supported diagnostic protocol offers for one unit."""

    async def start(self) -> None: ...
    async def identification(self) -> list[IdentField]: ...
    async def faults(self) -> list[Fault]: ...
    async def freeze_frame(self, fault: Fault) -> bytes: ...
    async def clear(self, token: ClearToken) -> None: ...


@dataclass
class UnitReport:
    """What one control unit said, in plain values that serialise to JSON."""

    unit: str
    description: str
    request_id: str
    response_id: str
    answered: bool = False
    notes: list[str] = field(default_factory=list)
    identification: dict[str, dict[str, str]] = field(default_factory=dict)
    faults: list[dict[str, str]] | None = None
    freeze_frames: dict[str, str] = field(default_factory=dict)


@dataclass
class ClearOutcome:
    """The result of one clear command."""

    before: UnitReport
    cleared: bool
    after: UnitReport | None


class ClearRefused(Exception):
    """The clear command stopped before sending anything that changes the car."""


def unit_session(elm: Elm, profile: Profile, unit: Unit) -> UnitSession:
    """A guarded request channel to one unit. The unit must already be addressed."""
    return UnitSession(elm, profile.protocol, unit.response_id)


def make_client(elm: Elm, profile: Profile, unit: Unit) -> DiagClient:
    """The protocol client the profile names, bound to one unit."""
    session = unit_session(elm, profile, unit)
    if profile.protocol is DiagProtocol.UDS:
        return Uds(session, profile.session)
    return Kwp2000(session, profile.session)


async def read_unit(
    elm: Elm, profile: Profile, unit: Unit, *, faults: bool, freeze: bool
) -> UnitReport:
    """Address one unit and read its identification, and optionally its faults and freeze frames.

    A unit that stays silent or refuses a request is reported, not raised: the report's
    `answered` flag and `notes` say what happened.
    """
    report = UnitReport(
        unit=unit.name,
        description=unit.description,
        request_id=f"{unit.request_id:X}",
        response_id=f"{unit.response_id:X}",
    )
    await elm.address_unit(unit.request_id, unit.response_id)
    client = make_client(elm, profile, unit)
    try:
        await client.start()
        report.answered = True
    except NoResponse:
        report.notes.append("no answer to the session request")
        return report
    except NegativeResponse as refusal:
        report.answered = True
        report.notes.append(f"session request refused: {refusal}")
    except ElmError as error:
        report.notes.append(f"session request failed: {error}")
        return report

    try:
        for item in await client.identification():
            report.identification[item.label] = {"hex": item.raw.hex().upper(), "text": item.text}
    except (NegativeResponse, ElmError) as error:
        report.notes.append(f"identification not read: {error}")

    if not faults:
        return report
    try:
        stored = await client.faults()
    except (NegativeResponse, ElmError) as error:
        report.notes.append(f"fault codes not read: {error}")
        return report
    report.faults = [{"code": fault.code, "status": f"{fault.status:02X}"} for fault in stored]

    if freeze:
        for fault in stored:
            try:
                report.freeze_frames[fault.code] = (await client.freeze_frame(fault)).hex().upper()
            except NoResponse:
                report.freeze_frames[fault.code] = "no answer"
            except (NegativeResponse, ElmError) as error:
                report.freeze_frames[fault.code] = f"not read: {error}"
    return report


async def scan(elm: Elm, profile: Profile, *, faults: bool, freeze: bool) -> list[UnitReport]:
    """Read every unit in the profile, one after another."""
    return [
        await read_unit(elm, profile, unit, faults=faults, freeze=freeze)
        for unit in profile.units.values()
    ]


def document(
    profile: Profile, adapter: AdapterInfo, units: list[UnitReport], transcript: list[str]
) -> dict[str, object]:
    """The saved form of a scan or snapshot: what was read, from what, and the raw exchange."""
    return {
        "tool": "obd-read",
        "taken": datetime.now(UTC).isoformat(timespec="seconds"),
        "profile": {"name": profile.name, "status": profile.status},
        "adapter": asdict(adapter),
        "units": [asdict(unit) for unit in units],
        "transcript": transcript,
    }


def render_markdown(profile: Profile, taken: str, units: list[UnitReport]) -> str:
    """A scan as a Markdown report: one summary table, then each unit's details."""
    lines = [
        "# obd-read scan",
        "",
        f"Taken {taken} with profile `{profile.name}` (address table {profile.status}).",
        "",
        "| Unit | Answered | Fault codes |",
        "|---|---|---|",
    ]
    for unit in units:
        count = "not read" if unit.faults is None else str(len(unit.faults))
        lines.append(f"| {unit.unit} | {'yes' if unit.answered else 'no'} | {count} |")
    for unit in units:
        lines += ["", f"## {unit.unit}", "", unit.description, ""]
        lines.append(f"Request {unit.request_id}, reply {unit.response_id}.")
        for label, value in unit.identification.items():
            lines.append(f"- {label}: `{value['hex']}` ({value['text']})")
        for fault in unit.faults or []:
            frame = unit.freeze_frames.get(fault["code"])
            suffix = f", freeze frame `{frame}`" if frame else ""
            lines.append(f"- fault `{fault['code']}`, status `{fault['status']}`{suffix}")
        for note in unit.notes:
            lines.append(f"- note: {note}")
    return "\n".join(lines) + "\n"


async def clear_unit(
    elm: Elm,
    profile: Profile,
    adapter: AdapterInfo,
    unit: Unit,
    save: Path,
    confirm: Callable[[UnitReport], bool],
) -> ClearOutcome:
    """Save a unit's fault codes and freeze frames, then erase its fault codes.

    The order is fixed: read, write the snapshot to `save`, ask `confirm`, clear, read
    again. Raises ClearRefused, having sent nothing that changes the car, when `save`
    already exists or the unit's codes cannot be read. When `confirm` returns False the
    snapshot stays on disk and the outcome reports that nothing was cleared.
    """
    if save.exists():
        raise ClearRefused(f"{save} already exists; choose a new file for the snapshot")
    before = await read_unit(elm, profile, unit, faults=True, freeze=True)
    if before.faults is None:
        raise ClearRefused(
            f"could not read {unit.name}'s fault codes ({'; '.join(before.notes)}); nothing cleared"
        )
    saved = document(profile, adapter, [before], list(elm.transcript.entries))
    with save.open("x", encoding="utf-8") as snapshot:
        json.dump(saved, snapshot, indent=2)
        snapshot.write("\n")
    token = authorise_clear(save)
    if not confirm(before):
        return ClearOutcome(before=before, cleared=False, after=None)
    await make_client(elm, profile, unit).clear(token)
    after = await read_unit(elm, profile, unit, faults=True, freeze=False)
    return ClearOutcome(before=before, cleared=True, after=after)
