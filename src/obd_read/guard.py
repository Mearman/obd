"""The single gate every diagnostic request passes before it reaches a car.

Requests that only read are allowed. Three services that change the car each have one route, and each route needs a token that only this module issues, after the safeguards that route depends on have run:

- clearing fault codes needs a ClearToken, proof that what is about to be erased is saved;
- a coding or adaptation write needs a WriteToken, bound to the exact request bytes and to a saved snapshot that records that request and the value it replaces;
- an actuator test needs an ActuationTokens pair, bound to the exact start request and the request that hands control back to the unit.

Write and actuation tokens pass one request each and then are spent. Security access, resets, routine control, programming sessions, data transfer and every service not listed here are refused, with or without a token: there is no setting that turns this off.

Sources for the request layouts: ISO/DIS 14230-3 draft of 16 December 1996 (KWP2000), tables 7.1.2.1, 7.5.2.1 and 9.1.2.1; python-udsoncan's InputOutputControlByIdentifier and WriteDataByIdentifier services (UDS, ISO 14229-1).
"""

from __future__ import annotations

import json
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

# The service that writes a value by identifier, per protocol: KWP2000 writeDataByLocalIdentifier, UDS writeDataByIdentifier.
WRITE_SERVICE: dict[DiagProtocol, int] = {
    DiagProtocol.KWP2000: 0x3B,
    DiagProtocol.UDS: 0x2E,
}

# The service that reads the value a write replaces, per protocol: readDataByLocalIdentifier and readDataByIdentifier.
READ_SERVICE: dict[DiagProtocol, int] = {
    DiagProtocol.KWP2000: 0x21,
    DiagProtocol.UDS: 0x22,
}

# The service that takes control of an input or output, per protocol: KWP2000 inputOutputControlByLocalIdentifier, UDS inputOutputControlByIdentifier.
ACTUATION_SERVICE: dict[DiagProtocol, int] = {
    DiagProtocol.KWP2000: 0x30,
    DiagProtocol.UDS: 0x2F,
}

# Bytes of identifier after the service byte in a read, write or actuation request: a KWP2000 local identifier is one byte, a UDS data identifier two.
IDENTIFIER_LENGTH: dict[DiagProtocol, int] = {
    DiagProtocol.KWP2000: 1,
    DiagProtocol.UDS: 2,
}

# The longest an actuator test may hold control, in seconds. An output driven for longer than its normal duty can overheat a coil or motor or hold a part at its end stop; a test that needs longer is run again, after the user has seen the first one end.
ACTUATION_MAX_SECONDS = 30.0

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
_TOKEN_KEY = object()


def identifier(protocol: DiagProtocol, payload: bytes) -> bytes:
    """The identifier bytes that follow the service byte in a read, write or actuation request.

    Raises GuardError when the request is too short to carry one.
    """
    length = IDENTIFIER_LENGTH.get(protocol)
    if length is None:
        raise GuardError(f"{protocol.value} has no identifier-addressed services")
    if len(payload) < 1 + length:
        raise GuardError(f"request {payload.hex().upper()} is too short to carry an identifier")
    return payload[1 : 1 + length]


class _SingleUseToken:
    """A token that passes one exact request once, then is spent."""

    def __init__(self, key: object, protocol: DiagProtocol, payload: bytes) -> None:
        if key is not _TOKEN_KEY:
            raise GuardError("write and actuation tokens are issued only by the guard")
        self.protocol = protocol
        self.payload = payload
        self.spent = False

    def _check(self) -> None:
        """Raise GuardError when a condition beyond the request bytes no longer holds."""

    def spend(self, protocol: DiagProtocol, payload: bytes) -> None:
        """Mark the token used for this request. Raises GuardError unless it is the request it was issued for and is unspent."""
        if self.spent:
            raise GuardError("this token has already been used; each one passes a single request")
        if protocol is not self.protocol or payload != self.payload:
            raise GuardError(
                f"a token for {self.protocol.value} request {self.payload.hex().upper()} cannot "
                f"authorise {protocol.value} request {payload.hex().upper()}"
            )
        self._check()
        self.spent = True


class WriteToken(_SingleUseToken):
    """Proof that a snapshot recording this write request and the value it replaces is on disk."""

    def __init__(self, key: object, protocol: DiagProtocol, payload: bytes, snapshot: Path) -> None:
        super().__init__(key, protocol, payload)
        self.snapshot = snapshot

    def _check(self) -> None:
        if not self.snapshot.is_file():
            raise GuardError(f"snapshot {self.snapshot} has gone; refusing to write")


class ActuatorToken(_SingleUseToken):
    """Leave to send one actuation request, issued only as half of an ActuationTokens pair."""


@dataclass(frozen=True)
class ActuationTokens:
    """The start request of one actuator test and the request that hands control back, each passable once."""

    start: ActuatorToken
    stop: ActuatorToken


