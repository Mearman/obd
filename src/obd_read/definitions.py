"""Read code and value names from diagnostic definition files the user supplies.

Nothing here ships a maker's data: every function reads a file at run time and returns what that file says. Two forms are understood:

- ODX (ISO 22901-1), as a single XML file or inside a PDX archive: DTC entries give fault-code texts, and a DIAG-SERVICE whose request is made of constant bytes gives a name for that request.
- The JSON written by Trafo from CaesarSuite (MIT, https://github.com/jglim/CaesarSuite), which converts a Mercedes CBF file to JSON: its `DTCs` give fault-code texts and its `DiagServices` give names for their request bytes. `obd-read` does not read CBF directly and does not depend on CaesarSuite.
"""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

from .codenames import CodeNameError, normalise_code

# A PDX member larger than this is refused rather than inflated into memory.
MAX_MEMBER_BYTES = 256 * 1024 * 1024

ODX_LAYERS = frozenset(
    {"BASE-VARIANT", "ECU-VARIANT", "PROTOCOL", "FUNCTIONAL-GROUP", "ECU-SHARED-DATA"}
)
ODX_SUFFIXES = (".odx", ".odx-d", ".odx-c", ".odx-v", ".xml")


class DefinitionError(Exception):
    """A definition file cannot be read or is not in a form this tool understands."""


@dataclass
class Definitions:
    """Names read from one definition file."""

    codes: dict[str, str] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)

    def add_code(self, code: str, text: str) -> None:
        self._add(self.codes, code, text, "fault code")

    def add_value(self, request: str, name: str) -> None:
        self._add(self.values, request, name, "request")

    def _add(self, table: dict[str, str], key: str, text: str, kind: str) -> None:
        text = " ".join(text.split())
        if not text:
            self.skipped.append(f"{kind} {key}: no text")
        elif key not in table:
            table[key] = text
        elif table[key] != text:
            self.conflicts.append(f"{kind} {key}: kept {table[key]!r}, ignored {text!r}")


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def _child(element: ElementTree.Element, name: str) -> ElementTree.Element | None:
    return next((item for item in element if _local(item.tag) == name), None)


def _child_text(element: ElementTree.Element, name: str) -> str:
    found = _child(element, name)
    return "" if found is None or found.text is None else found.text.strip()


def _hex_key(request: bytes) -> str:
    return request.hex().upper()


def _code_key(raw: str, definitions: Definitions, where: str) -> str | None:
    try:
        return normalise_code(raw)
    except CodeNameError:
        definitions.skipped.append(f"{where}: code {raw!r} is not hexadecimal or an SAE code")
        return None


def _odx_roots(path: Path) -> list[ElementTree.Element]:
    if path.suffix.lower() == ".pdx":
        try:
            with zipfile.ZipFile(path) as archive:
                members = [
                    info
                    for info in archive.infolist()
                    if info.filename.lower().endswith(ODX_SUFFIXES)
                ]
                if not members:
                    raise DefinitionError(f"{path}: the archive holds no ODX files")
                return [_parse_xml(_read_member(archive, info), info.filename) for info in members]
        except zipfile.BadZipFile as error:
            raise DefinitionError(f"{path}: not a zip archive: {error}") from error
    try:
        data = path.read_bytes()
    except OSError as error:
        raise DefinitionError(f"{path}: {error}") from error
    return [_parse_xml(data, str(path))]


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    if info.file_size > MAX_MEMBER_BYTES:
        raise DefinitionError(f"{info.filename}: larger than {MAX_MEMBER_BYTES} bytes")
    return archive.read(info)


def _parse_xml(data: bytes, where: str) -> ElementTree.Element:
    # A definition file has no need of entities; refusing them rules out expansion attacks.
    if b"<!ENTITY" in data:
        raise DefinitionError(f"{where}: entity declarations are not accepted")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as error:
        raise DefinitionError(f"{where}: {error}") from error


def _odx_requests(roots: list[ElementTree.Element]) -> dict[str, bytes]:
    """Each REQUEST's constant bytes by its ID, for requests made only of whole constant bytes."""
    requests: dict[str, bytes] = {}
    for root in roots:
        for request in root.iter():
            if _local(request.tag) != "REQUEST" or "ID" not in request.attrib:
                continue
            params = _child(request, "PARAMS")
            if params is None:
                continue
            placed: dict[int, int] = {}
            whole = True
            for param in params:
                coded = _child_text(param, "CODED-VALUE")
                length = _child(param, "DIAG-CODED-TYPE")
                position = _child_text(param, "BYTE-POSITION")
                bits = "" if length is None else _child_text(length, "BIT-LENGTH")
                if not (coded.isdigit() and position.isdigit() and bits == "8"):
                    whole = False
                    break
                if int(coded) > 0xFF:
                    whole = False
                    break
                placed[int(position)] = int(coded)
            if whole and placed and sorted(placed) == list(range(len(placed))):
                requests[request.attrib["ID"]] = bytes(placed[i] for i in range(len(placed)))
    return requests


