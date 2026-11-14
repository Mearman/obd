"""Validation of a vehicle profile beyond what loading needs, without connecting to anything."""

from __future__ import annotations

import argparse
import re
import tomllib
from collections.abc import Callable

from .profile import VALUE_KEYS, ProfileError, parse_profile, profile_source

PROFILE_KEYS = frozenset({"name", "description", "status", "bus", "diagnostics", "units"})
BUS_KEYS = frozenset({"id_bits", "bitrate"})
DIAGNOSTICS_KEYS = frozenset({"protocol", "session"})
UNIT_KEYS = frozenset({"description", "request", "response", "source", "values"})
STATUSES = frozenset({"confirmed", "unconfirmed"})
NAME = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
MAX_ID = {11: 0x7FF, 29: 0x1FFFFFFF}


def check_profile(text: str, where: str) -> list[str]:
    """List everything wrong with a profile's TOML text; an empty list means it is sound.

    Covers what loading rejects, and also unknown keys (a misspelt optional-looking key is otherwise silently ignored), a status other than confirmed or unconfirmed, a name that is not lower-case words joined by hyphens, blank descriptions and sources, identifiers wider than the bus allows, a unit whose request and response identifiers are the same, and any identifier shared by two units, which makes a reply impossible to attribute. For named values: unknown keys, a status other than confirmed or unconfirmed, a blank source and a zero scale.
    """
    try:
        profile = parse_profile(text, where)
    except ProfileError as error:
        return [str(error)]
    data = tomllib.loads(text)
    problems: list[str] = []

    def unknown(table: dict[str, object], allowed: frozenset[str], label: str) -> None:
        for key in sorted(set(table) - allowed):
            problems.append(f"{label}: unknown key {key}")

    unknown(data, PROFILE_KEYS, "profile")
    unknown(data["bus"], BUS_KEYS, "[bus]")
    unknown(data["diagnostics"], DIAGNOSTICS_KEYS, "[diagnostics]")
    for name, table in data["units"].items():
        unknown(table, UNIT_KEYS, f"[units.{name}]")
        for value_name, value_table in table.get("values", {}).items():
            unknown(value_table, VALUE_KEYS, f"[units.{name}.values.{value_name}]")
    if profile.status not in STATUSES:
        problems.append(f"status must be confirmed or unconfirmed, got {profile.status!r}")
    if not NAME.fullmatch(profile.name):
        problems.append(f"name {profile.name!r} must be lower-case words joined by hyphens")
    if not profile.description.strip():
        problems.append("description is blank")

    for unit in profile.units.values():
        for named in unit.values.values():
            label = f"[units.{unit.name}.values.{named.name}]"
            if named.status not in STATUSES:
                problems.append(f"{label}: status must be confirmed or unconfirmed")
            if not named.source.strip():
                problems.append(f"{label}: source is blank, so the identifier cannot be traced")
            if named.scale == 0:
                problems.append(f"{label}: scale is zero, so every reading is the bias")

    limit = MAX_ID[profile.id_bits]
    requests: dict[int, str] = {}
    responses: dict[int, str] = {}
    for unit in profile.units.values():
        label = f"[units.{unit.name}]"
        if not unit.description.strip():
            problems.append(f"{label}: description is blank")
        if not unit.source.strip():
            problems.append(f"{label}: source is blank, so the address cannot be traced")
        for kind, value in (("request", unit.request_id), ("response", unit.response_id)):
            if not 0 <= value <= limit:
                problems.append(
                    f"{label}: {kind} {value:#x} does not fit {profile.id_bits}-bit identifiers"
                )
        if unit.request_id == unit.response_id:
            problems.append(f"{label}: request and response are both {unit.request_id:#x}")
        for kind, value, seen in (
            ("request", unit.request_id, requests),
            ("response", unit.response_id, responses),
        ):
            if value in seen:
                problems.append(f"{label}: {kind} {value:#x} is also used by {seen[value]}")
            else:
                seen[value] = unit.name
    return problems


def profile_check_command(args: argparse.Namespace, out: Callable[[str], None]) -> int:
    """Check each named profile (a shipped name or a file path); the exit status is 1 on any problem."""
    status = 0
    for target in args.targets:
        try:
            text, where = profile_source(target)
        except ProfileError as error:
            out(f"{target}: {error}")
            status = 1
            continue
        problems = check_profile(text, where)
        if not problems:
            out(f"{where}: ok")
            continue
        status = 1
        out(f"{where}: {len(problems)} problem{'s' if len(problems) != 1 else ''}")
        for problem in problems:
            out(f"  {problem}")
    return status
