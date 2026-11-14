"""Vehicle profiles: the bus settings and control-unit addresses for one chassis."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from .guard import READ_ONLY, DiagProtocol


class ProfileError(Exception):
    """A profile file is missing, malformed or asks for something this tool will not send."""


@dataclass(frozen=True)
class Unit:
    """One control unit: where to send requests and where its replies come from."""

    name: str
    description: str
    request_id: int
    response_id: int
    source: str


@dataclass(frozen=True)
class Profile:
    """Everything needed to talk to one chassis."""

    name: str
    description: str
    status: str
    id_bits: int
    bitrate: int
    protocol: DiagProtocol
    session: int
    units: dict[str, Unit]

    def unit(self, name: str) -> Unit:
        """Look a unit up by name. Raises ProfileError listing the names when it is absent."""
        if name not in self.units:
            raise ProfileError(
                f"profile {self.name} has no unit {name!r}; it has {', '.join(self.units)}"
            )
        return self.units[name]


def builtin_profiles() -> list[str]:
    """Names of the profiles shipped with the package."""
    return sorted(
        entry.name.removesuffix(".toml")
        for entry in resources.files("obd_read.profiles").iterdir()
        if entry.name.endswith(".toml")
    )


def _field(table: dict[str, Any], key: str, kind: type, where: str) -> Any:
    if key not in table:
        raise ProfileError(f"{where}: missing {key}")
    value = table[key]
    if not isinstance(value, kind) or isinstance(value, bool):
        raise ProfileError(f"{where}: {key} must be {kind.__name__}, got {value!r}")
    return value


def parse_profile(text: str, where: str) -> Profile:
    """Build a Profile from TOML text. `where` names the source in error messages.

    Raises ProfileError for a missing or mistyped field, an identifier width or bit rate that is not valid CAN,
    or a diagnostic session the guard does not allow.
    """
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ProfileError(f"{where}: {error}") from error
    bus = _field(data, "bus", dict, where)
    diagnostics = _field(data, "diagnostics", dict, where)
    id_bits = _field(bus, "id_bits", int, f"{where} [bus]")
    bitrate = _field(bus, "bitrate", int, f"{where} [bus]")
    if id_bits not in (11, 29):
        raise ProfileError(f"{where}: id_bits must be 11 or 29, got {id_bits}")
    if bitrate <= 0:
        raise ProfileError(f"{where}: bitrate must be positive, got {bitrate}")
    protocol_name = _field(diagnostics, "protocol", str, f"{where} [diagnostics]")
    if protocol_name not in (DiagProtocol.KWP2000.value, DiagProtocol.UDS.value):
        raise ProfileError(f"{where}: protocol must be kwp2000 or uds, got {protocol_name!r}")
    protocol = DiagProtocol(protocol_name)
    session = _field(diagnostics, "session", int, f"{where} [diagnostics]")
    allowed_sessions = READ_ONLY[protocol][0x10]
    if allowed_sessions is not None and session not in allowed_sessions:
        raise ProfileError(f"{where}: diagnostic session {session:#04x} is not a read-only session")
    units: dict[str, Unit] = {}
    for name, table in _field(data, "units", dict, where).items():
        section = f"{where} [units.{name}]"
        if not isinstance(table, dict):
            raise ProfileError(f"{section}: must be a table")
        units[name] = Unit(
            name=name,
            description=_field(table, "description", str, section),
            request_id=_field(table, "request", int, section),
            response_id=_field(table, "response", int, section),
            source=_field(table, "source", str, section),
        )
    if not units:
        raise ProfileError(f"{where}: no units")
    return Profile(
        name=_field(data, "name", str, where),
        description=_field(data, "description", str, where),
        status=_field(data, "status", str, where),
        id_bits=id_bits,
        bitrate=bitrate,
        protocol=protocol,
        session=session,
        units=units,
    )


def profile_source(name_or_path: str) -> tuple[str, str]:
    """Find a shipped profile by name, or any profile by file path.

    Returns (TOML text, label for error messages). Raises ProfileError when neither exists.
    """
    path = Path(name_or_path)
    if path.suffix == ".toml" or path.exists():
        if not path.is_file():
            raise ProfileError(f"no profile file at {path}")
        return path.read_text(encoding="utf-8"), str(path)
    if name_or_path not in builtin_profiles():
        raise ProfileError(
            f"no profile named {name_or_path!r}; shipped profiles: {', '.join(builtin_profiles())}"
        )
    resource = resources.files("obd_read.profiles").joinpath(f"{name_or_path}.toml")
    return resource.read_text(encoding="utf-8"), name_or_path


def load_profile(name_or_path: str) -> Profile:
    """Load a shipped profile by name, or any profile by file path.

    Raises ProfileError when neither exists or the file is invalid.
    """
    text, where = profile_source(name_or_path)
    return parse_profile(text, where)
