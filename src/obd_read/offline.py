"""Commands that read saved files and never touch an adapter: compare, describe, import-names."""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path

from .codenames import (
    CodeNameError,
    CodeNames,
    Described,
    NamesFile,
    load_generic_titles,
    load_names_file,
    names_document,
    normalise_code,
    parse_profile_codes,
)
from .definitions import DefinitionError, read_definitions
from .profile import profile_source
from .scancompare import ScanFileError, compare_scans, load_scan, render_comparison

Printer = Callable[[str], None]

OFFLINE_COMMANDS = ("compare", "describe", "import-names")


def add_offline_commands(commands: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """Register the saved-file commands on the CLI's subcommand group."""
    compare = commands.add_parser(
        "compare",
        help="compare two saved scans",
        description="Report, per unit, which fault codes appeared, cleared or changed status, "
        "and which units started or stopped answering.",
    )
    compare.add_argument("first", type=Path, help="the earlier scan (.json from scan --output)")
    compare.add_argument("second", type=Path, help="the later scan")

    describe = commands.add_parser(
        "describe",
        help="name fault codes from a saved scan or given on the command line",
        description="Each item is a saved scan, or a fault code: an SAE code such as P0420 "
        "(generic list) or hexadecimal bytes with --unit (the profile's table, then --names).",
    )
    describe.add_argument("items", nargs="*", help="saved scan files and fault codes")
    describe.add_argument(
        "--profile", help="profile name or path; a scan's own profile is used when omitted"
    )
    describe.add_argument("--unit", help="the unit that reported the hexadecimal codes given")
    describe.add_argument(
        "--names", type=Path, action="append", default=[], help="a file from import-names"
    )
    describe.add_argument(
        "--request", action="append", default=[], metavar="HEX", help="name a request, from --names"
    )

    importer = commands.add_parser(
        "import-names",
        help="import code and request names from a definition file you supply",
        description="Read fault-code texts and request names from an ODX file, a PDX archive or "
        "the JSON Trafo (CaesarSuite) writes for a CBF file, and save them for one unit. "
        "Nothing from the file is kept anywhere else.",
    )
    importer.add_argument("file", type=Path, help=".odx, .odx-d, .xml, .pdx or Trafo .json")
    importer.add_argument("--unit", required=True, help="the profile unit these names belong to")
    importer.add_argument("--output", type=Path, required=True, help="new names file to write")
    importer.add_argument(
        "--variant", help="read only the diagnostic layer or variant of this name"
    )


def _code_names(profile: str | None, names_files: list[Path]) -> tuple[CodeNames, list[NamesFile]]:
    profile_codes = {}
    if profile is not None:
        text, where = profile_source(profile)
        profile_codes = parse_profile_codes(text, where)
    imported = [load_names_file(path) for path in names_files]
    return CodeNames(load_generic_titles(), profile_codes, imported), imported


def _line(text: str | None, described: Described | None) -> str:
    if described is None:
        return f"{text}: no description known"
    return f"{text}: {described.text}  [{described.source}]"


def _describe_scan(path: Path, profile: str | None, names_files: list[Path], out: Printer) -> None:
    scan = load_scan(path)
    names, _ = _code_names(profile or scan.profile, names_files)
    out(f"{path} (taken {scan.taken}, profile {scan.profile})")
    for unit in scan.units.values():
        if unit.faults is None:
            continue
        for code, statuses in unit.faults.items():
            label = f"{unit.name} {code} status {'/'.join(statuses)}"
            out(f"  {_line(label, names.unit_code(unit.name, code))}")


def run_offline(args: argparse.Namespace, out: Printer) -> int:
    """Run one saved-file command and return its exit status."""
    try:
        if args.command == "compare":
            first, second = load_scan(args.first), load_scan(args.second)
            for line in render_comparison(first, second, compare_scans(first, second)):
                out(line)
            return 0
        if args.command == "describe":
            return _describe(args, out)
        return _import_names(args, out)
    except (ScanFileError, CodeNameError, DefinitionError) as error:
        out(f"error: {error}")
        return 1


def _describe(args: argparse.Namespace, out: Printer) -> int:
    if not args.items and not args.request:
        raise CodeNameError("give a scan file, a fault code or --request")
    for item in args.items:
        path = Path(item)
        if path.is_file():
            _describe_scan(path, args.profile, args.names, out)
            continue
        names, _ = _code_names(args.profile, args.names)
        key = normalise_code(item)
        if args.unit is None:
            out(_line(key, names.generic_code(key)))
        else:
            out(_line(f"{args.unit} {key}", names.unit_code(args.unit, key)))
    if args.request:
        if args.unit is None:
            raise CodeNameError("--request needs --unit")
        _, imported = _code_names(None, args.names)
        for request in args.request:
            key = request.replace(" ", "").upper()
            label = next(
                (
                    file.values[args.unit][key]
                    for file in imported
                    if key in file.values.get(args.unit, {})
                ),
                None,
            )
            out(f"{args.unit} {key}: {label or 'no name known'}")
    return 0


def _import_names(args: argparse.Namespace, out: Printer) -> int:
    definitions = read_definitions(args.file, args.variant)
    document = names_document(args.file.name, args.unit, definitions.codes, definitions.values)
    try:
        with args.output.open("x", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
    except FileExistsError as error:
        raise CodeNameError(f"{args.output} already exists; choose a new file") from error
    out(f"read {len(definitions.codes)} fault codes and {len(definitions.values)} requests")
    for line in [*definitions.conflicts, *definitions.skipped]:
        out(f"note: {line}")
    out(f"wrote {args.output}; it holds names from {args.file.name} and must not be published")
    return 0