Token = ClearToken | WriteToken | ActuatorToken


def authorise_write(snapshot: Path, protocol: DiagProtocol, payload: bytes) -> WriteToken:
    """Return a token for one write request, once its snapshot is saved.

    The snapshot must be a JSON object whose `write_request` is this request in hexadecimal and whose `previous_value` is the hexadecimal value read before it. Raises GuardError when the request is not the protocol's write service, carries no value after its identifier, or the snapshot is missing, unreadable or for another request.
    """
    service = WRITE_SERVICE.get(protocol)
    if service is None or not payload or payload[0] != service:
        raise GuardError(
            f"{payload.hex().upper() or 'empty request'} is not a {protocol.value} write"
        )
    if len(payload) <= 1 + len(identifier(protocol, payload)):
        raise GuardError(f"write {payload.hex().upper()} carries no value to write")
    try:
        saved: object = json.loads(snapshot.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise GuardError(f"no readable snapshot at {snapshot}; refusing to write") from error
    if not isinstance(saved, dict):
        raise GuardError(f"snapshot {snapshot} is not a write snapshot; refusing to write")
    if saved.get("write_request") != payload.hex().upper():
        raise GuardError(f"snapshot {snapshot} does not record request {payload.hex().upper()}")
    if not isinstance(saved.get("previous_value"), str):
        raise GuardError(f"snapshot {snapshot} records no previous value; refusing to write")
    return WriteToken(_TOKEN_KEY, protocol, payload, snapshot)


def check_actuation(protocol: DiagProtocol, start: bytes, stop: bytes, seconds: float) -> None:
    """Refuse an actuator test that no token would be issued for, before anything is sent.

    Raises GuardError when either request is not the protocol's actuation service, the stop request names a different identifier from the start, the two are the same request, or `seconds` is not above zero and at most ACTUATION_MAX_SECONDS.
    """
    service = ACTUATION_SERVICE.get(protocol)
    for label, payload in (("start", start), ("stop", stop)):
        if service is None or not payload or payload[0] != service:
            raise GuardError(
                f"{label} request {payload.hex().upper() or '(empty)'} is not a "
                f"{protocol.value} actuation request"
            )
    if identifier(protocol, start) != identifier(protocol, stop):
        raise GuardError("the stop request must name the same identifier as the start request")
    if start == stop:
        raise GuardError("the stop request is the same as the start request")
    if not 0 < seconds <= ACTUATION_MAX_SECONDS:
        raise GuardError(
            f"an actuator test lasts more than 0 and at most {ACTUATION_MAX_SECONDS:g} seconds"
        )


def authorise_actuation(
    protocol: DiagProtocol, start: bytes, stop: bytes, seconds: float
) -> ActuationTokens:
    """Return the start and stop tokens for one actuator test that check_actuation passes.

    Raises GuardError as check_actuation does.
    """
    check_actuation(protocol, start, stop, seconds)
    return ActuationTokens(
        ActuatorToken(_TOKEN_KEY, protocol, start), ActuatorToken(_TOKEN_KEY, protocol, stop)
    )


class Permit:
    """A request the guard has passed. The adapter layer sends nothing else."""

    def __init__(self, key: object, protocol: DiagProtocol, payload: bytes) -> None:
        if key is not _PERMIT_KEY:
            raise GuardError("a Permit is issued only by guard.permit()")
        self.protocol = protocol
        self.payload = payload


def permit(protocol: DiagProtocol, payload: bytes, token: Token | None = None) -> Permit:
    """Pass or refuse one request.

    Read-only services pass. The clear service passes only with a ClearToken, and a clear token passes nothing but the clear service. A write or actuation request passes only with an unspent token issued for exactly that request, which it spends. Raises GuardError for everything else.
    """
    if not payload:
        raise GuardError("empty request")
    service = payload[0]
    if isinstance(token, WriteToken | ActuatorToken):
        token.spend(protocol, payload)
        return Permit(_PERMIT_KEY, protocol, payload)
    if token is not None:
        if service != CLEAR_SERVICE[protocol]:
            raise GuardError(f"a clear token cannot authorise service {service:02X}")
        if not token.snapshot.is_file():
            raise GuardError(f"snapshot {token.snapshot} has gone; refusing to clear")
        return Permit(_PERMIT_KEY, protocol, payload)

    allowed = READ_ONLY[protocol]
    if service not in allowed:
        if service == CLEAR_SERVICE[protocol]:
            reason = "clearing fault codes goes through the clear command"
        elif service == WRITE_SERVICE.get(protocol):
            reason = "writes go through the write command"
        elif service == ACTUATION_SERVICE.get(protocol):
            reason = "actuator tests go through the actuate command"
        else:
            reason = "it is not a read-only service"
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
