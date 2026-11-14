"""UDS (ISO 14229) requests carried over CAN."""

from __future__ import annotations

from .diag import Fault, IdentField, NegativeResponse, UnitSession
from .elm import ElmError
from .guard import ClearToken, DiagProtocol

SESSION_CONTROL = 0x10
CLEAR_FAULTS = 0x14
READ_FAULT_INFORMATION = 0x19
READ_DATA_BY_IDENTIFIER = 0x22

REPORT_BY_STATUS_MASK = 0x02
REPORT_SNAPSHOT_BY_FAULT = 0x04
ANY_STATUS = 0xFF
ALL_RECORDS = 0xFF
ALL_FAULT_GROUPS = (0xFF, 0xFF, 0xFF)

# Identification data identifiers defined by ISO 14229-1.
IDENT_FIELDS: dict[int, str] = {
    0xF190: "VIN",
    0xF187: "part number",
    0xF18C: "serial number",
    0xF195: "software version",
}


class Uds:
    """The UDS requests this tool sends to one control unit."""

    protocol = DiagProtocol.UDS

    def __init__(self, session: UnitSession, diagnostic_session: int) -> None:
        self._session = session
        self._diagnostic_session = diagnostic_session

    async def start(self) -> None:
        """Open the diagnostic session the profile names."""
        await self._session.request(bytes([SESSION_CONTROL, self._diagnostic_session]))

    async def identification(self) -> list[IdentField]:
        """Read the standard identification values the unit supports."""
        fields: list[IdentField] = []
        for identifier, label in IDENT_FIELDS.items():
            try:
                reply = await self._session.request(
                    bytes([READ_DATA_BY_IDENTIFIER, identifier >> 8, identifier & 0xFF])
                )
            except NegativeResponse:
                continue  # the unit does not hold this value
            fields.append(IdentField(label, reply[3:]))
        return fields

    async def faults(self) -> list[Fault]:
        """Read every stored fault code with its status byte.

        Raises ElmError when the reply is not a whole number of four-byte records.
        """
        reply = await self._session.request(
            bytes([READ_FAULT_INFORMATION, REPORT_BY_STATUS_MASK, ANY_STATUS])
        )
        body = reply[3:]
        if len(reply) < 3 or len(body) % 4:
            raise ElmError(f"fault-code reply is not whole records: {reply.hex()}")
        return [
            Fault(body[index : index + 3].hex().upper(), body[index + 3])
            for index in range(0, len(body), 4)
        ]

    async def freeze_frame(self, fault: Fault) -> bytes:
        """Read the snapshot records stored with one fault code, as raw bytes."""
        reply = await self._session.request(
            bytes(
                [
                    READ_FAULT_INFORMATION,
                    REPORT_SNAPSHOT_BY_FAULT,
                    *bytes.fromhex(fault.code),
                    ALL_RECORDS,
                ]
            )
        )
        return reply[2:]

    async def read_value(self, identifier: int) -> bytes:
        """Read one data identifier and return the data bytes that follow it in the reply.

        Raises ElmError when the reply names a different identifier.
        """
        reply = await self._session.request(
            bytes([READ_DATA_BY_IDENTIFIER, identifier >> 8, identifier & 0xFF])
        )
        if len(reply) < 3 or int.from_bytes(reply[1:3], "big") != identifier:
            raise ElmError(f"reply {reply.hex()} does not answer data identifier {identifier:04X}")
        return reply[3:]

    async def clear(self, token: ClearToken) -> None:
        """Erase every stored fault code. Needs the token that proves a snapshot was saved."""
        await self._session.request(bytes([CLEAR_FAULTS, *ALL_FAULT_GROUPS]), token)
