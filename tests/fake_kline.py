"""A scripted ELM327 adapter on a K-line bus, with units that answer by address."""

from __future__ import annotations

from collections.abc import Callable

from obd_read.kline import checksum

# A K-line unit takes one request payload and returns the reply payload, or None to stay silent.
Unit = Callable[[bytes], bytes | None]


def reply_line(source: int, payload: bytes, *, tester: int = 0xF1, corrupt: bool = False) -> str:
    """One reply as the adapter prints it with headers on: format, target, source, data, checksum."""
    body = bytes([0x48, tester, source]) + payload
    final = (checksum(body) + (1 if corrupt else 0)) & 0xFF
    return (body + bytes([final])).hex().upper()


class FakeKLineCore:
    """The adapter's command interpreter on a K-line bus."""

    def __init__(self, units: dict[int, Unit], silent_init: frozenset[int] = frozenset()) -> None:
        self.units = units
        self.silent_init = silent_init
        self.sent: list[str] = []
        self.target = 0
        self.corrupt = False
        self.functional = False
        self._partial = b""

    def feed(self, data: bytes) -> bytes:
        self._partial += data
        output = b""
        while b"\r" in self._partial:
            line, _, self._partial = self._partial.partition(b"\r")
            output += self._handle(line.decode("ascii").strip().upper()).encode("ascii") + b"\r\r>"
        return output

    def _handle(self, line: str) -> str:
        self.sent.append(line)
        if line == "ATZ":
            return "ELM327 v2.3"
        if line in ("ATI", "AT@1", "STI"):
            return "?" if line == "STI" else "ELM327 v2.3"
        if line == "ATRV":
            return "12.4V"
        if line.startswith("ATSH"):
            self.target = int(line[6:8], 16)
            return "OK"
        if line in ("ATSI", "ATFI"):
            return "BUS INIT: ERROR" if self.target in self.silent_init else "BUS INIT: OK"
        if line.startswith(("AT", "ST")):
            return "OK"
        unit = self.units.get(self.target)
        reply = unit(bytes.fromhex(line)) if unit is not None else None
        if reply is None:
            return "NO DATA"
        return reply_line(self.target, reply, corrupt=self.corrupt)

    @property
    def requests(self) -> list[str]:
        """Every line that was a diagnostic request, not an adapter command."""
        return [line for line in self.sent if not line.startswith(("AT", "ST"))]
