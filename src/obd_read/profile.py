"""Vehicle profiles: the bus settings and control-unit addresses for one chassis."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

from .guard import READ_ONLY, DiagProtocol


class ProfileError(Exception):
    """A profile file is missing, malformed or asks for something this tool will not send."""


# Keys a [units.<unit>.values.<name>] table may hold.
VALUE_KEYS = frozenset(
    {"label", "unit", "identifier", "offset", "size", "signed", "scale", "bias", "source", "status"}
)

# The widest identifier each protocol's read-by-identifier service takes: KWP2000 service 21 reads a one-byte local identifier, UDS service 22 a two-byte data identifier.
MAX_IDENTIFIER: dict[DiagProtocol, int] = {DiagProtocol.KWP2000: 0xFF, DiagProtocol.UDS: 0xFFFF}
MAX_VALUE_BYTES = 4


@dataclass(frozen=True)
class DataValue:
    """One named value a unit reports: which identifier holds it and how its bytes become a number.

    `offset` and `size` pick the bytes out of the data that follows the identifier in the reply. The number is `raw * scale + bias`, where `raw` is those bytes read big-endian, signed when `signed` is set.
    """

    name: str
    label: str
    unit: str
    identifier: int
    offset: int
    size: int
    signed: bool
    scale: float
    bias: float
    source: str
    status: str

    def decode(self, data: bytes) -> float:
        """Turn a reply's data bytes into the value. Raises ValueError when the reply is too short."""
        if len(data) < self.offset + self.size:
            raise ValueError(
                f"{self.name}: reply holds {len(data)} data bytes, "
                f"{self.offset + self.size} are needed"
            )
        raw = int.from_bytes(data[self.offset : self.offset + self.size], "big", signed=self.signed)
        return raw * self.scale + self.bias


@dataclass(frozen=True)
class Unit:
    """One control unit: where to send requests and where its replies come from."""

    name: str
    description: str
    request_id: int
    response_id: int
    source: str
    values: dict[str, DataValue] = field(default_factory=dict)


@dataclass(frozen=True)
class CanBus:
    """ISO 15765-4 CAN: identifier width and bit rate."""

    id_bits: int
    bitrate: int


@dataclass(frozen=True)
class KLineBus:
    """A K-line bus: how the adapter initialises it and the addresses in the message headers.

    For a K-line unit, `Unit.request_id` is the unit's address (it is also the address sent in a slow initialisation) and `Unit.response_id` is the address its replies come from.
    """

    scheme: str
    tester: int
    header_format: int


# The ELM327 protocol number for each K-line initialisation scheme, with the header format byte used unless the profile gives one.
KLINE_SCHEMES: dict[str, tuple[str, int]] = {
    "iso9141": ("3", 0x68),
    "kwp2000-slow": ("4", 0xC0),
    "kwp2000-fast": ("5", 0xC0),
}

# The address a tester uses on a K-line unless the profile gives one.
DEFAULT_TESTER = 0xF1


@dataclass(frozen=True)
class Profile:
    """Everything needed to talk to one chassis."""

    name: str
    description: str
    status: str
    bus: CanBus | KLineBus
    protocol: DiagProtocol
    session: int
    units: dict[str, Unit]

    @property
    def id_bits(self) -> int:
        """The CAN identifier width. Raises ProfileError for a K-line profile."""
        return self._can().id_bits

    @property
    def bitrate(self) -> int:
        """The CAN bit rate. Raises ProfileError for a K-line profile."""
        return self._can().bitrate

    def _can(self) -> CanBus:
        if not isinstance(self.bus, CanBus):
            raise ProfileError(f"profile {self.name} is a K-line profile and has no CAN settings")
        return self.bus

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


def _number(table: dict[str, Any], key: str, default: float, where: str) -> float:
    value = table.get(key, default)
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ProfileError(f"{where}: {key} must be a number, got {value!r}")
    return value


