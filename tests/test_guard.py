import json
from pathlib import Path

import pytest

from obd_read.guard import (
    ACTUATION_MAX_SECONDS,
    ACTUATION_SERVICE,
    CLEAR_SERVICE,
    READ_ONLY,
    WRITE_SERVICE,
    ActuatorToken,
    DiagProtocol,
    GuardError,
    WriteToken,
    authorise_actuation,
    authorise_clear,
    authorise_write,
    permit,
)

PROTOCOLS_WITH_WRITES = [DiagProtocol.KWP2000, DiagProtocol.UDS]

# A write, its read and an actuation start and stop per protocol. The bytes are invented and address nothing on a real car.
WRITE = {DiagProtocol.KWP2000: "3B0A0102", DiagProtocol.UDS: "2E01230102"}
START = {DiagProtocol.KWP2000: "300A07FF", DiagProtocol.UDS: "2F012303FF"}
STOP = {DiagProtocol.KWP2000: "300A00", DiagProtocol.UDS: "2F012300"}

# Services that stay refused even with a write or actuation token in hand: clear without its own token, security access, reset, routine control, communication control, data transfer, control DTC setting.
ALWAYS_REFUSED = {
    DiagProtocol.KWP2000: [0x11, 0x14, 0x27, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x3D],
    DiagProtocol.UDS: [
        0x11,
        0x14,
        0x27,
        0x28,
        0x31,
        0x34,
        0x35,
        0x36,
        0x37,
        0x38,
        0x3D,
        0x85,
        0x87,
    ],
}

# Services that change something on a car: clear, actuator and routine control, writes,
# security access, reset, and download or programming transfer.
REFUSED = {
    DiagProtocol.KWP2000: [0x11, 0x14, 0x27, 0x2E, 0x2F, 0x30, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3B],
    DiagProtocol.UDS: [
        0x11,
        0x14,
        0x27,
        0x28,
        0x2E,
        0x2F,
        0x31,
        0x34,
        0x35,
        0x36,
        0x37,
        0x3D,
        0x85,
    ],
    DiagProtocol.OBD: [0x04, 0x08],
}

ALLOWED = {
    DiagProtocol.KWP2000: [
        "1081",
        "1092",
        "12FF040123",
        "170123",
        "1802FF00",
        "1A86",
        "2101",
        "3E",
    ],
    DiagProtocol.UDS: ["1001", "1003", "1083", "1902FF", "22F190", "3E00"],
    DiagProtocol.OBD: ["0100", "020200", "03", "0600", "07", "0902", "0A"],
}


@pytest.mark.parametrize(
    ("protocol", "service"),
    [(protocol, service) for protocol, services in REFUSED.items() for service in services],
)
def test_services_that_change_the_car_are_refused(protocol: DiagProtocol, service: int) -> None:
    with pytest.raises(GuardError):
        permit(protocol, bytes([service, 0x01, 0x00]))


@pytest.mark.parametrize(
    ("protocol", "request_hex"),
    [(protocol, text) for protocol, requests in ALLOWED.items() for text in requests],
)
def test_read_only_requests_pass(protocol: DiagProtocol, request_hex: str) -> None:
    assert permit(protocol, bytes.fromhex(request_hex)).payload == bytes.fromhex(request_hex)


@pytest.mark.parametrize(
    ("protocol", "request_hex"),
    [
        (DiagProtocol.KWP2000, "1085"),  # programming session
        (DiagProtocol.KWP2000, "1086"),  # development session
        (DiagProtocol.KWP2000, "1087"),  # adjustment session
        (DiagProtocol.KWP2000, "10"),
        (DiagProtocol.UDS, "1002"),  # programming session
        (DiagProtocol.UDS, "1082"),  # programming session, reply suppressed
        (DiagProtocol.UDS, "1060"),
    ],
)
def test_only_default_and_standard_sessions_pass(protocol: DiagProtocol, request_hex: str) -> None:
    with pytest.raises(GuardError):
        permit(protocol, bytes.fromhex(request_hex))


def test_empty_request_is_refused() -> None:
    with pytest.raises(GuardError):
        permit(DiagProtocol.UDS, b"")