def read_odx(path: Path, variant: str | None = None) -> Definitions:
    """Fault-code texts and request names from an ODX file or PDX archive.

    With `variant`, only the diagnostic layer whose SHORT-NAME matches is read; otherwise every
    layer is, and differing texts for the same code are reported as conflicts, first kept.
    Raises DefinitionError when the file cannot be parsed or no layer matches `variant`.
    """
    roots = _odx_roots(path)
    requests = _odx_requests(roots)
    definitions = Definitions()
    layers = [
        layer
        for root in roots
        for layer in root.iter()
        if _local(layer.tag) in ODX_LAYERS
        and (variant is None or _child_text(layer, "SHORT-NAME") == variant)
    ]
    if not layers:
        raise DefinitionError(
            f"{path}: no diagnostic layer{f' named {variant}' if variant else ''}"
        )
    for layer in layers:
        layer_name = _child_text(layer, "SHORT-NAME") or "unnamed layer"
        for item in layer.iter():
            name = _local(item.tag)
            if name == "DTC":
                raw = _child_text(item, "TROUBLE-CODE")
                try:
                    number = int(raw, 0)
                except ValueError:
                    definitions.skipped.append(
                        f"{layer_name}: trouble code {raw!r} is not a number"
                    )
                    continue
                key = _code_key(f"{number:X}", definitions, layer_name)
                if key is not None:
                    text = _child_text(item, "TEXT") or _child_text(item, "SHORT-NAME")
                    definitions.add_code(key, text)
            elif name == "DIAG-SERVICE":
                reference = _child(item, "REQUEST-REF")
                request = (
                    None if reference is None else requests.get(reference.attrib.get("ID-REF", ""))
                )
                if request is not None:
                    label = _child_text(item, "LONG-NAME") or _child_text(item, "SHORT-NAME")
                    definitions.add_value(_hex_key(request), label)
    return definitions


def _text_field(entry: object, key: str) -> str | None:
    if not isinstance(entry, dict):
        return None
    value = entry.get(key)
    return value if isinstance(value, str) else None


def read_trafo(path: Path, variant: str | None = None) -> Definitions:
    """Fault-code texts and request names from the JSON Trafo writes for a CBF file.

    With `variant`, only the variant of that name is read. Raises DefinitionError when the
    file is not that JSON or no variant matches.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise DefinitionError(f"{path}: {error}") from error
    variants = data.get("Variants") if isinstance(data, dict) else None
    if not isinstance(variants, list):
        raise DefinitionError(f"{path}: not Trafo output (no Variants list)")
    chosen = [
        entry
        for entry in variants
        if variant is None or _text_field(entry, "VariantName") == variant
    ]
    if not chosen:
        names = ", ".join(filter(None, (_text_field(entry, "VariantName") for entry in variants)))
        raise DefinitionError(f"{path}: no variant named {variant}; it has {names}")
    definitions = Definitions()
    for entry in chosen:
        where = _text_field(entry, "VariantName") or "unnamed variant"
        body = entry if isinstance(entry, dict) else {}
        for dtc in _list(body.get("DTCs")):
            raw, text = _text_field(dtc, "Code"), _text_field(dtc, "Desc")
            if raw is None or text is None:
                definitions.skipped.append(f"{where}: a DTC entry has no Code or Desc")
                continue
            key = _code_key(raw, definitions, where)
            if key is not None:
                definitions.add_code(key, text)
        for service in _list(body.get("DiagServices")):
            request = _text_field(service, "RequestBytes")
            label = _text_field(service, "Desc") or _text_field(service, "DiagServiceName")
            if request is None or label is None:
                continue
            compact = re.sub(r"\s+", "", request).upper()
            if re.fullmatch(r"(?:[0-9A-F]{2})+", compact):
                definitions.add_value(compact, label)
    return definitions


def _list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def read_definitions(path: Path, variant: str | None = None) -> Definitions:
    """Read a definition file, choosing the reader by its suffix: .json is Trafo, the rest ODX."""
    if path.suffix.lower() == ".json":
        return read_trafo(path, variant)
    if path.suffix.lower() == ".cbf":
        raise DefinitionError(
            f"{path}: CBF files are not read directly; convert one with Trafo from CaesarSuite "
            "and pass the JSON it writes"
        )
    return read_odx(path, variant)