def _text(table: dict[str, Any], key: str, default: str, where: str) -> str:
    value = table.get(key, default)
    if not isinstance(value, str):
        raise ProfileError(f"{where}: {key} must be str, got {value!r}")
    return value


def _values(table: dict[str, Any], protocol: DiagProtocol, section: str) -> dict[str, DataValue]:
    values: dict[str, DataValue] = {}
    for name, entry in table.items():
        where = f"{section}.values.{name}]"
        if not isinstance(entry, dict):
            raise ProfileError(f"{where}: must be a table")
        identifier = _field(entry, "identifier", int, where)
        if not 0 <= identifier <= MAX_IDENTIFIER[protocol]:
            raise ProfileError(
                f"{where}: identifier {identifier:#x} does not fit a {protocol.value} identifier"
            )
        size = entry.get("size", 1)
        offset = entry.get("offset", 0)
        signed = entry.get("signed", False)
        if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_VALUE_BYTES:
            raise ProfileError(f"{where}: size must be 1 to {MAX_VALUE_BYTES} bytes, got {size!r}")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ProfileError(f"{where}: offset must be a whole number of bytes, got {offset!r}")
        if not isinstance(signed, bool):
            raise ProfileError(f"{where}: signed must be true or false, got {signed!r}")
        values[name] = DataValue(
            name=name,
            label=_field(entry, "label", str, where),
            unit=_text(entry, "unit", "", where),
            identifier=identifier,
            offset=offset,
            size=size,
            signed=signed,
            scale=_number(entry, "scale", 1, where),
            bias=_number(entry, "bias", 0, where),
            source=_field(entry, "source", str, where),
            status=_text(entry, "status", "unconfirmed", where),
        )
    return values


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
    bus_where = f"{where} [bus]"
    bus_settings: CanBus | KLineBus
    if "kline" in bus:
        scheme = _field(bus, "kline", str, bus_where)
        if scheme not in KLINE_SCHEMES:
            raise ProfileError(
                f"{bus_where}: kline must be one of {', '.join(KLINE_SCHEMES)}, got {scheme!r}"
            )
        bus_settings = KLineBus(
            scheme,
            _field(bus, "tester", int, bus_where) if "tester" in bus else DEFAULT_TESTER,
            _field(bus, "header_format", int, bus_where)
            if "header_format" in bus
            else KLINE_SCHEMES[scheme][1],
        )
        for value in (bus_settings.tester, bus_settings.header_format):
            if not 0 <= value <= 0xFF:
                raise ProfileError(f"{bus_where}: {value:#x} does not fit in one byte")
    else:
        id_bits = _field(bus, "id_bits", int, bus_where)
        bitrate = _field(bus, "bitrate", int, bus_where)
        if id_bits not in (11, 29):
            raise ProfileError(f"{where}: id_bits must be 11 or 29, got {id_bits}")
        if bitrate <= 0:
            raise ProfileError(f"{where}: bitrate must be positive, got {bitrate}")
        bus_settings = CanBus(id_bits, bitrate)
    protocol_name = _field(diagnostics, "protocol", str, f"{where} [diagnostics]")
    if protocol_name not in (DiagProtocol.KWP2000.value, DiagProtocol.UDS.value):
        raise ProfileError(f"{where}: protocol must be kwp2000 or uds, got {protocol_name!r}")
    if isinstance(bus_settings, KLineBus) and protocol_name != DiagProtocol.KWP2000.value:
        raise ProfileError(f"{where}: a K-line bus carries kwp2000 only, got {protocol_name!r}")
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
            values=_values(
                _field(table, "values", dict, section) if "values" in table else {},
                protocol,
                section.removesuffix("]"),
            ),
        )
    if not units:
        raise ProfileError(f"{where}: no units")
    return Profile(
        name=_field(data, "name", str, where),
        description=_field(data, "description", str, where),
        status=_field(data, "status", str, where),
        bus=bus_settings,
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
