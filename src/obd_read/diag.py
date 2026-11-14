"""One control unit's request and reply exchange, shared by KWP2000 and UDS."""

from __future__ import annotations

from dataclasses import dataclass

from .elm import Elm, ElmError
from .guard import DiagProtocol, Token, permit

NEGATIVE_RESPONSE = 0x7F
RESPONSE_PENDING = 0x78
POSITIVE_OFFSET = 0x40

# Negative response codes common to KWP2000 and UDS, for readable errors.
RESPONSE_CODES: dict[int, str] = {
    0x10: "general reject",
    0x11: "service not supported",
    0x12: "sub-function not supported",
    0x13: "incorrect message length or format",
    0x21: "busy, repeat request",
    0x22: "conditions not correct",
    0x31: "request out of range",
    0x33: "security access denied",
    0x7E: "sub-function not supported in the active session",
    0x7F: "service not supported in the active session",
    0x80: "service not supported in the active session",
}


class NegativeResponse(Exception):
    """The control unit answered and refused the request."""

    def __init__(self, service: int, code: int) -> None:
        self.service = service
        self.code = code
        meaning = RESPONSE_CODES.get(code, "manufacturer-specific or unlisted reason")
        super().__init__(f"service {service:02X} refused with code {code:02X} ({meaning})")


@dataclass(frozen=True)
class Fault:
    """One stored fault code with its status byte, exactly as the unit reported it."""

    code: str
    status: int


@dataclass(frozen=True)
class IdentField:
    """One identification value read from a unit."""

    label: str
    raw: bytes

    @property
    def text(self) -> str:
        """The printable ASCII characters in the value, for part numbers and names."""
        return "".join(chr(byte) for byte in self.raw if 0x20 <= byte < 0x7F).strip()


class UnitSession:
    """Requests to one addressed control unit, each passed through the guard."""

    def __init__(self, elm: Elm, protocol: DiagProtocol, response_id: int) -> None:
        self._elm = elm
        self._protocol = protocol
        self._response_id = response_id

    @property
    def protocol(self) -> DiagProtocol:
        return self._protocol

    async def request(self, payload: bytes, token: Token | None = None) -> bytes:
        """Send one request and return the unit's positive reply, service byte first.

        Raises GuardError when the request is not allowed, NegativeResponse when the unit
        refuses it, NoResponse when the unit is silent, and ElmError when the reply is
        unreadable or the unit asked for more time than the adapter waited.
        """
        replies = await self._elm.request(permit(self._protocol, payload, token))
        messages = replies.get(self._response_id)
        if not messages:
            senders = ", ".join(f"{can_id:X}" for can_id in replies)
            raise ElmError(f"expected a reply from {self._response_id:X}, got one from {senders}")
        settled = [
            message
            for message in messages
            if not (
                len(message) >= 3
                and message[0] == NEGATIVE_RESPONSE
                and message[2] == RESPONSE_PENDING
            )
        ]
        if not settled:
            raise ElmError(
                "the unit asked for more time and the adapter stopped listening before it answered"
            )
        message = settled[-1]
        if message[0] == NEGATIVE_RESPONSE:
            if len(message) < 3:
                raise ElmError(f"short negative response: {message.hex()}")
            raise NegativeResponse(message[1], message[2])
        if message[0] != payload[0] + POSITIVE_OFFSET:
            raise ElmError(f"reply {message.hex()} does not answer request {payload.hex()}")
        return message
