"""Names for fault codes: the open generic list, per-profile tables and imported name files.

Three sources, each reported with where its text came from:

- the generic OBD-II code titles shipped in `data/obdex-generic.tsv`, for codes in the SAE form such as P0420;
- `[codes.<unit>."<hex>"]` tables in a profile, each entry carrying its own `source`;
- a names file written by `obd-read import-names` from a definition file the user supplied.

Nothing here invents text: a code with no entry is reported as having none.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

GENERIC_SOURCE = "OBDex generic code list, CC0 (https://github.com/foerbsnavi/OBDex)"
NAMES_FILE_KIND = "names"

_SAE_CODE = re.compile(r"^[PBCU][0-3][0-9A-F]{3}$")
_HEX_CODE = re.compile(r"^[0-9A-Fa-f]{1,6}$")


class CodeNameError(Exception):
    """A code table or names file is malformed."""


@dataclass(frozen=True)
class Described:
    """A code's text and where it came from."""

    text: str
    source: str


def normalise_code(code: str) -> str:
    """The key a code is stored under: SAE codes upper-cased, hexadecimal codes as at least 4 digits.

    Raises CodeNameError when the code is neither form.
    """
    candidate = code.strip()
    if _SAE_CODE.match(candidate.upper()):
        return candidate.upper()
    if _HEX_CODE.match(candidate):
        return f"{int(candidate, 16):04X}"
    raise CodeNameError(f"{code!r} is neither an SAE code such as P0420 nor hexadecimal bytes")


def load_generic_titles() -> dict[str, str]:
    """The shipped generic code titles, keyed by SAE code."""
    text = resources.files("obd_read").joinpath("data/obdex-generic.tsv").read_text("utf-8")
    titles: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        code, _, title = line.partition("\t")
        titles[code] = title
    return titles


def parse_profile_codes(text: str, where: str) -> dict[str, dict[str, Described]]:
    """The per-unit code tables of a profile, keyed by unit then normalised code.

    Every entry needs `text` and `source`, and the unit must be one the profile defines.
    Raises CodeNameError otherwise. A profile with no `codes` table gives an empty result.
    """
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise CodeNameError(f"{where}: {error}") from error
    tables = data.get("codes", {})
    units = data.get("units", {})
    if not isinstance(tables, dict) or not isinstance(units, dict):
        raise CodeNameError(f"{where}: codes and units must be tables")
    result: dict[str, dict[str, Described]] = {}
    for unit, entries in tables.items():
        if unit not in units:
            raise CodeNameError(f"{where}: [codes.{unit}] names a unit the profile does not define")
        if not isinstance(entries, dict):
            raise CodeNameError(f"{where}: [codes.{unit}] must be a table")
        named: dict[str, Described] = {}
        for code, entry in entries.items():
            section = f"{where} [codes.{unit}.{code}]"
            if not isinstance(entry, dict):
                raise CodeNameError(f"{section}: must be a table with text and source")
            description, source = entry.get("text"), entry.get("source")
            if not isinstance(description, str) or not isinstance(source, str) or not source:
                raise CodeNameError(f"{section}: needs text and a non-empty source, both strings")
            key = normalise_code(code)
            if key in named:
                raise CodeNameError(f"{section}: duplicates another entry for {key}")
            named[key] = Described(description, source)
        result[unit] = named
    return result


@dataclass(frozen=True)
class NamesFile:
    """Names imported from a definition file: fault-code texts and data-value names per unit."""

    source: str
    codes: dict[str, dict[str, Described]] = field(default_factory=dict)
    values: dict[str, dict[str, str]] = field(default_factory=dict)


def names_document(
    source: str, unit: str, codes: dict[str, str], values: dict[str, str]
) -> dict[str, object]:
    """The saved form of an import for one unit, as written by `obd-read import-names`."""
    return {
        "tool": "obd-read",
        "kind": NAMES_FILE_KIND,
        "source": source,
        "units": {
            unit: {"codes": dict(sorted(codes.items())), "values": dict(sorted(values.items()))}
        },
    }


def load_names_file(path: Path) -> NamesFile:
    """Read a names file. Raises CodeNameError when it is missing or malformed."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CodeNameError(f"{path}: {error}") from error
    if not isinstance(data, dict) or data.get("kind") != NAMES_FILE_KIND:
        raise CodeNameError(f"{path}: not a names file written by obd-read import-names")
    source = data.get("source")
    units = data.get("units")
    if not isinstance(source, str) or not isinstance(units, dict):
        raise CodeNameError(f"{path}: needs a source and a units object")
    codes: dict[str, dict[str, Described]] = {}
    values: dict[str, dict[str, str]] = {}
    for unit, body in units.items():
        if not isinstance(body, dict):
            raise CodeNameError(f"{path}: unit {unit} must be an object")
        raw_codes, raw_values = body.get("codes", {}), body.get("values", {})
        if not isinstance(raw_codes, dict) or not isinstance(raw_values, dict):
            raise CodeNameError(f"{path}: unit {unit} codes and values must be objects")
        codes[unit] = {}
        for code, text in raw_codes.items():
            if not isinstance(text, str):
                raise CodeNameError(f"{path}: unit {unit} code {code} must have text")
            codes[unit][normalise_code(code)] = Described(text, f"imported from {source}")
        values[unit] = {name: label for name, label in raw_values.items() if isinstance(label, str)}
    return NamesFile(source, codes, values)


class CodeNames:
    """Looks a code up in the sources that apply, most specific first."""

    def __init__(
        self,
        generic: dict[str, str],
        profile_codes: dict[str, dict[str, Described]],
        imported: list[NamesFile],
    ) -> None:
        self._generic = generic
        self._profile_codes = profile_codes
        self._imported = imported

    def unit_code(self, unit: str, code: str) -> Described | None:
        """The text for a code a unit reported: the profile's table first, then imported names."""
        key = normalise_code(code)
        if (found := self._profile_codes.get(unit, {}).get(key)) is not None:
            return found
        for names in self._imported:
            if (found := names.codes.get(unit, {}).get(key)) is not None:
                return found
        return None

    def generic_code(self, code: str) -> Described | None:
        """The generic OBD-II title for an SAE code such as P0420."""
        title = self._generic.get(normalise_code(code))
        return None if title is None else Described(title, GENERIC_SOURCE)