def test_clear_needs_a_saved_snapshot(tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"
    with pytest.raises(GuardError):
        authorise_clear(missing)
    empty = tmp_path / "empty.json"
    empty.write_text("")
    with pytest.raises(GuardError):
        authorise_clear(empty)


@pytest.mark.parametrize("protocol", list(DiagProtocol))
def test_clear_passes_only_with_a_token(protocol: DiagProtocol, tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    request = bytes([CLEAR_SERVICE[protocol], 0xFF, 0x00])
    with pytest.raises(GuardError):
        permit(protocol, request)
    assert permit(protocol, request, authorise_clear(snapshot)).payload == request


def test_a_clear_token_authorises_nothing_else(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    token = authorise_clear(snapshot)
    for request in ("3101", "2E0001", "1A86", "2701"):
        with pytest.raises(GuardError):
            permit(DiagProtocol.KWP2000, bytes.fromhex(request), token)


def test_a_token_is_void_once_its_snapshot_is_gone(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    token = authorise_clear(snapshot)
    snapshot.unlink()
    with pytest.raises(GuardError):
        permit(DiagProtocol.KWP2000, bytes.fromhex("14FF00"), token)


def write_snapshot(path: Path, request_hex: str) -> Path:
    path.write_text(json.dumps({"write_request": request_hex, "previous_value": "0000"}))
    return path


@pytest.mark.parametrize("protocol", list(DiagProtocol))
@pytest.mark.parametrize("service", range(0x100))
def test_every_service_outside_the_read_only_table_is_refused_without_a_token(
    protocol: DiagProtocol, service: int
) -> None:
    if service in READ_ONLY[protocol]:
        return
    with pytest.raises(GuardError):
        permit(protocol, bytes([service, 0x01, 0x23, 0x00]))


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
@pytest.mark.parametrize("service", range(0x100))
def test_only_the_write_service_can_be_authorised_as_a_write(
    protocol: DiagProtocol, service: int, tmp_path: Path
) -> None:
    request = bytes([service, 0x01, 0x23, 0x00])
    snapshot = write_snapshot(tmp_path / "s.json", request.hex().upper())
    if service == WRITE_SERVICE[protocol]:
        assert permit(protocol, request, authorise_write(snapshot, protocol, request)).payload
    else:
        with pytest.raises(GuardError):
            authorise_write(snapshot, protocol, request)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
@pytest.mark.parametrize("service", range(0x100))
def test_only_the_actuation_service_can_be_authorised_as_an_actuator_test(
    protocol: DiagProtocol, service: int
) -> None:
    start = bytes([service, 0x01, 0x23, 0x03])
    stop = bytes([service, 0x01, 0x23, 0x00])
    if service == ACTUATION_SERVICE[protocol]:
        tokens = authorise_actuation(protocol, start, stop, 1)
        assert permit(protocol, start, tokens.start).payload == start
    else:
        with pytest.raises(GuardError):
            authorise_actuation(protocol, start, stop, 1)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_no_route_exists_for_writes_on_the_obd_path(protocol: DiagProtocol, tmp_path: Path) -> None:
    snapshot = write_snapshot(tmp_path / "s.json", WRITE[protocol])
    with pytest.raises(GuardError):
        authorise_write(snapshot, DiagProtocol.OBD, bytes.fromhex(WRITE[protocol]))
    with pytest.raises(GuardError):
        authorise_actuation(
            DiagProtocol.OBD, bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol]), 1
        )


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_write_and_actuation_services_are_refused_without_a_token(protocol: DiagProtocol) -> None:
    for request in (WRITE[protocol], START[protocol], STOP[protocol]):
        with pytest.raises(GuardError, match="command"):
            permit(protocol, bytes.fromhex(request))


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_write_token_passes_its_request_once(protocol: DiagProtocol, tmp_path: Path) -> None:
    request = bytes.fromhex(WRITE[protocol])
    token = authorise_write(write_snapshot(tmp_path / "s.json", WRITE[protocol]), protocol, request)
    assert permit(protocol, request, token).payload == request
    with pytest.raises(GuardError, match="already been used"):
        permit(protocol, request, token)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_write_token_authorises_no_other_request(protocol: DiagProtocol, tmp_path: Path) -> None:
    request = bytes.fromhex(WRITE[protocol])
    snapshot = write_snapshot(tmp_path / "s.json", WRITE[protocol])
    others = [
        START[protocol],
        STOP[protocol],
        WRITE[protocol] + "FF",
        WRITE[protocol][:-2] + "03",
        *(f"{service:02X}0123" for service in ALWAYS_REFUSED[protocol]),
    ]
    for other in others:
        token = authorise_write(snapshot, protocol, request)
        with pytest.raises(GuardError):
            permit(protocol, bytes.fromhex(other), token)
        assert not token.spent
    other_protocol = next(p for p in PROTOCOLS_WITH_WRITES if p is not protocol)
    with pytest.raises(GuardError):
        permit(other_protocol, request, authorise_write(snapshot, protocol, request))


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_actuation_tokens_pass_their_own_request_once(protocol: DiagProtocol) -> None:
    start, stop = bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol])
    tokens = authorise_actuation(protocol, start, stop, 1)
    with pytest.raises(GuardError):
        permit(protocol, stop, tokens.start)
    with pytest.raises(GuardError):
        permit(protocol, start, tokens.stop)
    assert permit(protocol, start, tokens.start).payload == start
    assert permit(protocol, stop, tokens.stop).payload == stop
    for request, token in ((start, tokens.start), (stop, tokens.stop)):
        with pytest.raises(GuardError, match="already been used"):
            permit(protocol, request, token)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_actuation_tokens_authorise_no_other_service(protocol: DiagProtocol) -> None:
    tokens = authorise_actuation(
        protocol, bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol]), 1
    )
    for service in [WRITE_SERVICE[protocol], *ALWAYS_REFUSED[protocol]]:
        with pytest.raises(GuardError):
            permit(protocol, bytes([service]) + bytes.fromhex(START[protocol])[1:], tokens.start)
    assert not tokens.start.spent


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_write_and_actuation_tokens_cannot_pass_a_clear(
    protocol: DiagProtocol, tmp_path: Path
) -> None:
    clear = bytes([CLEAR_SERVICE[protocol], 0xFF, 0x00])
    write = bytes.fromhex(WRITE[protocol])
    tokens = authorise_actuation(
        protocol, bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol]), 1
    )
    snapshot = write_snapshot(tmp_path / "s.json", WRITE[protocol])
    for token in (authorise_write(snapshot, protocol, write), tokens.start, tokens.stop):
        with pytest.raises(GuardError):
            permit(protocol, clear, token)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_clear_token_cannot_pass_a_write_or_actuation(
    protocol: DiagProtocol, tmp_path: Path
) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{}")
    token = authorise_clear(snapshot)
    for request in (WRITE[protocol], START[protocol], STOP[protocol]):
        with pytest.raises(GuardError):
            permit(protocol, bytes.fromhex(request), token)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_write_needs_a_snapshot_of_that_request(protocol: DiagProtocol, tmp_path: Path) -> None:
    request = bytes.fromhex(WRITE[protocol])
    with pytest.raises(GuardError):
        authorise_write(tmp_path / "missing.json", protocol, request)
    empty = tmp_path / "empty.json"
    empty.write_text("")
    with pytest.raises(GuardError):
        authorise_write(empty, protocol, request)
    other = write_snapshot(tmp_path / "other.json", WRITE[protocol] + "FF")
    with pytest.raises(GuardError, match="does not record"):
        authorise_write(other, protocol, request)
    no_previous = tmp_path / "no-previous.json"
    no_previous.write_text(json.dumps({"write_request": WRITE[protocol]}))
    with pytest.raises(GuardError, match="no previous value"):
        authorise_write(no_previous, protocol, request)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_write_token_is_void_once_its_snapshot_is_gone(
    protocol: DiagProtocol, tmp_path: Path
) -> None:
    request = bytes.fromhex(WRITE[protocol])
    snapshot = write_snapshot(tmp_path / "s.json", WRITE[protocol])
    token = authorise_write(snapshot, protocol, request)
    snapshot.unlink()
    with pytest.raises(GuardError, match="has gone"):
        permit(protocol, request, token)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_a_write_without_a_value_is_refused(protocol: DiagProtocol, tmp_path: Path) -> None:
    bare = bytes.fromhex(WRITE[protocol])[: 1 + (1 if protocol is DiagProtocol.KWP2000 else 2)]
    with pytest.raises(GuardError, match="no value"):
        authorise_write(write_snapshot(tmp_path / "s.json", bare.hex().upper()), protocol, bare)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_an_actuator_test_is_bounded(protocol: DiagProtocol) -> None:
    start, stop = bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol])
    authorise_actuation(protocol, start, stop, ACTUATION_MAX_SECONDS)
    for seconds in (0, -1, ACTUATION_MAX_SECONDS + 0.1):
        with pytest.raises(GuardError, match="at most"):
            authorise_actuation(protocol, start, stop, seconds)


