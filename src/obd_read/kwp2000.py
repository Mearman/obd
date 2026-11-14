"""KWP2000 (ISO 14230-3) requests carried over CAN."""

from __future__ import annotations

from .diag import Fault, IdentField, UnitSession
from .elm import ElmError
from .guard import ClearToken, DiagProtocol

START_SESSION = 0x10
READ_FREEZE_FRAME = 0x12
CLEAR_FAULTS = 0x14
READ_FAULTS_BY_STATUS = 0x18
READ_IDENTIFICATION = 0x1A

# readECUIdentification option that asks for the unit's full identification record.
IDENT_OPTION = 0x86

# readDTCByStatus: report every identified code as two hexadecimal bytes plus a status byte.
STATUS_HEX_CODES = 0x02

# Group of fault codes meaning "all groups".
ALL_GROUPS = (0xFF, 0x00)

# readFreezeFrameData: search every stored frame, selecting by the fault code that follows.
ALL_FRAMES = 0xFF
SELECT_BY_FAULT_CODE = 0x04


class Kwp2000:
    """The KWP2000 requests this tool sends to one control unit."""

    protocol = DiagProtocol.KWP2000

    def __init__(self, session: UnitSession, diagnostic_session: int) -> None:
        self._session = session
        self._diagnostic_session = diagnostic_session

    async def start(self) -> None:
        """Open the diagnostic session the profile names."""
        await self._session.request(bytes([START_SESSION, self._diagnostic_session]))

    async def identification(self) -> list[IdentField]:
        """Read the unit's identification record."""
        reply = await self._session.request(bytes([READ_IDENTIFICATION, IDENT_OPTION]))
        return [IdentField("identification", reply[2:])]

    async def faults(self) -> list[Fault]:
        """Read every stored fault code with its status byte.

        Raises ElmError when the reply's length does not match the count it declares.
        """
        reply = await self._session.request(
            bytes([READ_FAULTS_BY_STATUS, STATUS_HEX_CODES, *ALL_GROUPS])
        )
        if len(reply) < 2:
            raise ElmError(f"short fault-code reply: {reply.hex()}")
        count, body = reply[1], reply[2:]
        if len(body) != 3 * count:
            raise ElmError(f"fault-code reply declares {count} codes but carries {body.hex()}")
        return [
            Fault(body[index : index + 2].hex().upper(), body[index + 2])
            for index in range(0, len(body), 3)
        ]

    async def freeze_frame(self, fault: Fault) -> bytes:
        """Read the freeze frame stored with one fault code, as raw bytes."""
        reply = await self._session.request(
            bytes([READ_FREEZE_FRAME, ALL_FRAMES, SELECT_BY_FAULT_CODE, *bytes.fromhex(fault.code)])
        )
        return reply[1:]

    async def clear(self, token: ClearToken) -> None:
        """Erase every stored fault code. Needs the token that proves a snapshot was saved."""
        await self._session.request(bytes([CLEAR_FAULTS, *ALL_GROUPS]), token)
