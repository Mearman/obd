"""The single gate every diagnostic request passes before it reaches a car.

Requests that only read are allowed. Clearing fault codes is allowed through one route, with proof that what is about to be erased has been saved. Everything else is refused: there is no setting that turns this off.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class DiagProtocol(Enum):
    """The diagnostic protocol a request belongs to."""

    KWP2000 = "kwp2000"
    UDS = "uds"
    OBD = "obd"


class GuardError(Exception):
    """A request was refused because it could change something on the car."""


# Service IDs that only read, per protocol. A value of None allows every sub-function; a set allows only the listed first parameter bytes.
READ_ONLY: dict[DiagProtocol, dict[int, frozenset[int] | None]] = {
    DiagProtocol.KWP2000: {
        0x10: frozenset({0x81, 0x92}),  # default session, standard diagnostic session
        0x12: None,  # read freeze frame data
        0x17: None,  # read status of fault codes
        0x18: None,  # read fault codes by status
        0x1A: None,  # read ECU identification
        0x21: None,  # read data by local identifier
        0x3E: None,  # tester present
    },
    DiagProtocol.UDS: {
        0x10: frozenset({0x01, 0x03}),  # default session, extended diagnostic session
        0x19: None,  # read fault code information
        0x22: None,  # read data by identifier
        0x3E: None,  # tester present
    },
    DiagProtocol.OBD: {
        0x01: None,  # current data
        0x02: None,  # freeze frame data
        0x03: None,  # stored fault codes
        0x06: None,  # on-board monitoring results
        0x07: None,  # pending fault codes
        0x09: None,  # vehicle information
        0x0A: None,  # permanent fault codes
    },
}

# The service that clears stored fault codes, per protocol.
CLEAR_SERVICE: dict[DiagProtocol, int] = {
    DiagProtocol.KWP2000: 0x14,
    DiagProtocol.UDS: 0x14,
    DiagProtocol.OBD: 0x04,
}

# UDS sets bit 7 of a sub-function to suppress the positive reply; it is not part of the value.
UDS_SUPPRESS_REPLY = 0x80


@dataclass(frozen=True)
class ClearToken:
    """Proof that a snapshot of the codes about to be erased is on disk."""

    snapshot: Path


def authorise_clear(snapshot: Path) -> ClearToken:
    """Return a token for one clear request, once the snapshot file exists and has content.

    Raises GuardError when the file is missing or empty.
    """
    if not snapshot.is_file() or snapshot.stat().st_size == 0:
        raise GuardError(f"no saved snapshot at {snapshot}; refusing to clear")
    return ClearToken(snapshot)


_PERMIT_KEY = object()


class Permit:
    """A request the guard has passed. The adapter layer sends nothing else."""

    def __init__(self, key: object, protocol: DiagProtocol, payload: bytes) -> None:
        if key is not _PERMIT_KEY:
            raise GuardError("a Permit is issued only by guard.permit()")
        self.protocol = protocol
        self.payload = payload


def permit(protocol: DiagProtocol, payload: bytes, token: ClearToken | None = None) -> Permit:
    """Pass or refuse one request.

    Read-only services pass. The clear service passes only with a ClearToken, and a token passes nothing but the clear service. Raises GuardError for everything else.
    """
    if not payload:
        raise GuardError("empty request")
    service = payload[0]
    if token is not None:
        if service != CLEAR_SERVICE[protocol]:
            raise GuardError(f"a clear token cannot authorise service {service:02X}")
        if not token.snapshot.is_file():
            raise GuardError(f"snapshot {token.snapshot} has gone; refusing to clear")
        return Permit(_PERMIT_KEY, protocol, payload)

    allowed = READ_ONLY[protocol]
    if service not in allowed:
        reason = (
            "clearing fault codes goes through the clear command"
            if service == CLEAR_SERVICE[protocol]
            else "it is not a read-only service"
        )
        raise GuardError(f"{protocol.value} service {service:02X} refused: {reason}")
    sub_functions = allowed[service]
    if sub_functions is not None:
        if len(payload) < 2:
            raise GuardError(f"{protocol.value} service {service:02X} needs a sub-function")
        value = payload[1]
        if protocol is DiagProtocol.UDS:
            value &= ~UDS_SUPPRESS_REPLY
        if value not in sub_functions:
            raise GuardError(
                f"{protocol.value} service {service:02X} sub-function {payload[1]:02X} refused: "
                "only default and standard diagnostic sessions are allowed"
            )
    return Permit(_PERMIT_KEY, protocol, payload)
