from pathlib import Path

import pytest

from obd_read.guard import CLEAR_SERVICE, DiagProtocol, GuardError, authorise_clear, permit

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