@pytest.mark.parametrize("protocol", PROTOCOLS_WITH_WRITES)
def test_the_stop_request_must_hand_back_the_same_identifier(protocol: DiagProtocol) -> None:
    start = bytes.fromhex(START[protocol])
    elsewhere = bytearray(bytes.fromhex(STOP[protocol]))
    elsewhere[1] ^= 0xFF
    with pytest.raises(GuardError, match="same identifier"):
        authorise_actuation(protocol, start, bytes(elsewhere), 1)
    with pytest.raises(GuardError, match="same as the start"):
        authorise_actuation(protocol, start, start, 1)


def test_tokens_are_issued_only_by_the_guard(tmp_path: Path) -> None:
    with pytest.raises(GuardError):
        WriteToken(object(), DiagProtocol.UDS, bytes.fromhex(WRITE[DiagProtocol.UDS]), tmp_path)
    with pytest.raises(GuardError):
        ActuatorToken(object(), DiagProtocol.UDS, bytes.fromhex(START[DiagProtocol.UDS]))


@pytest.mark.parametrize(
    ("protocol", "request_hex"),
    [
        (DiagProtocol.KWP2000, "1085"),
        (DiagProtocol.KWP2000, "1086"),
        (DiagProtocol.KWP2000, "1087"),
        (DiagProtocol.UDS, "1002"),
        (DiagProtocol.UDS, "1004"),
    ],
)
def test_no_token_opens_a_programming_or_other_session(
    protocol: DiagProtocol, request_hex: str, tmp_path: Path
) -> None:
    request = bytes.fromhex(request_hex)
    tokens = authorise_actuation(
        protocol, bytes.fromhex(START[protocol]), bytes.fromhex(STOP[protocol]), 1
    )
    write = authorise_write(
        write_snapshot(tmp_path / "s.json", WRITE[protocol]),
        protocol,
        bytes.fromhex(WRITE[protocol]),
    )
    for token in (tokens.start, tokens.stop, write):
        with pytest.raises(GuardError):
            permit(protocol, request, token)
