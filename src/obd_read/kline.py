"""K-line (ISO 9141-2 and ISO 14230) through an ELM327-style adapter, protocols 3, 4 and 5.

The adapter does the wire-level work: the five-baud or fast initialisation, the timing and the checksum. This module selects the protocol, addresses one unit at a time and reads the adapter's replies, which carry a three-byte header, the data and a checksum. Anything about the adapter's exact output that the research notes mark unconfirmed is checked here rather than assumed: a reply whose checksum does not match is refused.
"""

from __future__ import annotations

import re

from .elm import ADAPTER_ERRORS, MAX_SINGLE_FRAME, NOISE, Elm, ElmError, NoResponse
from .guard import Permit
from .profile import KLINE_SCHEMES, CanBus, KLineBus, Profile

# Time the adapter may take to initialise a bus: a five-baud address alone takes about two seconds.
INIT_TIMEOUT = 20.0

# A reply line: three header bytes, at least one data byte, one checksum byte.
MIN_REPLY_BYTES = 5

# Bytes in the header the adapter prints with `ATH1`: format, target, source.
HEADER_BYTES = 3

SLOW_INIT_SCHEMES = ("iso9141", "kwp2000-slow")


def checksum(data: bytes) -> int:
    """The K-line checksum: the sum of every byte before it, modulo 256."""
    return sum(data) & 0xFF


def parse_reply_line(line: str) -> tuple[int, bytes]:
    """Split one printed K-line reply into (source address, data bytes).

    Raises ElmError when the line is not whole bytes, is too short or fails its checksum.
    """
    compact = line.replace(" ", "").upper()
    if not re.fullmatch(r"(?:[0-9A-F]{2})+", compact):
        raise ElmError(f"unreadable reply line: {line!r}")
    raw = bytes.fromhex(compact)
    if len(raw) < MIN_REPLY_BYTES:
        raise ElmError(f"K-line reply too short: {line!r}")
    if checksum(raw[:-1]) != raw[-1]:
        raise ElmError(f"K-line reply fails its checksum: {line!r}")
    return raw[2], raw[HEADER_BYTES:-1]


class KLineElm(Elm):
    """An adapter session on a K-line bus, with the same surface as the CAN session.

    A unit's request identifier is its K-line address and its response identifier is the address its replies come from. The bus is initialised, for the unit last addressed, on the first request after the address changes.
    """

    _bus: KLineBus | None = None
    _initialised = False

    async def select_can(self, id_bits: int, bitrate: int) -> None:
        raise ElmError("this session is on a K-line bus, not CAN")

    async def select_kline(self, bus: KLineBus) -> None:
        """Select the protocol the bus names and stop the adapter searching other protocols."""
        self._bus = bus
        await self.require(f"ATSP{KLINE_SCHEMES[bus.scheme][0]}")
        self._initialised = False

    def _selected(self) -> KLineBus:
        if self._bus is None:
            raise ElmError("no K-line protocol selected")
        return self._bus

    async def address_unit(self, request_id: int, response_id: int) -> None:
        """Direct requests to the unit at K-line address `request_id`.

        The adapter filters nothing by the reply address; callers read the reply by its source address.
        """
        bus = self._selected()
        if bus.scheme in SLOW_INIT_SCHEMES:
            await self.require(f"ATIIA{request_id:02X}")
        await self.require(f"ATSH{bus.header_format:02X}{request_id:02X}{bus.tester:02X}")
        self._initialised = False

    async def address_functional(self, request_id: int) -> None:
        """Use the adapter's default headers, which address every emissions unit."""
        self._selected()
        self._initialised = False

    async def _initiate(self) -> None:
        bus = self._selected()
        lines = await self.command(
            "ATSI" if bus.scheme in SLOW_INIT_SCHEMES else "ATFI", INIT_TIMEOUT
        )
        compact = [line.replace(" ", "").upper() for line in lines]
        if not any(line.endswith("OK") for line in compact):
            raise NoResponse(f"the unit did not answer the initialisation ({'; '.join(lines)})")
        self._initialised = True

    async def request(self, permit: Permit, timeout: float = 8.0) -> dict[int, list[bytes]]:
        """Send one guarded request and return each source address's reply messages.

        Raises NoResponse when the bus cannot be initialised or no unit answers, and ElmError for an adapter error, an unreadable reply or a request longer than the adapter sends.
        """
        payload = permit.payload
        if len(payload) > MAX_SINGLE_FRAME:
            raise ElmError(f"request of {len(payload)} bytes is longer than the adapter sends")
        if not self._initialised:
            await self._initiate()
        lines = await self.command(payload.hex().upper(), timeout=timeout)
        replies: dict[int, list[bytes]] = {}
        for line in lines:
            compact = line.replace(" ", "").upper()
            if compact in NOISE:
                continue
            if compact == "NODATA":
                raise NoResponse("no control unit answered")
            if compact == "?":
                raise ElmError(f"the adapter did not understand {payload.hex().upper()}")
            if compact.startswith((*ADAPTER_ERRORS, "BUSINIT")):
                raise ElmError(f"adapter error: {line}")
            source, data = parse_reply_line(line)
            replies.setdefault(source, []).append(data)
        if not replies:
            raise NoResponse("no control unit answered")
        return replies


async def select_bus(elm: Elm, profile: Profile) -> None:
    """Select the bus a profile names on the adapter session."""
    if isinstance(profile.bus, CanBus):
        await elm.select_can(profile.bus.id_bits, profile.bus.bitrate)
    elif isinstance(elm, KLineElm):
        await elm.select_kline(profile.bus)
    else:
        raise ElmError("a K-line profile needs a K-line adapter session")
